import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginRegistry, resetRegistryCache } from '../../src/engine/registry';

function makeMockDB(templateRows: any[]): D1Database {
  return {
    prepare: vi.fn().mockImplementation((sql: string) => {
      const rows = sql.includes('FROM templates') ? templateRows : [];
      return {
        all: vi.fn().mockResolvedValue({ results: rows }),
        first: vi.fn().mockResolvedValue(rows[0] ?? null),
        run: vi.fn().mockResolvedValue({ success: true }),
        bind: vi.fn().mockReturnThis(),
      };
    }),
    exec: vi.fn().mockResolvedValue(undefined),
    batch: vi.fn().mockResolvedValue([{ results: templateRows }]),
    dump: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
  } as any as D1Database;
}

const HY2_PROTO_ROW = {
  id: 'hysteria2',
  category: 'protocol',
  name: 'Hysteria2',
  version: '1.0.0',
  server_template: JSON.stringify({ listen: '{{ params.port }}', tag: '{{ params.tag }}' }),
  client_template: JSON.stringify({ tag: '{{ params.tag }}' }),
  template_content: null,
  config: null,
  entry_script: null,
  params: JSON.stringify([
    { name: 'port', type: 'number', required: false, default: 443 },
    { name: 'tag', type: 'string', required: false, generator: 'hex:8' },
  ]),
  description: null,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
};

const DEFAULT_SERVER_ROW = {
  id: 'server-default',
  category: 'overall-server',
  name: 'Default Server',
  version: '1.0.0',
  server_template: null,
  client_template: null,
  template_content: JSON.stringify({ outbounds: [{ type: 'direct', tag: 'direct' }] }),
  config: null,
  entry_script: null,
  params: '[]',
  description: null,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
};

const DEFAULT_DOCKER_ROW = {
  id: 'docker-default',
  category: 'overall-docker',
  name: 'Default Docker',
  version: '1.0.0',
  server_template: null,
  client_template: null,
  template_content: JSON.stringify({ services: { app: { image: 'busybox' } } }),
  config: null,
  entry_script: '#!/bin/sh\necho ok',
  params: '[]',
  description: null,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
};

describe('PluginRegistry', () => {
  let registry: PluginRegistry;

  beforeEach(async () => {
    resetRegistryCache(); // shared module cache must not leak across mock DBs
    const db = makeMockDB([HY2_PROTO_ROW, DEFAULT_SERVER_ROW, DEFAULT_DOCKER_ROW]);
    registry = new PluginRegistry(db);
    await registry.loadAll();
  });

  it('loads protocols and overall templates', () => {
    expect(registry.getProtocol('hysteria2')).toBeDefined();
    expect(registry.getOverallTemplate('server-default')).toBeDefined();
    expect(registry.getOverallTemplate('docker-default')).toBeDefined();
  });

  it('size() returns counts for each cache', () => {
    const s = registry.size();
    expect(s.protocols).toBe(1);
    expect(s.overalls).toBe(2);
  });

  it('renderProtocolInstance uses protocol params + templates', async () => {
    const result = await registry.renderProtocolInstance('hysteria2', { port: 8443 });
    expect(result).toBeDefined();
    expect(result.serverConfig).toBeDefined();
    expect((result.serverConfig as any).listen).toBe(8443);
    expect(result.clientConfig).toBeDefined();
  });

  it('renderDocker uses overall docker template', async () => {
    const result = await registry.renderDocker('docker-default', {});
    expect(result).toBeDefined();
    expect(result.composeYaml).toContain('image: busybox');
    expect(result.entrySh).toContain('#!/bin/sh');
  });

  it('throws when unknown protocol', async () => {
    await expect(registry.renderProtocolInstance('nonexistent', {})).rejects.toMatchObject({ code: 'PLG_UNKNOWN_TYPE' });
  });

  it('loadAll is idempotent', async () => {
    resetRegistryCache(); // beforeEach already warmed the shared cache
    const db = makeMockDB([HY2_PROTO_ROW, DEFAULT_SERVER_ROW]);
    const reg = new PluginRegistry(db);
    await reg.loadAll();
    await reg.loadAll();
    expect((db.prepare as any).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('renderServerOverall combines protocol instances', async () => {
    resetRegistryCache(); // beforeEach already warmed the shared cache
    const instances = [
      { id: 'inst-1', serverConfig: { type: 'vless', port: 443 } as Record<string, unknown>, clientConfig: {} },
      { id: 'inst-2', serverConfig: { type: 'hysteria2', port: 8443 } as Record<string, unknown>, clientConfig: {} },
    ];
    const templateObj = { inbounds: '{{ protocols }}' };
    const templateContent = JSON.stringify(templateObj);
    const db = makeMockDB([{
      id: 'server-default',
      category: 'overall-server',
      name: 'Default Server',
      version: '1.0.0',
      server_template: null,
      client_template: null,
      template_content: templateContent,
      config: JSON.stringify({ params: [] }),
      entry_script: null,
      params: '[]',
      description: null,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    }]);
    const reg = new PluginRegistry(db);
    await reg.loadAll();
    const result = await reg.renderServerOverall(instances, 'server-default', {});
    expect(result).toBeDefined();
    expect(result.inbounds).toBeDefined();
    expect(Array.isArray(result.inbounds)).toBe(true);
    expect(result.inbounds).toHaveLength(2);
  });
});
