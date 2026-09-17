import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { adminAuth } from '../auth/middleware';

const upsertSchema = z.object({
  config: z.record(z.unknown()),
  protocol_type: z.string().min(1),
  content_hash: z.string().optional(),
  enabled: z.boolean().optional(),
  deployed: z.boolean().optional(),
});

const CLIENT_CONFIG_TTL = 7776000; // 90 days

/**
 * Upper bound on per-key KV reads in one request (full-record pull paths).
 * Every KV read counts toward the Workers subrequest budget (50 on the free
 * plan): 1 list + 45 gets + ≤3 auth/D1 calls stays under the cap. Metadata
 * list endpoints don't hit this — they read mirrored KV metadata at zero
 * per-key cost (see MAX_LIST_RESULTS). Beyond 45 records per node, full pulls
 * truncate silently; lifting that requires a paginated pull API (core must
 * follow the cursor) or migrating configs to D1.
 */
const MAX_KV_READS = 45;

/**
 * Upper bound on list results returned from metadata-only endpoints. KV list
 * is a single operation regardless of size, so this only guards the response
 * body — far above the free-plan read budget that used to cap it at 40.
 */
const MAX_LIST_RESULTS = 500;

/**
 * Metadata mirrored from the full KV record. List endpoints (sync
 * reconciliation, subscription filtering) read only this, so a sync round
 * costs one KV list and zero KV reads. Legacy records written before this
 * schema lack `name` and are fetched via a bounded get() fallback.
 */
interface ClientMeta {
  fingerprint: string;
  protocol_type: string;
  name: string;
  content_hash: string;
  enabled: boolean;
  deployed: boolean;
  port: number | null;
  tag: string;
  created_at: string;
  updated_at: string;
}

const clients = new Hono<{ Bindings: Env }>();

/**
 * Client configs are namespaced per node fingerprint: `client:{fingerprint}:{name}`.
 * Legacy entries (uploaded before fingerprint namespacing) use `client:{name}`
 * and are only readable via the legacy single-segment endpoints.
 */

function clientKey(fingerprint: string, name: string) {
  return `client:${fingerprint}:${name}`;
}

/** KV key of the tag-uniqueness index: tag → "fingerprint:name" owner. */
function tagIndexKey(tag: string) {
  return `tag:${tag}`;
}

