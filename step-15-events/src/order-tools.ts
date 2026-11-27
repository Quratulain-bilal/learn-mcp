import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import type { Db, ForTenant } from "./db";
import type { SettingsStore } from "./settings";
import type { TenantContext } from "./tenant";
import { READ_ONLY, dbError, markdownTable, rowSchema, toolError } from "./tool-helpers";
import { WIDGETS } from "./widgets/resources";

/**
 * Production data tools: a paginated list, a single-order lookup, summaries that fit in
 * the model's context, and one transactional write. All run through forTenant(), so
 * row-level security applies to every query, and none takes a company as input.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD, e.g. 2025-03-31.");
const searchText = z.string().trim().min(2).max(80);
const orderRef = z
  .string()
  .trim()
  .regex(/^[A-Z]{2,4}-[A-Z0-9-]{1,20}$/i, "An order reference looks like SO-0042 or WEB-1A2B3C4D.");

/** ILIKE pattern for "contains", with the user's own % and _ treated as plain text. */
const contains = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * The cursor is the (date, id) of the last order on the page, opaque to the model.
 * Keyset pagination: "orders older than this one", which stays correct when new orders
 * arrive, unlike OFFSET. It carries no company: forTenant still decides whose rows these are.
 */
interface Cursor {
  d: string;
  id: string;
}
const encodeCursor = (c: Cursor) => btoa(JSON.stringify(c)).replace(/=+$/, "");
function decodeCursor(value: string): Cursor | null {
  try {
    const c = JSON.parse(atob(value)) as Partial<Cursor>;
    if (typeof c.d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.d) && typeof c.id === "string" && /^\d+$/.test(c.id)) {
      return { d: c.d, id: c.id };
    }
  } catch {
    // fall through
  }
  return null;
}

/** The same words whether the order doesn't exist or belongs to another company (lesson 19.10). */
const notFound = (ref: string) =>
  toolError(`No order ${ref} was found in your company. Check the reference with list_orders.`);

const orderSummarySchema = z.object({
  order_ref: z.string(),
  order_date: z.string(),
  customer: z.string(),
  city: z.string(),
  lines: z.number(),
  total: z.number(),
});

