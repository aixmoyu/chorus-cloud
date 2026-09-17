import { Hono } from 'hono';
import { signJWT, verifyJWT, hashToken, TOKEN_TTL, resolveJwtSecret } from '../auth/jwt';
import { adminAuth } from '../auth/middleware';
import { logAction } from '../services/audit';

const auth = new Hono<{ Bindings: Env }>();

/**
 * POST /api/auth/login
 * 使用 AUTH_TOKEN 换取 JWT (24h 过期)
 * P1: Admin Token 改为 JWT
 */
auth.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { token?: string };
  const providedToken = body.token;

  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null;

  if (!providedToken || providedToken !== c.env.AUTH_TOKEN) {
    // 审计之余留在 stdout 日志（Workers Logs 可回查）：失败登录是安全信号。
    c.get('logger').warn('admin login failed', { ip: ip ?? undefined });
    return c.json({ error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid credentials' } }, 401);
  }

  const { token, jti, exp } = await signJWT(
    { sub: 'admin', type: 'admin', ttl: TOKEN_TTL.ADMIN },
    resolveJwtSecret(c.env),
  );

  // Record token in tokens table for revocation
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(exp * 1000).toISOString();
  try {
    await c.env.DB.prepare(
      'INSERT INTO tokens (id, subject, token_hash, type, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(jti, 'admin', tokenHash, 'admin', expiresAt).run();
  } catch {
    // best-effort — token issuance still succeeds
  }

  await logAction(c.env.DB, { actor: 'admin', action: 'login', resource: 'auth', ip: ip ?? undefined });
  c.get('logger').info('admin login succeeded', { ip: ip ?? undefined });

  return c.json({ accessToken: token, tokenType: 'Bearer', expiresIn: TOKEN_TTL.ADMIN });
});

/**
 * POST /api/auth/refresh
 * 使用当前有效 JWT 换取新 JWT
 * P1: Token 刷新机制
 */
auth.post('/refresh', adminAuth, async (c) => {
  const authCtx = c.get('auth');

  // Revoke old token
  await c.env.DB.prepare('UPDATE tokens SET revoked = 1 WHERE id = ?').bind(authCtx.jti).run();

  // Issue new token
  const { token, jti, exp } = await signJWT(
    { sub: authCtx.actor, type: authCtx.tokenType, ttl: TOKEN_TTL.ADMIN },
    resolveJwtSecret(c.env),
  );

  const tokenHash = await hashToken(token);
  const expiresAt = new Date(exp * 1000).toISOString();
  await c.env.DB.prepare(
    'INSERT INTO tokens (id, subject, token_hash, type, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(jti, authCtx.actor, tokenHash, authCtx.tokenType, expiresAt).run();

  return c.json({ accessToken: token, tokenType: 'Bearer', expiresIn: TOKEN_TTL.ADMIN });
});

/**
 * POST /api/auth/logout
 * 吊销当前 JWT
 */
auth.post('/logout', adminAuth, async (c) => {
  const authCtx = c.get('auth');
  await c.env.DB.prepare('UPDATE tokens SET revoked = 1 WHERE id = ?').bind(authCtx.jti).run();

  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null;
  await logAction(c.env.DB, { actor: authCtx.actor, action: 'logout', resource: 'auth', ip: ip ?? undefined });

  return c.json({ success: true });
});

/**
 * GET /api/auth/audit-logs
 * 查看审计日志 (admin only)
 * P2: 增加操作审计日志
 */
auth.get('/audit-logs', adminAuth, async (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const resource = c.req.query('resource') || undefined;
  const actor = c.req.query('actor') || undefined;

  const { results, total } = await import('../services/audit').then(m =>
    m.listAuditLogs(c.env.DB, { limit, offset, resource, actor })
  );
  return c.json({ logs: results, total, limit, offset });
});

export { auth };
