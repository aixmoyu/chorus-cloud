import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { adminAuth } from '../auth/middleware';
import { signJWT, hashToken, TOKEN_TTL, resolveJwtSecret } from '../auth/jwt';
import { logAction } from '../services/audit';

const createUserSchema = z.object({
  name: z.string().min(1).max(128),
  subscription_url: z.string().url().optional(),
});

const updateUserSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  subscription_url: z.string().url().nullable().optional(),
});

const users = new Hono<{ Bindings: Env }>();

users.use('*', adminAuth);

/**
 * GET /api/users — 列出所有用户
 * P2: 恢复 users 表
 */
users.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, subscription_url, created_at FROM users ORDER BY created_at DESC'
  ).all();
  return c.json({ users: results });
});

/**
 * POST /api/users — 创建用户
 */
users.post('/', zValidator('json', createUserSchema), async (c) => {
  const body = c.req.valid('json');
  const id = crypto.randomUUID();

  // Generate user token (for subscription pull)
  const rawToken = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');

  try {
    await c.env.DB.prepare(
      'INSERT INTO users (id, name, token, subscription_url) VALUES (?, ?, ?, ?)'
    ).bind(id, body.name, rawToken, body.subscription_url ?? null).run();
  } catch (e: any) {
    if (e?.message?.includes('UNIQUE constraint failed')) {
      return c.json({ error: { code: 'USER_DUPLICATE', message: 'User already exists' } }, 409);
    }
    throw e;
  }

  const authCtx = c.get('auth');
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null;
  await logAction(c.env.DB, { actor: authCtx.actor, action: 'create', resource: 'user', resourceId: id, ip: ip ?? undefined });

  const row = await c.env.DB.prepare('SELECT id, name, subscription_url, created_at FROM users WHERE id = ?').bind(id).first();
  return c.json({ user: row }, 201);
});

/**
 * GET /api/users/:id — 查看用户
 */
users.get('/:id', async (c) => {
  const { id } = c.req.param();
  const row = await c.env.DB.prepare(
    'SELECT id, name, subscription_url, created_at FROM users WHERE id = ?'
  ).bind(id).first();
  if (!row) {
    return c.json({ error: { code: 'USER_NOT_FOUND', message: `User '${id}' not found` } }, 404);
  }
  return c.json({ user: row });
});

/**
 * PUT /api/users/:id — 更新用户
 */
users.put('/:id', zValidator('json', updateUserSchema), async (c) => {
  const { id } = c.req.param();
  const body = c.req.valid('json');
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
  if (!existing) {
    return c.json({ error: { code: 'USER_NOT_FOUND', message: `User '${id}' not found` } }, 404);
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) { sets.push('name = ?'); binds.push(body.name); }
  if (body.subscription_url !== undefined) { sets.push('subscription_url = ?'); binds.push(body.subscription_url); }

  if (sets.length > 0) {
    sets.push("created_at = created_at"); // no-op to keep SQL valid with single element
    binds.push(id);
    await c.env.DB.prepare(
      `UPDATE users SET ${sets.join(', ')} WHERE id = ?`
    ).bind(...binds).run();
  }

  const row = await c.env.DB.prepare(
    'SELECT id, name, subscription_url, created_at FROM users WHERE id = ?'
  ).bind(id).first();
  return c.json({ user: row });
});

/**
 * DELETE /api/users/:id — 删除用户 (同时吊销其所有 token)
 */
users.delete('/:id', async (c) => {
  const { id } = c.req.param();
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
  if (!existing) {
    return c.json({ error: { code: 'USER_NOT_FOUND', message: `User '${id}' not found` } }, 404);
  }

  // Revoke all tokens for this user
  await c.env.DB.prepare('UPDATE tokens SET revoked = 1 WHERE subject = ? AND type = ?').bind(id, 'user').run();
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();

  const authCtx = c.get('auth');
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null;
  await logAction(c.env.DB, { actor: authCtx.actor, action: 'delete', resource: 'user', resourceId: id, ip: ip ?? undefined });

  return c.json({ success: true });
});

/**
 * POST /api/users/:id/token — 为用户签发 JWT (30d 过期)
 * P2: User Token (30d 过期)，给终端用户独立拉取配置的入口
 */
users.post('/:id/token', async (c) => {
  const { id } = c.req.param();
  const user = await c.env.DB.prepare('SELECT id, name FROM users WHERE id = ?').bind(id).first<{ id: string; name: string }>();
  if (!user) {
    return c.json({ error: { code: 'USER_NOT_FOUND', message: `User '${id}' not found` } }, 404);
  }

  const { token, jti, exp } = await signJWT(
    { sub: user.id, type: 'user', ttl: TOKEN_TTL.USER },
    resolveJwtSecret(c.env),
  );

  // Record in tokens table
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(exp * 1000).toISOString();
  await c.env.DB.prepare(
    'INSERT INTO tokens (id, subject, token_hash, type, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(jti, user.id, tokenHash, 'user', expiresAt).run();

  const authCtx = c.get('auth');
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null;
  await logAction(c.env.DB, { actor: authCtx.actor, action: 'issue_token', resource: 'user', resourceId: id, ip: ip ?? undefined });

  return c.json({ accessToken: token, tokenType: 'Bearer', expiresIn: TOKEN_TTL.USER });
});

export { users };
