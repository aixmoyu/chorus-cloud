import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { adminAuth } from '../auth/middleware';
import { invalidateTemplateCache } from '../engine/registry';

const protocolCreateSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  version: z.string().default('1.0.0'),
  serverTemplate: z.string().min(1),
  clientTemplate: z.string().min(1),
  params: z.string().default('[]'),
  description: z.string().max(512).optional(),
});

const protocols = new Hono<{ Bindings: Env }>();

protocols.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM templates WHERE category = 'protocol' ORDER BY created_at DESC"
  ).all();
  return c.json({ protocols: results });
});

protocols.get('/:id', async (c) => {
  const { id } = c.req.param();
  const proto = await c.env.DB.prepare(
    "SELECT * FROM templates WHERE id = ? AND category = 'protocol'"
  ).bind(id).first();
  if (!proto) {
    return c.json({ error: { code: 'PROTO_NOT_FOUND', message: `Protocol '${id}' not found` } }, 404);
  }
  return c.json({ protocol: proto });
});

protocols.post('/', adminAuth, zValidator('json', protocolCreateSchema), async (c) => {
  const body = c.req.valid('json');
  try {
    await c.env.DB.prepare(
      `INSERT INTO templates (id, category, name, version, server_template, client_template, params, description)
       VALUES (?, 'protocol', ?, ?, ?, ?, ?, ?)`
    ).bind(
      body.id,
      body.name,
      body.version,
      body.serverTemplate,
      body.clientTemplate,
      body.params,
      body.description ?? null,
    ).run();

    const proto = await c.env.DB.prepare(
      "SELECT * FROM templates WHERE id = ? AND category = 'protocol'"
    ).bind(body.id).first();
    invalidateTemplateCache(); // CLOUD-P4: renders must see the new protocol now
    return c.json({ protocol: proto }, 201);
  } catch (e: any) {
    if (e?.message?.includes('UNIQUE constraint failed')) {
      return c.json({ error: { code: 'PROTO_DUPLICATE_ID', message: `Protocol id '${body.id}' already exists` } }, 409);
    }
    throw e;
  }
});

protocols.put('/:id', adminAuth, zValidator('json', protocolCreateSchema.omit({ id: true }).partial()), async (c) => {
  const { id } = c.req.param();
  const body = c.req.valid('json');
  const existing = await c.env.DB.prepare(
    "SELECT * FROM templates WHERE id = ? AND category = 'protocol'"
  ).bind(id).first();
  if (!existing) {
    return c.json({ error: { code: 'PROTO_NOT_FOUND', message: `Protocol '${id}' not found` } }, 404);
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.name !== undefined) { sets.push('name = ?'); values.push(body.name); }
  if (body.version !== undefined) { sets.push('version = ?'); values.push(body.version); }
  if (body.serverTemplate !== undefined) { sets.push('server_template = ?'); values.push(body.serverTemplate); }
  if (body.clientTemplate !== undefined) { sets.push('client_template = ?'); values.push(body.clientTemplate); }
  if (body.params !== undefined) { sets.push('params = ?'); values.push(body.params); }
  if (body.description !== undefined) { sets.push('description = ?'); values.push(body.description); }

  if (sets.length > 0) {
    values.push(id);
    await c.env.DB.prepare(
      `UPDATE templates SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`
    ).bind(...values).run();
    invalidateTemplateCache(); // CLOUD-P4: drop the stale shared cache immediately
  }

  const updated = await c.env.DB.prepare(
    "SELECT * FROM templates WHERE id = ? AND category = 'protocol'"
  ).bind(id).first();
  return c.json({ protocol: updated });
});

protocols.delete('/:id', adminAuth, async (c) => {
  const { id } = c.req.param();
  const existing = await c.env.DB.prepare(
    "SELECT * FROM templates WHERE id = ? AND category = 'protocol'"
  ).bind(id).first();
  if (!existing) {
    return c.json({ error: { code: 'PROTO_NOT_FOUND', message: `Protocol '${id}' not found` } }, 404);
  }
  await c.env.DB.prepare('DELETE FROM templates WHERE id = ?').bind(id).run();
  invalidateTemplateCache(); // CLOUD-P4: deleted protocols must not render
  return c.json({ success: true });
});

export { protocols };
