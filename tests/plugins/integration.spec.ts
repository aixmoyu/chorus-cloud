import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginRegistry } from '../../src/engine/registry';

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

const vlessProtocolRow = {
  id: 'vless-reality-vision',
  category: 'protocol',
  name: 'VLESS Reality Vision',
  version: '1.0.0',
  server_template: JSON.stringify({
    type: 'vless',
    tag: '{{ params.tag }}',
    listen: '::',
    listen_port: '{{ params.port }}',
    tls: { enabled: true, reality: { enabled: true, private_key: '{{ params.realityKeyPair.privateKey }}' } },
  }),
  client_template: JSON.stringify({
    type: 'vless',
    tag: '{{ params.tag }}',
    server: '{{ params.domain }}',
    server_port: '{{ params.port }}',
    uuid: '{{ params.uuid }}',
    tls: { enabled: true, reality: { enabled: true, public_key: '{{ params.realityKeyPair.publicKey }}' } },
  }),
  template_content: null,
  config: null,
  entry_script: null,
  params: JSON.stringify([
    { name: 'domain', type: 'string', required: true },
    { name: 'port', type: 'number', required: false, default: 443 },
    { name: 'tag', type: 'string', required: false, default: 'vless' },
    { name: 'uuid', type: 'string', required: false, generator: 'uuid' },
    { name: 'realityServerName', type: 'string', required: false, default: 'update.microsoft.com' },
    { name: 'realityKeyPair', type: 'string', required: false, generator: 'x25519_keypair' },
    { name: 'realityShortID', type: 'string', required: false, generator: 'hex:8' },
    { name: 'domainStrategy', type: 'string', required: false, default: 'prefer_ipv4' },
  ]),
  description: 'VLESS protocol with Reality TLS',
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
};

const defaultServerRow = {
  id: 'server-default',
  category: 'overall-server',
  name: 'Default Server',
  version: '1.0.0',
  server_template: null,
  client_template: null,
  template_content: JSON.stringify({
    log: { level: 'info' },
    inbounds: '"{{ protocols }}"',
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { rules: [], final: 'direct' },
  }),
  config: JSON.stringify({ params: [] }),
  entry_script: null,
  params: '[]',
  description: null,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
};

const defaultDockerRow = {
  id: 'docker-default',
  category: 'overall-docker',
  name: 'Default Docker',
  version: '1.0.0',
  server_template: null,
  client_template: null,
  template_content: JSON.stringify({ version: '3.8', services: { 'sing-box': { image: 'busybox', ports: ['443:443'] } } }),
  config: null,
  entry_script: '#!/bin/sh\nsing-box run',
  params: '[]',
  description: null,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
};

describe('Integration: Cross-component rendering', () => {
  let registry: PluginRegistry;

  beforeEach(async () => {
    const db = makeMockDB([vlessProtocolRow, defaultServerRow, defaultDockerRow]);
    registry = new PluginRegistry(db);
    await registry.loadAll();
  });

  it('renders protocol instance from protocol def + server/client templates', async () => {
    const result = await registry.renderProtocolInstance('vless-reality-vision', {
      domain: 'test.com',
      port: 443,
    });
    expect(result.serverConfig).toBeDefined();
    expect((result.serverConfig as any).type).toBe('vless');
    expect(result.clientConfig).toBeDefined();
    expect((result.clientConfig as any).type).toBe('vless');
  });

  it('renders docker from overall docker template', async () => {
    const result = await registry.renderDocker('docker-default', {});
    expect(result.composeYaml).toBeDefined();
    expect(result.entrySh).toBeDefined();
  });

  it('throws when no template found', async () => {
    const emptyDb = makeMockDB([]);
    const emptyReg = new PluginRegistry(emptyDb);
    await emptyReg.loadAll();
    await expect(emptyReg.renderProtocolInstance('nonexistent', {})).rejects.toThrow();
  });

  it('renders protocol instance with defaults from generators', async () => {
    const result = await registry.renderProtocolInstance('vless-reality-vision', {
      domain: 'server.example.com',
    });
    expect(result.serverConfig).toBeDefined();
    expect(result.clientConfig).toBeDefined();
    expect((result.clientConfig as any).server).toBe('server.example.com');
    expect((result.clientConfig as any).uuid).toBeDefined();
  });
});
