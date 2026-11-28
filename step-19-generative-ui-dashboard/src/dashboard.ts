import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import type { Db, ForTenant, Row } from "./db";
import type { SettingsStore } from "./settings";
import type { TenantContext } from "./tenant";
import { READ_ONLY, dbError, markdownTable, untrusted } from "./tool-helpers";
import { WIDGETS } from "./widgets/resources";

/**
 * GENERATIVE UI, rung two of book lesson 20.10's ladder: the model COMPOSES a screen from
 * APPROVED PARTS. It never writes HTML. It answers the user's intent with a short spec,
 *
 *   { title: "March at a glance", blocks: [ {type:"kpi", metric:"revenue", ...},
 *                                           {type:"chart", group_by:"product", ...},
 *                                           {type:"table", ...} ] }
 *
 * and this tool checks the spec against a strict schema, fetches every block's data for
 * the caller's company (forTenant + row-level security), and returns it to ONE dashboard
 * widget, which renders each block with the matching component from the widget library.
 *
 * Why parts and not free HTML: every part is reviewed, themed, accessible and escapes its
 * data; the model can't invent a screen that leaks, misleads or breaks. Why parts and not
 * one fixed screen: "how did March go", "who should I call", and "is the shop healthy"
 * want different screens, and the model is good at choosing.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const range = { from: isoDate.optional(), to: isoDate.optional() };

export const KPI_METRICS = ["revenue", "orders", "average_order_value", "customers", "top_product", "top_customer"] as const;

const kpiBlock = z.object({
  type: z.literal("kpi"),
  metrics: z.array(z.enum(KPI_METRICS)).min(1).max(4).describe("1-4 headline numbers, shown as cards in a row."),
  ...range,
  compare_previous: z
    .boolean()
    .default(false)
    .describe("Also show the change against the period of the same length just before (needs from and to)."),
});
const chartBlock = z.object({
  type: z.literal("chart"),
  group_by: z.enum(["month", "product", "customer"]),
  ...range,
  limit: z.number().int().min(1).max(12).default(8),
});
const tableBlock = z.object({
  type: z.literal("table"),
  customer: z.string().trim().min(2).max(80).optional(),
  product: z.string().trim().min(2).max(80).optional(),
  ...range,
  limit: z.number().int().min(1).max(20).default(10),
});
const reportBlock = z.object({
  type: z.literal("report"),
  year: z.number().int().min(2000).max(2100).describe("Shows the latest saved report for this year (from start_sales_report)."),
});

export const blockSchema = z.discriminatedUnion("type", [kpiBlock, chartBlock, tableBlock, reportBlock]);
export type BlockSpec = z.infer<typeof blockSchema>;

const IN_RANGE = `($2::date IS NULL OR o.order_date >= $2::date) AND ($3::date IS NULL OR o.order_date <= $3::date)`;

/** The headline numbers for one period. */
async function kpis(db: Db, orgId: string, from: string | null, to: string | null) {
  const [totals] = await db.query<{ revenue: number; orders: number; customers: number }>(
    `SELECT coalesce(round(sum(i.quantity * i.unit_price), 2), 0)::float8 AS revenue,
            count(DISTINCT o.order_id)::int AS orders, count(DISTINCT o.customer_id)::int AS customers
     FROM orders o JOIN order_items i ON i.org_id = o.org_id AND i.order_id = o.order_id
     WHERE o.org_id = $1 AND ${IN_RANGE}`,
    [orgId, from, to],
  );
  const [topProduct] = await db.query<{ name: string; revenue: number }>(
    `SELECT p.name, round(sum(i.quantity * i.unit_price), 2)::float8 AS revenue
     FROM orders o JOIN order_items i ON i.org_id = o.org_id AND i.order_id = o.order_id
     JOIN products p ON p.org_id = i.org_id AND p.product_id = i.product_id
     WHERE o.org_id = $1 AND ${IN_RANGE} GROUP BY p.name ORDER BY revenue DESC LIMIT 1`,
    [orgId, from, to],
  );
  const [topCustomer] = await db.query<{ name: string; revenue: number }>(
    `SELECT cu.name, round(sum(i.quantity * i.unit_price), 2)::float8 AS revenue
     FROM orders o JOIN order_items i ON i.org_id = o.org_id AND i.order_id = o.order_id
     JOIN customers cu ON cu.org_id = o.org_id AND cu.customer_id = o.customer_id
     WHERE o.org_id = $1 AND ${IN_RANGE} GROUP BY cu.name ORDER BY revenue DESC LIMIT 1`,
    [orgId, from, to],
  );
  const t = totals ?? { revenue: 0, orders: 0, customers: 0 };
  return {
    revenue: t.revenue,
    orders: t.orders,
    customers: t.customers,
    average_order_value: t.orders ? Math.round((t.revenue / t.orders) * 100) / 100 : 0,
    top_product: topProduct?.name ?? null,
    top_customer: topCustomer?.name ?? null,
  };
}