/** Extract the effective listen/connect port from a sing-box config (0/absent → null). */
function extractPort(config: Record<string, unknown>): number | null {
  const raw = config?.server_port ?? config?.listen_port;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/** Extract the sing-box tag from a stored client record (empty when absent). */
function extractTag(config: Record<string, unknown> | undefined): string {
  const tag = config?.tag;
  return typeof tag === 'string' ? tag.trim() : '';
}

/** A single KV entry: key + mirrored metadata. */
interface KeyWithMeta {
  name: string;
  metadata: Partial<ClientMeta> | undefined;
}

/**
 * List client entries under a fingerprint prefix, tolerating KV failure
 * (returns null — callers degrade gracefully instead of failing the upload).
 */
async function listClientKeys(env: Env, fingerprint: string): Promise<KeyWithMeta[] | null> {
  try {
    const { keys } = await env.CLIENT_CONFIGS.list({ prefix: `client:${fingerprint}:` });
    return keys.map((k) => ({ name: k.name, metadata: k.metadata as Partial<ClientMeta> | undefined }));
  } catch (e) {
    // KV unavailable (e.g. free-tier daily list quota exhausted).
    console.error('listClientKeys: KV list failed:', e); // no request context here — plain line
    return null;
  }
}

/** Metadata for one key, or undefined when absent / legacy (no mirrored name). */
function metaOf(entry: KeyWithMeta): Partial<ClientMeta> | undefined {
  return entry.metadata?.name ? entry.metadata : undefined;
}

// List all clients across every node (metadata-only: 1 KV list, 0 reads).
clients.get('/', adminAuth, async (c) => {
  const fingerprint = c.req.query('fingerprint');
  const prefix = fingerprint ? `client:${fingerprint}:` : 'client:';

  let keys: KeyWithMeta[];
  try {
    const { keys: raw } = await c.env.CLIENT_CONFIGS.list({ prefix });
    keys = raw.map((k) => ({ name: k.name, metadata: k.metadata as Partial<ClientMeta> | undefined }));
  } catch (e) {
    // KV unavailable (e.g. free-tier daily list quota exhausted). Return 503,
    // NOT an empty list — sync callers reconcile against this response and an
    // empty list would look like "cloud has nothing".
    c.get('logger').error('clients list: KV list failed', { err: e });
    return c.json({ error: { code: 'KV_UNAVAILABLE', message: 'Client storage temporarily unavailable' } }, 503);
  }
  const readable = keys.filter((k) => k.name.split(':').length >= 3).slice(0, MAX_LIST_RESULTS);

  // Legacy records without mirrored metadata: bounded get() fallback so sync
  // reconciliation still sees (and can delete) pre-metadata entries.
  const legacyKeys = readable.filter((k) => !k.metadata?.name).slice(0, MAX_KV_READS);
  const legacyValues = await Promise.all(legacyKeys.map((k) => c.env.CLIENT_CONFIGS.get(k.name)));
  const legacyByName = new Map<string, Record<string, unknown> | null>();
  for (let i = 0; i < legacyKeys.length; i++) {
    legacyByName.set(legacyKeys[i].name, legacyValues[i] ? JSON.parse(legacyValues[i] as string) : null);
  }

  const clientList = readable.map((k) => {
    const legacy = legacyByName.get(k.name);
    if (legacy) return legacy;
    const m = metaOf(k);
    if (!m) return null;
    return {
      name: m.name,
      fingerprint: m.fingerprint,
      protocol_type: m.protocol_type,
      content_hash: m.content_hash,
      enabled: m.enabled ?? true,
      deployed: m.deployed ?? false,
      created_at: m.created_at,
      updated_at: m.updated_at,
    };
  }).filter(Boolean) as Record<string, unknown>[];

  clientList.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return c.json({ clients: clientList });
});

// List clients owned by one node (full records: pull needs the config body).
clients.get('/:fingerprint', adminAuth, async (c) => {
  const { fingerprint } = c.req.param();
  if (fingerprint.includes(':')) {
    return c.json({ error: { code: 'BAD_FINGERPRINT', message: 'Invalid fingerprint' } }, 400);
  }
  let keys: { name: string }[];
  try {
    ({ keys } = await c.env.CLIENT_CONFIGS.list({ prefix: `client:${fingerprint}:` }));
  } catch (e) {
    // Same rationale as GET /: return 503 rather than a misleading empty list.
    console.error('clients list by node: KV list failed:', e);
    return c.json({ error: { code: 'KV_UNAVAILABLE', message: 'Client storage temporarily unavailable' } }, 503);
  }
  if (keys.length === 0) {
    // Distinguish "node unknown" from "node has no configs".
    const { keys: nodeKeys } = await c.env.CLIENT_CONFIGS.list({ prefix: `client:${fingerprint}` });
    if (nodeKeys.length === 0) {
      return c.json({ error: { code: 'CLIENT_NOT_FOUND', message: `Node '${fingerprint}' not found` } }, 404);
    }
  }

  const clientList: Record<string, unknown>[] = [];
  const bounded = keys.slice(0, MAX_KV_READS);
  const values = await Promise.all(bounded.map((k) => c.env.CLIENT_CONFIGS.get(k.name)));
  for (const val of values) {
    if (val) clientList.push(JSON.parse(val));
  }
  clientList.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return c.json({ clients: clientList });
});

// Get a single client by fingerprint + name.
clients.get('/:fingerprint/:name', adminAuth, async (c) => {
  const { fingerprint, name } = c.req.param();
  const val = await c.env.CLIENT_CONFIGS.get(clientKey(fingerprint, name));
  if (!val) {
    return c.json({ error: { code: 'CLIENT_NOT_FOUND', message: `Client '${name}' not found` } }, 404);
  }
  return c.json({ client: JSON.parse(val) });
});

// Upsert a client owned by the given node.
clients.put('/:fingerprint/:name', adminAuth, zValidator('json', upsertSchema), async (c) => {
  const { fingerprint, name } = c.req.param();
  const { config, protocol_type, content_hash, enabled, deployed } = c.req.valid('json');

  const key = clientKey(fingerprint, name);
  const now = new Date().toISOString();

  // One KV list covers both the previous record's metadata (created_at, tag)
  // and the same-machine port conflict check — no reads needed.
  const siblings = await listClientKeys(c.env, fingerprint);
  const prevMeta = siblings ? metaOf(siblings.find((k) => k.name === key) ?? { name: key, metadata: undefined }) : undefined;

  // Same-machine port conflict guard: reject when another config of this
  // node already listens on the same port (only when content is new/changed).
  const port = extractPort(config);
  if (port !== null && siblings) {
    for (const sibling of siblings) {
      if (sibling.name === key) continue;
      const m = metaOf(sibling);
      if (m && m.port === port) {
        return c.json({
          error: {
            code: 'PORT_CONFLICT',
            message: `Port ${port} is already used by config '${m.name}' on this node`,
          },
        }, 409);
      }
    }
  }

  const record = {
    name,
    fingerprint,
    config,
    protocol_type,
    content_hash: content_hash || '',
    enabled: enabled ?? true,
    deployed: deployed ?? false,
    status: 'active',
    created_at: prevMeta?.created_at ?? now,
    updated_at: now,
  };

  const meta: ClientMeta = {
    fingerprint,
    protocol_type,
    name,
    content_hash: record.content_hash,
    enabled: record.enabled,
    deployed: record.deployed,
    port,
    tag: extractTag(config),
    created_at: record.created_at,
    updated_at: now,
  };

  await c.env.CLIENT_CONFIGS.put(key, JSON.stringify(record), {
    expirationTtl: CLIENT_CONFIG_TTL,
    metadata: meta,
  });

  // Maintain the tag-uniqueness index (tag → owner). The previous tag's index
  // entry is removed when the config was re-tagged, so renames don't leave
  // stale claims behind.
  const tag = meta.tag;
  const prevTag = prevMeta?.tag ?? '';
  if (tag && tag !== prevTag) {
    await c.env.CLIENT_CONFIGS.put(tagIndexKey(tag), `${fingerprint}:${name}`, {
      expirationTtl: CLIENT_CONFIG_TTL,
    });
  } else if (tag && tag === prevTag) {
    // Renew the index TTL alongside the config so the claim never outlives
    // the config renewal cadence (otherwise the index expires first and the
    // same tag can be re-claimed by another config). Renew only when this
    // config still owns the claim — after an index expiry the tag may
    // already have been legitimately re-claimed elsewhere.
    const owner = await c.env.CLIENT_CONFIGS.get(tagIndexKey(tag));
    if (owner === null || owner === `${fingerprint}:${name}`) {
      await c.env.CLIENT_CONFIGS.put(tagIndexKey(tag), `${fingerprint}:${name}`, {
        expirationTtl: CLIENT_CONFIG_TTL,
      });
    }
  }
  if (prevTag && prevTag !== tag) {
    const owner = await c.env.CLIENT_CONFIGS.get(tagIndexKey(prevTag));
    if (owner === `${fingerprint}:${name}`) {
      await c.env.CLIENT_CONFIGS.delete(tagIndexKey(prevTag));
    }
  }

  return c.json({ client: record }, prevMeta ? 200 : 201);
});

clients.delete('/:fingerprint/:name', adminAuth, async (c) => {
  const { fingerprint, name } = c.req.param();
  const key = clientKey(fingerprint, name);
  const val = await c.env.CLIENT_CONFIGS.get(key);
  if (!val) {
    return c.json({ error: { code: 'CLIENT_NOT_FOUND', message: `Client '${name}' not found` } }, 404);
  }
  await c.env.CLIENT_CONFIGS.delete(key);

  // Release the tag claim if this config owned it.
  const tag = extractTag(JSON.parse(val)?.config);
  if (tag) {
    const owner = await c.env.CLIENT_CONFIGS.get(tagIndexKey(tag));
    if (owner === `${fingerprint}:${name}`) {
      await c.env.CLIENT_CONFIGS.delete(tagIndexKey(tag));
    }
  }

  return c.json({ success: true });
});

export { clients };
