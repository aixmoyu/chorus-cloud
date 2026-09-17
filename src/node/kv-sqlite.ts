/**
 * Workers KV-compatible adapter over better-sqlite3 — backs the
 * `CLIENT_CONFIGS` binding for the Node/VPS entry. Covers the surface the app
 * uses: `get`, `put` (expirationTtl + metadata), `delete`, and lexicographic
 * `list({ prefix, limit, cursor })`. Lives in the same SQLite file as the D1
 * adapter, so a self-hosted deploy is one data file.
 *
 * Intentional differences from real KV (both strictly friendlier):
 *  - strongly consistent — no up-to-60s global propagation delay
 *  - no 60s minimum TTL, no daily free-tier quotas
 * Expired entries read back as null (like KV) and are purged lazily on list.
 */
import type BetterSqlite3 from 'better-sqlite3';

export interface KVListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

/** Mirrors Workers KV's list entry shape. */
export interface KVKey {
  name: string;
  expiration?: number;
  metadata?: unknown;
}

export interface KVListResult {
  keys: KVKey[];
  list_complete: boolean;
  cursor?: string;
}

interface KvRow {
  key: string;
  value: string;
  metadata: string | null;
  expire_at: number | null; // epoch ms, NULL = never expires
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv_store (
  key       TEXT PRIMARY KEY,
  value     TEXT NOT NULL,
  metadata  TEXT,
  expire_at INTEGER
);
CREATE INDEX IF NOT EXISTS kv_store_expire_idx ON kv_store (expire_at);
`;

/** Workers KV default list page size. */
const DEFAULT_LIST_LIMIT = 1000;

export class SqliteKV {
  private readonly getStmt: BetterSqlite3.Statement;
  private readonly putStmt: BetterSqlite3.Statement;
  private readonly deleteStmt: BetterSqlite3.Statement;
  private readonly listStmt: BetterSqlite3.Statement;
  private readonly purgeStmt: BetterSqlite3.Statement;

  constructor(db: BetterSqlite3.Database) {
    db.exec(SCHEMA);
    this.getStmt = db.prepare('SELECT value, metadata, expire_at FROM kv_store WHERE key = ?');
    this.putStmt = db.prepare('INSERT INTO kv_store (key, value, metadata, expire_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, metadata = excluded.metadata, expire_at = excluded.expire_at');
    this.deleteStmt = db.prepare('DELETE FROM kv_store WHERE key = ?');
    // Range scan [prefix, prefix + U+10FFFF): code-unit lexicographic, the
    // same ordering Workers KV returns, backed by the primary-key index. The
    // only strings missed are keys ending in U+10FFFF itself (the last
    // Unicode code point — not producible by this app's key schemes).
    this.listStmt = db.prepare(
      `SELECT key, metadata, expire_at FROM kv_store
       WHERE key >= ? AND key < ? AND (? IS NULL OR key > ?)
       ORDER BY key
       LIMIT ?`,
    );
    this.purgeStmt = db.prepare('DELETE FROM kv_store WHERE expire_at IS NOT NULL AND expire_at <= ?');
  }

  async get(key: string): Promise<string | null> {
    const row = this.getStmt.get(key) as KvRow | undefined;
    if (!row) return null;
    if (row.expire_at !== null && row.expire_at <= Date.now()) return null;
    return row.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: unknown },
  ): Promise<void> {
    if (typeof value !== 'string') {
      // The app only ever stores JSON text; ArrayBuffer/ReadableStream puts
      // are a Workers-only feature with no caller here.
      throw new TypeError('SqliteKV.put: only string values are supported');
    }
    const { expirationTtl, metadata } = options ?? {};
    if (expirationTtl !== undefined && (!Number.isFinite(expirationTtl) || expirationTtl <= 0)) {
      throw new TypeError(`SqliteKV.put: invalid expirationTtl ${expirationTtl}`);
    }
    const expireAt = expirationTtl !== undefined ? Date.now() + expirationTtl * 1000 : null;
    this.putStmt.run(
      key,
      value,
      metadata === undefined ? null : JSON.stringify(metadata),
      expireAt,
    );
  }

  async delete(key: string): Promise<void> {
    this.deleteStmt.run(key);
  }

  async list(options: KVListOptions = {}): Promise<KVListResult> {
    // Lazy expiry sweep: expired entries vanish from list/get anyway, but
    // purging on list keeps the file from growing without a background job.
    this.purgeStmt.run(Date.now());

    const prefix = options.prefix ?? '';
    const upper = `${prefix}\u{10FFFF}`;
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIST_LIMIT, 1), DEFAULT_LIST_LIMIT);
    const cursor = options.cursor ? Buffer.from(options.cursor, 'base64').toString('utf8') : null;

    const rows = this.listStmt.all(prefix, upper, cursor, cursor, limit) as unknown as KvRow[];

    const keys: KVKey[] = rows.map((row) => {
      const entry: KVKey = { name: row.key };
      if (row.expire_at !== null) entry.expiration = Math.floor(row.expire_at / 1000);
      if (row.metadata !== null) {
        try {
          entry.metadata = JSON.parse(row.metadata);
        } catch {
          entry.metadata = undefined;
        }
      }
      return entry;
    });

    const complete = keys.length < limit;
    return {
      keys,
      list_complete: complete,
      ...(complete ? {} : { cursor: Buffer.from(keys[keys.length - 1].name, 'utf8').toString('base64') }),
    };
  }
}
