import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabaseInitCache } from '../src/db/schema';
import { resetRegistryCache } from '../src/engine/registry';
import { adminHeaders, api, createInstance, createSimpleProtocol, jsonBody } from './helpers';

// D1 storage is reset per test while module state persists in the single
// worker — drop the init memo so every test re-runs the schema setup.
beforeEach(() => {
  resetDatabaseInitCache();
  resetRegistryCache(); // 30s shared template cache must not outlive the per-test D1 reset
});

describe('Nodes API', () => {
  it('requires auth for every operation', async () => {
    expect((await api('/api/nodes')).status).toBe(401);
    expect((await api('/api/nodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await api('/api/nodes/some-id', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await api('/api/nodes/some-id', { method: 'DELETE' })).status).toBe(401);
  });

  it('rejects invalid create bodies (empty name)', async () => {
    const res = await api('/api/nodes', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /:id returns the node or 404', async () => {
    const created = await jsonBody(await api('/api/nodes', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ name: 'detail-node', hostname: 'h.example.com' }),
    }));
    expect(created.status ?? 201).toBe(201);

    const got = await jsonBody(await api(`/api/nodes/${created.node.id}`, { headers: await adminHeaders() }));
    expect(got.node.name).toBe('detail-node');
    expect(got.node.hostname).toBe('h.example.com');

    expect((await api('/api/nodes/no-such-id', { headers: await adminHeaders() })).status).toBe(404);
  });

  it('PUT updates fields, including serverParams JSON serialization', async () => {
    const created = await jsonBody(await api('/api/nodes', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ name: 'put-node' }),
    }));
    const id = created.node.id;

    const put = await api(`/api/nodes/${id}`, {
      method: 'PUT',
      headers: await adminHeaders(),
      body: JSON.stringify({ hostname: 'new.example.com', serverParams: { mtu: 9000 } }),
    });
    expect(put.status).toBe(200);
    const body = await jsonBody(put);
    expect(body.node.hostname).toBe('new.example.com');
    expect(JSON.parse(body.node.server_params)).toEqual({ mtu: 9000 });

    // Unchanged fields survive a partial update.
    expect(body.node.name).toBe('put-node');
  });

  it('PUT returns 404 for unknown node', async () => {
    const res = await api('/api/nodes/no-such-id', {
      method: 'PUT',
      headers: await adminHeaders(),
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('DELETE cascades to protocol_instances (dangling rows would keep being delivered)', async () => {
    await createSimpleProtocol('cascade-proto');
    const created = await jsonBody(await api('/api/nodes', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ name: 'cascade-node' }),
    }));
    const nodeId = created.node.id;
    const instance = await createInstance('cascade-proto', nodeId, { domain: 'c.test' });

    const del = await api(`/api/nodes/${nodeId}`, {
      method: 'DELETE',
      headers: await adminHeaders(),
    });
    expect(del.status).toBe(200);

    expect((await api(`/api/nodes/${nodeId}`, { headers: await adminHeaders() })).status).toBe(404);

    // The instance must be gone too, not orphaned.
    const remaining = await jsonBody(
      await api(`/api/protocol-instances?nodeId=${nodeId}`, { headers: await adminHeaders() }),
    );
    expect(remaining.instances).toHaveLength(0);
    expect((await api(`/api/protocol-instances/${instance.id}`, { headers: await adminHeaders() })).status).toBe(404);
  });
});

describe('Users API', () => {
  it('rejects unauthenticated access', async () => {
    expect((await api('/api/users')).status).toBe(401);
    expect((await api('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"x"}' })).status).toBe(401);
    expect((await api('/api/users/some-id/token', { method: 'POST' })).status).toBe(401);
  });

  it('rejects invalid create bodies (bad subscription_url)', async () => {
    const res = await api('/api/users', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ name: 'Bad', subscription_url: 'not-a-url' }),
    });
    expect(res.status).toBe(400);
  });

  it('creates a user without exposing the raw token', async () => {
    const res = await api('/api/users', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ name: 'Token User' }),
    });
    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.user.id).toBeDefined();
    // Token material must never leak through list/detail payloads.
    expect(JSON.stringify(body)).not.toContain('token');
  });

  it('GET /:id returns the user or 404', async () => {
    const created = await jsonBody(await api('/api/users', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ name: 'Get Me' }),
    }));
    const id = created.user.id;

    const got = await jsonBody(await api(`/api/users/${id}`, { headers: await adminHeaders() }));
    expect(got.user.name).toBe('Get Me');
    expect((await api('/api/users/no-such-user', { headers: await adminHeaders() })).status).toBe(404);
  });

  it('PUT updates name and subscription_url', async () => {
    const created = await jsonBody(await api('/api/users', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ name: 'Put Me' }),
    }));
    const id = created.user.id;

    const put = await api(`/api/users/${id}`, {
      method: 'PUT',
      headers: await adminHeaders(),
      body: JSON.stringify({ name: 'Updated', subscription_url: 'https://example.com/s/x' }),
    });
    expect(put.status).toBe(200);
    const body = await jsonBody(put);
    expect(body.user.name).toBe('Updated');
    expect(body.user.subscription_url).toBe('https://example.com/s/x');
  });

  it('issues a 30d user JWT via POST /:id/token', async () => {
    const created = await jsonBody(await api('/api/users', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ name: 'Token Holder' }),
    }));
    const id = created.user.id;

    const res = await api(`/api/users/${id}/token`, {
      method: 'POST',
      headers: await adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.tokenType).toBe('Bearer');
    expect(body.expiresIn).toBe(30 * 86_400);
    expect(body.accessToken.split('.')).toHaveLength(3);
  });

  it('token issuance returns 404 for unknown user', async () => {
    const res = await api('/api/users/no-such-user/token', {
      method: 'POST',
      headers: await adminHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it('DELETE removes the user and revokes its tokens', async () => {
    const created = await jsonBody(await api('/api/users', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ name: 'Doomed' }),
    }));
    const id = created.user.id;
    await api(`/api/users/${id}/token`, { method: 'POST', headers: await adminHeaders() });

    const del = await api(`/api/users/${id}`, {
      method: 'DELETE',
      headers: await adminHeaders(),
    });
    expect(del.status).toBe(200);
    expect((await api(`/api/users/${id}`, { headers: await adminHeaders() })).status).toBe(404);

    // All tokens of the user are marked revoked in D1.
    const revoked = await (env as any).DB.prepare(
      'SELECT COUNT(*) as count FROM tokens WHERE subject = ? AND type = ? AND revoked = 1',
    ).bind(id, 'user').first() as { count: number } | null;
    expect(revoked?.count).toBeGreaterThan(0);
  });
});
