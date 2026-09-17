-- Migration 0008: Unify protocols + overall_templates into a single templates table
-- Implements design doc 9.11 extension point: "新协议 = Cloud 端 templates 表新增记录"
-- category values: 'protocol', 'overall-server', 'overall-client', 'overall-docker'

PRAGMA foreign_keys = OFF;

-- 1. Drop legacy templates table (from migration 0001, unused by new code)
DROP TABLE IF EXISTS templates;

-- 2. Create new unified templates table
CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  server_template TEXT,
  client_template TEXT,
  template_content TEXT,
  config TEXT,
  entry_script TEXT,
  params TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 3. Migrate protocols → templates (category='protocol')
INSERT INTO templates (id, category, name, version, server_template, client_template, params, description, created_at, updated_at)
SELECT id, 'protocol', name, version, server_template, client_template, params, description, created_at, updated_at
FROM protocols;

-- 4. Migrate overall_templates → templates (category mapped: server→overall-server, etc.)
INSERT INTO templates (id, category, name, version, template_content, config, entry_script, params, description, created_at, updated_at)
SELECT
  id,
  CASE category
    WHEN 'server' THEN 'overall-server'
    WHEN 'client' THEN 'overall-client'
    WHEN 'docker' THEN 'overall-docker'
    ELSE category
  END,
  name, version, template_content, config, entry_script, '[]', description, created_at, updated_at
FROM overall_templates;

-- 5. Rebuild protocol_instances with FK → templates(id)
CREATE TABLE protocol_instances_new (
  id TEXT PRIMARY KEY,
  protocol_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  server_config TEXT DEFAULT NULL,
  client_config TEXT DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (protocol_id) REFERENCES templates(id),
  FOREIGN KEY (node_id) REFERENCES nodes(id)
);

INSERT INTO protocol_instances_new (id, protocol_id, node_id, params, server_config, client_config, status, created_at, updated_at)
SELECT id, protocol_id, node_id, params, server_config, client_config, status, created_at, updated_at
FROM protocol_instances;

DROP TABLE protocol_instances;
ALTER TABLE protocol_instances_new RENAME TO protocol_instances;

CREATE INDEX IF NOT EXISTS idx_protocol_instances_node_id ON protocol_instances(node_id);
CREATE INDEX IF NOT EXISTS idx_protocol_instances_protocol_id ON protocol_instances(protocol_id);

-- 6. Rebuild subscriptions with FK → templates(id)
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
  FOREIGN KEY (overall_template_id) REFERENCES templates(id)
);

INSERT INTO subscriptions_new (id, name, path, overall_template_id, overall_params, token, active, created_at, updated_at)
SELECT id, name, path, overall_template_id, overall_params, token, active, created_at, updated_at
FROM subscriptions;

DROP TABLE subscriptions;
ALTER TABLE subscriptions_new RENAME TO subscriptions;

CREATE INDEX IF NOT EXISTS idx_subscriptions_path ON subscriptions(path);
CREATE INDEX IF NOT EXISTS idx_subscriptions_token ON subscriptions(token);

-- 7. Drop old tables
DROP TABLE protocols;
DROP TABLE overall_templates;

-- 8. Create index on templates
CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category);

PRAGMA foreign_keys = ON;
