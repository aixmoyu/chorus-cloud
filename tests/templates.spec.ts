import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabaseInitCache } from '../src/db/schema';
import { adminHeaders, api, jsonBody } from './helpers';

// D1 storage is reset per test while module state persists in the single
// worker — drop the init memo so every test re-runs the schema setup.
beforeEach(() => {
  resetDatabaseInitCache();
});

const VALID_TEMPLATE = {
  id: 'tmpl-it',
  category: 'docker',
  name: 'IT Docker',
  version: '1.0.0',
  templateContent: JSON.stringify({ services: { app: { image: 'busybox' } } }),
  entryScript: '#!/bin/sh\necho hi',
};

async function createTemplate(extra: Record<string, unknown> = {}): Promise<any> {
  const res = await api('/api/templates', {
    method: 'POST',
    headers: await adminHeaders(),
    body: JSON.stringify({ ...VALID_TEMPLATE, ...extra }),
  });
  return { status: res.status, body: await jsonBody(res) };
}

describe('Templates API', () => {
  it('GET / lists templates without auth (public read)', async () => {
    const res = await api('/api/templates');
    expect(res.status).toBe(200);
    expect(Array.isArray((await jsonBody(res)).templates)).toBe(true);
  });

  it('rejects create without auth', async () => {
    const res = await api('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_TEMPLATE),
    });
    expect(res.status).toBe(401);
  });

  it('rejects invalid create bodies (bad category / bad JSON field)', async () => {
    const badCategory = await createTemplate({ id: 'bad-cat', category: 'network' });
    expect(badCategory.status).toBe(400);

    const badJson = await createTemplate({ id: 'bad-json', templateContent: '{oops' });
    expect(badJson.status).toBe(400);
    expect(badJson.body.error.code).toBe('TMPL_INVALID_JSON');
  });

  it('rejects duplicate template id (409)', async () => {
    await createTemplate();
    const dup = await createTemplate({ name: 'Second' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('TMPL_DUPLICATE_ID');
  });

  it('GET /:id returns the template or 404', async () => {
    await createTemplate();
    const got = await jsonBody(await api('/api/templates/tmpl-it'));
    expect(got.template.id).toBe('tmpl-it');
    expect(got.template.category).toBe('overall-docker'); // short name mapped on write

    const missing = await api('/api/templates/no-such-tmpl');
    expect(missing.status).toBe(404);
  });

  it('GET /?category= filters using short category names', async () => {
    await createTemplate();
    const res = await api('/api/templates?category=docker');
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.templates.some((t: any) => t.id === 'tmpl-it')).toBe(true);
  });

  it('PUT updates content and renders see the change immediately (cache invalidation)', async () => {
    await createTemplate();

    const renderBefore = await api('/api/render/overall', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ category: 'docker', templateId: 'tmpl-it' }),
    });
    expect(renderBefore.status).toBe(200);
    expect((await jsonBody(renderBefore)).composeYaml).toContain('busybox');

    const put = await api('/api/templates/tmpl-it', {
      method: 'PUT',
      headers: await adminHeaders(),
      body: JSON.stringify({ templateContent: JSON.stringify({ services: { app: { image: 'alpine' } } }) }),
    });
    expect(put.status).toBe(200);
    expect((await jsonBody(put)).template.template_content).toContain('alpine');

    const renderAfter = await api('/api/render/overall', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ category: 'docker', templateId: 'tmpl-it' }),
    });
    expect((await jsonBody(renderAfter)).composeYaml).toContain('alpine');
  });

  it('PUT returns 404 for unknown template and 400 for invalid JSON', async () => {
    expect(
      (await api('/api/templates/no-such-tmpl', {
        method: 'PUT',
        headers: await adminHeaders(),
        body: JSON.stringify({ name: 'x' }),
      })).status,
    ).toBe(404);

    await createTemplate();
    const bad = await api('/api/templates/tmpl-it', {
      method: 'PUT',
      headers: await adminHeaders(),
      body: JSON.stringify({ templateContent: '{oops' }),
    });
    expect(bad.status).toBe(400);
  });

  it('DELETE removes the template and renders then fail with PLG_UNKNOWN_TYPE', async () => {
    await createTemplate();

    const del = await api('/api/templates/tmpl-it', {
      method: 'DELETE',
      headers: await adminHeaders(),
    });
    expect(del.status).toBe(200);
    expect((await api('/api/templates/tmpl-it')).status).toBe(404);

    // Deleted templates must not render (CLOUD-P4: cache invalidated on delete).
    const render = await api('/api/render/overall', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ category: 'docker', templateId: 'tmpl-it' }),
    });
    expect(render.status).toBe(400);
    expect((await jsonBody(render)).error.code).toBe('PLG_UNKNOWN_TYPE');
  });

  it('DELETE returns 404 for unknown template', async () => {
    const res = await api('/api/templates/no-such-tmpl', {
      method: 'DELETE',
      headers: await adminHeaders(),
    });
    expect(res.status).toBe(404);
  });
});
