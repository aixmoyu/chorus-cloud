/**
 * 审计日志服务 — 记录关键管理操作
 * P2: 增加操作审计日志
 */
import type { D1Database } from '@cloudflare/workers-types';

export interface AuditEntry {
  actor: string;
  action: string;
  resource: string;
  resourceId?: string;
  ip?: string;
}

export async function logAction(db: D1Database, entry: AuditEntry): Promise<void> {
  const id = crypto.randomUUID();
  try {
    await db.prepare(
      'INSERT INTO audit_logs (id, actor, action, resource, resource_id, ip) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(
      id,
      entry.actor,
      entry.action,
      entry.resource,
      entry.resourceId ?? null,
      entry.ip ?? null,
    ).run();
  } catch {
    // audit logging is best-effort — must not break the request
  }
}

export async function listAuditLogs(
  db: D1Database,
  opts: { limit?: number; offset?: number; resource?: string; actor?: string } = {},
): Promise<{ results: unknown[]; total: number }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;
  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (opts.resource) { conditions.push('resource = ?'); binds.push(opts.resource); }
  if (opts.actor) { conditions.push('actor = ?'); binds.push(opts.actor); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { results } = await db.prepare(
    `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all();
  const totalRow = await db.prepare(
    `SELECT COUNT(*) as count FROM audit_logs ${where}`
  ).bind(...binds).first<{ count: number }>();
  return { results: results ?? [], total: totalRow?.count ?? 0 };
}
