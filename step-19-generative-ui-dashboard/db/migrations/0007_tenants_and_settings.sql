-- 0007: where each company lives, and each company's own settings.
--
-- These migrations run on EVERY tenant database: the shared one and each dedicated one
-- (npm run db:migrate does them all). So every database has both tables, with the same
-- row-level security as the business tables.

-- Which database each company uses (see TENANCY.md). Only the SHARED database's copy is
-- read: the tenant router looks a company up here before it knows where else to go.
-- No row means the default: the shared tier.
CREATE TABLE tenants (
  org_id     text        PRIMARY KEY,
  tier       text        NOT NULL CHECK (tier IN ('shared', 'dedicated')),
  -- The Hyperdrive binding (in wrangler.jsonc) for a dedicated company's database.
  db_binding text        CHECK (
               (tier = 'shared' AND db_binding IS NULL) OR
               (tier = 'dedicated' AND db_binding ~ '^TENANT_DB_[A-Z0-9_]+$')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Each company's own rules, without per-company code. Lives in the company's own
-- database, like the rest of its data. No row means the defaults below.
CREATE TABLE company_settings (
  org_id                  text          PRIMARY KEY,
  currency                char(3)       NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  fiscal_year_start_month smallint      NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  -- Groups at or above this revenue are flagged in sales summaries.
  sales_threshold         numeric(12,2) NOT NULL DEFAULT 1000 CHECK (sales_threshold >= 0),
  updated_at              timestamptz   NOT NULL DEFAULT now(),
  updated_by              text          NOT NULL
);

ALTER TABLE tenants          ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants          FORCE  ROW LEVEL SECURITY;
ALTER TABLE company_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_settings FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenants TO mcp_connector
  USING      (org_id = current_setting('app.tenant_id', true))
  WITH CHECK (org_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation ON company_settings TO mcp_connector
  USING      (org_id = current_setting('app.tenant_id', true))
  WITH CHECK (org_id = current_setting('app.tenant_id', true));

-- The Worker may read its company's placement (never change it: only the owner's
-- provisioning script does), and read and save its company's settings.
GRANT SELECT ON tenants TO mcp_connector;
GRANT SELECT, INSERT, UPDATE ON company_settings TO mcp_connector;
