import { readFile } from "node:fs/promises";
import path from "node:path";
import { neon } from "@neondatabase/serverless";

interface FlatRow {
  order_id: string;
  order_line: number | string;
  order_date: string;
  customer_name: string;
  customer_email: string;
  customer_city: string;
  product_names: string;
  category: string;
  unit_price: string | number;
  quantity: number | string;
}

interface CustomerRow {
  customer_id: string;
  name: string;
  email: string;
  city: string;
}

interface CategoryRow {
  category_id: string;
  name: string;
}

interface ProductRow {
  product_id: string;
  name: string;
  category_id: string;
  catalog_price: string | number;
}

interface OrderRow {
  order_id: string;
  customer_id: string;
  order_date: string;
}

interface ItemRow {
  order_id: string;
  line_no: number | string;
  product_id: string;
  unit_price: string | number;
  quantity: number | string;
}

async function getConnectionString() {
  if (process.env.NEON_DATABASE_URL) return process.env.NEON_DATABASE_URL;
  const localVars = await readFile(path.join(process.cwd(), ".dev.vars"), "utf8");
  const line = localVars
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("NEON_DATABASE_URL="));
  return line?.slice("NEON_DATABASE_URL=".length).trim();
}

const connectionString = await getConnectionString();
const orgId = process.argv[2];

if (!connectionString) {
  throw new Error("Set NEON_DATABASE_URL before running npm run seed.");
}
if (!orgId) {
  throw new Error("Usage: npm run seed -- <your-org-id>");
}

const sql = neon(connectionString);
const demo = "demo-company";

const readResults = await sql.transaction((txn) => [
  txn.query("SELECT set_config('app.tenant_id', $1, true)", [demo]),
  txn.query<FlatRow>(
    "SELECT order_id, order_line, order_date, customer_name, customer_email, customer_city, product_names, category, unit_price, quantity FROM staging.flat_sales WHERE org_id = $1 ORDER BY order_id, order_line",
    [demo],
  ),
  txn.query<CustomerRow>(
    "SELECT customer_id, name, email, city FROM customers WHERE org_id = $1 ORDER BY customer_id",
    [demo],
  ),
  txn.query<CategoryRow>(
    "SELECT category_id, name FROM categories WHERE org_id = $1 ORDER BY category_id",
    [demo],
  ),
  txn.query<ProductRow>(
    "SELECT product_id, name, category_id, catalog_price FROM products WHERE org_id = $1 ORDER BY product_id",
    [demo],
  ),
  txn.query<OrderRow>(
    "SELECT order_id, customer_id, order_date FROM orders WHERE org_id = $1 ORDER BY order_id",
    [demo],
  ),
  txn.query<ItemRow>(
    "SELECT order_id, line_no, product_id, unit_price, quantity FROM order_items WHERE org_id = $1 ORDER BY order_id, line_no",
    [demo],
  ),
]);

const flat = readResults[1] ?? [];
const customers = readResults[2] ?? [];
const categories = readResults[3] ?? [];
const products = readResults[4] ?? [];
const orders = readResults[5] ?? [];
const items = readResults[6] ?? [];

await sql.transaction((txn) => {
  const queries = [
    txn.query("SELECT set_config('app.tenant_id', $1, true)", [orgId]),
    txn.query("DELETE FROM staging.flat_sales WHERE org_id = $1", [orgId]),
    txn.query("DELETE FROM order_items WHERE org_id = $1", [orgId]),
    txn.query("DELETE FROM orders WHERE org_id = $1", [orgId]),
    txn.query("DELETE FROM products WHERE org_id = $1", [orgId]),
    txn.query("DELETE FROM categories WHERE org_id = $1", [orgId]),
    txn.query("DELETE FROM customers WHERE org_id = $1", [orgId]),
  ];
  for (const row of flat) {
    queries.push(txn.query(
      `INSERT INTO staging.flat_sales (
        org_id, order_id, order_line, order_date, customer_name, customer_email,
        customer_city, product_names, category, unit_price, quantity
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT DO NOTHING`,
      [orgId, row.order_id, row.order_line, row.order_date, row.customer_name, row.customer_email, row.customer_city, row.product_names, row.category, row.unit_price, row.quantity],
    ));
  }
  for (const row of customers) {
    queries.push(txn.query(
      "INSERT INTO customers (org_id, customer_id, name, email, city) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
      [orgId, row.customer_id, row.name, row.email, row.city],
    ));
  }
  for (const row of categories) {
    queries.push(txn.query(
      "INSERT INTO categories (org_id, category_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [orgId, row.category_id, row.name],
    ));
  }
  for (const row of products) {
    queries.push(txn.query(
      "INSERT INTO products (org_id, product_id, name, category_id, catalog_price) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
      [orgId, row.product_id, row.name, row.category_id, row.catalog_price],
    ));
  }
  for (const row of orders) {
    queries.push(txn.query(
      "INSERT INTO orders (org_id, order_id, customer_id, order_date) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [orgId, row.order_id, row.customer_id, row.order_date],
    ));
  }
  for (const row of items) {
    queries.push(txn.query(
      "INSERT INTO order_items (org_id, order_id, line_no, product_id, unit_price, quantity) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING",
      [orgId, row.order_id, row.line_no, row.product_id, row.unit_price, row.quantity],
    ));
  }
  return queries;
});

console.log(`Seeded sales data into ${orgId}`);
