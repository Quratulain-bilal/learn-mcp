import { asOwner } from "./helpers";

/**
 * A tiny company with one row in every business table, planted by the owner role for
 * the isolation and order tests, and removed afterwards. Ids are far above the sample
 * data's, and the order reference names the company (MX-<tag>1).
 */
export async function plantCompany(
  orgId: string,
  tag: string,
  binding = "HYPERDRIVE",
): Promise<{ orderRef: string; email: string }> {
  const orderRef = `MX-${tag}1`;
  const email = `buyer@${tag.toLowerCase()}.example.com`;
  await asOwner(`INSERT INTO categories (org_id, category_id, name) VALUES ($1, 900001, 'Matrix Category')`, [orgId], binding);
  await asOwner(
    `INSERT INTO products (org_id, product_id, category_id, name, list_price) VALUES ($1, 900001, 900001, 'Matrix Product', 10.00)`,
    [orgId],
    binding,
  );
  await asOwner(
    `INSERT INTO customers (org_id, customer_id, name, email, city) VALUES ($1, 900001, $2, $3, 'Testville')`,
    [orgId, `Matrix Buyer ${tag}`, email],
    binding,
  );
  await asOwner(
    `INSERT INTO orders (org_id, order_id, order_ref, customer_id, order_date) VALUES ($1, 900001, $2, 900001, DATE '2025-06-01')`,
    [orgId, orderRef],
    binding,
  );
  await asOwner(
    `INSERT INTO order_items (org_id, order_id, line_no, product_id, quantity, unit_price) VALUES ($1, 900001, 1, 900001, 2, 10.00)`,
    [orgId],
    binding,
  );
  await asOwner(
    `INSERT INTO staging.flat_sales (org_id, order_ref, order_date, customer_name, customer_email, customer_city,
                                     products, category, unit_price, quantity)
     VALUES ($1, $2, DATE '2025-06-01', 'Matrix Buyer', $3, 'Testville', 'Matrix Product', 'Matrix Category', '10.00', '2')`,
    [orgId, orderRef, email],
    binding,
  );
  return { orderRef, email };
}

/** Removes everything a test company has, children first. */
export async function removeCompany(orgId: string, binding = "HYPERDRIVE"): Promise<void> {
  const tables = ["order_items", "orders", "customers", "products", "categories", "staging.flat_sales", "company_settings"];
  for (const table of tables) await asOwner(`DELETE FROM ${table} WHERE org_id = $1`, [orgId], binding);
  // The tenants table lives in the shared database only.
  await asOwner(`DELETE FROM tenants WHERE org_id = $1`, [orgId]);
}

export const uniqueOrg = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}`;
