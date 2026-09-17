import { Hono } from 'hono';
import { adminAuth } from '../auth/middleware';

/**
 * Tag uniqueness check. Tags are sing-box inbound/outbound identifiers —
 * every config across every node must have a globally unique tag so merged
 * configs never contain duplicate identifiers.
 *
 * Checks three stores, in cost order:
 *  1. protocol_instances.tag indexed column (mirrored from params.tag on
 *     every write since migration 0010)
 *  2. KV tag index `tag:{tag}` (maintained on client upload/delete) — O(1)
 *  3. Bounded fallback scan of KV client configs (legacy entries written
 *     before the index existed; the index self-heals as panels re-sync)
 *
 * Every D1 query and KV operation counts toward the Workers subrequest
 * budget (50 on the free plan), so both KV phases are strictly bounded.
 */

/** Fallback scan budget — keeps the whole request well under 50 subrequests. */
const FALLBACK_SCAN_LIMIT = 30;

const tags = new Hono<{ Bindings: Env }>();

tags.get('/check', adminAuth, async (c) => {
  const tag = c.req.query('tag');
  if (!tag) {
    return c.json({ error: { code: 'TAG_REQUIRED', message: 'tag query param is required' } }, 400);
  }

  // 1. protocol_instances — indexed lookup on the tag column mirrored from
  //    params.tag (CLOUD-P2: replaces the previous params LIKE full scan).
  const { results: instanceRows } = await c.env.DB.prepare(
    "SELECT id, params FROM protocol_instances WHERE tag = ?"
  ).bind(tag).all<{ id: string; params: string }>();
  if (instanceRows && instanceRows.length > 0) {
    return c.json({ tag, available: false, source: 'protocol_instances' });
  }

  // Legacy rows written before migration 0010 have tag = '' and would be
  // invisible to the indexed lookup. The probe is itself an index lookup, so
  // once every row has been backfilled the LIKE scan disappears entirely;
  // until then a hit self-heals its row, converging the scan to zero.
  const legacyRow = await c.env.DB.prepare(
    "SELECT id FROM protocol_instances WHERE tag = '' LIMIT 1"
  ).first();
  if (legacyRow) {
    const { results: legacyRows } = await c.env.DB.prepare(
      "SELECT id, params FROM protocol_instances WHERE params LIKE ?"
    ).bind(`%"${tag}"%`).all<{ id: string; params: string }>();
    for (const row of legacyRows ?? []) {
      try {
        const p = JSON.parse(row.params);
        if (p.tag === tag) {
          // Self-heal: backfill the indexed column so future checks for this
          // tag never repeat the LIKE scan.
          await c.env.DB.prepare(
            "UPDATE protocol_instances SET tag = ? WHERE id = ?"
          ).bind(tag, row.id).run().catch(() => { /* best-effort */ });
          return c.json({ tag, available: false, source: 'protocol_instances' });
        }
      } catch { /* malformed params row — skip */ }
    }
  }

  // 2. O(1) index lookup — written by every client upload since the index
  //    was introduced.
  const owner = await c.env.CLIENT_CONFIGS.get(`tag:${tag}`);
  if (owner) {
    return c.json({ tag, available: false, source: 'kv_client_configs' });
  }

  // 3. Legacy fallback: scan client configs written before the index existed.
  //    Parallel and capped so the subrequest budget is never exceeded. KV
  //    failures (e.g. free-tier daily list quota exhausted) degrade to
  //    "available" — the index already covers everything uploaded since its
  //    introduction, and blocking creation on a transient KV error is worse
  //    than a missed conflict.
  try {
    const { keys } = await c.env.CLIENT_CONFIGS.list({ prefix: 'client:' });
    const scannable = keys
      .filter((k) => k.name.split(':').length >= 3) // skip legacy single-segment keys
      .slice(0, FALLBACK_SCAN_LIMIT);
    const values = await Promise.all(scannable.map((k) => c.env.CLIENT_CONFIGS.get(k.name)));
    for (let i = 0; i < values.length; i++) {
      const val = values[i];
      if (!val) continue;
      try {
        const parsed = JSON.parse(val);
        if (parsed?.config?.tag === tag) {
          // Self-heal: backfill the index so future checks for this tag are
          // O(1) instead of repeating the fallback scan.
          const rec = parsed as { name?: string; fingerprint?: string };
          if (rec.name && rec.fingerprint) {
            await c.env.CLIENT_CONFIGS.put(`tag:${tag}`, `${rec.fingerprint}:${rec.name}`, {
              expirationTtl: 7_776_000,
            }).catch(() => { /* best-effort */ });
          }
          return c.json({ tag, available: false, source: 'kv_client_configs' });
        }
      } catch { /* malformed KV value — skip */ }
    }
  } catch (e) {
    c.get('logger').warn('tags/check: KV fallback scan failed, degrading to available', { err: e });
  }

  return c.json({ tag, available: true });
});

export { tags };
