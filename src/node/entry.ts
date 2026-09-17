#!/usr/bin/env node
/**
 * Node/VPS entry point for chorus-cloud.
 *
 * Serves the SAME Hono app as the Cloudflare Workers entry (src/index.ts) —
 * routes, auth, rendering, and the DB-init middleware are 100% shared. Only
 * the injected platform bindings differ:
 *
 *   D1        → SqliteD1      (better-sqlite3, single file)
 *   KV        → SqliteKV      (a kv_store table in the same SQLite file)
 *   Secrets   → AUTH_TOKEN / JWT_SECRET env vars, auto-generated + persisted
 *               on first boot when unset
 *   RateLimit → MemoryRateLimiter (opt-in via CHORUS_CLOUD_SUB_RATE_LIMIT_RPM)
 *
 * Usage: pnpm build:node && pnpm start:node   (or: pnpm dev:node)
 * Docs:  docs/deploy-vps.md
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { serve } from '@hono/node-server';

import { app } from '../index';
import { ensureDatabaseInitialized } from '../db/schema';
import { SqliteD1 } from './d1-sqlite';
import { SqliteKV } from './kv-sqlite';
import { MemoryRateLimiter } from './rate-limiter';
import { createLogger } from '../logger';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = resolve(process.env.CHORUS_CLOUD_DB ?? 'data/chorus-cloud.db');

// Boot logger: structured JSON to stdout (docker logs / journald take it from
// here). LOG_FORMAT=pretty for human-readable local debugging.
const log = createLogger(
  process.env.CHORUS_CLOUD_LOG_LEVEL ?? process.env.LOG_LEVEL,
  {},
  process.env.LOG_FORMAT === 'pretty' ? 'pretty' : 'json',
);

interface Secrets {
  AUTH_TOKEN: string;
  JWT_SECRET: string;
}

/**
 * AUTH_TOKEN / JWT_SECRET resolution: env vars win; anything missing is
 * generated once and persisted next to the database — mirroring
 * scripts/setup-prod.mjs on the Cloudflare side. Restart-safe: the generated
 * values survive reboots and container recreations as long as the data
 * directory does.
 */
function loadOrCreateSecrets(): Secrets {
  const fromEnv = {
    AUTH_TOKEN: process.env.AUTH_TOKEN,
    JWT_SECRET: process.env.JWT_SECRET,
  };
  if (fromEnv.AUTH_TOKEN && fromEnv.JWT_SECRET) {
    return { AUTH_TOKEN: fromEnv.AUTH_TOKEN, JWT_SECRET: fromEnv.JWT_SECRET };
  }

  const dataDir = dirname(DB_PATH);
  const secretsPath = join(dataDir, 'secrets.json');
  mkdirSync(dataDir, { recursive: true });
  const stored: Partial<Secrets> = existsSync(secretsPath)
    ? JSON.parse(readFileSync(secretsPath, 'utf8'))
    : {};
  stored.AUTH_TOKEN ||= randomBytes(32).toString('hex');
  stored.JWT_SECRET ||= randomBytes(32).toString('hex');
  writeFileSync(secretsPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  chmodSync(secretsPath, 0o600); // mode is ignored when the file already exists

  const generated = [
    !fromEnv.AUTH_TOKEN && 'AUTH_TOKEN',
    !fromEnv.JWT_SECRET && 'JWT_SECRET',
  ].filter(Boolean);
  log.warn(
    `${generated.join(' / ')} not set via env — generated and stored in ${secretsPath}. `
    + 'Set them as env vars to control the values (e.g. docker compose secrets).',
  );
  return {
    AUTH_TOKEN: fromEnv.AUTH_TOKEN || stored.AUTH_TOKEN!,
    JWT_SECRET: fromEnv.JWT_SECRET || stored.JWT_SECRET!,
  };
}

async function main(): Promise<void> {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const secrets = loadOrCreateSecrets();

  // Single seam between runtimes: the Workers runtime materializes `Env` from
  // wrangler bindings; here the SQLite adapters stand in. The adapters
  // implement the exact surface the app uses (pinned by tests/node/api.spec.ts).
  // LOG_LEVEL mirrors the wrangler [vars] setting so the request-logging
  // middleware behaves identically on both runtimes.
  const env = {
    DB: new SqliteD1(sqlite),
    CLIENT_CONFIGS: new SqliteKV(sqlite),
    AUTH_TOKEN: secrets.AUTH_TOKEN,
    JWT_SECRET: secrets.JWT_SECRET,
    LOG_LEVEL: process.env.CHORUS_CLOUD_LOG_LEVEL ?? process.env.LOG_LEVEL ?? 'info',
  } as unknown as Env;

  // Fail fast on a corrupt/unreadable database instead of 503-ing every
  // request — a boot-time check surfaces the problem in `docker logs` /
  // journalctl immediately. The per-process memo means the middleware will
  // not re-run the DDL afterwards.
  await ensureDatabaseInitialized(env.DB);

  const rpmRaw = process.env.CHORUS_CLOUD_SUB_RATE_LIMIT_RPM;
  if (rpmRaw) {
    const rpm = Number(rpmRaw);
    if (Number.isFinite(rpm) && rpm > 0) {
      env.SUBSCRIPTION_RATE_LIMITER = new MemoryRateLimiter(rpm, 60_000);
      log.info(`subscription rate limit: ${rpm} req/min per subscription`);
    } else {
      log.warn(`ignoring invalid CHORUS_CLOUD_SUB_RATE_LIMIT_RPM='${rpmRaw}'`);
    }
  }

  const server = serve(
    { fetch: (request) => app.fetch(request, env), port: PORT, hostname: HOST },
    (info) => {
      log.info(`chorus-cloud (node) listening on http://${info.address}:${info.port}`);
      log.info(`sqlite db: ${DB_PATH}`);
    },
  );

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    server.close(() => {
      sqlite.close();
      process.exit(0);
    });
    // Release idle keep-alive connections (health pollers) so close() can
    // finish; the unref'd timer is the hard fallback for in-flight requests.
    (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('fatal startup error', { err });
  process.exit(1);
});
