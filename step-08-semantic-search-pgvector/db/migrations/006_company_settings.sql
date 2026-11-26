CREATE TABLE IF NOT EXISTS public.company_settings (
  org_id text PRIMARY KEY,
  currency text NOT NULL CHECK (char_length(currency) = 3),
  fiscal_year_start integer NOT NULL CHECK (fiscal_year_start BETWEEN 1 AND 12),
  sales_threshold numeric(14,2) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.company_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.company_settings;
CREATE POLICY tenant_isolation ON public.company_settings
  FOR ALL
  USING (org_id = current_setting('app.tenant_id', true))
  WITH CHECK (org_id = current_setting('app.tenant_id', true));
