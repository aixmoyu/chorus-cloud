import { Hono } from 'hono';
import { ensureDatabaseInitialized } from './db/schema';
import { protocols } from './routes/protocols';
import { protocolInstances } from './routes/protocol-instances';
import { templates } from './routes/templates';
import { clients } from './routes/clients';
import { subscriptions } from './routes/subscriptions';
import { admin } from './routes/admin';
import { nodes } from './routes/nodes';
import { deploy } from './routes/deploy';
import { render } from './routes/render';
import { auth } from './routes/auth';
import { users } from './routes/users';
import { tags } from './routes/tags';
import { PluginError } from './engine/errors';
import { createLogger } from './logger';

const app = new Hono<{ Bindings: Env }>();

/**
 * Request logging: one structured JSON line per request, plus an
 * X-Request-ID for cross-service tracing. The panel forwards its own
 * X-Request-ID when calling cloud, so one ID traces the full
 * panel → cloud → Workers Logs path.
 *
 * The runtime seam stays intact: LOG_LEVEL is read from the request env —
 * a wrangler var on Workers, process.env injected by node/entry.ts on Node.
 */
app.use('*', async (c, next) => {
  const requestId = c.req.header('X-Request-ID') ?? crypto.randomUUID();
  const logger = createLogger(c.env.LOG_LEVEL, { requestId });
  c.set('logger', logger);
  c.set('requestId', requestId);
  c.header('X-Request-ID', requestId);
  const startedAt = Date.now();
  await next();
  logger.info('request completed', {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - startedAt,
  });
});

app.use('*', async (c, next) => {
  try {
    await ensureDatabaseInitialized(c.env.DB);
  } catch (err) {
    // CLOUD-A2: D1 outage at cold start — fail with explicit 503 semantics
    // instead of a raw 500 (which looks like a bug). Mirrors the
    // KV_UNAVAILABLE contract; core already retries 5xx with backoff.
    c.get('logger').error('database init failed', { err });
    return c.json({ error: { code: 'DB_UNAVAILABLE', message: 'Database temporarily unavailable' } }, 503);
  }
  await next();
});

app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'chorus-cloud' });
});

app.route('/api/protocols', protocols);
app.route('/api/protocol-instances', protocolInstances);
app.route('/api/templates', templates);
app.route('/api/clients', clients);
app.route('/', subscriptions);
app.route('/api/admin', admin);
app.route('/api/nodes', nodes);
app.route('/api/deploy', deploy);
app.route('/api/render', render);
app.route('/api/auth', auth);
app.route('/api/users', users);
app.route('/api/tags', tags);

// Unified error exit: PluginError (engine validation/rendering) maps to 400;
// anything unexpected is logged with route context and returned as 500. The
// error message IS included in the response — this is an admin-facing API and
// actionable detail (e.g. KV "free usage limit" errors) beats opaqueness.
// Stack traces are never returned.
app.onError((err, c) => {
  const logger = c.get('logger') ?? createLogger(c.env?.LOG_LEVEL, {});
  if (err instanceof PluginError) {
    logger.warn('request rejected by engine', { method: c.req.method, path: c.req.path, code: err.code });
    return c.json({ error: { code: err.code, message: err.message } }, 400);
  }
  logger.error('request failed', { method: c.req.method, path: c.req.path, err });
  return c.json({
    error: {
      code: 'INTERNAL_ERROR',
      message: err instanceof Error ? err.message : 'Internal server error',
    },
  }, 500);
});

app.notFound((c) => {
  return c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404);
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

// Named export for the Node/VPS entry (src/node/entry.ts): same app instance
// and middleware chain — only the injected platform bindings differ.
export { app };
