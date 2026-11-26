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

export interface SqlClient {
  query<T>(text: string, params?: unknown[]): Promise<readonly T[]>;
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

export function createNeonSalesStore(sql: SqlClient): SalesStore {
  return {
    async describeSchema() {
      const columns = await sql.query<{
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

      const keys = await sql.query<{
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

      const tables = new Map<string, {
        schema: string;
        name: string;
        columns: Array<{ name: string; type: string; nullable: boolean }>;
        keys: Array<{ type: string; columns: string[] }>;
      }>();
      for (const row of columns) {
        const id = `${row.table_schema}.${row.table_name}`;
        const table = tables.get(id) ?? {
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
      const rows = await sql.query<Record<string, unknown>>(NORMALIZED_SQL[question], [orgId]);
      return { question, rows };
    },

    async compare(orgId, question) {
      const flat = await sql.query<Record<string, unknown>>(FLAT_SQL[question], [orgId]);
      const normalized = await sql.query<Record<string, unknown>>(NORMALIZED_SQL[question], [orgId]);
      return {
        question,
        flat,
        normalized,
        anomalies: [
          "A customer can appear with two cities in staging.flat_sales; the normalized customers table stores one city per customer.",
          "A product name and price are repeated on every order line; products stores the catalog price once and order_items keeps the sale price on purpose.",
          "Deleting the last order line in the flat table deletes the only copy of the customer and product details; the normalized tables keep those facts."
        ]
      };
    }
  };
}
