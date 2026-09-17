import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabaseInitCache } from '../src/db/schema';
import { adminHeaders, api, jsonBody } from './helpers';

// D1 storage is reset per test while module state persists in the single
// worker — drop the init memo so every test re-runs the schema setup.
beforeEach(() => {
  resetDatabaseInitCache();
});

async function putClient(fingerprint: string, name: string, body: Record<string, unknown>) {
  const res = await api(`/api/clients/${fingerprint}/${name}`, {
    method: 'PUT',
    headers: await adminHeaders(),
    body: JSON.stringify({ protocol_type: 'vless', ...body }),
  });
  return { status: res.status, body: await jsonBody(res) };
}

describe('Clients API — domain semantics', () => {
  it('rejects invalid upsert bodies (config must be an object, protocol_type required)', async () => {
    const res = await api('/api/clients/fp-val/bad', {
      method: 'PUT',
      headers: await adminHeaders(),
      body: JSON.stringify({ config: 'not-an-object', protocol_type: 'vless' }),
    });
    expect(res.status).toBe(400);

    const noType = await api('/api/clients/fp-val/bad2', {
      method: 'PUT',
      headers: await adminHeaders(),
      body: JSON.stringify({ config: {} }),
    });
    expect(noType.status).toBe(400);
  });

  it('rejects invalid fingerprint (no colon allowed — it namespaces KV keys)', async () => {
    const res = await api('/api/clients/bad:fp', { headers: await adminHeaders() });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error.code).toBe('BAD_FINGERPRINT');
  });

  it('returns 404 CLIENT_NOT_FOUND for an unknown node fingerprint', async () => {
    const res = await api('/api/clients/fp-unknown-1', { headers: await adminHeaders() });
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).error.code).toBe('CLIENT_NOT_FOUND');
  });

  it('returns 404 for unknown single client and unknown delete target', async () => {
    expect((await api('/api/clients/fp-x/no-such-name', { headers: await adminHeaders() })).status).toBe(404);
    const del = await api('/api/clients/fp-x/no-such-name', {
      method: 'DELETE',
      headers: await adminHeaders(),
    });
    expect(del.status).toBe(404);
  });

  it('upsert returns 201 on create and 200 on update, preserving created_at', async () => {
    const first = await putClient('fp-upsert', 'cfg', { config: { tag: 't1' } });
    expect(first.status).toBe(201);
    const created = first.body.client.created_at;

    const second = await putClient('fp-upsert', 'cfg', { config: { tag: 't1' } });
    expect(second.status).toBe(200);
    expect(second.body.client.created_at).toBe(created);
  });

  it('rejects a same-node port conflict (409 PORT_CONFLICT)', async () => {
    await putClient('fp-ports', 'a', { config: { tag: 'pa', server_port: 8443 } });
    const conflict = await putClient('fp-ports', 'b', { config: { tag: 'pb', server_port: 8443 } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('PORT_CONFLICT');
    expect(conflict.body.error.message).toContain('a');

    // Same port on a DIFFERENT node is fine.
    const otherNode = await putClient('fp-ports-2', 'c', { config: { tag: 'pc', server_port: 8443 } });
    expect(otherNode.status).toBe(201);

    // Updating config 'a' itself must not self-conflict.
    const self = await putClient('fp-ports', 'a', { config: { tag: 'pa', server_port: 8443 } });
    expect(self.status).toBe(200);
  });

  it('maintains the tag index across re-tagging and releases claims on delete', async () => {
    await putClient('fp-tag', 'cfg', { config: { tag: 'old-tag' } });
    expect(await (env as any).CLIENT_CONFIGS.get('tag:old-tag')).toBe('fp-tag:cfg');

    // Re-tag: new claim created, old claim released.
    await putClient('fp-tag', 'cfg', { config: { tag: 'new-tag' } });
    expect(await (env as any).CLIENT_CONFIGS.get('tag:new-tag')).toBe('fp-tag:cfg');
    expect(await (env as any).CLIENT_CONFIGS.get('tag:old-tag')).toBeNull();

    // Delete: claim released so the tag becomes claimable again.
    const del = await api('/api/clients/fp-tag/cfg', {
      method: 'DELETE',
      headers: await adminHeaders(),
    });
    expect(del.status).toBe(200);
    expect(await (env as any).CLIENT_CONFIGS.get('tag:new-tag')).toBeNull();
  });
});
