-- Migration 0004: Add missing columns to nodes table for server/docker overall template linkage
ALTER TABLE nodes ADD COLUMN server_overall_id TEXT DEFAULT NULL;
ALTER TABLE nodes ADD COLUMN docker_overall_id TEXT DEFAULT NULL;
ALTER TABLE nodes ADD COLUMN server_params TEXT DEFAULT '{}';

-- Create overall_templates table (schema.ts expects this, not 'templates')
CREATE TABLE IF NOT EXISTS overall_templates (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  template_content TEXT NOT NULL,
  config TEXT DEFAULT NULL,
  entry_script TEXT DEFAULT NULL,
  description TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Create protocols table (referenced by protocol_instances FK)
CREATE TABLE IF NOT EXISTS protocols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  server_template TEXT NOT NULL,
  client_template TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '[]',
  description TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Create protocol_instances table
CREATE TABLE IF NOT EXISTS protocol_instances (
  id TEXT PRIMARY KEY,
  protocol_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  server_config TEXT DEFAULT NULL,
  client_config TEXT DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (protocol_id) REFERENCES protocols(id),
  FOREIGN KEY (node_id) REFERENCES nodes(id)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_protocol_instances_node_id ON protocol_instances(node_id);
CREATE INDEX IF NOT EXISTS idx_protocol_instances_protocol_id ON protocol_instances(protocol_id);
CREATE INDEX IF NOT EXISTS idx_overall_templates_category ON overall_templates(category);