import { Hono } from 'hono';
import { adminAuth } from '../auth/middleware';
import { PluginRegistry } from '../engine/registry';
import { PluginError } from '../engine/errors';
import type { DockerOverrides } from '../engine/docker_renderer';

const SERVER_CONFIG_PLACEHOLDER = 'SING_BOX_CONFIG_PLACEHOLDER';

// Derive docker overrides (env/volumes/ports) from the rendered server config.
function deriveDockerOverrides(serverConfig: Record<string, unknown>): DockerOverrides {
  const env: string[] = [];
  const volumes: string[] = [];
  // Expose inbound listen ports if present in the server config
  const inbounds = Array.isArray(serverConfig.inbounds) ? serverConfig.inbounds : [];
  for (const ib of inbounds) {
    if (ib && typeof ib === 'object') {
      const port = (ib as Record<string, unknown>).listen_port;
      if (typeof port === 'number') env.push(`SING_BOX_PORT_${port}=${port}`);
    }
  }
  return { env, volumes };
}

const deploy = new Hono<{ Bindings: Env }>();

deploy.post('/:nodeId', adminAuth, async (c) => {
  const { nodeId } = c.req.param();

  const node = await c.env.DB.prepare('SELECT * FROM nodes WHERE id = ?').bind(nodeId).first<any>();
  if (!node) {
    return c.json({ error: { code: 'NODE_NOT_FOUND', message: `Node '${nodeId}' not found` } }, 404);
  }

  const { results: instanceRows } = await c.env.DB.prepare(
    "SELECT * FROM protocol_instances WHERE node_id = ? AND status = 'active'"
  ).bind(nodeId).all<any>();

  if (!instanceRows || instanceRows.length === 0) {
    return c.json({ error: { code: 'NO_ACTIVE_PROTOCOLS', message: 'Node has no active protocol instances' } }, 400);
  }

  if (!node.server_overall_id) {
    return c.json({ error: { code: 'NO_SERVER_OVERALL', message: 'Node has no server overall template assigned' } }, 400);
  }

  if (!node.docker_overall_id) {
    return c.json({ error: { code: 'NO_DOCKER_OVERALL', message: 'Node has no docker template assigned' } }, 400);
  }

  const reg = new PluginRegistry(c.env.DB);
  await reg.loadAll();

  const instanceConfigs: Array<{ id: string; serverConfig: Record<string, unknown>; clientConfig: Record<string, unknown> }> = [];

  for (const row of instanceRows) {
    try {
      const rendered = await reg.renderProtocolInstance(row.protocol_id, JSON.parse(row.params));
      instanceConfigs.push({
        id: row.id,
        serverConfig: rendered.serverConfig,
        clientConfig: rendered.clientConfig,
      });
    } catch (e) {
      if (e instanceof PluginError) {
        return c.json({ error: { code: e.code, message: `Instance ${row.id}: ${e.message}` } }, 400);
      }
      throw e;
    }
  }

  const serverParams = node.server_params ? JSON.parse(node.server_params) : {};

  let combinedServerConfig: Record<string, unknown>;
  try {
    combinedServerConfig = await reg.renderServerOverall(instanceConfigs, node.server_overall_id, serverParams);
  } catch (e) {
    if (e instanceof PluginError) {
      return c.json({ error: { code: e.code, message: `Server overall: ${e.message}` } }, 400);
    }
    throw e;
  }

  let composeYaml: string;
  let entrySh: string;
  try {
    const dockerOverrides = deriveDockerOverrides(combinedServerConfig);
    const dockerResult = await reg.renderDocker(node.docker_overall_id, serverParams, dockerOverrides);
    composeYaml = dockerResult.composeYaml;
    entrySh = dockerResult.entrySh;
  } catch (e) {
    if (e instanceof PluginError) {
      return c.json({ error: { code: e.code, message: `Docker: ${e.message}` } }, 400);
    }
    throw e;
  }

  // Substitute the server config into entry.sh so Cloud produces a complete artifact.
  // The placeholder is replaced with the actual JSON config (indented heredoc-friendly).
  if (entrySh.includes(SERVER_CONFIG_PLACEHOLDER)) {
    entrySh = entrySh.replaceAll(SERVER_CONFIG_PLACEHOLDER, JSON.stringify(combinedServerConfig, null, 2));
  }

  // No KV archival here: deploy results are consumed directly from this
  // response (core calls /api/render/deploy). Archiving client configs under
  // single-segment `client:{instanceId}` keys drifted from the clients domain's
  // `client:{fingerprint}:{name}` schema and leaked orphan records on redeploys.

  c.get('logger').info('deploy artifacts rendered', {
    node: nodeId,
    instances: instanceConfigs.length,
  });

  return c.json({
    composeYaml,
    entrySh,
    serverConfig: combinedServerConfig,
    instances: instanceConfigs.map((ic) => ({
      id: ic.id,
      clientConfig: ic.clientConfig,
    })),
  });
});

export { deploy };
