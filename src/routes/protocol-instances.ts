import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { adminAuth } from '../auth/middleware';
import { PluginRegistry, invalidateTemplateCache } from '../engine/registry';
import { PluginError } from '../engine/errors';

const createInstanceSchema = z.object({
  protocolId: z.string().min(1),
  nodeId: z.string().min(1),
  params: z.record(z.unknown()).default({}),
});

/** Mirror params.tag into the indexed `tag` column (CLOUD-P2) so tag
 * uniqueness checks avoid a params LIKE full scan. */
function extractTag(params: Record<string, unknown>): string {
  const tag = params?.tag;
  return typeof tag === 'string' ? tag.trim() : '';
}

const protocolInstances = new Hono<{ Bindings: Env }>();

// P0: GET endpoints require admin auth — were public, exposed protocol instances
protocolInstances.get('/', adminAuth, async (c) => {
  const nodeId = c.req.query('nodeId');
  let query = 'SELECT * FROM protocol_instances';
  const bind: unknown[] = [];
  if (nodeId) {
    query += ' WHERE node_id = ?';
    bind.push(nodeId);
  }
  query += ' ORDER BY created_at DESC';
  const { results } = await c.env.DB.prepare(query).bind(...bind).all();
  return c.json({ instances: results });
});

// P0: GET /:id requires admin auth — was public, exposed instance details
protocolInstances.get('/:id', adminAuth, async (c) => {
  const { id } = c.req.param();
  const instance = await c.env.DB.prepare('SELECT * FROM protocol_instances WHERE id = ?').bind(id).first();
  if (!instance) {
    return c.json({ error: { code: 'INSTANCE_NOT_FOUND', message: `Protocol instance '${id}' not found` } }, 404);
  }
  return c.json({ instance });
});

protocolInstances.post('/', adminAuth, zValidator('json', createInstanceSchema), async (c) => {
  const body = c.req.valid('json');
  const id = crypto.randomUUID();

  const node = await c.env.DB.prepare('SELECT * FROM nodes WHERE id = ?').bind(body.nodeId).first();
  if (!node) {
    return c.json({ error: { code: 'NODE_NOT_FOUND', message: `Node '${body.nodeId}' not found` } }, 404);
  }

  const proto = await c.env.DB.prepare(
    "SELECT * FROM templates WHERE id = ? AND category = 'protocol'"
  ).bind(body.protocolId).first();
  if (!proto) {
    return c.json({ error: { code: 'PROTO_NOT_FOUND', message: `Protocol '${body.protocolId}' not found` } }, 404);
  }

  const reg = new PluginRegistry(c.env.DB);
  await reg.loadAll();

  const rendered = await reg.renderProtocolInstance(body.protocolId, body.params);
  const serverConfig = rendered.serverConfig;
  const clientConfig = rendered.clientConfig;

  await c.env.DB.prepare(
    'INSERT INTO protocol_instances (id, protocol_id, node_id, params, server_config, client_config, status, tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    id,
    body.protocolId,
    body.nodeId,
    JSON.stringify(body.params),
    JSON.stringify(serverConfig),
    JSON.stringify(clientConfig),
    'active',
    extractTag(body.params),
  ).run();

  const instance = await c.env.DB.prepare('SELECT * FROM protocol_instances WHERE id = ?').bind(id).first();
  return c.json({ instance }, 201);
});

