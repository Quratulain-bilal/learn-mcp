-- 0012: EVENTS the server emits (order.created, sales.threshold_reached).
--
-- Only ADDS a table, so earlier steps that share this database keep working.
--
-- One row per event occurrence, per company. `seq` orders a company's events and is the
-- poll cursor; `event_id` is the stable identity a client uses to drop duplicates, and
-- UNIQUE (org_id, event_id) means the same upstream event can't be stored twice, however
-- often the queue delivers it.

CREATE TABLE event_log (
  org_id      text        NOT NULL,
  seq         bigint      GENERATED ALWAYS AS IDENTITY,
  event_id    text        NOT NULL CHECK (length(event_id) <= 200),
  name        text        NOT NULL CHECK (name IN ('order.created', 'sales.threshold_reached')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  data        jsonb       NOT NULL,
  PRIMARY KEY (org_id, seq),
  UNIQUE (org_id, event_id)
);

CREATE INDEX event_log_name_idx ON event_log (org_id, name, seq);

ALTER TABLE event_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_log FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON event_log TO mcp_connector
  USING      (org_id = current_setting('app.tenant_id', true))
  WITH CHECK (org_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT ON event_log TO mcp_connector;
