import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PluginRegistry, resetRegistryCache } from '../../src/engine/registry';
import hy2ServerTpl from '../../src/templates/protocols/hysteria2/server.json';
import hy2ClientTpl from '../../src/templates/protocols/hysteria2/client.json';
import hy2Config from '../../src/templates/protocols/hysteria2/config.json';
import vlessServerTpl from '../../src/templates/protocols/vless-reality-vision/server.json';
import vlessClientTpl from '../../src/templates/protocols/vless-reality-vision/client.json';
import vlessConfig from '../../src/templates/protocols/vless-reality-vision/config.json';
import serverOverall from '../../src/templates/server/default/template.json';
import clientOverall from '../../src/templates/client/default/template.json';

// Binary vendored at packages/cloud/bin/sing-box (gitignored).
// Test is skipped when absent so CI without the binary still passes.
const SINGBOX_BIN = path.resolve(process.cwd(), 'bin/sing-box');
const hasSingBox = existsSync(SINGBOX_BIN);

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

const mkProtocolRow = (id: string, name: string, serverTpl: any, clientTpl: any, config: any) => ({
  id,
  category: 'protocol',
  name,
  version: config.version,
  server_template: JSON.stringify(serverTpl),
  client_template: JSON.stringify(clientTpl),
  template_content: null,
  config: null,
  entry_script: null,
  params: JSON.stringify(config.params),
  description: config.description,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
});

const mkOverallRow = (id: string, category: string, template: any) => ({
  id,
  category,
  name: id,
  version: '1.0.0',
  server_template: null,
  client_template: null,
  template_content: JSON.stringify(template),
  config: JSON.stringify({ params: [] }),
  entry_script: null,
  params: '[]',
  description: null,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
});

function runSingBoxCheck(configPath: string): { status: number | null; stderr: string; stdout: string } {
  const r = spawnSync(SINGBOX_BIN, ['check', '-c', configPath], {
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return { status: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

const describeOrSkip = hasSingBox ? describe : describe.skip;

describeOrSkip('sing-box check on rendered configs (binary at packages/cloud/bin/sing-box)', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'singbox-check-'));
  });

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders hysteria2 + vless server config that passes sing-box check', async () => {
    const protocolRows = [
      mkProtocolRow('hysteria2', 'Hysteria2', hy2ServerTpl, hy2ClientTpl, hy2Config),
      mkProtocolRow('vless-reality-vision', 'VLESS Reality Vision', vlessServerTpl, vlessClientTpl, vlessConfig),
    ];
    const overallRows = [mkOverallRow('server-default', 'overall-server', serverOverall)];
    const db = makeMockDB([...protocolRows, ...overallRows]);
    const reg = new PluginRegistry(db);
    await reg.loadAll();

    const hy2Params = {
      domain: 'hy2.example.com',
      port: 8443,
      tag: 'proxy-hy2',
      masqueradeDomain: 'example.net',
    };
    const vlessParams = {
      domain: 'vless.example.com',
      port: 443,
      tag: 'proxy-vless',
    };

    const hy2Inst = await reg.renderProtocolInstance('hysteria2', hy2Params);
    const vlessInst = await reg.renderProtocolInstance('vless-reality-vision', vlessParams);
    const instances = [
      { id: 'hy2', serverConfig: hy2Inst.serverConfig, clientConfig: hy2Inst.clientConfig },
      { id: 'vless', serverConfig: vlessInst.serverConfig, clientConfig: vlessInst.clientConfig },
    ];

    const serverConfig = await reg.renderServerOverall(instances, 'server-default', {});

    const serverPath = path.join(tmpDir, 'server.json');
    writeFileSync(serverPath, JSON.stringify(serverConfig, null, 2));

    const res = runSingBoxCheck(serverPath);
    expect(res.status, `server check failed:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(0);
  });

  it('renders hysteria2 + vless client config that passes sing-box check', async () => {
    resetRegistryCache(); // the earlier test in this file warmed the shared cache
    const protocolRows = [
      mkProtocolRow('hysteria2', 'Hysteria2', hy2ServerTpl, hy2ClientTpl, hy2Config),
      mkProtocolRow('vless-reality-vision', 'VLESS Reality Vision', vlessServerTpl, vlessClientTpl, vlessConfig),
    ];
    const overallRows = [mkOverallRow('client-default', 'overall-client', clientOverall)];
    const db = makeMockDB([...protocolRows, ...overallRows]);
    const reg = new PluginRegistry(db);
    await reg.loadAll();

    const hy2Params = {
      domain: 'hy2.example.com',
      port: 8443,
      tag: 'proxy-hy2',
      masqueradeDomain: 'example.net',
    };
    const vlessParams = {
      domain: 'vless.example.com',
      port: 443,
      tag: 'proxy-vless',
    };

    const hy2Inst = await reg.renderProtocolInstance('hysteria2', hy2Params);
    const vlessInst = await reg.renderProtocolInstance('vless-reality-vision', vlessParams);
    const instances = [
      { id: 'hy2', serverConfig: hy2Inst.serverConfig, clientConfig: hy2Inst.clientConfig },
      { id: 'vless', serverConfig: vlessInst.serverConfig, clientConfig: vlessInst.clientConfig },
    ];

    const clientConfig: any = await reg.renderClientOverall(instances, 'client-default', {});

    const clientPath = path.join(tmpDir, 'client.json');
    writeFileSync(clientPath, JSON.stringify(clientConfig, null, 2));

    const res = runSingBoxCheck(clientPath);
    expect(res.status, `client check failed:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(0);
  });
});
