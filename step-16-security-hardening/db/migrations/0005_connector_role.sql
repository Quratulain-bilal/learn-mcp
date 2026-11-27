-- 0005: a LEAST-PRIVILEGE role for the Worker.
--
-- Two roles from now on:
--   * the OWNER role (neondb_owner) runs migrations and scripts. It owns the tables and,
--     on Neon, has BYPASSRLS, so the Worker must NEVER connect as it.
--   * mcp_connector is the role the Worker connects as (through Hyperdrive). It can read
--     the business tables and add orders, but it can't change the schema, can't create
--     or drop anything, and can't bypass row-level security.
--
-- The role is created here WITHOUT a password, because a password must never be in git.
-- `npm run db:connector` gives it a random password and writes the connection string
-- into your git-ignored .env file.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mcp_connector') THEN
    CREATE ROLE mcp_connector NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- Even if the role already existed, make sure it can never skip row-level security.
ALTER ROLE mcp_connector NOBYPASSRLS;

-- Lets the owner act as the connector inside a test transaction (SET LOCAL ROLE), so the
-- planted-bug tests can check exactly what the Worker would see. The owner already has
-- every privilege the connector has, so this adds nothing for the owner.
GRANT mcp_connector TO CURRENT_USER;

-- No one but the owner may create objects in our schemas.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Only what the tools need. Reading: all business tables. Writing: new orders only
-- (create_order). No UPDATE or DELETE anywhere, and nothing on the staging work tables
-- except the flat sheet that compare_designs reads.
GRANT USAGE ON SCHEMA public, staging TO mcp_connector;
GRANT SELECT ON customers, categories, products, orders, order_items TO mcp_connector;
GRANT INSERT ON orders, order_items TO mcp_connector;
GRANT SELECT ON staging.flat_sales TO mcp_connector;
-- New order ids come from the identity sequence behind orders.order_id.
GRANT USAGE ON SEQUENCE orders_order_id_seq TO mcp_connector;
