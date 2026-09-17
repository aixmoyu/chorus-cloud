import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabaseInitCache } from '../src/db/schema';
import { resetRegistryCache } from '../src/engine/registry';
import { adminHeaders, api, createSimpleProtocol, jsonBody, seed } from './helpers';

/**
 * core-D4 / CLOUD-D2 — @chorus/core ↔ chorus-cloud HTTP contract lock.
 *
 * Locks the exact request/response field names that packages/core's
 * CloudClient/ChorusCore depend on:
 *   - uploadNodeClient → PUT /api/clients/:fp/:name body
 *   - toRemoteEntry / syncAllToCloud → fields read back from client records
 *   - getNodeClients → 404 semantics (mapped to an empty list)
 *   - deleteNodeClient → DELETE /:fp/:name semantics
 *   - renderProtocol → POST /api/render response keys
 *   - renderDeploy → POST /api/render/deploy response keys
 *
 * A failure here means a cloud-side rename is about to silently break panel
 * sync/deploy — change core and cloud together in the same commit.
 */

// D1 storage is reset per test while module state persists in the single
// worker — drop the init memo so every test re-runs the schema setup, and
// drop the 30s shared template cache so it can't outlive the D1 reset.
beforeEach(() => {
  resetDatabaseInitCache();
  resetRegistryCache();
});

/** The exact body CloudClient.uploadNodeClient sends (cloud-client.ts). */
async function putAsCoreWould(fp: string, name: string): Promise<Response> {
  return api(`/api/clients/${fp}/${name}`, {
    method: 'PUT',
    headers: await adminHeaders(),
    body: JSON.stringify({
      config: { tag: name, server_port: 9000 },
      protocol_type: 'vless',
      content_hash: 'hash-1',
      enabled: true,
      deployed: false,
    }),
  });
}

describe('Contract: /api/clients (core CloudClient)', () => {
  it('PUT /:fingerprint/:name accepts the exact uploadNodeClient body and echoes every field toRemoteEntry/cloudMap reads', async () => {
    const res = await putAsCoreWould('fp-contract', 'cfg-a');
    expect(res.status).toBe(201);
    const { client } = await jsonBody<{ client: Record<string, unknown> }>(res);
    for (const key of [
      'name', 'fingerprint', 'config', 'protocol_type', 'content_hash',
      'enabled', 'deployed', 'created_at', 'updated_at',
    ]) {
      expect(client).toHaveProperty(key);
    }
    expect(client.name).toBe('cfg-a');
    expect(client.fingerprint).toBe('fp-contract');
    expect(client.content_hash).toBe('hash-1');
  });

  it('GET / returns metadata entries carrying fingerprint+name (syncAllToCloud reconciliation keys)', async () => {
    await putAsCoreWould('fp-contract', 'cfg-a');
    const res = await api('/api/clients', { headers: await adminHeaders() });
    expect(res.status).toBe(200);
    const { clients } = await jsonBody<{ clients: Record<string, unknown>[] }>(res);
    const entry = clients.find((c) => c.name === 'cfg-a');
    expect(entry).toBeDefined();
    for (const key of [
      'name', 'fingerprint', 'protocol_type', 'content_hash',
      'enabled', 'deployed', 'created_at', 'updated_at',
    ]) {
      expect(entry).toHaveProperty(key);
    }
    expect(entry!.fingerprint).toBe('fp-contract');
  });

  it('GET /:fingerprint returns full records including the config body (toRemoteEntry source)', async () => {
    await putAsCoreWould('fp-contract', 'cfg-a');
    const res = await api('/api/clients/fp-contract', { headers: await adminHeaders() });
    expect(res.status).toBe(200);
    const { clients } = await jsonBody<{ clients: Record<string, unknown>[] }>(res);
    const entry = clients.find((c) => c.name === 'cfg-a');
    expect(entry).toBeDefined();
    expect((entry!.config as Record<string, unknown>).tag).toBe('cfg-a');
    expect(entry!.protocol_type).toBe('vless');
    expect(entry!.content_hash).toBe('hash-1');
  });

  it('unknown fingerprint → 404 CLIENT_NOT_FOUND (getNodeClients maps 404 to an empty list)', async () => {
    const res = await api('/api/clients/fp-ghost', { headers: await adminHeaders() });
    expect(res.status).toBe(404);
    expect((await jsonBody<{ error: { code: string } }>(res)).error.code).toBe('CLIENT_NOT_FOUND');
  });

  it('DELETE /:fingerprint/:name returns <400 (deleteNodeClient treats anything else as failure)', async () => {
    await putAsCoreWould('fp-contract', 'cfg-a');
    const res = await api('/api/clients/fp-contract/cfg-a', {
      method: 'DELETE',
      headers: await adminHeaders(),
    });
    expect(res.status).toBeLessThan(400);
  });
});

describe('Contract: /api/render (core renderProtocol / renderDeploy)', () => {
  it('POST / responds with camelCase serverConfig/clientConfig (renderProtocol accepts both namings)', async () => {
    await createSimpleProtocol('contract-proto');
    const res = await api('/api/render', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ protocolId: 'contract-proto', params: { domain: 'example.com' } }),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody<{ serverConfig: Record<string, unknown>; clientConfig: Record<string, unknown> }>(res);
    expect(body.serverConfig).toBeDefined();
    expect(body.clientConfig).toBeDefined();
    expect((body.clientConfig as Record<string, unknown>).server).toBe('example.com');
  });

  it('POST /render/deploy responds with serverConfig/composeYaml/entrySh (renderDeploy source)', async () => {
    await seed();
    const res = await api('/api/render/deploy', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({
        instances: [{ id: 'cfg-a', serverConfig: { type: 'vless' }, clientConfig: { tag: 'cfg-a' } }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody<{ serverConfig: unknown; composeYaml: string; entrySh: string }>(res);
    expect(body).toHaveProperty('serverConfig');
    expect(typeof body.composeYaml).toBe('string');
    expect(typeof body.entrySh).toBe('string');
  });
});
