-- 0006: ROW-LEVEL SECURITY on every business table (book lessons 19.8 and 19.9).
--
-- Until now, only our code kept companies apart: every query says `WHERE org_id = $1`.
-- One forgotten WHERE clause would leak another company's rows. Now Postgres enforces it
-- too, on every query, whatever the SQL says:
--
--   * ENABLE turns row-level security on for the table.
--   * FORCE makes it apply to the table's owner as well, so no role we connect as can
--     skip it by accident. (Neon's owner role has BYPASSRLS, which still skips it; that's
--     why the Worker connects as mcp_connector, which has NOBYPASSRLS.)
--   * USING decides which rows a query may SEE (and update or delete).
--   * WITH CHECK decides which rows a query may WRITE: an insert for another company fails.
--
-- The company comes from the setting app.tenant_id, which forTenant() (src/db.ts) sets
-- for ONE transaction with set_config('app.tenant_id', $1, true). current_setting(..., true)
-- returns NULL (or '' once a transaction has ended) when nothing is set, and
-- `org_id = NULL` is never true, so a query with no company sees NOTHING: it fails closed.

ALTER TABLE customers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers   FORCE  ROW LEVEL SECURITY;
ALTER TABLE categories  ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories  FORCE  ROW LEVEL SECURITY;
ALTER TABLE products    ENABLE ROW LEVEL SECURITY;
ALTER TABLE products    FORCE  ROW LEVEL SECURITY;
ALTER TABLE orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders      FORCE  ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items FORCE  ROW LEVEL SECURITY;
ALTER TABLE staging.flat_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE staging.flat_sales FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON customers TO mcp_connector
  USING      (org_id = current_setting('app.tenant_id', true))
  WITH CHECK (org_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation ON categories TO mcp_connector
  USING      (org_id = current_setting('app.tenant_id', true))
  WITH CHECK (org_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation ON products TO mcp_connector
  USING      (org_id = current_setting('app.tenant_id', true))
  WITH CHECK (org_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation ON orders TO mcp_connector
  USING      (org_id = current_setting('app.tenant_id', true))
  WITH CHECK (org_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation ON order_items TO mcp_connector
  USING      (org_id = current_setting('app.tenant_id', true))
  WITH CHECK (org_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation ON staging.flat_sales TO mcp_connector
  USING      (org_id = current_setting('app.tenant_id', true))
  WITH CHECK (org_id = current_setting('app.tenant_id', true));
