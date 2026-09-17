import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabaseInitCache } from '../src/db/schema';
import { resetRegistryCache } from '../src/engine/registry';
import { adminHeaders, api, createInstance, createNode, jsonBody, seed } from './helpers';

// D1 storage is reset per test while module state persists in the single
// worker — drop the init memo so every test re-runs the schema setup.
beforeEach(() => {
  resetDatabaseInitCache();
  resetRegistryCache(); // 30s shared template cache must not outlive the per-test D1 reset
});

describe('POST /api/render (dry-run protocol rendering)', () => {
  it('requires auth', async () => {
    const res = await api('/api/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolId: 'hysteria2' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 INVALID_JSON for a malformed body', async () => {
    const res = await api('/api/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await adminHeaders()) },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error.code).toBe('INVALID_JSON');
  });

  it('returns 400 PROTOCOL_ID_REQUIRED when protocolId is missing', async () => {
    const res = await api('/api/render', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ params: {} }),
    });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error.code).toBe('PROTOCOL_ID_REQUIRED');
  });

  it('renders server and client configs for a seeded protocol', async () => {
    await seed();
    const res = await api('/api/render', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({
        protocolId: 'hysteria2',
        params: { domain: 'render.example.com', port: 8443 },
      }),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.serverConfig).toBeDefined();
    expect(body.clientConfig).toBeDefined();
    expect(JSON.stringify(body.serverConfig)).not.toContain('{{');
  });

  it('maps PluginError from an unknown protocol to 400', async () => {
    await seed(); // ensure the templates table exists but lacks the protocol
    const res = await api('/api/render', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ protocolId: 'no-such-proto', params: {} }),
    });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error.code).toBe('PLG_UNKNOWN_TYPE');
  });
});

describe('POST /api/render/deploy', () => {
  it('requires auth', async () => {
    const res = await api('/api/render/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instances: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 INSTANCES_REQUIRED for an empty instance list', async () => {
    const res = await api('/api/render/deploy', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ instances: [] }),
    });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error.code).toBe('INSTANCES_REQUIRED');
  });

  it('returns 400 INVALID_JSON for a malformed body', async () => {
    const res = await api('/api/render/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await adminHeaders()) },
      body: '{oops',
    });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error.code).toBe('INVALID_JSON');
  });

  it('renders the full deploy artifact set from cloud-side templates', async () => {
    await seed();
    const node = await createNode();
    await createInstance('hysteria2', node.id, { domain: 'deploy.example.com', port: 8443 });
    const list = await jsonBody(
      await api(`/api/protocol-instances?nodeId=${node.id}`, { headers: await adminHeaders() }),
    );
    const instances = list.instances.map((row: any) => ({
      id: row.id,
      serverConfig: JSON.parse(row.server_config),
      clientConfig: JSON.parse(row.client_config),
    }));

    const res = await api('/api/render/deploy', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ instances, serverOverallId: 'server-default', dockerOverallId: 'docker-default' }),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.serverConfig.inbounds).toHaveLength(1);
    expect(typeof body.composeYaml).toBe('string');
    expect(body.composeYaml).toContain('services:');
    expect(typeof body.entrySh).toBe('string');
  });
});

describe('POST /api/render/overall', () => {
  const instances = [
    { id: 'i1', serverConfig: { type: 'vless', listen_port: 443 }, clientConfig: { tag: 'proxy-a', type: 'vless' } },
    { id: 'i2', serverConfig: { type: 'hysteria2', listen_port: 8443 }, clientConfig: { tag: 'proxy-b', type: 'hysteria2' } },
  ];

  it('requires auth', async () => {
    const res = await api('/api/render/overall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'server', templateId: 'server-default' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 TEMPLATE_ID_REQUIRED without templateId', async () => {
    const res = await api('/api/render/overall', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ category: 'server' }),
    });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error.code).toBe('TEMPLATE_ID_REQUIRED');
  });

  it('returns 400 INVALID_CATEGORY for an unknown category', async () => {
    const res = await api('/api/render/overall', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ category: 'network', templateId: 'x' }),
    });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error.code).toBe('INVALID_CATEGORY');
  });

  it('renders a server overall with spliced protocol inbounds', async () => {
    await seed();
    const res = await api('/api/render/overall', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ category: 'server', templateId: 'server-default', instances }),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.serverConfig.inbounds).toHaveLength(2);
    expect(JSON.stringify(body.serverConfig)).not.toContain('{{');
  });

  it('renders a client overall with spliced proxy outbounds', async () => {
    await seed();
    const res = await api('/api/render/overall', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ category: 'client', templateId: 'client-default', instances }),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    const tags = body.clientConfig.outbounds.map((o: any) => o.tag);
    expect(tags).toContain('proxy-a');
    expect(tags).toContain('proxy-b');
  });

  it('renders docker compose + entry script', async () => {
    await seed();
    const res = await api('/api/render/overall', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ category: 'docker', templateId: 'docker-default' }),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.composeYaml).toContain('services:');
    expect(typeof body.entrySh).toBe('string');
  });

  it('maps PluginError (unknown template) to 400', async () => {
    await seed();
    const res = await api('/api/render/overall', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ category: 'server', templateId: 'no-such-template', instances }),
    });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error.code).toBe('PLG_UNKNOWN_TYPE');
  });
});
