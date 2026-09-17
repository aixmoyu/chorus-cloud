-- Migration 0006: Drop users table, remove user_id and protocol_instance_ids from subscriptions
-- SQLite requires table recreate to drop FK-referenced columns

PRAGMA foreign_keys = OFF;

CREATE TABLE subscriptions_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  overall_template_id TEXT DEFAULT NULL,
  overall_params TEXT NOT NULL DEFAULT '{}',
  token TEXT NOT NULL UNIQUE,
  active TEXT NOT NULL DEFAULT '1',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (overall_template_id) REFERENCES overall_templates(id)
);

INSERT INTO subscriptions_new (id, name, path, overall_template_id, overall_params, token, active, created_at, updated_at)
SELECT id, name, path, overall_template_id, overall_params, token, active, created_at, updated_at FROM subscriptions;

DROP TABLE subscriptions;
ALTER TABLE subscriptions_new RENAME TO subscriptions;

CREATE INDEX IF NOT EXISTS idx_subscriptions_path ON subscriptions(path);
CREATE INDEX IF NOT EXISTS idx_subscriptions_token ON subscriptions(token);

DROP TABLE IF EXISTS users;

PRAGMA foreign_keys = ON;
