import type { SqlClient } from "./db-client";
import { forTenant } from "./tenant";

export const BUSINESS_QUESTIONS = [
  "monthly_revenue",
  "top_products",
  "best_customers",
  "orders_by_city",
  "catalog_size",
  "revenue_by_category",
  "average_order_value",
  "units_sold",
  "customers_per_city",
  "monthly_orders"
] as const;

export type BusinessQuestion = (typeof BUSINESS_QUESTIONS)[number];
export type SummaryGroupBy = "month" | "product" | "customer";

export interface ListOrdersInput {
  from?: string;
  to?: string;
  customerId?: string;
  productId?: string;
  cursor?: string;
  limit?: number;
}

export interface CreateOrderItemInput {
  productId: string;
  quantity: number;
}

export interface CreateOrderInput {
  orderId: string;
  customerId: string;
  orderDate: string;
  items: readonly CreateOrderItemInput[];
}

export interface SalesStore {
  describeSchema(): Promise<{
    tables: Array<{
      schema: string;
      name: string;
      columns: Array<{ name: string; type: string; nullable: boolean }>;
      keys: Array<{ type: string; columns: string[] }>;
    }>;
  }>;
  answer(orgId: string, question: BusinessQuestion): Promise<{
    question: BusinessQuestion;
    rows: readonly Record<string, unknown>[];
  }>;
  compare(orgId: string, question: BusinessQuestion): Promise<{
    question: BusinessQuestion;
    flat: readonly Record<string, unknown>[];
    normalized: readonly Record<string, unknown>[];
    anomalies: string[];
  }>;
  listOrders(orgId: string, input: ListOrdersInput): Promise<{
    orders: readonly Record<string, unknown>[];
    nextCursor: string | null;
  }>;
  getSalesSummary(orgId: string, groupBy: SummaryGroupBy): Promise<{
    groupBy: SummaryGroupBy;
    rows: readonly Record<string, unknown>[];
  }>;
  createOrder(orgId: string, input: CreateOrderInput): Promise<{
    orderId: string;
    itemCount: number;
    total: string;
  }>;
}

const NORMALIZED_SQL: Record<BusinessQuestion, string> = {
  monthly_revenue: `SELECT to_char(date_trunc('month', o.order_date), 'YYYY-MM') AS month,
    SUM(oi.unit_price * oi.quantity)::numeric(12,2) AS revenue
    FROM orders o JOIN order_items oi ON oi.org_id = o.org_id AND oi.order_id = o.order_id
    WHERE o.org_id = $1 GROUP BY 1 ORDER BY 1`,
  top_products: `SELECT p.name AS product, SUM(oi.quantity) AS units,
    SUM(oi.unit_price * oi.quantity)::numeric(12,2) AS revenue
    FROM order_items oi JOIN products p ON p.org_id = oi.org_id AND p.product_id = oi.product_id
    WHERE oi.org_id = $1 GROUP BY p.name ORDER BY revenue DESC, units DESC LIMIT 5`,
  best_customers: `SELECT c.name AS customer, SUM(oi.unit_price * oi.quantity)::numeric(12,2) AS revenue
    FROM orders o JOIN customers c ON c.org_id = o.org_id AND c.customer_id = o.customer_id
    JOIN order_items oi ON oi.org_id = o.org_id AND oi.order_id = o.order_id
    WHERE o.org_id = $1 GROUP BY c.name ORDER BY revenue DESC LIMIT 5`,
  orders_by_city: `SELECT c.city, COUNT(DISTINCT o.order_id) AS orders
    FROM orders o JOIN customers c ON c.org_id = o.org_id AND c.customer_id = o.customer_id
    WHERE o.org_id = $1 GROUP BY c.city ORDER BY orders DESC, c.city`,
  catalog_size: `SELECT cat.name AS category, COUNT(*) AS products
    FROM products p JOIN categories cat ON cat.org_id = p.org_id AND cat.category_id = p.category_id
    WHERE p.org_id = $1 GROUP BY cat.name ORDER BY products DESC, cat.name`,
  revenue_by_category: `SELECT cat.name AS category,
    SUM(oi.unit_price * oi.quantity)::numeric(12,2) AS revenue
    FROM order_items oi
    JOIN products p ON p.org_id = oi.org_id AND p.product_id = oi.product_id
    JOIN categories cat ON cat.org_id = p.org_id AND cat.category_id = p.category_id
    WHERE oi.org_id = $1 GROUP BY cat.name ORDER BY revenue DESC`,
  average_order_value: `SELECT ROUND(AVG(order_total), 2) AS average_order_value FROM (
    SELECT o.order_id, SUM(oi.unit_price * oi.quantity) AS order_total
    FROM orders o JOIN order_items oi ON oi.org_id = o.org_id AND oi.order_id = o.order_id
    WHERE o.org_id = $1 GROUP BY o.order_id
  ) t`,
  units_sold: `SELECT COALESCE(SUM(quantity), 0) AS units FROM order_items WHERE org_id = $1`,
  customers_per_city: `SELECT city, COUNT(*) AS customers FROM customers
    WHERE org_id = $1 GROUP BY city ORDER BY customers DESC, city`,
  monthly_orders: `SELECT to_char(date_trunc('month', order_date), 'YYYY-MM') AS month,
    COUNT(*) AS orders FROM orders WHERE org_id = $1 GROUP BY 1 ORDER BY 1`
};

