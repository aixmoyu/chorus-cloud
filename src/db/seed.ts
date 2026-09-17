import type { D1Database } from '@cloudflare/workers-types';
import type { ProtocolConfigFile, OverallConfigFile } from '../engine/types';

import hysteria2Config from '../templates/protocols/hysteria2/config.json';
import hysteria2Server from '../templates/protocols/hysteria2/server.json';
import hysteria2Client from '../templates/protocols/hysteria2/client.json';
import vlessConfig from '../templates/protocols/vless-reality-vision/config.json';
import vlessServer from '../templates/protocols/vless-reality-vision/server.json';
import vlessClient from '../templates/protocols/vless-reality-vision/client.json';
import serverTemplate from '../templates/server/default/template.json';
import serverConfig from '../templates/server/default/config.json';
import clientTemplate from '../templates/client/default/template.json';
import clientConfig from '../templates/client/default/config.json';
import dockerTemplate from '../templates/docker/default/template.json';
import dockerConfig from '../templates/docker/default/config.json';

const hy2Config = hysteria2Config as ProtocolConfigFile;
const vlessCfg = vlessConfig as ProtocolConfigFile;
const serverCfg = serverConfig as OverallConfigFile;
const clientCfg = clientConfig as OverallConfigFile;
const dockerCfg = dockerConfig as OverallConfigFile;

interface TemplateSeed {
  id: string;
  category: string;
  name: string;
  version: string;
  server_template: string | null;
  client_template: string | null;
  template_content: string | null;
  config: string | null;
  entry_script: string | null;
  params: string;
  description: string | null;
}

const templateSeeds: TemplateSeed[] = [
  // Protocol templates
  {
    id: 'hysteria2',
    category: 'protocol',
    name: hy2Config.name,
    version: hy2Config.version,
    server_template: JSON.stringify(hysteria2Server),
    client_template: JSON.stringify(hysteria2Client),
    template_content: null,
    config: null,
    entry_script: null,
    params: JSON.stringify(hy2Config.params),
    description: hy2Config.description ?? null,
  },
  {
    id: 'vless-reality-vision',
    category: 'protocol',
    name: vlessCfg.name,
    version: vlessCfg.version,
    server_template: JSON.stringify(vlessServer),
    client_template: JSON.stringify(vlessClient),
    template_content: null,
    config: null,
    entry_script: null,
    params: JSON.stringify(vlessCfg.params),
    description: vlessCfg.description ?? null,
  },
  // Overall templates
  {
    id: 'server-default',
    category: 'overall-server',
    name: serverCfg.name ?? 'Default Server Config',
    version: serverCfg.version ?? '1.0.0',
    server_template: null,
    client_template: null,
    template_content: JSON.stringify(serverTemplate),
    config: JSON.stringify(serverConfig),
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
    template_content: JSON.stringify(clientTemplate),
    config: JSON.stringify(clientConfig),
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
    template_content: JSON.stringify(dockerTemplate),
    config: JSON.stringify(dockerConfig),
    // Matches the panel-side entry script: verify, format, then run.
    entry_script: '#!/bin/sh\nset -e\nconfigFilePath="/data/config.json"\necho "entry"\nsing-box version\necho -e "\\nconfig:"\nsing-box check -c $configFilePath || cat $configFilePath\necho -e "\\nstarting"\nsing-box run -c $configFilePath\n',
    params: '[]',
    description: dockerCfg.description ?? 'Default docker-compose template',
  },
];

// Legacy ids from pre-migration-0008 seeds. Two generations existed:
//   - path-style ids ('server/default', …) from the earliest cloud seed
//   - dash-style ids ('default-server', …) from the role-based admin seed
// Migration 0008 carried them into the unified templates table verbatim,
// while the unified seed uses '<role>-default' ids — leaving duplicates.
const LEGACY_TO_CURRENT: Record<string, string> = {
  'server/default': 'server-default',
  'client/default': 'client-default',
  'docker/default': 'docker-default',
  'default-server': 'server-default',
  'default-client': 'client-default',
  'default-docker': 'docker-default',
};

/**
 * Re-point references from legacy template ids to the current seeds and
 * delete the legacy rows. Idempotent; skips when no replacement exists
 * (e.g. a legacy row that was customized into the only copy).
 */
export async function cleanupLegacyTemplates(db: D1Database): Promise<void> {
  for (const [legacyId, currentId] of Object.entries(LEGACY_TO_CURRENT)) {
    const replacement = await db.prepare('SELECT id FROM templates WHERE id = ?').bind(currentId).first();
    if (!replacement) continue;

    await db.prepare(
      'UPDATE subscriptions SET overall_template_id = ? WHERE overall_template_id = ?'
    ).bind(currentId, legacyId).run();
    await db.prepare(
      'UPDATE nodes SET server_overall_id = ? WHERE server_overall_id = ?'
    ).bind(currentId, legacyId).run();
    await db.prepare(
      'UPDATE nodes SET docker_overall_id = ? WHERE docker_overall_id = ?'
    ).bind(currentId, legacyId).run();
    await db.prepare('DELETE FROM templates WHERE id = ?').bind(legacyId).run();
  }
}

/**
 * Upsert the built-in templates (matched by id) so a deployed cloud never
 * serves stale seed templates. Custom templates (any id not in the seed
 * list) are left untouched.
 */
export async function refreshSeedTemplates(db: D1Database): Promise<void> {
  for (const t of templateSeeds) {
    await db.prepare(
      `UPDATE templates SET category = ?, name = ?, version = ?, server_template = ?, client_template = ?,
       template_content = ?, config = ?, entry_script = ?, params = ?, description = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(
      t.category, t.name, t.version,
      t.server_template, t.client_template,
      t.template_content, t.config, t.entry_script,
      t.params, t.description, t.id,
    ).run();
  }
}

/**
 * Keep seed templates in sync with the code. `seedIfEmpty` handles fresh
 * databases; on existing databases it refreshes the built-in seeds.
 */
export async function seedIfEmpty(db: D1Database): Promise<void> {
  const existing = await db.prepare('SELECT COUNT(*) as count FROM templates').first();
  const count = (existing as any)?.count ?? 0;
  if (count > 0) {
    // Database already has templates — still refresh the built-in seeds so
    // a code deploy updates them (custom templates are never touched).
    await refreshSeedTemplates(db);
    return;
  }

  for (const t of templateSeeds) {
    await db.prepare(
      `INSERT INTO templates (id, category, name, version, server_template, client_template, template_content, config, entry_script, params, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      t.id, t.category, t.name, t.version,
      t.server_template, t.client_template,
      t.template_content, t.config, t.entry_script,
      t.params, t.description,
    ).run();
  }

  console.log(`Seeded database: ${templateSeeds.length} templates`);
}
