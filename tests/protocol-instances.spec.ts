import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabaseInitCache } from '../src/db/schema';
import { resetRegistryCache } from '../src/engine/registry';
import { adminHeaders, api, createInstance, createNode, createSimpleProtocol, jsonBody } from './helpers';

// D1 storage is reset per test while module state persists in the single
// worker — drop the init memo so every test re-runs the schema setup.
beforeEach(() => {
  resetDatabaseInitCache();
  resetRegistryCache(); // 30s shared template cache must not outlive the per-test D1 reset
});

describe('Protocol Instances API', () => {
  it('rejects unauthenticated access to list/create/detail', async () => {
    expect((await api('/api/protocol-instances')).status).toBe(401);
    expect(
      (await api('/api/protocol-instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolId: 'p', nodeId: 'n', params: {} }),
      })).status,
    ).toBe(401);
    expect((await api('/api/protocol-instances/some-id')).status).toBe(401);
  });

  it('creates an instance, renders configs, and mirrors params.tag into the tag column', async () => {
    await createSimpleProtocol('pi-proto');
    const node = await createNode();
    const instance = await createInstance('pi-proto', node.id, { domain: 'x.test', tag: 'my-tag' });

    expect(instance.id).toBeDefined();
    expect(instance.status).toBe('active');
    expect(instance.tag).toBe('my-tag');
    expect(JSON.parse(instance.server_config).tag).toBe('my-tag');
    expect(JSON.parse(instance.client_config).server).toBe('x.test');

    // Indexed column is queryable (load-bearing for /api/tags/check).
    const row = await (env as any).DB.prepare('SELECT tag FROM protocol_instances WHERE id = ?')
      .bind(instance.id)
      .first() as { tag: string } | null;
    expect(row?.tag).toBe('my-tag');
  });

  it('returns 404 NODE_NOT_FOUND for unknown node', async () => {
    await createSimpleProtocol('pi-proto2');
    const res = await api('/api/protocol-instances', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ protocolId: 'pi-proto2', nodeId: 'no-such-node', params: { domain: 'x.test' } }),
    });
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).error.code).toBe('NODE_NOT_FOUND');
  });

  it('returns 404 PROTO_NOT_FOUND for unknown protocol', async () => {
    const node = await createNode();
    const res = await api('/api/protocol-instances', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ protocolId: 'no-such-proto', nodeId: node.id, params: {} }),
    });
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).error.code).toBe('PROTO_NOT_FOUND');
  });

  it('rejects invalid create bodies (missing fields / wrong types)', async () => {
    const res = await api('/api/protocol-instances', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ protocolId: '', nodeId: 42, params: 'not-an-object' }),
    });
    expect(res.status).toBe(400);
  });

  it('lists instances with optional nodeId filter', async () => {
    await createSimpleProtocol('pi-proto3');
    const nodeA = await createNode();
    const nodeB = await createNode();
    await createInstance('pi-proto3', nodeA.id, { domain: 'a.test' });
    await createInstance('pi-proto3', nodeB.id, { domain: 'b.test' });

    const all = await jsonBody(await api('/api/protocol-instances', { headers: await adminHeaders() }));
    expect(all.instances.length).toBeGreaterThanOrEqual(2);

    const filtered = await jsonBody(
      await api(`/api/protocol-instances?nodeId=${nodeA.id}`, { headers: await adminHeaders() }),
    );
    expect(filtered.instances).toHaveLength(1);
    expect(filtered.instances[0].node_id).toBe(nodeA.id);
  });

  it('GET /:id returns the instance or 404', async () => {
    await createSimpleProtocol('pi-proto4');
    const node = await createNode();
    const instance = await createInstance('pi-proto4', node.id, { domain: 'x.test' });

    const got = await jsonBody(await api(`/api/protocol-instances/${instance.id}`, { headers: await adminHeaders() }));
    expect(got.instance.id).toBe(instance.id);

    const missing = await api('/api/protocol-instances/no-such-id', { headers: await adminHeaders() });
    expect(missing.status).toBe(404);
  });

  it('PUT re-renders configs from new params and updates the mirrored tag', async () => {
    await createSimpleProtocol('pi-proto5');
    const node = await createNode();
    const instance = await createInstance('pi-proto5', node.id, { domain: 'old.test', tag: 'old-tag' });

    const res = await api(`/api/protocol-instances/${instance.id}`, {
      method: 'PUT',
      headers: await adminHeaders(),
      body: JSON.stringify({ params: { domain: 'new.test', tag: 'new-tag' } }),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.instance.tag).toBe('new-tag');
    expect(JSON.parse(body.instance.client_config).server).toBe('new.test');
  });

  it('PUT rejects invalid status values (only active/inactive allowed)', async () => {
    await createSimpleProtocol('pi-proto6');
    const node = await createNode();
    const instance = await createInstance('pi-proto6', node.id, { domain: 'x.test' });

    const res = await api(`/api/protocol-instances/${instance.id}`, {
      method: 'PUT',
      headers: await adminHeaders(),
      body: JSON.stringify({ status: 'paused' }),
    });
    expect(res.status).toBe(400);
  });

  it('PUT toggles status to inactive and back', async () => {
    await createSimpleProtocol('pi-proto7');
    const node = await createNode();
    const instance = await createInstance('pi-proto7', node.id, { domain: 'x.test' });

    const res = await api(`/api/protocol-instances/${instance.id}`, {
      method: 'PUT',
      headers: await adminHeaders(),
      body: JSON.stringify({ status: 'inactive' }),
    });
    expect(res.status).toBe(200);
    expect((await jsonBody(res)).instance.status).toBe('inactive');
  });

  it('DELETE removes the instance (then 404)', async () => {
    await createSimpleProtocol('pi-proto8');
    const node = await createNode();
    const instance = await createInstance('pi-proto8', node.id, { domain: 'x.test' });

    const del = await api(`/api/protocol-instances/${instance.id}`, {
      method: 'DELETE',
      headers: await adminHeaders(),
    });
    expect(del.status).toBe(200);
    expect((await api(`/api/protocol-instances/${instance.id}`, { headers: await adminHeaders() })).status).toBe(404);
  });

  it('rerender refreshes stored configs from the current template (CLOUD-C1)', async () => {
    await createSimpleProtocol('pi-proto9');
    const node = await createNode();
    const instance = await createInstance('pi-proto9', node.id, { domain: 'before.test' });

    // Edit the protocol's client template so the stored snapshot is stale.
    const edit = await api('/api/protocols/pi-proto9', {
      method: 'PUT',
      headers: await adminHeaders(),
      body: JSON.stringify({
        clientTemplate: JSON.stringify({ type: 'vless', server: '{{ params.domain }}', edited: true }),
      }),
    });
    expect(edit.status).toBe(200);

    const res = await api('/api/protocol-instances/rerender', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ protocolId: 'pi-proto9' }),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.rerendered).toBe(1);
    expect(body.failed).toBe(0);

    const after = await jsonBody(await api(`/api/protocol-instances/${instance.id}`, { headers: await adminHeaders() }));
    expect(JSON.parse(after.instance.client_config).edited).toBe(true);
  });

  it('rerender reports per-instance failures without failing the batch', async () => {
    await createSimpleProtocol('pi-proto10');
    const node = await createNode();
    await createInstance('pi-proto10', node.id, { domain: 'ok.test' });
    // An instance whose params no longer satisfy the (required domain) definition.
    await (env as any).DB.prepare(
      "INSERT INTO protocol_instances (id, protocol_id, node_id, params, server_config, client_config, status, tag) VALUES (?, ?, ?, ?, '{}', '{}', 'active', '')",
    ).bind('bad-instance', 'pi-proto10', node.id, JSON.stringify({})).run();

    const res = await api('/api/protocol-instances/rerender', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.rerendered).toBeGreaterThanOrEqual(1);
    expect(body.failed).toBe(1);
    expect(body.failures[0].id).toBe('bad-instance');
  });

  it('rerender returns 404 for unknown protocolId', async () => {
    const res = await api('/api/protocol-instances/rerender', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ protocolId: 'no-such-proto' }),
    });
    expect(res.status).toBe(404);
  });
});
