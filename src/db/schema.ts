import type { D1Database } from '@cloudflare/workers-types';
import { seedIfEmpty, cleanupLegacyTemplates } from './seed';

let legacyCleanupDone = false;

/**
 * Memoized per isolate. The DDL/idempotent setup (~21 D1 statements) runs once
 * per isolate instead of once per request — D1 calls count against the Workers
 * subrequest budget (50 on the free plan), so re-running them on every request
 * starves heavyweight handlers (e.g. tag checks) and surfaces as 500s.
 */
let initPromise: Promise<void> | null = null;

export function ensureDatabaseInitialized(db: D1Database): Promise<void> {
  if (!initPromise) {
    initPromise = doInitialize(db).catch((err) => {
      initPromise = null; // allow retry on the next request
      throw err;
    });
  }
  return initPromise;
}

/** Test-only: drop the per-isolate memo so the next request re-runs setup.
 * vitest-pool-workers shares module state across tests while D1 storage is
 * reset per test — without this, later tests would see an uninitialized DB. */
export function resetDatabaseInitCache(): void {
  initPromise = null;
}

async function doInitialize(db: D1Database): Promise<void> {
  await initializeDatabase(db);
  await seedIfEmpty(db).catch(() => { /* table may not exist yet */ });
  if (!legacyCleanupDone) {
    await cleanupLegacyTemplates(db)
      .catch(() => { /* tables may not exist yet; retry on next cold start */ })
      .finally(() => { legacyCleanupDone = true; });
  }
}

export async function initializeDatabase(db: D1Database): Promise<void> {
  try { await db.prepare('PRAGMA foreign_keys = ON').run(); } catch { /* pragma not available in all environments */ }

  // Create tables eagerly so the database works in any environment (test/local/production)
  for (const stmt of CREATE_TABLES) {
    try { await db.prepare(stmt).run(); } catch { /* table may already exist */ }
  }

  // Create indexes
  for (const stmt of CREATE_INDEXES) {
    try { await db.prepare(stmt).run(); } catch { /* index may already exist */ }
  }
}

// Design note: overall template bindings are split by scope —
//   nodes.server_overall_id / docker_overall_id / server_params  (node-scoped: a node runs one server + one docker compose)
//   subscriptions.overall_template_id / overall_params           (subscription-scoped: each subscriber gets a client config)
// This asymmetry is intentional: server/docker configs are deployed per-node, while client configs are delivered per-subscription.
const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hostname TEXT,
    fingerprint TEXT,
    address TEXT,
    last_seen TEXT,
    status TEXT NOT NULL DEFAULT 'offline',
    server_overall_id TEXT DEFAULT NULL,
    docker_overall_id TEXT DEFAULT NULL,
    server_params TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Unified templates table (migration 0008)
  // Replaces protocols + overall_tables + legacy templates
  // category: 'protocol' | 'overall-server' | 'overall-client' | 'overall-docker'
  `CREATE TABLE IF NOT EXISTS templates (
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
  )`,
  // CLOUD-P2 (migration 0010): `tag` mirrors params.tag so tags/check is an
  // index lookup instead of a params LIKE full scan.
  `CREATE TABLE IF NOT EXISTS protocol_instances (
    id TEXT PRIMARY KEY,
    protocol_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    server_config TEXT DEFAULT NULL,
    client_config TEXT DEFAULT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    tag TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (protocol_id) REFERENCES templates(id),
    FOREIGN KEY (node_id) REFERENCES nodes(id)
  )`,
  `CREATE TABLE IF NOT EXISTS subscriptions (
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
  )`,
  // Auth tables (migration 0007)
  `CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL DEFAULT 'admin',
    expires_at TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    subscription_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    resource TEXT NOT NULL,
    resource_id TEXT,
    ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

const CREATE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category)',
  'CREATE INDEX IF NOT EXISTS idx_protocol_instances_node_id ON protocol_instances(node_id)',
  'CREATE INDEX IF NOT EXISTS idx_protocol_instances_protocol_id ON protocol_instances(protocol_id)',
  'CREATE INDEX IF NOT EXISTS idx_protocol_instances_tag ON protocol_instances(tag)',
  'CREATE INDEX IF NOT EXISTS idx_subscriptions_path ON subscriptions(path)',
  'CREATE INDEX IF NOT EXISTS idx_subscriptions_token ON subscriptions(token)',
  'CREATE INDEX IF NOT EXISTS idx_tokens_subject ON tokens(subject)',
  'CREATE INDEX IF NOT EXISTS idx_tokens_hash ON tokens(token_hash)',
  'CREATE INDEX IF NOT EXISTS idx_tokens_type ON tokens(type)',
  'CREATE INDEX IF NOT EXISTS idx_users_token ON users(token)',
  'CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor)',
  'CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource)',
  'CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at)',
  // Partial unique index: only enforce uniqueness on non-null fingerprints
  // (rows created before migration 0009 have NULL).
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_fingerprint ON nodes(fingerprint) WHERE fingerprint IS NOT NULL',
];
