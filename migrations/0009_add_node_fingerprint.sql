-- Migration 0009: node identity by fingerprint
-- Panels now register themselves with a stable fingerprint; id stays as the
-- primary key but fingerprint becomes the dedup key for registration.
ALTER TABLE nodes ADD COLUMN fingerprint TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_fingerprint ON nodes(fingerprint) WHERE fingerprint IS NOT NULL;
ALTER TABLE nodes ADD COLUMN address TEXT;
