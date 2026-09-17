import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { adminAuth } from '../auth/middleware';

const createNodeSchema = z.object({
  name: z.string().min(1).max(128),
  hostname: z.string().optional(),
  serverOverallId: z.string().optional(),
  dockerOverallId: z.string().optional(),
  serverParams: z.record(z.unknown()).optional(),
});

const registerNodeSchema = z.object({
  fingerprint: z.string().min(8).max(128),
  name: z.string().min(1).max(128),
  address: z.string().optional(),
});

const updateNodeSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  hostname: z.string().optional(),
  status: z.string().optional(),
  serverOverallId: z.string().optional(),
  dockerOverallId: z.string().optional(),
  serverParams: z.record(z.unknown()).optional(),
});

const nodes = new Hono<{ Bindings: Env }>();

/**
 * Idempotent node registration / heartbeat. Panels call this on every sync.
 * A node is identified by its stable fingerprint — re-registering updates
 * name/address and refreshes last_seen.
 */
nodes.post('/register', adminAuth, zValidator('json', registerNodeSchema), async (c) => {
  const { fingerprint, name, address } = c.req.valid('json');
  const now = new Date().toISOString();

  // Two-statement heartbeat instead of the old SELECT→UPDATE→SELECT (or
  // SELECT→INSERT→SELECT) round-trips. INSERT OR IGNORE only returns a row on
  // a genuine insert, which also distinguishes 201 from 200 cleanly.
  const inserted = await c.env.DB.prepare(
    `INSERT INTO nodes (id, name, fingerprint, address, last_seen, status)
     VALUES (?, ?, ?, ?, ?, 'online')
     ON CONFLICT(fingerprint) WHERE fingerprint IS NOT NULL DO NOTHING
     RETURNING *`
  ).bind(crypto.randomUUID(), name, fingerprint, address || null, now).first<Record<string, unknown>>();

  if (inserted) {
    return c.json({ node: inserted }, 201);
  }

  const updated = await c.env.DB.prepare(
    `UPDATE nodes SET name = ?, address = COALESCE(?, address), last_seen = ?, status = 'online'
     WHERE fingerprint = ? RETURNING *`
  ).bind(name, address || null, now, fingerprint).first<Record<string, unknown>>();
  return c.json({ node: updated });
});

nodes.get('/', adminAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM nodes ORDER BY created_at DESC'
  ).all<Record<string, unknown>>();
  return c.json({ nodes: results });
});

nodes.get('/:id', adminAuth, async (c) => {
  const { id } = c.req.param();
  const node = await c.env.DB.prepare('SELECT * FROM nodes WHERE id = ?').bind(id).first();
  if (!node) {
    return c.json({ error: { code: 'NODE_NOT_FOUND', message: `Node '${id}' not found` } }, 404);
  }
  return c.json({ node });
});

nodes.post('/', adminAuth, zValidator('json', createNodeSchema), async (c) => {
  const { name, hostname, serverOverallId, dockerOverallId, serverParams } = c.req.valid('json');
  const id = crypto.randomUUID();
  
  await c.env.DB.prepare(
    'INSERT INTO nodes (id, name, hostname, server_overall_id, docker_overall_id, server_params) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(
    id,
    name,
    hostname || null,
    serverOverallId || null,
    dockerOverallId || null,
    serverParams ? JSON.stringify(serverParams) : '{}',
  ).run();

  const node = await c.env.DB.prepare('SELECT * FROM nodes WHERE id = ?').bind(id).first();
  return c.json({ node }, 201);
});

nodes.put('/:id', adminAuth, zValidator('json', updateNodeSchema), async (c) => {
  const { id } = c.req.param();
  const updates = c.req.valid('json');

  const existing = await c.env.DB.prepare('SELECT * FROM nodes WHERE id = ?').bind(id).first();
  if (!existing) {
    return c.json({ error: { code: 'NODE_NOT_FOUND', message: `Node '${id}' not found` } }, 404);
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.hostname !== undefined) { sets.push('hostname = ?'); values.push(updates.hostname); }
  if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status); }
  if (updates.serverOverallId !== undefined) { sets.push('server_overall_id = ?'); values.push(updates.serverOverallId); }
  if (updates.dockerOverallId !== undefined) { sets.push('docker_overall_id = ?'); values.push(updates.dockerOverallId); }
  if (updates.serverParams !== undefined) { sets.push('server_params = ?'); values.push(JSON.stringify(updates.serverParams)); }

  if (sets.length > 0) {
    values.push(id);
    await c.env.DB.prepare(
      `UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`
    ).bind(...values).run();
  }

  const updated = await c.env.DB.prepare('SELECT * FROM nodes WHERE id = ?').bind(id).first();
  return c.json({ node: updated });
});

nodes.delete('/:id', adminAuth, async (c) => {
  const { id } = c.req.param();
  const existing = await c.env.DB.prepare('SELECT * FROM nodes WHERE id = ?').bind(id).first();
  if (!existing) {
    return c.json({ error: { code: 'NODE_NOT_FOUND', message: `Node '${id}' not found` } }, 404);
  }
  // Cascade: dangling protocol_instances rows would keep being delivered by
  // subscriptions while deploy would silently skip the missing node. Batch is
  // atomic — either both statements apply or neither does.
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM protocol_instances WHERE node_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM nodes WHERE id = ?').bind(id),
  ]);
  return c.json({ success: true });
});

export { nodes };
