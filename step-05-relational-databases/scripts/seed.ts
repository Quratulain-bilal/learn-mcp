import { neon } from "@neondatabase/serverless";

const connectionString = process.env.NEON_DATABASE_URL;
const orgId = process.argv[2];

if (!connectionString) {
  throw new Error("Set NEON_DATABASE_URL before running npm run seed.");
}
if (!orgId) {
  throw new Error("Usage: npm run seed -- <your-org-id>");
}

const sql = neon(connectionString);
const demo = "demo-company";

const statements: Array<[string, unknown[]]> = [
  ["DELETE FROM staging.flat_sales WHERE org_id = $1", [orgId]],
  ["DELETE FROM order_items WHERE org_id = $1", [orgId]],
  ["DELETE FROM orders WHERE org_id = $1", [orgId]],
  ["DELETE FROM products WHERE org_id = $1", [orgId]],
  ["DELETE FROM categories WHERE org_id = $1", [orgId]],
  ["DELETE FROM customers WHERE org_id = $1", [orgId]],
  [
    `INSERT INTO staging.flat_sales (
      org_id, order_id, order_line, order_date, customer_name, customer_email,
      customer_city, product_names, category, unit_price, quantity
    )
    SELECT $1, order_id, order_line, order_date, customer_name, customer_email,
           customer_city, product_names, category, unit_price, quantity
    FROM staging.flat_sales WHERE org_id = $2`,
    [orgId, demo],
  ],
  [
    `INSERT INTO customers (org_id, customer_id, name, email, city)
     SELECT $1, customer_id, name, email, city FROM customers WHERE org_id = $2`,
    [orgId, demo],
  ],
  [
    `INSERT INTO categories (org_id, category_id, name)
     SELECT $1, category_id, name FROM categories WHERE org_id = $2`,
    [orgId, demo],
  ],
  [
    `INSERT INTO products (org_id, product_id, name, category_id, catalog_price)
     SELECT $1, product_id, name, category_id, catalog_price FROM products WHERE org_id = $2`,
    [orgId, demo],
  ],
  [
    `INSERT INTO orders (org_id, order_id, customer_id, order_date)
     SELECT $1, order_id, customer_id, order_date FROM orders WHERE org_id = $2`,
    [orgId, demo],
  ],
  [
    `INSERT INTO order_items (org_id, order_id, line_no, product_id, unit_price, quantity)
     SELECT $1, order_id, line_no, product_id, unit_price, quantity
     FROM order_items WHERE org_id = $2`,
    [orgId, demo],
  ],
];

for (const [statement, params] of statements) {
  await sql.query(statement, params);
}

console.log(`Seeded sales data into ${orgId}`);