export function registerOrderTools(
  server: McpServer,
  forTenant: ForTenant,
  tenant: TenantContext,
  settings: SettingsStore,
  /** Called after an order is saved (step 15: queues an order.created event). */
  onOrderCreated?: (order: { order_ref: string; order_date: string; total: number; customer_name: string }) => Promise<void>,
): void {
  const orgId = tenant.orgId;

  // ---------------------------------------------------------------------------------
  // registerAppTool is registerTool plus _meta.ui.resourceUri: hosts that support MCP Apps
  // show the widget with the result; others just show the text. Same data either way.
  registerAppTool(
    server,
    "list_orders",
    {
      title: "List orders",
      description:
        "Show the company's orders as an interactive TABLE (newest first, one page at a time) with each order's customer, city, number of lines and total. " +
        "Use it when the user wants to see, browse or find orders. " +
        "Filter by date range, customer (part of a name or email) or product (part of a name). " +
        "If the reply has a nextCursor, pass it back as `cursor` to get the next page; keep the same filters. " +
        "For totals over many orders use get_sales_summary instead of paging through everything.",
      _meta: { ui: { resourceUri: WIDGETS.ordersTable } },
      inputSchema: z.object({
        from: isoDate.optional().describe("Only orders on or after this date (YYYY-MM-DD)."),
        to: isoDate.optional().describe("Only orders on or before this date (YYYY-MM-DD)."),
        customer: searchText.optional().describe('Part of the customer\'s name or email, e.g. "ayesha".'),
        product: searchText.optional().describe('Only orders containing a product whose name includes this, e.g. "chair".'),
        limit: z.number().int().min(1).max(50).default(20).describe("Orders per page (1-50). Defaults to 20."),
        cursor: z.string().max(200).optional().describe("nextCursor from the previous page. Omit for the first page."),
      }),
      outputSchema: z.object({
        orders: z.array(orderSummarySchema),
        nextCursor: z.string().nullable().describe("Pass as `cursor` for the next page; null when there are no more."),
      }),
      annotations: READ_ONLY,
    },
    async ({ from, to, customer, product, limit, cursor }) => {
      const after = cursor ? decodeCursor(cursor) : null;
      if (cursor && !after) {
        return toolError("That cursor isn't valid. Call list_orders again without `cursor` to start from the first page.");
      }
      try {
        // Ask for one extra row to know whether there's another page.
        const rows = await forTenant(tenant, (db) =>
          db.query<z.infer<typeof orderSummarySchema> & { order_id: string }>(
            `SELECT o.order_id::text                                   AS order_id,
                    o.order_ref,
                    to_char(o.order_date, 'YYYY-MM-DD')                AS order_date,
                    cu.name                                            AS customer,
                    cu.city,
                    count(i.line_no)::int                              AS lines,
                    round(sum(i.quantity * i.unit_price), 2)::float8   AS total
             FROM orders o
             JOIN customers cu  ON cu.org_id = o.org_id AND cu.customer_id = o.customer_id
             JOIN order_items i ON i.org_id = o.org_id AND i.order_id = o.order_id
             WHERE o.org_id = $1
               AND ($2::date IS NULL OR o.order_date >= $2::date)
               AND ($3::date IS NULL OR o.order_date <= $3::date)
               AND ($4::text IS NULL OR cu.name ILIKE $4 OR cu.email ILIKE $4)
               AND ($5::text IS NULL OR EXISTS (
                     SELECT 1 FROM order_items pi
                     JOIN products p ON p.org_id = pi.org_id AND p.product_id = pi.product_id
                     WHERE pi.org_id = o.org_id AND pi.order_id = o.order_id AND p.name ILIKE $5))
               AND ($6::date IS NULL OR (o.order_date, o.order_id) < ($6::date, $7::bigint))
             GROUP BY o.order_id, o.order_ref, o.order_date, cu.name, cu.city
             ORDER BY o.order_date DESC, o.order_id DESC
             LIMIT $8`,
            [
              orgId,
              from ?? null,
              to ?? null,
              customer ? contains(customer) : null,
              product ? contains(product) : null,
              after?.d ?? null,
              after?.id ?? null,
              limit + 1,
            ],
          ),
        );
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        const nextCursor = rows.length > limit && last ? encodeCursor({ d: last.order_date, id: last.order_id }) : null;
        const orders = page.map(({ order_id: _id, ...o }) => o);
        const text =
          (orders.length ? markdownTable(orders) : "No orders match these filters in your company.") +
          (nextCursor ? `\n\nMore orders exist: call list_orders again with cursor "${nextCursor}".` : "");
        return { content: [{ type: "text", text }], structuredContent: { orders, nextCursor } };
      } catch (error) {
        return dbError(error);
      }
    },
  );

  // ---------------------------------------------------------------------------------
  server.registerTool(
    "get_order",
    {
      title: "Get one order",
      description:
        "Show one order in full: date, customer and every line with product, quantity, the price paid and the line total. " +
        "Use the order reference shown by list_orders, e.g. SO-0042.",
      inputSchema: z.object({ order_ref: orderRef.describe("The order reference, e.g. SO-0042.") }),
      outputSchema: z.object({
        order_ref: z.string(),
        order_date: z.string(),
        customer: z.string(),
        email: z.string(),
        city: z.string(),
        lines: z.array(rowSchema),
        total: z.number(),
      }),
      annotations: READ_ONLY,
    },
    async ({ order_ref }) => {
      const ref = order_ref.toUpperCase();
      try {
        const order = await loadOrder(forTenant, tenant, ref);
        if (!order) return notFound(ref);

        const { order_id: _id, ...head } = order.head;
        const total = Math.round(order.lines.reduce((sum, l) => sum + Number(l.line_total), 0) * 100) / 100;
        const text = `Order ${ref}, ${head.order_date}, ${head.customer} (${head.city}), total ${total}:\n\n${markdownTable(order.lines)}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: { order_ref: ref, ...head, lines: order.lines, total },
        };
      } catch (error) {
        return dbError(error);
      }
    },
  );

  // ---------------------------------------------------------------------------------
  const GROUPS = {
    month: { label: "to_char(date_trunc('month', o.order_date), 'YYYY-MM')", order: "1" },
    product: { label: "p.name", order: "revenue DESC, 1" },
    customer: { label: "cu.name", order: "revenue DESC, 1" },
  } as const;

  registerAppTool(
    server,
    "get_sales_summary",
    {
      title: "Sales summary",
      description:
        "Show the company's sales totals as a bar CHART, grouped by month, product or customer: orders, units and revenue per group, plus a grand total. " +
        "Use it for trends, comparisons and \"how are we doing\" questions, instead of paging through list_orders. Optionally limit to a date range. " +
        "Groups at or above the company's sales threshold are highlighted.",
      _meta: { ui: { resourceUri: WIDGETS.salesChart } },
      inputSchema: z.object({
        group_by: z.enum(["month", "product", "customer"]).describe("How to group the totals."),
        from: isoDate.optional().describe("Only orders on or after this date (YYYY-MM-DD)."),
        to: isoDate.optional().describe("Only orders on or before this date (YYYY-MM-DD)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(12)
          .describe("How many groups to return (biggest first for product and customer). Defaults to 12."),
      }),
      outputSchema: z.object({
        group_by: z.string(),
        groups: z.array(rowSchema),
        total: z.object({ orders: z.number(), units: z.number(), revenue: z.number() }),
        currency: z.string().describe("The company's currency, from its settings."),
        threshold: z.number().describe("Groups with revenue at or above this have at_or_above_threshold = true."),
        moreGroups: z.boolean().describe("True when there were more groups than `limit`."),
      }),
      annotations: READ_ONLY,
    },
    async ({ group_by, from, to, limit }) => {
      const g = GROUPS[group_by]; // our own SQL text, chosen by the enum: never model text
      const filters = `o.org_id = $1
        AND ($2::date IS NULL OR o.order_date >= $2::date)
        AND ($3::date IS NULL OR o.order_date <= $3::date)`;
      try {
        const { groups, total } = await forTenant(tenant, async (db) => {
          const groups = await db.query(
            `SELECT ${g.label}                                     AS ${group_by},
                    count(DISTINCT o.order_id)::int                  AS orders,
                    sum(i.quantity)::int                             AS units,
                    round(sum(i.quantity * i.unit_price), 2)::float8 AS revenue
             FROM orders o
             JOIN customers cu  ON cu.org_id = o.org_id AND cu.customer_id = o.customer_id
             JOIN order_items i ON i.org_id = o.org_id AND i.order_id = o.order_id
             JOIN products p    ON p.org_id = i.org_id AND p.product_id = i.product_id
             WHERE ${filters}
             GROUP BY 1
             ORDER BY ${g.order}
             LIMIT $4`,
            [orgId, from ?? null, to ?? null, limit + 1],
          );
          const [total] = await db.query<{ orders: number; units: number; revenue: number }>(
            `SELECT count(DISTINCT o.order_id)::int                              AS orders,
                    coalesce(sum(i.quantity), 0)::int                             AS units,
                    coalesce(round(sum(i.quantity * i.unit_price), 2), 0)::float8 AS revenue
             FROM orders o
             JOIN order_items i ON i.org_id = o.org_id AND i.order_id = o.order_id
             WHERE ${filters}`,
            [orgId, from ?? null, to ?? null],
          );
          return { groups, total: total ?? { orders: 0, units: 0, revenue: 0 } };
        });
        // The company's own rules, from its settings: same code, different results per company.
        const { settings: s } = await settings.get(tenant);
        const moreGroups = groups.length > limit;
        const shown = groups
          .slice(0, limit)
          .map((g) => ({ ...g, at_or_above_threshold: Number(g.revenue) >= s.sales_threshold }));
        const text =
          `Sales by ${group_by}: ${total.orders} orders, ${total.units} units, revenue ${total.revenue} ${s.currency}. ` +
          `Groups at or above the ${s.sales_threshold} ${s.currency} threshold are flagged.\n\n` +
          markdownTable(shown) +
          (moreGroups ? `\n\nOnly the first ${limit} groups are shown; raise limit to see more.` : "");
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            group_by,
            groups: shown,
            total,
            moreGroups,
            currency: s.currency,
            threshold: s.sales_threshold,
          },
        };
      } catch (error) {
        return dbError(error);
      }
    },
  );

  // ---------------------------------------------------------------------------------
  registerAppTool(
    server,
    "open_order_form",
    {
      title: "Open the order form",
      description:
        "Show an interactive ORDER FORM where the user picks a customer and products and places the order themselves. " +
        "Use it when the user wants to create or enter an order but hasn't given every detail (customer email, exact product names, quantities). " +
        "If they gave all the details, call create_order directly instead.",
      _meta: { ui: { resourceUri: WIDGETS.orderForm } },
      inputSchema: z.object({}),
      outputSchema: z.object({
        customers: z.array(z.object({ name: z.string(), email: z.string(), city: z.string() })),
        products: z.array(z.object({ name: z.string(), category: z.string(), list_price: z.number() })),
        currency: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async () => {
      try {
        // Only this company's customers and catalog (forTenant + row-level security).
        const { customers, products } = await forTenant(tenant, async (db) => ({
          customers: await db.query<{ name: string; email: string; city: string }>(
            `SELECT name, email, city FROM customers WHERE org_id = $1 ORDER BY name LIMIT 200`,
            [orgId],
          ),
          products: await db.query<{ name: string; category: string; list_price: number }>(
            `SELECT p.name, c.name AS category, p.list_price::float8 AS list_price
             FROM products p JOIN categories c ON c.org_id = p.org_id AND c.category_id = p.category_id
             WHERE p.org_id = $1 ORDER BY p.name LIMIT 200`,
            [orgId],
          ),
        }));
        const { settings: s } = await settings.get(tenant);
        if (customers.length === 0 || products.length === 0) {
          return toolError("Your company has no customers or no products yet, so there's nothing to order. Load data first.");
        }
        const text =
          `Opened the order form with ${customers.length} customers and ${products.length} products. ` +
          "The user fills it in and places the order in the form; you don't need to call create_order.";
        return {
          content: [{ type: "text", text }],
          structuredContent: { customers, products, currency: s.currency },
        };
      } catch (error) {
        return dbError(error);
      }
    },
  );

  // ---------------------------------------------------------------------------------
  server.registerTool(
    "create_order",
    {
      title: "Create an order",
      description:
        "Create a new order for an existing customer, dated today. Name the customer by email and each product by its exact catalog name " +
        "(see answer_business_question with top_products or products_never_sold for names). Each line's price is today's catalog price. " +
        "The whole order is saved in one transaction: if anything is wrong, nothing is saved and the error says what to fix. " +
        "Confirm the customer, products and quantities with the user before calling this.",
      inputSchema: z.object({
        customer_email: z.string().trim().toLowerCase().email().max(254).describe("The existing customer's email address."),
        items: z
          .array(
            z.object({
              product: z.string().trim().min(1).max(120).describe('The exact product name, e.g. "Ergo Chair".'),
              quantity: z.number().int().min(1).max(1000).describe("How many (1-1000)."),
            }),
          )
          .min(1)
          .max(20)
          .describe("The order lines, 1 to 20, each product at most once."),
      }),
      outputSchema: z.object({
        order_ref: z.string(),
        order_date: z.string(),
        customer: z.string(),
        lines: z.array(rowSchema),
        total: z.number(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ customer_email, items }) => {
      const names = items.map((i) => i.product.toLowerCase());
      const duplicate = names.find((n, i) => names.indexOf(n) !== i);
      if (duplicate) {
        return toolError(`"${duplicate}" appears twice. List each product once and add up its quantity.`);
      }
      try {
        const result = await forTenant(tenant, (db) => insertOrder(db, orgId, customer_email, items));
        if ("error" in result) return toolError(result.error);
        await onOrderCreated?.({
          order_ref: result.order_ref,
          order_date: result.order_date,
          total: result.total,
          customer_name: result.customer,
        });
        const text =
          `Created order ${result.order_ref} for ${result.customer} on ${result.order_date}, total ${result.total}:\n\n` +
          markdownTable(result.lines);
        return { content: [{ type: "text", text }], structuredContent: result };
      } catch (error) {
        return dbError(error);
      }
    },
  );

  // ---------------------------------------------------------------------------------
  // The same order as a RESOURCE the user can attach: order://SO-0042. Another company's
  // reference gives exactly the same error as one that doesn't exist.
  server.registerResource(
    "order",
    new ResourceTemplate("order://{order_ref}", { list: undefined }),
    { title: "Order", description: "One order with its lines, as Markdown.", mimeType: "text/markdown" },
    async (uri, variables) => {
      const ref = String(variables.order_ref ?? "").toUpperCase();
      const order = orderRef.safeParse(ref).success ? await loadOrder(forTenant, tenant, ref) : null;
      if (!order) throw new Error(`Resource not found: order://${ref}. Use list_orders to see your company's orders.`);
      const lines = order.lines.map((l) => `- ${l.quantity} × ${l.product} at ${l.unit_price} = ${l.line_total}`);
      const head = `${order.head.order_date}, ${order.head.customer} (${order.head.city})`;
      const text = [`# Order ${ref}`, "", head, "", ...lines].join("\n");
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    },
  );
}

/** One order and its lines, for the company in `tenant`; null if it isn't theirs or doesn't exist. */
async function loadOrder(forTenant: ForTenant, tenant: TenantContext, ref: string) {
  const orgId = tenant.orgId;
  return forTenant(tenant, async (db) => {
    const [head] = await db.query<{ order_id: string; order_date: string; customer: string; email: string; city: string }>(
      `SELECT o.order_id::text AS order_id, to_char(o.order_date, 'YYYY-MM-DD') AS order_date,
              cu.name AS customer, cu.email, cu.city
       FROM orders o
       JOIN customers cu ON cu.org_id = o.org_id AND cu.customer_id = o.customer_id
       WHERE o.org_id = $1 AND o.order_ref = $2`,
      [orgId, ref],
    );
    if (!head) return null;
    const lines = await db.query(
      `SELECT i.line_no, p.name AS product, i.quantity, i.unit_price::float8 AS unit_price,
              round(i.quantity * i.unit_price, 2)::float8 AS line_total
       FROM order_items i
       JOIN products p ON p.org_id = i.org_id AND p.product_id = i.product_id
       WHERE i.org_id = $1 AND i.order_id = $2
       ORDER BY i.line_no`,
      [orgId, head.order_id],
    );
    return { head, lines };
  });
}

type Line = { line_no: number; product: string; quantity: number; unit_price: number; line_total: number };

/**
 * Checks and inserts one order, inside the caller's transaction (forTenant). Returning an
 * {error} BEFORE any insert means nothing was written; any database error after an insert
 * makes forTenant roll the whole order back.
 */
export async function insertOrder(
  db: Db,
  orgId: string,
  email: string,
  items: { product: string; quantity: number }[],
  /** For imports: a set reference and date (the import decides them, so a retry gives the same ones). */
  options: { orderRef?: string; orderDate?: string } = {},
): Promise<
  | { error: string }
  | { order_ref: string; order_date: string; customer: string; lines: Line[]; total: number }
> {
  const [customer] = await db.query<{ customer_id: string; name: string }>(
    `SELECT customer_id::text AS customer_id, name FROM customers WHERE org_id = $1 AND email = $2`,
    [orgId, email],
  );
  if (!customer) {
    return { error: `No customer with email ${email} was found in your company. Check the spelling, or ask which customer they mean.` };
  }

  const products = await db.query<{ product_id: string; name: string }>(
    `SELECT product_id::text AS product_id, name FROM products WHERE org_id = $1 AND lower(name) = ANY($2::text[])`,
    [orgId, items.map((i) => i.product.toLowerCase())],
  );
  const byName = new Map(products.map((p) => [p.name.toLowerCase(), p]));
  const unknown = items.filter((i) => !byName.has(i.product.toLowerCase())).map((i) => `"${i.product}"`);
  if (unknown.length) {
    return { error: `These products aren't in your company's catalog: ${unknown.join(", ")}. Use the exact product names.` };
  }

  // A short random reference; UNIQUE (org_id, order_ref) guards against the rare clash.
  const ref = options.orderRef ?? `WEB-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const [order] = await db.query<{ order_id: string; order_date: string }>(
    `INSERT INTO orders (org_id, order_ref, customer_id, order_date)
     VALUES ($1, $2, $3, coalesce($4::date, CURRENT_DATE))
     RETURNING order_id::text AS order_id, to_char(order_date, 'YYYY-MM-DD') AS order_date`,
    [orgId, ref, customer.customer_id, options.orderDate ?? null],
  );
  if (!order) throw new Error("insert into orders returned no row");

  // Copy today's catalog price into unit_price: the copy on purpose from step 5.
  const lines = await db.query<Line>(
    `INSERT INTO order_items (org_id, order_id, line_no, product_id, quantity, unit_price)
     SELECT $1, $2, x.line_no, p.product_id, x.quantity, p.list_price
     FROM unnest($3::bigint[], $4::int[]) WITH ORDINALITY AS x(product_id, quantity, line_no)
     JOIN products p ON p.org_id = $1 AND p.product_id = x.product_id
     RETURNING line_no, quantity, unit_price::float8 AS unit_price,
               round(quantity * unit_price, 2)::float8 AS line_total,
               (SELECT name FROM products WHERE org_id = $1 AND product_id = order_items.product_id) AS product`,
    [
      orgId,
      order.order_id,
      items.map((i) => byName.get(i.product.toLowerCase())!.product_id),
      items.map((i) => i.quantity),
    ],
  );
  lines.sort((a, b) => a.line_no - b.line_no);
  const ordered = lines.map(({ line_no, product, quantity, unit_price, line_total }) => ({
    line_no,
    product,
    quantity,
    unit_price,
    line_total,
  }));
  const total = Math.round(ordered.reduce((sum, l) => sum + l.line_total, 0) * 100) / 100;
  return { order_ref: ref, order_date: order.order_date, customer: customer.name, lines: ordered, total };
}