const FLAT_SQL: Record<BusinessQuestion, string> = {
  monthly_revenue: `SELECT to_char(date_trunc('month', order_date), 'YYYY-MM') AS month,
    SUM(unit_price * quantity)::numeric(12,2) AS revenue
    FROM staging.flat_sales WHERE org_id = $1 GROUP BY 1 ORDER BY 1`,
  top_products: `SELECT trim(product) AS product, SUM(quantity) AS units,
    SUM(unit_price * quantity)::numeric(12,2) AS revenue
    FROM staging.flat_sales, unnest(string_to_array(product_names, ',')) product
    WHERE org_id = $1 GROUP BY trim(product) ORDER BY revenue DESC, units DESC LIMIT 5`,
  best_customers: `SELECT customer_name AS customer,
    SUM(unit_price * quantity)::numeric(12,2) AS revenue
    FROM staging.flat_sales WHERE org_id = $1 GROUP BY customer_name ORDER BY revenue DESC LIMIT 5`,
  orders_by_city: `SELECT customer_city AS city, COUNT(DISTINCT order_id) AS orders
    FROM staging.flat_sales WHERE org_id = $1 GROUP BY customer_city ORDER BY orders DESC, city`,
  catalog_size: `SELECT category, COUNT(DISTINCT product_names) AS products
    FROM staging.flat_sales WHERE org_id = $1 GROUP BY category ORDER BY products DESC, category`,
  revenue_by_category: `SELECT category, SUM(unit_price * quantity)::numeric(12,2) AS revenue
    FROM staging.flat_sales WHERE org_id = $1 GROUP BY category ORDER BY revenue DESC`,
  average_order_value: `SELECT ROUND(AVG(order_total), 2) AS average_order_value FROM (
    SELECT order_id, SUM(unit_price * quantity) AS order_total
    FROM staging.flat_sales WHERE org_id = $1 GROUP BY order_id
  ) t`,
  units_sold: `SELECT COALESCE(SUM(quantity), 0) AS units FROM staging.flat_sales WHERE org_id = $1`,
  customers_per_city: `SELECT customer_city AS city, COUNT(DISTINCT customer_email) AS customers
    FROM staging.flat_sales WHERE org_id = $1 GROUP BY customer_city ORDER BY customers DESC, city`,
  monthly_orders: `SELECT to_char(date_trunc('month', order_date), 'YYYY-MM') AS month,
    COUNT(DISTINCT order_id) AS orders FROM staging.flat_sales
    WHERE org_id = $1 GROUP BY 1 ORDER BY 1`
};

const LIST_ORDERS_SQL = `SELECT o.org_id, o.order_id, o.order_date::text AS order_date,
    c.name AS customer, COUNT(oi.line_no)::int AS item_count,
    SUM(oi.unit_price * oi.quantity)::numeric(12,2) AS total
  FROM orders o
  JOIN customers c ON c.org_id = o.org_id AND c.customer_id = o.customer_id
  JOIN order_items oi ON oi.org_id = o.org_id AND oi.order_id = o.order_id
  WHERE o.org_id = $1
    AND ($2::date IS NULL OR o.order_date >= $2::date)
    AND ($3::date IS NULL OR o.order_date <= $3::date)
    AND ($4::text IS NULL OR o.customer_id = $4)
    AND ($5::text IS NULL OR EXISTS (
      SELECT 1 FROM order_items line
      WHERE line.org_id = o.org_id AND line.order_id = o.order_id AND line.product_id = $5
    ))
  GROUP BY o.org_id, o.order_id, o.order_date, c.name
  ORDER BY o.order_date DESC, o.order_id DESC
  LIMIT $6 OFFSET $7`;

