import { createMiddleware } from 'hono/factory';
import { verifyJWT, hashToken, resolveJwtSecret } from './jwt';

export interface AuthContext {
  actor: string;
  tokenType: 'admin' | 'user';
  jti: string;
}

/**
 * KV TTL for revocation markers (`revoke:{tokenHash}`). Written when the D1
 * check observes a revoked token, so a later D1 outage can still reject
 * tokens revoked while the DB was healthy. 24h matches the admin token's
 * max lifetime; longer-lived user tokens lose this extra coverage after it
 * expires — still a strict improvement over pure fail-open.
 */
const REVOCATION_MARKER_TTL = 24 * 60 * 60;

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

/**
 * adminAuth 中间件 — 验证 JWT (HS256)
 * P1: Admin Token 改为 JWT (24h 过期)，支持吊销
 *
 * 验证流程：
 * 1. 提取 Bearer token
 * 2. 验证 JWT 签名 + 过期时间 (Web Crypto API)
 * 3. 查询 tokens 表确认未被吊销
 */
export const adminAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: { code: 'AUTH_MISSING_TOKEN', message: 'Authentication required' } }, 401);
  }
  const token = authHeader.slice(7);

  const payload = await verifyJWT(token, resolveJwtSecret(c.env));
  if (!payload) {
    return c.json({ error: { code: 'AUTH_INVALID_TOKEN', message: 'Invalid or expired token' } }, 401);
  }

  // Check revocation in tokens table
  // Only reject if token is explicitly revoked (revoked=1).
  // If token is not found in DB (e.g., DB reset, cross-instance), accept it —
  // the JWT signature is already verified.
  const tokenHash = await hashToken(token);
  let dbCheckFailed = false;
  try {
    const tokenRow = await c.env.DB.prepare(
      'SELECT revoked FROM tokens WHERE token_hash = ?'
    ).bind(tokenHash).first<{ revoked: number }>();

    if (tokenRow && tokenRow.revoked === 1) {
      // Record a KV marker so this revocation stays enforceable even if D1
      // goes down before the token expires. Best-effort; revocations are rare
      // so this costs no meaningful KV quota.
      await c.env.CLIENT_CONFIGS.put(`revoke:${tokenHash}`, '1', {
        expirationTtl: REVOCATION_MARKER_TTL,
      }).catch(() => {});
      return c.json({ error: { code: 'AUTH_TOKEN_REVOKED', message: 'Token has been revoked' } }, 401);
    }
  } catch {
    dbCheckFailed = true;
  }

  if (dbCheckFailed) {
    // D1 outage — fail open for unknown tokens (signature is already valid),
    // but fail closed for tokens whose revocation marker is still cached.
    try {
      const marker = await c.env.CLIENT_CONFIGS.get(`revoke:${tokenHash}`);
      if (marker) {
        return c.json({ error: { code: 'AUTH_TOKEN_REVOKED', message: 'Token has been revoked' } }, 401);
      }
    } catch {
      // KV also unavailable — fall through (fail open)
    }
  }

  c.set('auth', {
    actor: payload.sub,
    tokenType: payload.type,
    jti: payload.jti,
  });

  await next();
});