/** The same number of days just before [from, to]. */
function previousPeriod(from: string, to: string): [string, string] {
  const day = 86_400_000;
  const start = Date.parse(from);
  const end = Date.parse(to);
  const prevEnd = new Date(start - day);
  const prevStart = new Date(start - day - (end - start));
  return [prevStart.toISOString().slice(0, 10), prevEnd.toISOString().slice(0, 10)];
}

/** Fetches one block's data. Every query is scoped to the company ($1) and runs under RLS. */
async function loadBlock(db: Db, orgId: string, b: BlockSpec, currency: string, threshold: number) {
  if (b.type === "kpi") {
    const now = await kpis(db, orgId, b.from ?? null, b.to ?? null);
    let previous: Awaited<ReturnType<typeof kpis>> | null = null;
    if (b.compare_previous && b.from && b.to) previous = await kpis(db, orgId, ...previousPeriod(b.from, b.to));
    return {
      type: "kpi" as const,
      range: { from: b.from ?? null, to: b.to ?? null },
      currency,
      cards: b.metrics.map((m) => ({
        metric: m,
        value: now[m],
        previous: previous ? previous[m] : null,
      })),
    };
  }
  if (b.type === "chart") {
    const label = { month: "to_char(date_trunc('month', o.order_date), 'YYYY-MM')", product: "p.name", customer: "cu.name" }[b.group_by];
    const order = b.group_by === "month" ? "1" : "revenue DESC, 1";
    const groups = await db.query<Row>(
      `SELECT ${label} AS label, count(DISTINCT o.order_id)::int AS orders,
              round(sum(i.quantity * i.unit_price), 2)::float8 AS revenue
       FROM orders o
       JOIN customers cu  ON cu.org_id = o.org_id AND cu.customer_id = o.customer_id
       JOIN order_items i ON i.org_id = o.org_id AND i.order_id = o.order_id
       JOIN products p    ON p.org_id = i.org_id AND p.product_id = i.product_id
       WHERE o.org_id = $1 AND ${IN_RANGE}
       GROUP BY 1 ORDER BY ${order} LIMIT $4`,
      [orgId, b.from ?? null, b.to ?? null, b.limit],
    );
    return {
      type: "chart" as const,
      group_by: b.group_by,
      range: { from: b.from ?? null, to: b.to ?? null },
      currency,
      threshold,
      groups: groups.map((g) => ({ label: String(g.label), orders: Number(g.orders), revenue: Number(g.revenue) })),
    };
  }
  if (b.type === "table") {
    const contains = (t?: string) => (t ? `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null);
    const orders = await db.query<Row>(
      `SELECT o.order_ref, to_char(o.order_date, 'YYYY-MM-DD') AS order_date, cu.name AS customer,
              round(sum(i.quantity * i.unit_price), 2)::float8 AS total
       FROM orders o
       JOIN customers cu  ON cu.org_id = o.org_id AND cu.customer_id = o.customer_id
       JOIN order_items i ON i.org_id = o.org_id AND i.order_id = o.order_id
       WHERE o.org_id = $1 AND ${IN_RANGE}
         AND ($4::text IS NULL OR cu.name ILIKE $4 OR cu.email ILIKE $4)
         AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM order_items pi JOIN products p
               ON p.org_id = pi.org_id AND p.product_id = pi.product_id
               WHERE pi.org_id = o.org_id AND pi.order_id = o.order_id AND p.name ILIKE $5))
       GROUP BY o.order_id, o.order_ref, o.order_date, cu.name
       ORDER BY o.order_date DESC, o.order_id DESC LIMIT $6`,
      [orgId, b.from ?? null, b.to ?? null, contains(b.customer), contains(b.product), b.limit],
    );
    return { type: "table" as const, currency, filters: { customer: b.customer ?? null, product: b.product ?? null }, orders };
  }
  const [report] = await db.query<{ report_id: string; stage: string; summary: unknown }>(
    `SELECT report_id, stage, summary FROM reports
     WHERE org_id = $1 AND year = $2 AND summary IS NOT NULL ORDER BY updated_at DESC LIMIT 1`,
    [orgId, b.year],
  );
  return { type: "report" as const, year: b.year, currency, report: report ?? null };
}

export function registerDashboard(
  server: McpServer,
  deps: { forTenant: ForTenant; tenant: TenantContext; settings: SettingsStore },
): void {
  const { forTenant, tenant, settings } = deps;

  registerAppTool(
    server,
    "show_dashboard",
    {
      title: "Show a sales dashboard",
      description:
        "FIRST CHOICE for any question about how the business is doing: a year, quarter, month, date range, overview, " +
        "health check, summary, 'how are we doing', or 'at a glance'. Call this tool before get_sales_summary or " +
        "answer_business_question; it is the only sales tool that renders the dashboard widget in the chat. " +
        "Never answer an overview in prose or in a hand-written table without calling this tool first.\n" +
        "Compose a DASHBOARD from 1-6 approved blocks:\n" +
        "- kpi: 1-4 headline cards (revenue, orders, average_order_value, customers, top_product, top_customer), optionally compared with the previous period\n" +
        "- chart: revenue bars by month, product or customer\n" +
        "- table: the most recent orders, optionally filtered by customer or product\n" +
        "- report: the latest saved yearly report (start_sales_report makes one)\n" +
        "For a whole year use a kpi block with from/to covering the year and a chart grouped by month. " +
        "For one specific list, chart or order only, use list_orders, get_sales_summary or get_order instead.",
      _meta: { ui: { resourceUri: WIDGETS.dashboard } },
      inputSchema: z.object({
        title: z.string().trim().min(3).max(80).describe('What the dashboard answers, e.g. "March 2025 at a glance".'),
        blocks: z.array(blockSchema).min(1).max(6).describe("The blocks, top to bottom."),
      }),
      annotations: READ_ONLY,
    },
    async ({ title, blocks }) => {
      try {
        const { settings: s } = await settings.get(tenant);
        // One transaction for the whole screen: every block sees the same moment's data.
        const loaded = await forTenant(tenant, async (db) => {
          const out = [];
          for (const b of blocks) out.push(await loadBlock(db, tenant.orgId, b, s.currency, s.sales_threshold));
          return out;
        });
        // A text version of the same screen, for clients without widgets and for the model.
        const parts = loaded.map((b) => {
          if (b.type === "kpi") return markdownTable(b.cards.map((c) => ({ metric: c.metric, value: c.value, previous: c.previous })));
          if (b.type === "chart") return `Revenue by ${b.group_by}:\n${markdownTable(b.groups)}`;
          if (b.type === "table") return `Recent orders:\n${markdownTable(b.orders)}`;
          return b.report ? untrusted("records", `Report ${b.year}: ${JSON.stringify(b.report.summary)}`) : `No saved report for ${b.year} yet.`;
        });
        const text = `# ${title}\n\n${parts.join("\n\n")}`;
        return { content: [{ type: "text", text }], structuredContent: { title, blocks: loaded } };
      } catch (error) {
        return dbError(error);
      }
    },
  );
}