const SUMMARY_SQL: Record<SummaryGroupBy, string> = {
  month: `SELECT $1::text AS org_id, to_char(date_trunc('month', o.order_date), 'YYYY-MM') AS label,
    COUNT(DISTINCT o.order_id)::int AS orders,
    SUM(oi.unit_price * oi.quantity)::numeric(12,2) AS total
    FROM orders o JOIN order_items oi ON oi.org_id = o.org_id AND oi.order_id = o.order_id
    WHERE o.org_id = $1 GROUP BY 1, 2 ORDER BY 2`,
  product: `SELECT $1::text AS org_id, p.name AS label, SUM(oi.quantity)::int AS units,
    SUM(oi.unit_price * oi.quantity)::numeric(12,2) AS total
    FROM order_items oi JOIN products p ON p.org_id = oi.org_id AND p.product_id = oi.product_id
    WHERE oi.org_id = $1 GROUP BY 1, 2 ORDER BY total DESC, label LIMIT 20`,
  customer: `SELECT $1::text AS org_id, c.name AS label, COUNT(DISTINCT o.order_id)::int AS orders,
    SUM(oi.unit_price * oi.quantity)::numeric(12,2) AS total
    FROM orders o JOIN customers c ON c.org_id = o.org_id AND c.customer_id = o.customer_id
    JOIN order_items oi ON oi.org_id = o.org_id AND oi.order_id = o.order_id
    WHERE o.org_id = $1 GROUP BY 1, 2 ORDER BY total DESC, label LIMIT 20`
};

const CREATE_ORDER_SQL = `WITH requested AS (
    SELECT product_id, quantity
    FROM unnest($2::text[], $3::integer[]) AS requested(product_id, quantity)
  ),
  prices AS (
    SELECT p.product_id, p.catalog_price
    FROM products p JOIN requested r ON r.product_id = p.product_id
    WHERE p.org_id = $1
  ),
  customer_exists AS (
    SELECT 1 AS ok FROM customers WHERE org_id = $1 AND customer_id = $4
  ),
  inserted_order AS (
    INSERT INTO orders (org_id, order_id, customer_id, order_date)
    SELECT $1, $5, $4, $6::date
    WHERE EXISTS (SELECT 1 FROM customer_exists)
      AND (SELECT count(*) FROM prices) = (SELECT count(*) FROM requested)
    ON CONFLICT (org_id, order_id) DO NOTHING
    RETURNING order_id
  ),
  inserted_items AS (
    INSERT INTO order_items (org_id, order_id, line_no, product_id, unit_price, quantity)
    SELECT $1, $5, row_number() OVER (ORDER BY r.product_id)::integer,
           p.product_id, p.catalog_price, r.quantity
    FROM requested r JOIN prices p ON p.product_id = r.product_id
    WHERE EXISTS (SELECT 1 FROM inserted_order)
    ON CONFLICT (org_id, order_id, line_no) DO NOTHING
    RETURNING line_no
  )
  SELECT
    (SELECT count(*)::int FROM prices) AS matched_products,
    (SELECT count(*)::int FROM requested) AS requested_products,
    (SELECT count(*)::int FROM customer_exists) AS customer_exists,
    (SELECT count(*)::int FROM inserted_order) AS inserted_order,
    (SELECT count(*)::int FROM inserted_items) AS inserted_items,
    (SELECT SUM(p.catalog_price * r.quantity)::numeric(12,2)
      FROM prices p JOIN requested r ON r.product_id = p.product_id) AS total`;

function cursorOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) {
    throw new Error("Invalid cursor.");
  }
  return offset;
}

