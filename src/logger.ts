/**
 * Runtime-agnostic structured logger for chorus-cloud.
 *
 * Design constraints (see the "single seam" between the Workers and Node
 * entries): the logger itself only ever touches `console`, which exists in
 * both runtimes — the destination differs but the code does not:
 *
 *   Cloudflare Workers → console.* is captured by Workers Logs
 *     (wrangler.toml [observability]; JSON lines get auto-indexed, so fields
 *     like requestId/level/path become dashboard filters).
 *   Node/VPS entry     → console.* goes to stdout, i.e. `docker logs` /
 *     journald, which own rotation and retention.
 *
 * One JSON line per event, stable schema:
 *   {"ts":"...","level":"info","msg":"...","requestId":"...", ...fields}
 *
 * Log level comes from the request env (`c.env.LOG_LEVEL`): wrangler vars on
 * Workers, process.env injected into the fake env object on Node — the
 * middleware never branches on the runtime.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/** Serialize an Error for JSON output (JSON.stringify drops name/stack). */
export function serializeError(err: unknown): LogFields | undefined {
  if (err === undefined || err === null) return undefined;
  if (err instanceof Error) {
    const out: LogFields = { name: err.name, message: err.message };
    if (err.stack) out.stack = err.stack;
    if (err.cause) out.cause = serializeError(err.cause);
    return out;
  }
  return { message: String(err) };
}

export function resolveLogLevel(raw: unknown): LogLevel {
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized in LEVEL_WEIGHT) return normalized as LogLevel;
  }
  return 'info';
}

const CONSOLE_METHOD: Record<Exclude<LogLevel, 'silent'>, 'debug' | 'info' | 'warn' | 'error'> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

/**
 * Build a logger. `base` fields are attached to every line (e.g. requestId).
 * `format: 'pretty'` swaps JSON for a human-readable line — for `wrangler dev`
 * and local debugging only; production stays JSON so Workers Logs / jq can
 * parse it.
 */
export function createLogger(
  level: unknown,
  base: LogFields = {},
  format: 'json' | 'pretty' = 'json',
): Logger {
  const min = LEVEL_WEIGHT[resolveLogLevel(level)];
  const write = (lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: LogFields): void => {
    if (LEVEL_WEIGHT[lvl] < min) return;
    const { err, ...rest } = fields ?? {};
    const payload: LogFields = {
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...base,
      ...rest,
    };
    const serialized = serializeError(err);
    if (serialized !== undefined) payload.err = serialized;

    if (format === 'pretty') {
      const extras = Object.entries(payload).filter(([k]) => !['ts', 'level', 'msg'].includes(k));
      const suffix = extras.length ? ` ${JSON.stringify(Object.fromEntries(extras))}` : '';
      console[CONSOLE_METHOD[lvl]](`${payload.ts} ${lvl.toUpperCase().padEnd(5)} ${msg}${suffix}`);
      return;
    }
    console[CONSOLE_METHOD[lvl]](JSON.stringify(payload));
  };

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}

/** No-op logger — tests / library code without a request context. */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Make the request-scoped logger available to every Hono sub-router via
 * `c.get('logger')`, same pattern as the global `auth` variable in
 * auth/middleware.ts.
 */
declare module 'hono' {
  interface ContextVariableMap {
    logger: Logger;
    requestId: string;
  }
}
