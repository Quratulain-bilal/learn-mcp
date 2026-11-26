CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.policy_documents (
  org_id text NOT NULL,
  document_id text NOT NULL,
  title text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, document_id)
);

CREATE TABLE IF NOT EXISTS public.policy_passages (
  org_id text NOT NULL,
  document_id text NOT NULL,
  line integer NOT NULL,
  content text NOT NULL,
  embedding vector(1024) NOT NULL,
  PRIMARY KEY (org_id, document_id, line),
  FOREIGN KEY (org_id, document_id) REFERENCES public.policy_documents (org_id, document_id) ON DELETE CASCADE
);

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS description_embedding vector(1024);

ALTER TABLE public.policy_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.policy_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.policy_documents;
CREATE POLICY tenant_isolation ON public.policy_documents
  USING (org_id = current_setting('app.tenant_id', true))
  WITH CHECK (org_id = current_setting('app.tenant_id', true));

ALTER TABLE public.policy_passages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.policy_passages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.policy_passages;
CREATE POLICY tenant_isolation ON public.policy_passages
  USING (org_id = current_setting('app.tenant_id', true))
  WITH CHECK (org_id = current_setting('app.tenant_id', true));

CREATE INDEX IF NOT EXISTS policy_passages_embedding_idx
  ON public.policy_passages USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS products_description_embedding_idx
  ON public.products USING hnsw (description_embedding vector_cosine_ops)
  WHERE description_embedding IS NOT NULL;