export function createNeonSalesStore(sql: SqlClient): SalesStore {
  const query = <T>(text: string, params?: readonly unknown[]) => sql.query<T>(text, params);
  return {
    async describeSchema() {
      const columns = await query<{
        table_schema: string;
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(`SELECT table_schema, table_name, column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE (table_schema = 'public' AND table_name IN ('customers','categories','products','orders','order_items'))
           OR (table_schema = 'staging' AND table_name = 'flat_sales')
        ORDER BY table_schema, table_name, ordinal_position`);

      const keys = await query<{
        table_schema: string;
        table_name: string;
        constraint_type: string;
        column_name: string;
      }>(`SELECT tc.table_schema, tc.table_name, tc.constraint_type, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_catalog = kcu.constraint_catalog
         AND tc.constraint_schema = kcu.constraint_schema
         AND tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE (tc.table_schema = 'public' AND tc.table_name IN ('customers','categories','products','orders','order_items'))
           OR (tc.table_schema = 'staging' AND tc.table_name = 'flat_sales')
        ORDER BY tc.table_schema, tc.table_name, tc.constraint_type, kcu.ordinal_position`);

      type SchemaTable = {
        schema: string;
        name: string;
        columns: Array<{ name: string; type: string; nullable: boolean }>;
        keys: Array<{ type: string; columns: string[] }>;
      };
      const tables = new Map<string, SchemaTable>();
      for (const row of columns) {
        const id = `${row.table_schema}.${row.table_name}`;
        const table: SchemaTable = tables.get(id) ?? {
          schema: row.table_schema,
          name: row.table_name,
          columns: [],
          keys: []
        };
        table.columns.push({
          name: row.column_name,
          type: row.data_type,
          nullable: row.is_nullable === "YES"
        });
        tables.set(id, table);
      }
      for (const row of keys) {
        const id = `${row.table_schema}.${row.table_name}`;
        const table = tables.get(id);
        if (!table) continue;
        let key = table.keys.find((item) => item.type === row.constraint_type);
        if (!key) {
          key = { type: row.constraint_type, columns: [] };
          table.keys.push(key);
        }
        key.columns.push(row.column_name);
      }
      return { tables: [...tables.values()] };
    },

    async answer(orgId, question) {
      const results = await forTenant<Record<string, unknown>>(sql, orgId, (txn) => [
        txn.query(NORMALIZED_SQL[question], [orgId]),
      ]);
      return { question, rows: results[0] ?? [] };
    },

    async compare(orgId, question) {
      const results = await forTenant<Record<string, unknown>>(sql, orgId, (txn) => [
        txn.query(FLAT_SQL[question], [orgId]),
        txn.query(NORMALIZED_SQL[question], [orgId]),
      ]);
      return {
        question,
        flat: results[0] ?? [],
        normalized: results[1] ?? [],
        anomalies: [
          "A customer can appear with two cities in staging.flat_sales; the normalized customers table stores one city per customer.",
          "A product name and price are repeated on every order line; products stores the catalog price once and order_items keeps the sale price on purpose.",
          "Deleting the last order line in the flat table deletes the only copy of the customer and product details; the normalized tables keep those facts."
        ]
      };
    },

    async listOrders(orgId, input) {
      const limit = input.limit ?? 20;
      const offset = cursorOffset(input.cursor);
      const results = await forTenant<Record<string, unknown>>(sql, orgId, (txn) => [
        txn.query(LIST_ORDERS_SQL, [
          orgId,
          input.from ?? null,
          input.to ?? null,
          input.customerId ?? null,
          input.productId ?? null,
          limit + 1,
          offset,
        ]),
      ]);
      const rows = results[0] ?? [];
      const hasMore = rows.length > limit;
      return {
        orders: hasMore ? rows.slice(0, limit) : rows,
        nextCursor: hasMore ? String(offset + limit) : null,
      };
    },

    async getSalesSummary(orgId, groupBy) {
      const results = await forTenant<Record<string, unknown>>(sql, orgId, (txn) => [
        txn.query(SUMMARY_SQL[groupBy], [orgId]),
      ]);
      return { groupBy, rows: results[0] ?? [] };
    },

    async createOrder(orgId, input) {
      const results = await forTenant<{
        matched_products: string | number;
        requested_products: string | number;
        customer_exists: string | number;
        inserted_order: string | number;
        inserted_items: string | number;
        total: string | null;
      }>(sql, orgId, (txn) => [
        txn.query(CREATE_ORDER_SQL, [
          orgId,
          input.items.map((item) => item.productId),
          input.items.map((item) => item.quantity),
          input.customerId,
          input.orderId,
          input.orderDate,
        ]),
      ]);
      const row = results[0]?.[0];
      if (!row) throw new Error("Create order did not return a result.");
      const matched = Number(row.matched_products);
      const requested = Number(row.requested_products);
      const insertedOrder = Number(row.inserted_order);
      const insertedItems = Number(row.inserted_items);
      if (Number(row.customer_exists) !== 1) {
        throw new Error("Customer not found in your company.");
      }
      if (matched !== requested) {
        throw new Error("One or more products were not found in your company.");
      }
      if (insertedOrder !== 1 || insertedItems !== requested) {
        throw new Error("Order was not created. Check the order id and items.");
      }
      return {
        orderId: input.orderId,
        itemCount: insertedItems,
        total: row.total ?? "0.00",
      };
    },
  };
}
