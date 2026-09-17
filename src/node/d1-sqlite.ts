/**
 * D1-compatible adapter over better-sqlite3 — backs the `DB` binding for the
 * Node/VPS entry (src/node/entry.ts). Implements exactly the D1 surface the
 * app exercises at runtime: `prepare → bind/first/all/run/raw` plus
 * transactional `batch`. Business code keeps reading `c.env.DB` unchanged —
 * on Workers the real D1 is injected, here this adapter stands in. The Node
 * API suite (tests/node/api.spec.ts) pins this contract so drift between the
 * two runtimes fails CI instead of surfacing in production.
 *
 * This module is imported ONLY by the Node entry — the Workers bundle never
 * pulls in better-sqlite3.
 */
import type BetterSqlite3 from 'better-sqlite3';

type SqlValue = null | number | bigint | string | Buffer;

/** Subset of D1's result shape that the app reads. */
export interface SqliteD1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta: {
    duration: number;
    changes?: number;
    last_row_id?: number;
  };
}

/** Mirror D1's bind-value rules: D1 rejects booleans/undefined/objects, and
 * so does SQLite — failing here keeps Node behavior aligned with Workers. */
function toSqlValue(value: unknown): SqlValue {
  if (value === null || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') {
    return value;
  }
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'boolean') {
    throw new TypeError('D1 adapter: cannot bind boolean — use 1/0 (D1 rejects booleans too)');
  }
  if (value === undefined) {
    throw new TypeError('D1 adapter: cannot bind undefined — use null (D1 rejects undefined too)');
  }
  throw new TypeError(`D1 adapter: unsupported bind value type '${typeof value}'`);
}

export class SqliteD1Statement {
  constructor(
    private readonly stmt: BetterSqlite3.Statement,
    private readonly args: SqlValue[],
  ) {}

  /** Collect bind values; execution happens on first/all/run, like D1. */
  bind(...values: unknown[]): SqliteD1Statement {
    return new SqliteD1Statement(this.stmt, values.map(toSqlValue));
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const row = this.stmt.get(...this.args) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    if (column !== undefined) return (row[column] ?? null) as T;
    return row as unknown as T;
  }

  async run<T = unknown>(): Promise<SqliteD1Result<T>> {
    const started = performance.now();
    const info = this.stmt.run(...this.args);
    return {
      success: true,
      results: [],
      meta: {
        duration: performance.now() - started,
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
      },
    };
  }

  async all<T = unknown>(): Promise<SqliteD1Result<T>> {
    const started = performance.now();
    const rows = this.stmt.all(...this.args) as Record<string, unknown>[];
    return { success: true, results: rows as unknown as T[], meta: { duration: performance.now() - started } };
  }

  /** D1 `raw()`: rows as arrays instead of objects. Unused by the app today;
   * implemented so future route code can't silently diverge between runtimes. */
  async raw(): Promise<unknown[]> {
    return this.stmt.raw().all(...this.args) as unknown[];
  }

  private execSync(): void {
    this.stmt.run(...this.args);
  }

  /** Synchronous execution for `batch` — better-sqlite3 transactions are
   * sync, so the batch core must be too (async callbacks would break its
   * atomicity). */
  static execAllSync(statements: SqliteD1Statement[]): void {
    for (const s of statements) s.execSync();
  }
}

export class SqliteD1 {
  constructor(private readonly db: BetterSqlite3.Database) {}

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db.prepare(sql), []);
  }

  /**
   * D1 batch semantics: statements execute in order inside one transaction —
   * all commit, or (on error) all roll back. better-sqlite3's `transaction`
   * maps 1:1.
   */
  async batch(statements: SqliteD1Statement[]): Promise<SqliteD1Result[]> {
    const tx = this.db.transaction((stmts: SqliteD1Statement[]) => {
      SqliteD1Statement.execAllSync(stmts);
    });
    tx.call(this.db, statements);
    return statements.map(() => ({ success: true, results: [], meta: { duration: 0 } }));
  }
}
