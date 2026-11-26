CREATE TABLE IF NOT EXISTS public.tenants (
  org_id text PRIMARY KEY,
  tier text NOT NULL CHECK (tier IN ('shared', 'enterprise')),
  database_binding text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.tenants;
CREATE POLICY tenant_isolation ON public.tenants
  FOR ALL
  USING (org_id = current_setting('app.tenant_id', true))
  WITH CHECK (org_id = current_setting('app.tenant_id', true));
