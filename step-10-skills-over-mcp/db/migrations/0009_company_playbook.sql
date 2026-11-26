CREATE TABLE public.company_playbook (
  org_id text PRIMARY KEY,
  sales_target text,
  product_terms text,
  sign_off_steps text,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL
);

ALTER TABLE public.company_playbook ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_playbook FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.company_playbook;
CREATE POLICY tenant_isolation ON public.company_playbook TO mcp_connector
  USING (org_id = current_setting('app.tenant_id', true))
  WITH CHECK (org_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON public.company_playbook TO mcp_connector;
