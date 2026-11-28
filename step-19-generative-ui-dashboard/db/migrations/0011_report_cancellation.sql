-- 0011: a report run can be CANCELLED (tasks/cancel terminates its Workflow).
--
-- Only widens the list of allowed stages, so step 13, which shares this database and
-- never uses 'cancelled', keeps working unchanged.

ALTER TABLE reports DROP CONSTRAINT reports_stage_check;
ALTER TABLE reports ADD CONSTRAINT reports_stage_check CHECK (stage IN (
  'queued', 'reading', 'computing', 'awaiting_approval', 'published', 'expired', 'failed', 'cancelled'));
