import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginRegistry, resetRegistryCache } from '../../src/engine/registry';
import serverTemplate from '../../src/templates/server/default/template.json';
import clientTemplate from '../../src/templates/client/default/template.json';

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

const mkRow = (id: string, category: string, template: any) => ({
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

describe('template port verification', () => {
  beforeEach(() => {
    resetRegistryCache(); // shared module cache must not leak across mock DBs
  });

  it('renderServerOverall splices protocols into minimal server template', async () => {
    const db = makeMockDB([mkRow('server-default', 'overall-server', serverTemplate)]);
    const reg = new PluginRegistry(db);
    await reg.loadAll();
    const instances = [
      { id: 'i1', serverConfig: { type: 'hysteria2', listen: 8443 }, clientConfig: {} },
      { id: 'i2', serverConfig: { type: 'vless', listen: 443 }, clientConfig: {} },
    ];
    const result: any = await reg.renderServerOverall(instances, 'server-default', {});
    expect(result.log).toEqual({ level: 'info', output: '/data/sing-box.log', timestamp: true });
    expect(Array.isArray(result.inbounds)).toBe(true);
    expect(result.inbounds).toHaveLength(2);
    expect(result.inbounds[0].type).toBe('hysteria2');
    expect(result.outbounds).toContainEqual({ type: 'direct', tag: 'direct' });
    expect(result.outbounds).toContainEqual({ type: 'block', tag: 'block' });
    expect(result.route).toBeDefined();
    expect(result.route.final).toBe('direct');
    expect(result.route.auto_detect_interface).toBe(true);
    expect(result.dns.final).toBe('google');
    // remote rule-set definitions preserved from the template
    expect(result.route.rule_set.length).toBeGreaterThan(0);
    // no leftover placeholder tokens
    const json = JSON.stringify(result);
    expect(json).not.toContain('{{');
  });

  it('renderClientOverall splices proxy_tags into selectors and protocols into outbounds', async () => {
    const db = makeMockDB([mkRow('client-default', 'overall-client', clientTemplate)]);
    const reg = new PluginRegistry(db);
    await reg.loadAll();
    const instances = [
      { id: 'i1', serverConfig: {}, clientConfig: { tag: 'proxy-a', type: 'hysteria2', server: '1.1.1.1' } },
      { id: 'i2', serverConfig: {}, clientConfig: { tag: 'proxy-b', type: 'vless', server: '2.2.2.2' } },
    ];
    const result: any = await reg.renderClientOverall(instances, 'client-default', {});

    // outbounds: 18 selectors + auto + direct + 2 generated = 22
    expect(result.outbounds).toHaveLength(22);

    // proxy selector: ["auto","direct","proxy-a","proxy-b"]
    const proxySel = result.outbounds.find((o: any) => o.tag === 'proxy');
    expect(proxySel.outbounds).toEqual(['auto', 'direct', 'proxy-a', 'proxy-b']);

    // Adobe selector: ["direct","proxy","proxy-a","proxy-b"]
    const adobeSel = result.outbounds.find((o: any) => o.tag === '🅰️ Adobe');
    expect(adobeSel.outbounds).toEqual(['direct', 'proxy', 'proxy-a', 'proxy-b']);

    // auto urltest: ["proxy-a","proxy-b"]
    const auto = result.outbounds.find((o: any) => o.tag === 'auto');
    expect(auto.type).toBe('urltest');
    expect(auto.outbounds).toEqual(['proxy-a', 'proxy-b']);

    // last two are the generated outbounds
    expect(result.outbounds[20].tag).toBe('proxy-a');
    expect(result.outbounds[21].tag).toBe('proxy-b');

    // tun inbound preserved
    const tun = result.inbounds.find((o: any) => o.type === 'tun');
    expect(tun.interface_name).toBe('tun0');
    expect(tun.mtu).toBe(9000);

    // dns + route preserved
    expect(result.dns.final).toBe('dns-local');
    expect(result.route.final).toBe('proxy');
    expect(result.route.default_domain_resolver).toBe('dns-local');
    // rule_set count tracks the template's remote rule-set definitions
    // (games@cn / games@!cn entries were removed from the template).
    expect(result.route.rule_set).toHaveLength(75);

    // no leftover placeholder tokens
    const json = JSON.stringify(result);
    expect(json).not.toContain('{{');
    expect(json).not.toContain('<PROXY_TAGS>');
    expect(json).not.toContain('<GENERATED');
  });

  it('renderClientOverall handles zero instances (empty tags/protocols)', async () => {
    const db = makeMockDB([mkRow('client-default', 'overall-client', clientTemplate)]);
    const reg = new PluginRegistry(db);
    await reg.loadAll();
    const result: any = await reg.renderClientOverall([], 'client-default', {});
    const proxySel = result.outbounds.find((o: any) => o.tag === 'proxy');
    expect(proxySel.outbounds).toEqual(['auto', 'direct']);
    expect(result.outbounds).toHaveLength(20);
    const json = JSON.stringify(result);
    expect(json).not.toContain('{{');
  });
});
