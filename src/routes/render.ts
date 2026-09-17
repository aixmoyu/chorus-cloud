import { Hono } from 'hono';
import { PluginRegistry, type ProtocolInstanceConfig } from '../engine/registry';
import { PluginError } from '../engine/errors';
import { adminAuth } from '../auth/middleware';
import type { DockerOverrides } from '../engine/docker_renderer';

const render = new Hono<{ Bindings: Env }>();

/** Parse the request body as JSON, returning a readable 400 instead of a 500
 * when the body is missing or malformed. */
async function readJson<T>(c: { req: { json<T>(): Promise<T> } }): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}

// POST /api/render — dry-run protocol instance rendering
render.post('/', adminAuth, async (c) => {
  const body = await readJson<{ protocolId?: string; params?: Record<string, unknown> }>(c);
  if (!body) {
    return c.json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON (set Content-Type: application/json)' } }, 400);
  }
  if (!body.protocolId) {
    return c.json({ error: { code: 'PROTOCOL_ID_REQUIRED', message: 'protocolId is required' } }, 400);
  }

  const reg = new PluginRegistry(c.env.DB);
  await reg.loadAll();

  try {
    const rendered = await reg.renderProtocolInstance(body.protocolId, body.params ?? {});
    return c.json(rendered, 200);
  } catch (e) {
    if (e instanceof PluginError) {
      return c.json({ error: { code: e.code, message: e.message } }, 400);
    }
    throw e;
  }
});

// POST /api/render/deploy — render everything a node needs to deploy.
// Body: { instances: [{ id, serverConfig, clientConfig }], serverOverallId?, dockerOverallId?, serverParams?, dockerOverrides? }
// Falls back to the default server/docker overall templates when ids are omitted.
// Returns { serverConfig, composeYaml, entrySh } so panels deploy cloud-rendered
// artifacts instead of assembling their own (same source of truth as subscriptions).
render.post('/deploy', adminAuth, async (c) => {
  const body = await readJson<{
    instances?: ProtocolInstanceConfig[];
    serverOverallId?: string;
    dockerOverallId?: string;
    serverParams?: Record<string, unknown>;
    dockerOverrides?: DockerOverrides;
  }>(c);

  if (!body) {
    return c.json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON (set Content-Type: application/json)' } }, 400);
  }
  if (!Array.isArray(body.instances) || body.instances.length === 0) {
    return c.json({ error: { code: 'INSTANCES_REQUIRED', message: 'instances must be a non-empty array' } }, 400);
  }

  const reg = new PluginRegistry(c.env.DB);
  await reg.loadAll();

  const serverOverallId = body.serverOverallId || 'server-default';
  const dockerOverallId = body.dockerOverallId || 'docker-default';

  const serverConfig = await reg.renderServerOverall(body.instances, serverOverallId, body.serverParams ?? {});
  const dockerResult = await reg.renderDocker(dockerOverallId, body.serverParams ?? {}, body.dockerOverrides ?? {});
  const composeYaml = dockerResult.composeYaml;
  const entrySh = dockerResult.entrySh;

  return c.json({ serverConfig, composeYaml, entrySh }, 200);
});

// POST /api/render/overall — dry-run overall template rendering (server/client/docker).
// Body: { category: 'server'|'client'|'docker', templateId, params?, instances?, overrides? }
// - For 'server'/'client': instances is an array of { id, serverConfig, clientConfig }.
// - For 'docker': overrides is { env?, volumes? }.
render.post('/overall', adminAuth, async (c) => {
  const body = await readJson<{
    category: 'server' | 'client' | 'docker';
    templateId: string;
    params?: Record<string, unknown>;
    instances?: ProtocolInstanceConfig[];
    overrides?: DockerOverrides;
  }>(c);

  if (!body) {
    return c.json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON (set Content-Type: application/json)' } }, 400);
  }
  if (!body.templateId) {
    return c.json({ error: { code: 'TEMPLATE_ID_REQUIRED', message: 'templateId is required' } }, 400);
  }
  if (!['server', 'client', 'docker'].includes(body.category)) {
    return c.json({ error: { code: 'INVALID_CATEGORY', message: "category must be 'server', 'client', or 'docker'" } }, 400);
  }

  const reg = new PluginRegistry(c.env.DB);
  await reg.loadAll();

  try {
    if (body.category === 'server') {
      const result = await reg.renderServerOverall(body.instances ?? [], body.templateId, body.params ?? {});
      return c.json({ serverConfig: result }, 200);
    }
    if (body.category === 'client') {
      const result = await reg.renderClientOverall(body.instances ?? [], body.templateId, body.params ?? {});
      return c.json({ clientConfig: result }, 200);
    }
    // docker
    const result = await reg.renderDocker(body.templateId, body.params ?? {}, body.overrides ?? {});
    return c.json({ composeYaml: result.composeYaml, entrySh: result.entrySh }, 200);
  } catch (e) {
    if (e instanceof PluginError) {
      return c.json({ error: { code: e.code, message: e.message } }, 400);
    }
    throw e;
  }
});

export { render };
