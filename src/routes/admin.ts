import { Hono } from 'hono';
import { adminAuth } from '../auth/middleware';
import { logAction } from '../services/audit';
import type { ProtocolConfigFile, OverallConfigFile } from '../engine/types';
import vlessServerJson from '../templates/protocols/vless-reality-vision/server.json';
import vlessClientJson from '../templates/protocols/vless-reality-vision/client.json';
import vlessConfigJson from '../templates/protocols/vless-reality-vision/config.json';
import hy2ServerJson from '../templates/protocols/hysteria2/server.json';
import hy2ClientJson from '../templates/protocols/hysteria2/client.json';
import hy2ConfigJson from '../templates/protocols/hysteria2/config.json';
import defaultServerTmpl from '../templates/server/default/template.json';
import defaultServerConfig from '../templates/server/default/config.json';
import defaultClientTmpl from '../templates/client/default/template.json';
import defaultClientConfig from '../templates/client/default/config.json';
import defaultDockerTmpl from '../templates/docker/default/template.json';
import defaultDockerConfig from '../templates/docker/default/config.json';
import { validateProtocolConfig, validateOverallConfig } from '../engine/config-validator';

const hy2Cfg = hy2ConfigJson as ProtocolConfigFile;
const vlessCfg = vlessConfigJson as ProtocolConfigFile;
const serverCfg = defaultServerConfig as OverallConfigFile;
const clientCfg = defaultClientConfig as OverallConfigFile;
const dockerCfg = defaultDockerConfig as OverallConfigFile;

const admin = new Hono<{ Bindings: Env }>();

admin.use('*', adminAuth);

interface SeedEntry {
  table: string;
  id: string;
  status: string;
}

admin.post('/seed', async (c) => {
  const results: SeedEntry[] = [];

  // Validate config files before seeding
  const protoConfigs = [vlessConfigJson, hy2ConfigJson];
  for (const cfg of protoConfigs) {
    const vr = validateProtocolConfig(cfg);
    if (!vr.valid) {
      return c.json({
        error: {
          code: 'CONFIG_VALIDATION_FAILED',
          message: `Protocol config validation failed`,
          issues: vr.issues,
        },
      }, 400);
    }
  }

  const overallConfigs = [defaultServerConfig, defaultClientConfig, defaultDockerConfig];
  for (const cfg of overallConfigs) {
    const vr = validateOverallConfig(cfg);
    if (!vr.valid) {
      return c.json({
        error: {
          code: 'CONFIG_VALIDATION_FAILED',
          message: `Overall config validation failed`,
          issues: vr.issues,
        },
      }, 400);
    }
  }

  // Unified templates (migration 0008): single table, category distinguishes type
  // IDs match seedIfEmpty() in db/seed.ts for consistency
  const templates = [
    {
      id: 'hysteria2',
      category: 'protocol',
      name: hy2Cfg.name,
      version: hy2Cfg.version,
      server_template: JSON.stringify(hy2ServerJson),
      client_template: JSON.stringify(hy2ClientJson),
      template_content: null,
      config: null,
      entry_script: null,
      params: JSON.stringify(hy2Cfg.params),
      description: hy2Cfg.description ?? null,
    },
    {
      id: 'vless-reality-vision',
      category: 'protocol',
      name: vlessCfg.name,
      version: vlessCfg.version,
      server_template: JSON.stringify(vlessServerJson),
      client_template: JSON.stringify(vlessClientJson),
      template_content: null,
      config: null,
      entry_script: null,
      params: JSON.stringify(vlessCfg.params),
      description: vlessCfg.description ?? null,
    },
    {
      id: 'server-default',
      category: 'overall-server',
      name: serverCfg.name ?? 'Default Server Config',
      version: serverCfg.version ?? '1.0.0',
      server_template: null,
      client_template: null,
      template_content: JSON.stringify(defaultServerTmpl),
      config: JSON.stringify(defaultServerConfig),
      entry_script: null,
      params: '[]',
      description: serverCfg.description ?? 'Default server overall template',
    },
    {
      id: 'client-default',
      category: 'overall-client',
      name: clientCfg.name ?? 'Default Client Config',
      version: clientCfg.version ?? '1.0.0',
      server_template: null,
      client_template: null,
      template_content: JSON.stringify(defaultClientTmpl),
      config: JSON.stringify(defaultClientConfig),
      entry_script: null,
      params: '[]',
      description: clientCfg.description ?? 'Default client overall template',
    },
    {
      id: 'docker-default',
      category: 'overall-docker',
      name: dockerCfg.name ?? 'Default Docker Compose',
      version: dockerCfg.version ?? '1.0.0',
      server_template: null,
      client_template: null,
      template_content: JSON.stringify(defaultDockerTmpl),
      config: JSON.stringify(defaultDockerConfig),
      entry_script: '#!/bin/sh\nset -e\nconfigFilePath="/data/config.json"\necho "entry"\nsing-box version\necho -e "\\nconfig:"\nsing-box check -c $configFilePath || cat $configFilePath\necho -e "\\nstarting"\nsing-box run -c $configFilePath\n',
      params: '[]',
      description: dockerCfg.description ?? 'Default docker-compose template',
    },
  ];

  for (const t of templates) {
    const existing = await c.env.DB.prepare('SELECT id FROM templates WHERE id = ?').bind(t.id).first();
    if (existing) {
      await c.env.DB.prepare(
        `UPDATE templates SET category = ?, name = ?, version = ?, server_template = ?, client_template = ?,
         template_content = ?, config = ?, entry_script = ?, params = ?, description = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).bind(
        t.category, t.name, t.version, t.server_template, t.client_template,
        t.template_content, t.config, t.entry_script, t.params, t.description, t.id,
      ).run();
      results.push({ table: 'templates', id: t.id, status: 'updated' });
    } else {
      await c.env.DB.prepare(
        `INSERT INTO templates (id, category, name, version, server_template, client_template, template_content, config, entry_script, params, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        t.id, t.category, t.name, t.version,
        t.server_template, t.client_template,
        t.template_content, t.config, t.entry_script,
        t.params, t.description,
      ).run();
      results.push({ table: 'templates', id: t.id, status: 'created' });
    }
  }

  return c.json({ seeded: results });
});

export { admin };
