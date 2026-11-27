-- 0009: BULK ORDER IMPORTS through a queue.
--
-- Only ADDS tables, so earlier steps that share this database keep working.
--
-- imports       one row per bulk_import_orders call: who started it and how many rows.
-- import_rows   one row per CSV row once the queue consumer has handled it: done (with
--               the order it created) or failed (with the reason).
--
-- Queues deliver AT LEAST ONCE: a batch can arrive twice (a retry after a timeout, say).
-- The consumer claims each row by inserting it here, keyed by (org_id, import_id, row_no),
-- in the SAME transaction as the order. A row that's already here was already handled, so
-- a second delivery can never create a second order.

CREATE TABLE imports (
  org_id     text        NOT NULL,
  import_id  uuid        NOT NULL,
  created_by text        NOT NULL,
  total_rows integer     NOT NULL CHECK (total_rows BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, import_id)
);

CREATE TABLE import_rows (
  org_id    text        NOT NULL,
  import_id uuid        NOT NULL,
  row_no    integer     NOT NULL CHECK (row_no > 0),
  status    text        NOT NULL CHECK (status IN ('done', 'failed')),
  order_ref text,
  error     text        CHECK (length(error) <= 500),
  handled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, import_id, row_no),
  FOREIGN KEY (org_id, import_id) REFERENCES imports (org_id, import_id) ON DELETE CASCADE,
  CHECK ((status = 'done' AND order_ref IS NOT NULL) OR (status = 'failed' AND error IS NOT NULL))
);

ALTER TABLE imports     ENABLE ROW LEVEL SECURITY;
ALTER TABLE imports     FORCE  ROW LEVEL SECURITY;
ALTER TABLE import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_rows FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON imports TO mcp_connector
  USING      (org_id = current_setting('app.tenant_id', true))
  WITH CHECK (org_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation ON import_rows TO mcp_connector
  USING      (org_id = current_setting('app.tenant_id', true))
  WITH CHECK (org_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT ON imports, import_rows TO mcp_connector;
