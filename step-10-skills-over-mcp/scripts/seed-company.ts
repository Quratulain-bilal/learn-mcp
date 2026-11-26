/**
 * Copies the demo company's sample sales data into YOUR company, so your signed-in
 * account has data to ask about.
 *
 *   npm run db:seed -- --org <your company id>
 *   npm run db:seed -- --org <id> --database TENANT_DB_ENTERPRISE   # a dedicated company
 *
 * Seed a company in the database it LIVES in: the shared one by default, or its
 * dedicated one (every tenant database has the demo rows, from the migrations).
 *
 * Find your company id by calling describe_schema in Claude: when your company has no
 * data yet, it tells you the id. Running the seed twice is safe: rows that already exist
 * are skipped (ON CONFLICT DO NOTHING).
 *
 * The ids stay the same as the demo's. That's fine, because every key starts with
 * org_id: (your-company, 1) and (demo, 1) are different rows.
 */
import pg from "pg";
import { ownerUrlFor } from "./env";

const DEMO = "demo";

async function main() {
  const orgIndex = process.argv.indexOf("--org");
  const orgId = orgIndex > 0 ? process.argv[orgIndex + 1] : undefined;
  if (!orgId || !/^[A-Za-z0-9_-]{1,64}$/.test(orgId) || orgId === DEMO) {
    console.error("Usage: npm run db:seed -- --org <your company id>");
    process.exit(1);
  }

  // Parents before children, so every foreign key finds its row. $1 = your company.
  const copies: [string, string][] = [
    ["categories", `INSERT INTO categories (org_id, category_id, name)
       SELECT $1, category_id, name FROM categories WHERE org_id = $2
       ON CONFLICT DO NOTHING`],
    ["products", `INSERT INTO products (org_id, product_id, category_id, name, list_price,
                            description, description_embedding, description_embedder)
       SELECT $1, product_id, category_id, name, list_price, description, description_embedding, description_embedder
       FROM products WHERE org_id = $2
       ON CONFLICT DO NOTHING`],
    ["customers", `INSERT INTO customers (org_id, customer_id, name, email, city)
       SELECT $1, customer_id, name, email, city FROM customers WHERE org_id = $2
       ON CONFLICT DO NOTHING`],
    ["orders", `INSERT INTO orders (org_id, order_id, order_ref, customer_id, order_date)
       SELECT $1, order_id, order_ref, customer_id, order_date FROM orders WHERE org_id = $2
       ON CONFLICT DO NOTHING`],
    ["order_items", `INSERT INTO order_items (org_id, order_id, line_no, product_id, quantity, unit_price)
       SELECT $1, order_id, line_no, product_id, quantity, unit_price FROM order_items WHERE org_id = $2
       ON CONFLICT DO NOTHING`],
    // The flat sheet too, so compare_designs has something to compare. It has no natural
    // key, so it's copied only if the company has none of it yet.
    ["flat_sales", `INSERT INTO staging.flat_sales
         (org_id, order_ref, order_date, customer_name, customer_email, customer_city, products, category, unit_price, quantity)
       SELECT $1, order_ref, order_date, customer_name, customer_email, customer_city, products, category, unit_price, quantity
       FROM staging.flat_sales
       WHERE org_id = $2 AND NOT EXISTS (SELECT 1 FROM staging.flat_sales WHERE org_id = $1)
       ORDER BY line_id`],
  ];

  const dbIndex = process.argv.indexOf("--database");
  const binding = dbIndex > 0 ? (process.argv[dbIndex + 1] ?? "") : "HYPERDRIVE";
  const client = new pg.Client({ connectionString: ownerUrlFor(binding) });
  await client.connect();
  try {
    await client.query("BEGIN");
    console.log(`Seeding company ${orgId}:`);
    for (const [table, sql] of copies) {
      const result = await client.query(sql, [orgId, DEMO]);
      console.log(`  ${table.padEnd(12)} ${result.rowCount} new rows`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Seeding failed, nothing was changed:\n", error.message ?? error);
  process.exit(1);
});
