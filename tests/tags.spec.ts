import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase, resetDatabaseInitCache } from '../src/db/schema';
import { resetRegistryCache } from '../src/engine/registry';
import { adminHeaders, api, createInstance, createNode, createSimpleProtocol, jsonBody } from './helpers';

// D1 storage is reset per test while module state persists in the single
// worker — drop the init memo so every test re-runs the schema setup.
beforeEach(() => {
  resetDatabaseInitCache();
  resetRegistryCache(); // 30s shared template cache must not outlive the per-test D1 reset
});

async function checkTag(tag: string): Promise<{ status: number; body: any }> {
  const res = await api(`/api/tags/check?tag=${encodeURIComponent(tag)}`, {
    headers: await adminHeaders(),
  });
  return { status: res.status, body: await jsonBody(res) };
}

describe('GET /api/tags/check', () => {
  it('requires auth', async () => {
    const res = await api('/api/tags/check?tag=some-tag');
    expect(res.status).toBe(401);
  });

  it('returns 400 TAG_REQUIRED without the tag query param', async () => {
    const res = await api('/api/tags/check', { headers: await adminHeaders() });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error.code).toBe('TAG_REQUIRED');
  });

  it('returns available:true for an unknown tag', async () => {
    const { status, body } = await checkTag('fresh-tag');
    expect(status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.tag).toBe('fresh-tag');
  });

  it('detects tags claimed by a protocol instance via the indexed tag column', async () => {
    await createSimpleProtocol('tag-proto');
    const node = await createNode();
    await createInstance('tag-proto', node.id, { domain: 'x.test', tag: 'claimed-tag' });

    const { status, body } = await checkTag('claimed-tag');
    expect(status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.source).toBe('protocol_instances');
  });

  it('self-heals legacy instance rows (tag column empty) via the LIKE probe', async () => {
    // Direct D1 access bypasses the app middleware, so initialize the schema
    // explicitly (beforeEach only dropped the init memo).
    await initializeDatabase((env as any).DB);
    // Simulate a pre-migration-0010 row: params hold the tag, the indexed
    // column is empty. FKs require real parent rows.
    await createSimpleProtocol('legacy-proto');
    const node = await createNode();
    await (env as any).DB.prepare(
      "INSERT INTO protocol_instances (id, protocol_id, node_id, params, server_config, client_config, status, tag) VALUES (?, 'legacy-proto', ?, ?, '{}', '{}', 'active', '')",
    ).bind('legacy-inst', node.id, JSON.stringify({ tag: 'legacy-tag' })).run();

    const { status, body } = await checkTag('legacy-tag');
    expect(status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.source).toBe('protocol_instances');

    // The probe backfills the indexed column so the LIKE scan converges to zero.
    const row = await (env as any).DB.prepare('SELECT tag FROM protocol_instances WHERE id = ?')
      .bind('legacy-inst')
      .first() as { tag: string } | null;
    expect(row?.tag).toBe('legacy-tag');
  });

  it('detects tags via the O(1) KV index written on client upload', async () => {
    const res = await api('/api/clients/fp-tag/conf-a', {
      method: 'PUT',
      headers: await adminHeaders(),
      body: JSON.stringify({ config: { tag: 'kv-tag' }, protocol_type: 'vless' }),
    });
    expect(res.status).toBe(201);

    const { status, body } = await checkTag('kv-tag');
    expect(status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.source).toBe('kv_client_configs');
  });

  it('falls back to scanning legacy KV client records and backfills the index', async () => {
    // Legacy-format record written before the index existed.
    await (env as any).CLIENT_CONFIGS.put(
      'client:legacyfp:legacy-name',
      JSON.stringify({ name: 'legacy-name', fingerprint: 'legacyfp', config: { tag: 'kv-legacy-tag' } }),
    );

    const { status, body } = await checkTag('kv-legacy-tag');
    expect(status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.source).toBe('kv_client_configs');

    // The fallback scan self-heals the O(1) index.
    expect(await (env as any).CLIENT_CONFIGS.get('tag:kv-legacy-tag')).toBe('legacyfp:legacy-name');
  });

  it('treats legacy single-segment KV keys as non-scannable', async () => {
    // Pre-fingerprint keys (`client:{name}`) are skipped by the scan filter.
    await (env as any).CLIENT_CONFIGS.put(
      'client:oldstyle',
      JSON.stringify({ config: { tag: 'single-segment-tag' } }),
    );

    const { status, body } = await checkTag('single-segment-tag');
    expect(status).toBe(200);
    expect(body.available).toBe(true);
  });
});
