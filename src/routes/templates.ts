import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { adminAuth } from '../auth/middleware';
import { invalidateTemplateCache } from '../engine/registry';

// Overall templates use categories: overall-server, overall-client, overall-docker (migration 0008)
// For backward compatibility, the API accepts short names (server/client/docker) and maps them.
const SHORT_TO_FULL: Record<string, string> = {
  server: 'overall-server',
  client: 'overall-client',
  docker: 'overall-docker',
  'overall-server': 'overall-server',
  'overall-client': 'overall-client',
  'overall-docker': 'overall-docker',
};

// Validate that a templateContent/config/entryScript string is valid JSON when present.
function validateJsonField(field: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    JSON.parse(value);
    return null;
  } catch {
    return `Field '${field}' must be valid JSON`;
  }
}

const templateCreateSchema = z.object({
  id: z.string().min(1).max(64),
  category: z.enum(['server', 'client', 'docker', 'overall-server', 'overall-client', 'overall-docker']),
  name: z.string().min(1).max(128),
  version: z.string().default('1.0.0'),
  templateContent: z.string().min(1),
  config: z.string().optional(),
  entryScript: z.string().optional(),
  description: z.string().max(512).optional(),
});

const templates = new Hono<{ Bindings: Env }>();

templates.get('/', async (c) => {
  const categoryRaw = c.req.query('category');
  let query = "SELECT * FROM templates WHERE category IN ('overall-server', 'overall-client', 'overall-docker')";
  const bind: unknown[] = [];
  if (categoryRaw) {
    const mapped = SHORT_TO_FULL[categoryRaw];
    if (mapped) {
      query += ' AND category = ?';
      bind.push(mapped);
    }
  }
  query += " ORDER BY created_at DESC";
  const { results } = await c.env.DB.prepare(query).bind(...bind).all();
  return c.json({ templates: results });
});

templates.get('/:id', async (c) => {
  const { id } = c.req.param();
  const tmpl = await c.env.DB.prepare(
    "SELECT * FROM templates WHERE id = ? AND category IN ('overall-server', 'overall-client', 'overall-docker')"
  ).bind(id).first();
  if (!tmpl) {
    return c.json({ error: { code: 'TMPL_NOT_FOUND', message: `Template '${id}' not found` } }, 404);
  }
  return c.json({ template: tmpl });
});

templates.post('/', adminAuth, zValidator('json', templateCreateSchema), async (c) => {
  const body = c.req.valid('json');
  const category = SHORT_TO_FULL[body.category];

  const jsonErr = validateJsonField('templateContent', body.templateContent) ?? validateJsonField('config', body.config);
  if (jsonErr) {
    return c.json({ error: { code: 'TMPL_INVALID_JSON', message: jsonErr } }, 400);
  }

  try {
    await c.env.DB.prepare(
      `INSERT INTO templates (id, category, name, version, template_content, config, entry_script, params, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)`
    ).bind(
      body.id,
      category,
      body.name,
      body.version,
      body.templateContent,
      body.config ?? null,
      body.entryScript ?? null,
      body.description ?? null,
    ).run();

    const tmpl = await c.env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(body.id).first();
    invalidateTemplateCache(); // CLOUD-P4: renders must see the new template now
    return c.json({ template: tmpl }, 201);
  } catch (e: any) {
    if (e?.message?.includes('UNIQUE constraint failed')) {
      return c.json({ error: { code: 'TMPL_DUPLICATE_ID', message: `Template id '${body.id}' already exists` } }, 409);
    }
    throw e;
  }
});

templates.put('/:id', adminAuth, zValidator('json', templateCreateSchema.omit({ id: true, category: true }).partial()), async (c) => {
  const { id } = c.req.param();
  const body = c.req.valid('json');
  const existing = await c.env.DB.prepare(
    "SELECT * FROM templates WHERE id = ? AND category IN ('overall-server', 'overall-client', 'overall-docker')"
  ).bind(id).first();
  if (!existing) {
    return c.json({ error: { code: 'TMPL_NOT_FOUND', message: `Template '${id}' not found` } }, 404);
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.name !== undefined) { sets.push('name = ?'); values.push(body.name); }
  if (body.version !== undefined) { sets.push('version = ?'); values.push(body.version); }
  if (body.templateContent !== undefined) {
    const err = validateJsonField('templateContent', body.templateContent);
    if (err) return c.json({ error: { code: 'TMPL_INVALID_JSON', message: err } }, 400);
    sets.push('template_content = ?'); values.push(body.templateContent);
  }
  if (body.config !== undefined) {
    const err = validateJsonField('config', body.config);
    if (err) return c.json({ error: { code: 'TMPL_INVALID_JSON', message: err } }, 400);
    sets.push('config = ?'); values.push(body.config);
  }
  if (body.entryScript !== undefined) { sets.push('entry_script = ?'); values.push(body.entryScript); }
  if (body.description !== undefined) { sets.push('description = ?'); values.push(body.description); }

  if (sets.length > 0) {
    values.push(id);
    await c.env.DB.prepare(
      `UPDATE templates SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`
    ).bind(...values).run();
    invalidateTemplateCache(); // CLOUD-P4: drop the stale shared cache immediately
  }

  const updated = await c.env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(id).first();
  return c.json({ template: updated });
});

templates.delete('/:id', adminAuth, async (c) => {
  const { id } = c.req.param();
  const existing = await c.env.DB.prepare(
    "SELECT * FROM templates WHERE id = ? AND category IN ('overall-server', 'overall-client', 'overall-docker')"
  ).bind(id).first();
  if (!existing) {
    return c.json({ error: { code: 'TMPL_NOT_FOUND', message: `Template '${id}' not found` } }, 404);
  }
  await c.env.DB.prepare('DELETE FROM templates WHERE id = ?').bind(id).run();
  invalidateTemplateCache(); // CLOUD-P4: deleted templates must not render
  return c.json({ success: true });
});

export { templates };
