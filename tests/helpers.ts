import { SELF, env } from 'cloudflare:test';

export const DEV_AUTH_TOKEN = (env as any).AUTH_TOKEN || 'dev-admin-token-change-in-production';

let cachedJwt: string | null = null;

/** Login via AUTH_TOKEN and cache the resulting admin JWT.
 * Safe across tests: D1 storage resets per test and the auth middleware
 * fail-opens for tokens missing from the (fresh) tokens table. */
export async function getJwt(): Promise<string> {
  if (cachedJwt) return cachedJwt;
  const res = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: DEV_AUTH_TOKEN }),
  });
  if (res.status !== 200) {
    throw new Error(`Failed to login: ${res.status}`);
  }
  const body = (await res.json()) as any;
  cachedJwt = body.accessToken;
  return cachedJwt!;
}

export async function adminHeaders(): Promise<Record<string, string>> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${await getJwt()}`,
  };
}

/** SELF.fetch against a path on the test origin. */
export function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

export async function jsonBody<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** POST /api/admin/seed — populates the 5 default templates. */
export async function seed(): Promise<void> {
  const res = await api('/api/admin/seed', { method: 'POST', headers: await adminHeaders() });
  if (res.status !== 200) throw new Error(`Seed failed: ${res.status}`);
}

/** Create a node, returning the node row. */
export async function createNode(extra: Record<string, unknown> = {}): Promise<any> {
  const res = await api('/api/nodes', {
    method: 'POST',
    headers: await adminHeaders(),
    body: JSON.stringify({ name: `node-${Math.random().toString(36).slice(2, 8)}`, ...extra }),
  });
  const body = await jsonBody(res);
  if (res.status !== 201) throw new Error(`createNode failed: ${res.status}`);
  return body.node;
}

/** Create a minimal custom protocol definition (params: domain required). */
export async function createSimpleProtocol(id: string): Promise<void> {
  const res = await api('/api/protocols', {
    method: 'POST',
    headers: await adminHeaders(),
    body: JSON.stringify({
      id,
      name: `Protocol ${id}`,
      version: '1.0.0',
      serverTemplate: JSON.stringify({ type: 'vless', tag: '{{ params.tag }}' }),
      clientTemplate: JSON.stringify({ type: 'vless', server: '{{ params.domain }}' }),
      params: JSON.stringify([
        { name: 'domain', type: 'string', required: true },
        { name: 'tag', type: 'string', required: false, default: 'proto-tag' },
      ]),
    }),
  });
  if (res.status !== 201) throw new Error(`createSimpleProtocol failed: ${res.status}`);
}

/** Create a protocol instance, returning the instance row. */
export async function createInstance(
  protocolId: string,
  nodeId: string,
  params: Record<string, unknown>,
): Promise<any> {
  const res = await api('/api/protocol-instances', {
    method: 'POST',
    headers: await adminHeaders(),
    body: JSON.stringify({ protocolId, nodeId, params }),
  });
  const body = await jsonBody(res);
  if (res.status !== 201) throw new Error(`createInstance failed: ${res.status} ${JSON.stringify(body)}`);
  return body.instance;
}