protocolInstances.put('/:id', adminAuth, zValidator('json', z.object({
  params: z.record(z.unknown()).optional(),
  // Enum-constrained: consumers (deploy, subscription delivery) only select
  // `status = 'active'`, so arbitrary strings would silently drop instances.
  status: z.enum(['active', 'inactive']).optional(),
})), async (c) => {
  const { id } = c.req.param();
  const body = c.req.valid('json');
  const existing = await c.env.DB.prepare('SELECT * FROM protocol_instances WHERE id = ?').bind(id).first();
  if (!existing) {
    return c.json({ error: { code: 'INSTANCE_NOT_FOUND', message: `Protocol instance '${id}' not found` } }, 404);
  }

  if (body.params) {
    const reg = new PluginRegistry(c.env.DB);
    await reg.loadAll();
    const instance = existing as any;
    try {
      const rendered = await reg.renderProtocolInstance(instance.protocol_id, body.params);
      await c.env.DB.prepare(
        "UPDATE protocol_instances SET params = ?, server_config = ?, client_config = ?, tag = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(
        JSON.stringify(body.params),
        JSON.stringify(rendered.serverConfig),
        JSON.stringify(rendered.clientConfig),
        extractTag(body.params),
        id,
      ).run();
    } catch (e) {
      if (e instanceof PluginError) {
        return c.json({ error: { code: e.code, message: e.message } }, 400);
      }
      throw e;
    }
  }

  if (body.status) {
    await c.env.DB.prepare(
      "UPDATE protocol_instances SET status = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(body.status, id).run();
  }

  const updated = await c.env.DB.prepare('SELECT * FROM protocol_instances WHERE id = ?').bind(id).first();
  return c.json({ instance: updated });
});

protocolInstances.delete('/:id', adminAuth, async (c) => {
  const { id } = c.req.param();
  const existing = await c.env.DB.prepare('SELECT * FROM protocol_instances WHERE id = ?').bind(id).first();
  if (!existing) {
    return c.json({ error: { code: 'INSTANCE_NOT_FOUND', message: `Protocol instance '${id}' not found` } }, 404);
  }
  await c.env.DB.prepare('DELETE FROM protocol_instances WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

const rerenderSchema = z.object({
  // Omit to re-render instances of every protocol template.
  protocolId: z.string().min(1).optional(),
});

/**
 * CLOUD-C1 maintenance endpoint: instances snapshot server_config/client_config
 * at creation time, so a template edit never propagates to existing instances.
 * This re-renders stored instances from the current template definition using
 * each instance's own params. Per-instance failures are reported, not fatal —
 * one bad param set must not block the rest of the batch.
 */
protocolInstances.post('/rerender', adminAuth, async (c) => {
  const parsed = rerenderSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request body' } }, 400);
  }
  const { protocolId } = parsed.data;

  if (protocolId) {
    const proto = await c.env.DB.prepare(
      "SELECT id FROM templates WHERE id = ? AND category = 'protocol'"
    ).bind(protocolId).first();
    if (!proto) {
      return c.json({ error: { code: 'PROTO_NOT_FOUND', message: `Protocol '${protocolId}' not found` } }, 404);
    }
  }

  // Force a fresh template load — the 30s shared cache may still hold the
  // pre-edit definition this endpoint exists to pick up.
  invalidateTemplateCache();
  const reg = new PluginRegistry(c.env.DB);
  await reg.loadAll();

  const query = protocolId
    ? 'SELECT id, protocol_id, params FROM protocol_instances WHERE protocol_id = ?'
    : 'SELECT id, protocol_id, params FROM protocol_instances';
  const { results: rows } = protocolId
    ? await c.env.DB.prepare(query).bind(protocolId).all<{ id: string; protocol_id: string; params: string }>()
    : await c.env.DB.prepare(query).all<{ id: string; protocol_id: string; params: string }>();

  let rerendered = 0;
  const failures: { id: string; error: string }[] = [];
  for (const row of rows ?? []) {
    try {
      const rendered = await reg.renderProtocolInstance(row.protocol_id, JSON.parse(row.params || '{}'));
      await c.env.DB.prepare(
        "UPDATE protocol_instances SET server_config = ?, client_config = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(JSON.stringify(rendered.serverConfig), JSON.stringify(rendered.clientConfig), row.id).run();
      rerendered++;
    } catch (e) {
      failures.push({ id: row.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return c.json({ rerendered, failed: failures.length, failures });
});

export { protocolInstances };
