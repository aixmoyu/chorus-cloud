import { SELF, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';
import { resetDatabaseInitCache } from '../src/db/schema';
import { resetSubscriptionKvCache } from '../src/routes/subscriptions';

// D1 storage is reset per test while module state persists in the single
// worker — drop the init memo so every test re-runs the schema setup.
beforeEach(() => {
  resetDatabaseInitCache();
  resetSubscriptionKvCache();
});

// P1: Helper to obtain JWT via /api/auth/login, then use it for authenticated requests
let cachedJwt: string | null = null;

async function getJwt(): Promise<string> {
  if (cachedJwt) return cachedJwt;
  const authToken = (env as any).AUTH_TOKEN || 'dev-admin-token-change-in-production';
  const res = await SELF.fetch('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: authToken }),
  });
  if (res.status !== 200) {
    throw new Error(`Failed to login: ${res.status}`);
  }
  const body = await res.json() as any;
  cachedJwt = body.accessToken;
  return cachedJwt!;
}

async function adminHeaders(): Promise<Record<string, string>> {
  const jwt = await getJwt();
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${jwt}`,
  };
}

async function createSampleProtocol(id: string, name: string): Promise<string> {
  const res = await SELF.fetch('http://localhost/api/protocols', {
    method: 'POST',
    headers: await adminHeaders(),
    body: JSON.stringify({
      id,
      name,
      version: '1.0.0',
      serverTemplate: JSON.stringify({ type: 'vless', tag: '{{ params.tag }}' }),
      clientTemplate: JSON.stringify({ type: 'vless', server: '{{ params.domain }}' }),
      params: JSON.stringify([
        { name: 'domain', type: 'string', required: true },
        { name: 'port', type: 'number', default: 443 },
      ]),
    }),
  });
  const body = await res.json() as any;
  return body.protocol.id;
}

describe('ChorusCloud Worker', () => {
  describe('Health Check', () => {
    it('GET /health returns status ok', async () => {
      const res = await SELF.fetch('http://localhost/health');
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.status).toBe('ok');
      expect(body.service).toBe('chorus-cloud');
    });
  });

  describe('Route handling', () => {
    it('returns 404 for unknown routes', async () => {
      const res = await SELF.fetch('http://localhost/unknown-route');
      expect(res.status).toBe(404);
    });
  });

  describe('Auth', () => {
    it('rejects admin API calls without token', async () => {
      const res = await SELF.fetch('http://localhost/api/protocols', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });

    it('rejects admin API calls with invalid token', async () => {
      const res = await SELF.fetch('http://localhost/api/protocols', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer invalid-token' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('Protocol Management', () => {
    it('GET /api/protocols returns protocols (includes seed data)', async () => {
      const res = await SELF.fetch('http://localhost/api/protocols');
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(Array.isArray(body.protocols)).toBe(true);
      // Seed data inserts 2 protocols on first request
      expect(body.protocols.length).toBeGreaterThanOrEqual(2);
    });

    it('POST /api/protocols creates a protocol definition', async () => {
      const sample = {
        id: 'test-proto',
        name: 'Test Protocol',
        version: '1.0.0',
        serverTemplate: JSON.stringify({ type: 'vless' }),
        clientTemplate: JSON.stringify({ type: 'vless' }),
        params: JSON.stringify([{ name: 'domain', type: 'string', required: true }]),
      };
      const res = await SELF.fetch('http://localhost/api/protocols', {
        method: 'POST',
        headers: await adminHeaders(),
        body: JSON.stringify(sample),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.protocol.id).toBe('test-proto');
    });

    it('GET /api/protocols returns protocol by id', async () => {
      await createSampleProtocol('get-test', 'Get Test');
      const res = await SELF.fetch('http://localhost/api/protocols/get-test');
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.protocol.id).toBe('get-test');
    });

    it('GET /api/protocols/:id returns 404 for unknown', async () => {
      const res = await SELF.fetch('http://localhost/api/protocols/nonexistent');
      expect(res.status).toBe(404);
    });

    it('POST /api/protocols rejects duplicate id', async () => {
      await createSampleProtocol('dup-test', 'Dup Test');
      const res = await SELF.fetch('http://localhost/api/protocols', {
        method: 'POST',
        headers: await adminHeaders(),
        body: JSON.stringify({
          id: 'dup-test',
          name: 'Dup Test 2',
          version: '1.0.0',
          serverTemplate: '{}',
          clientTemplate: '{}',
          params: '[]',
        }),
      });
      expect(res.status).toBe(409);
    });

    it('DELETE /api/protocols/:id removes a protocol', async () => {
      await createSampleProtocol('del-test', 'Del Test');
      const delRes = await SELF.fetch('http://localhost/api/protocols/del-test', {
        method: 'DELETE',
        headers: await adminHeaders(),
      });
      expect(delRes.status).toBe(200);
      const getRes = await SELF.fetch('http://localhost/api/protocols/del-test');
      expect(getRes.status).toBe(404);
    });

    it('DELETE /api/protocols/:id returns 404 for non-existent', async () => {
      const res = await SELF.fetch('http://localhost/api/protocols/non-existent', {
        method: 'DELETE',
        headers: await adminHeaders(),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('Template Management', () => {
    it('POST /api/templates creates a server overall template', async () => {
      const res = await SELF.fetch('http://localhost/api/templates', {
        method: 'POST',
        headers: await adminHeaders(),
        body: JSON.stringify({
          id: 'server/test',
          category: 'server',
          name: 'Test Server',
          version: '1.0.0',
          templateContent: JSON.stringify({ log: { level: 'info' }, inbounds: '"{{ protocols }}"', outbounds: [] }),
        }),
      });
      expect(res.status).toBe(201);
    });

    it('GET /api/templates lists templates', async () => {
      const res = await SELF.fetch('http://localhost/api/templates');
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(Array.isArray(body.templates)).toBe(true);
    });

    it('GET /api/templates?category=docker filters by category', async () => {
      const res = await SELF.fetch('http://localhost/api/templates?category=docker');
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(Array.isArray(body.templates)).toBe(true);
    });
  });

  describe('Client Management', () => {
    it('PUT /api/clients/:fingerprint/:name stores a client config', async () => {
      const clientData = {
        config: { server: 'example.com', port: 443, password: 'test123' },
        protocol_type: 'vless',
        content_hash: 'abc123',
        enabled: true,
      };
      const res = await SELF.fetch('http://localhost/api/clients/fp-node-1/test-config', {
        method: 'PUT',
        headers: await adminHeaders(),
        body: JSON.stringify(clientData),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.client.name).toBe('test-config');
      expect(body.client.fingerprint).toBe('fp-node-1');
    });

    it('GET /api/clients/:fingerprint lists clients owned by one node', async () => {
      const putRes = await SELF.fetch('http://localhost/api/clients/fp-node-2/list-test', {
        method: 'PUT',
        headers: await adminHeaders(),
        body: JSON.stringify({ config: {}, protocol_type: 'vless' }),
      });
      expect(putRes.status).toBe(201);
      const res = await SELF.fetch('http://localhost/api/clients/fp-node-2', {
        headers: await adminHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.clients.length).toBeGreaterThanOrEqual(1);
      expect(body.clients.some((c: any) => c.name === 'list-test')).toBe(true);
    });

    it('DELETE /api/clients/:fingerprint/:name removes the client', async () => {
      await SELF.fetch('http://localhost/api/clients/fp-node-3/del-test', {
        method: 'PUT',
        headers: await adminHeaders(),
        body: JSON.stringify({ config: {}, protocol_type: 'vless' }),
      });
      const delRes = await SELF.fetch('http://localhost/api/clients/fp-node-3/del-test', {
        method: 'DELETE',
        headers: await adminHeaders(),
      });
      expect(delRes.status).toBe(200);
      const getRes = await SELF.fetch('http://localhost/api/clients/fp-node-3/del-test', {
        headers: await adminHeaders(),
      });
      expect(getRes.status).toBe(404);
    });

    it('rejects PUT /api/clients/:fingerprint/:name without auth (P0: endpoint secured)', async () => {
      const res = await SELF.fetch('http://localhost/api/clients/fp-x/test-noauth', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: {}, protocol_type: 'vless' }),
      });
      expect(res.status).toBe(401);
    });

    it('rejects GET /api/clients/:fingerprint/:name without auth (P0: endpoint secured)', async () => {
      const res = await SELF.fetch('http://localhost/api/clients/fp-x/test-noauth');
      expect(res.status).toBe(401);
    });

    it('rejects GET /api/protocol-instances/:id without auth (P0: endpoint secured)', async () => {
      const res = await SELF.fetch('http://localhost/api/protocol-instances/test-noauth');
      expect(res.status).toBe(401);
    });
  });

  describe('User Management (P2: User Token)', () => {
    it('POST /api/users creates a user', async () => {
      const res = await SELF.fetch('http://localhost/api/users', {
        method: 'POST',
        headers: await adminHeaders(),
        body: JSON.stringify({ name: 'Test User' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.user.name).toBe('Test User');
      expect(body.user.id).toBeDefined();
    });

    it('GET /api/users lists users', async () => {
      const res = await SELF.fetch('http://localhost/api/users', { headers: await adminHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(Array.isArray(body.users)).toBe(true);
    });

    it('rejects user operations without auth', async () => {
      const res = await SELF.fetch('http://localhost/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'No Auth' }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('Auth endpoints (P1: JWT)', () => {
    it('POST /api/auth/login with valid credentials returns JWT', async () => {
      const res = await SELF.fetch('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: (env as any).AUTH_TOKEN || 'dev-admin-token-change-in-production' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.accessToken).toBeDefined();
      expect(body.tokenType).toBe('Bearer');
      expect(body.expiresIn).toBe(86400); // 24h
    });

    it('POST /api/auth/login rejects invalid credentials', async () => {
      const res = await SELF.fetch('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'wrong-token' }),
      });
      expect(res.status).toBe(401);
    });

    it('POST /api/auth/logout revokes current token', async () => {
      const res = await SELF.fetch('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: await adminHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.success).toBe(true);
    });

    // Full revocation cycle within one test: D1 persists for the duration of a
    // single test, so the tokens-table revocation is observable here.
    it('rejects the token after logout (revocation is enforced, not just recorded)', async () => {
      const login = await SELF.fetch('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: (env as any).AUTH_TOKEN || 'dev-admin-token-change-in-production' }),
      });
      const { accessToken } = await login.json() as any;
      const authed = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` };

      const logout = await SELF.fetch('http://localhost/api/auth/logout', {
        method: 'POST', headers: authed,
      });
      expect(logout.status).toBe(200);

      const again = await SELF.fetch('http://localhost/api/users', { headers: authed });
      expect(again.status).toBe(401);
      expect((await again.json() as any).error.code).toBe('AUTH_TOKEN_REVOKED');
    });

    it('POST /api/auth/refresh issues a new token', async () => {
      const res = await SELF.fetch('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: await adminHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.accessToken).toBeDefined();
    });

    it('GET /api/auth/audit-logs returns audit logs (P2)', async () => {
      const res = await SELF.fetch('http://localhost/api/auth/audit-logs', {
        headers: await adminHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(Array.isArray(body.logs)).toBe(true);
      expect(body.total).toBeDefined();
    });
  });

  describe('Admin Seed', () => {
    it('POST /api/admin/seed populates default templates', async () => {
      const res = await SELF.fetch('http://localhost/api/admin/seed', {
        method: 'POST',
        headers: await adminHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.seeded.length).toBe(5);
    });

    it('POST /api/admin/seed is idempotent (run twice)', async () => {
      await SELF.fetch('http://localhost/api/admin/seed', {
        method: 'POST',
        headers: await adminHeaders(),
      });
      const res = await SELF.fetch('http://localhost/api/admin/seed', {
        method: 'POST',
        headers: await adminHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.seeded.every((s: any) => s.status === 'updated')).toBe(true);
    });

    it('rejects seed without auth', async () => {
      const res = await SELF.fetch('http://localhost/api/admin/seed', {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('Protocol Instances', () => {
    it('POST /api/protocol-instances requires auth', async () => {
      const res = await SELF.fetch('http://localhost/api/protocol-instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolId: 'test', nodeId: 'test', params: {} }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('Node Management', () => {
    it('POST /api/nodes creates a node', async () => {
      const res = await SELF.fetch('http://localhost/api/nodes', {
        method: 'POST',
        headers: await adminHeaders(),
        body: JSON.stringify({ name: 'test-node', hostname: 'example.com' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.node.name).toBe('test-node');
      expect(body.node.id).toBeDefined();
    });

    it('POST /api/nodes/register is idempotent by fingerprint', async () => {
      const first = await SELF.fetch('http://localhost/api/nodes/register', {
        method: 'POST',
        headers: await adminHeaders(),
        body: JSON.stringify({ fingerprint: 'fp-abcdef1234567890', name: 'node-a', address: 'a.example.com' }),
      });
      expect(first.status).toBe(201);
      const firstBody = await first.json() as any;
      expect(firstBody.node.fingerprint).toBe('fp-abcdef1234567890');
      expect(firstBody.node.address).toBe('a.example.com');

      // Re-registering the same fingerprint updates instead of duplicating.
      const second = await SELF.fetch('http://localhost/api/nodes/register', {
        method: 'POST',
        headers: await adminHeaders(),
        body: JSON.stringify({ fingerprint: 'fp-abcdef1234567890', name: 'node-a-renamed' }),
      });
      expect(second.status).toBe(200);
      const secondBody = await second.json() as any;
      expect(secondBody.node.name).toBe('node-a-renamed');
      expect(secondBody.node.address).toBe('a.example.com');
    });

    it('POST /api/nodes/register requires auth', async () => {
      const res = await SELF.fetch('http://localhost/api/nodes/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint: 'fp-unauth-12345678', name: 'no-auth' }),
      });
      expect(res.status).toBe(401);
    });
  });
});
