-- 0010: SALES REPORTS made by the generate_sales_report Workflow.
--
-- Only ADDS a table, so earlier steps that share this database keep working.
--
-- One row per report run. The tool creates the row (stage 'queued') when it starts the
-- Workflow, so ownership is known before the first step runs; each step moves the stage
-- on, and the finished report is saved as JSON in `summary`.

CREATE TABLE reports (
  org_id       text        NOT NULL,
  report_id    text        NOT NULL CHECK (report_id ~ '^[a-z0-9-]{8,64}$'),  -- = the Workflow instance id
  created_by   text        NOT NULL,
  year         integer     NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  stage        text        NOT NULL CHECK (stage IN ('queued', 'reading', 'computing', 'awaiting_approval',
                                                    'published', 'expired', 'failed')),
  summary      jsonb,
  approved_by  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, report_id)
);

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON reports TO mcp_connector
  USING      (org_id = current_setting('app.tenant_id', true))
  WITH CHECK (org_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON reports TO mcp_connector;
