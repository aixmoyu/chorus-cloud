/**
 * JWT 签发与验证工具 — 使用 Web Crypto API (HS256)
 * 设计文档要求：Admin Token 24h 过期，User Token 30d 过期，支持吊销
 */

const ALG = 'HS256';
const encoder = new TextEncoder();

interface JwtPayload {
  sub: string;       // subject (admin / user id)
  type: 'admin' | 'user';
  iat: number;       // issued at (seconds)
  exp: number;       // expires at (seconds)
  jti: string;       // unique token id (for revocation)
}

function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signJWT(
  payload: Omit<JwtPayload, 'iat' | 'exp' | 'jti'> & { ttl: number },
  secret: string,
): Promise<{ token: string; jti: string; exp: number }> {
  const now = Math.floor(Date.now() / 1000);
  const jti = crypto.randomUUID();
  const fullPayload: JwtPayload = {
    sub: payload.sub,
    type: payload.type,
    iat: now,
    exp: now + payload.ttl,
    jti,
  };

  const header = { alg: ALG, typ: 'JWT' };
  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(fullPayload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
  const sigB64 = base64UrlEncode(signature);

  return { token: `${signingInput}.${sigB64}`, jti, exp: fullPayload.exp };
}

export async function verifyJWT(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  try {
    const key = await importKey(secret);
    const signature = base64UrlDecode(sigB64);
    const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(signingInput));
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as JwtPayload;
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;

    return payload;
  } catch {
    return null;
  }
}

export async function hashToken(token: string): Promise<string> {
  const data = encoder.encode(token);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(hash);
}

export const TOKEN_TTL = {
  ADMIN: 24 * 60 * 60,       // 24 hours
  USER: 30 * 24 * 60 * 60,   // 30 days
} as const;

let jwtSecretWarned = false;

/**
 * 解析 JWT 签发密钥。JWT_SECRET 缺失时回退到 AUTH_TOKEN：
 * AUTH_TOKEN 同时用作登录凭据，一旦泄漏即可离线伪造任意 admin JWT。
 * 回退仅为存量部署兼容，缺失时按 isolate 一次性告警提醒运维补齐。
 */
export function resolveJwtSecret(env: { JWT_SECRET?: string | null; AUTH_TOKEN: string }): string {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  if (!jwtSecretWarned) {
    jwtSecretWarned = true;
    console.warn(
      '[auth] JWT_SECRET is not set — falling back to AUTH_TOKEN as the JWT signing key. '
      + 'Set JWT_SECRET (wrangler secret put JWT_SECRET) so AUTH_TOKEN leakage cannot enable offline JWT forgery.',
    );
  }
  return env.AUTH_TOKEN;
}
