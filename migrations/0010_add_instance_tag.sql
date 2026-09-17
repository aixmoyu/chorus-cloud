-- CLOUD-P2: extract the instance tag into a dedicated indexed column so
-- tags/check performs an index lookup instead of a params LIKE full scan.
-- Rows created before this migration keep tag = '' and are covered by the
-- LIKE fallback in tags/check, which self-heals the column on a hit.
ALTER TABLE protocol_instances ADD COLUMN tag TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_protocol_instances_tag ON protocol_instances(tag);
