import { describe, expect, it } from 'vitest';
import { hashToken, resolveJwtSecret, signJWT, TOKEN_TTL, verifyJWT } from '../src/auth/jwt';

/**
 * Unit coverage for the JWT primitives used by every authenticated route.
 * Runs in the workers pool (Web Crypto available).
 */
describe('signJWT / verifyJWT', () => {
  const SECRET = 'unit-test-secret';

  it('round-trips a payload (sub, type, jti preserved)', async () => {
    const { token, jti, exp } = await signJWT({ sub: 'admin', type: 'admin', ttl: 60 }, SECRET);
    const payload = await verifyJWT(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('admin');
    expect(payload!.type).toBe('admin');
    expect(payload!.jti).toBe(jti);
    expect(payload!.exp).toBe(exp);
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('produces a three-part compact token', async () => {
    const { token } = await signJWT({ sub: 'u', type: 'user', ttl: 60 }, SECRET);
    expect(token.split('.')).toHaveLength(3);
  });

  it('rejects an expired token', async () => {
    const { token } = await signJWT({ sub: 'u', type: 'admin', ttl: -10 }, SECRET);
    expect(await verifyJWT(token, SECRET)).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const { token } = await signJWT({ sub: 'u', type: 'admin', ttl: 60 }, SECRET);
    const [h, , s] = token.split('.');
    const forgedPayload = btoa(JSON.stringify({ sub: 'attacker', type: 'admin', exp: Math.floor(Date.now() / 1000) + 9999 }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await verifyJWT(`${h}.${forgedPayload}.${s}`, SECRET)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const { token } = await signJWT({ sub: 'u', type: 'admin', ttl: 60 }, SECRET);
    expect(await verifyJWT(token, 'other-secret')).toBeNull();
  });

  it('rejects malformed tokens', async () => {
    expect(await verifyJWT('not-a-jwt', SECRET)).toBeNull();
    expect(await verifyJWT('a.b', SECRET)).toBeNull();
    expect(await verifyJWT('a.b.c', SECRET)).toBeNull();
    expect(await verifyJWT('', SECRET)).toBeNull();
  });
});

describe('hashToken', () => {
  it('is deterministic and base64url-encoded', async () => {
    const a = await hashToken('same-input');
    const b = await hashToken('same-input');
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toContain('=');
  });

  it('differs for different inputs', async () => {
    expect(await hashToken('a')).not.toBe(await hashToken('b'));
  });
});

describe('TOKEN_TTL', () => {
  it('matches the documented policy (admin 24h, user 30d)', () => {
    expect(TOKEN_TTL.ADMIN).toBe(86_400);
    expect(TOKEN_TTL.USER).toBe(30 * 86_400);
  });
});

describe('resolveJwtSecret', () => {
  it('prefers JWT_SECRET when present', () => {
    expect(resolveJwtSecret({ JWT_SECRET: 'explicit', AUTH_TOKEN: 'fallback' })).toBe('explicit');
  });

  it('falls back to AUTH_TOKEN when JWT_SECRET is missing (legacy deployments)', () => {
    expect(resolveJwtSecret({ AUTH_TOKEN: 'fallback' })).toBe('fallback');
    expect(resolveJwtSecret({ JWT_SECRET: null, AUTH_TOKEN: 'fallback' })).toBe('fallback');
  });
});
