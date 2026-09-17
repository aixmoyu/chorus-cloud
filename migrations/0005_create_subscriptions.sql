-- Migration 0005: Create subscriptions table and remove legacy user fields
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  overall_template_id TEXT DEFAULT NULL,
  overall_params TEXT NOT NULL DEFAULT '{}',
  protocol_instance_ids TEXT NOT NULL DEFAULT '[]',
  token TEXT NOT NULL UNIQUE,
  active TEXT NOT NULL DEFAULT '1',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (overall_template_id) REFERENCES overall_templates(id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_path ON subscriptions(path);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_token ON subscriptions(token);
