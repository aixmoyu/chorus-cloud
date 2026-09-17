#!/usr/bin/env node
/**
 * ChorusCloud 生产环境一键初始化
 *
 * 做的事情（幂等，可重复执行）：
 *   1. 获取或创建 D1 数据库（chorus-cloud-prod）
 *   2. 获取或创建 KV Namespace（CLIENT_CONFIGS）
 *   3. 生成 wrangler.prod.toml（写入真实资源 ID，不含 secrets）
 *   4. 应用远程 D1 迁移
 *   5. 部署 Worker
 *   6. 设置生产 secrets（AUTH_TOKEN / JWT_SECRET）
 *      - 优先使用环境变量 AUTH_TOKEN / JWT_SECRET 的值
 *      - 否则随机生成 64 字符 hex，并写入 .prod.vars 供查阅
 *   7. 打印部署 URL 与 seed 命令
 *
 * 用法：
 *   pnpm setup:prod            # 全自动
 *   AUTH_TOKEN=xxx JWT_SECRET=yyy pnpm setup:prod   # 指定密钥
 *
 * 前置：已执行 `npx wrangler login` 或设置 CLOUDFLARE_API_TOKEN 环境变量。
 */
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLOUD_DIR = resolve(__dirname, '..');
const PROD_TOML = resolve(CLOUD_DIR, 'wrangler.prod.toml');
const PROD_VARS = resolve(CLOUD_DIR, '.prod.vars');

const D1_NAME = 'chorus-cloud-prod';
const KV_TITLE = 'CLIENT_CONFIGS';
const WORKER_NAME = 'chorus-cloud';
const MIGRATIONS_DIR = 'migrations';

const log = (msg) => console.log(`\n\x1b[1;36m▸ ${msg}\x1b[0m`);
const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const warn = (msg) => console.log(`  \x1b[33m! ${msg}\x1b[0m`);
const die = (msg) => {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
};

function run(cmd, { input, cwd = CLOUD_DIR, ignoreError = false } = {}) {
  try {
    return execSync(cmd, {
      cwd,
      input,
      encoding: 'utf8',
      stdio: input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    }).trim();
  } catch (err) {
    if (ignoreError) return '';
    throw err;
  }
}

function runJson(cmd, opts = {}) {
  // Try the --json flag first (works for most wrangler subcommands like `d1 list`).
  try {
    const out = run(`${cmd} --json`, { ...opts, ignoreError: false });
    return JSON.parse(out);
  } catch {
    // fall through
  }
  // Some wrangler subcommands (e.g. `kv namespace list`) reject --json but
  // already emit a JSON array by default — parse the plain output.
  try {
    const out = run(cmd, { ...opts, ignoreError: false });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function getOrCreateD1() {
  log(`D1 数据库：${D1_NAME}`);
  let list = runJson('npx wrangler d1 list');
  let existing = Array.isArray(list) ? list.find((d) => d.name === D1_NAME || d.database === D1_NAME) : null;
  if (existing) {
    const id = existing.uuid || existing.database_id || existing.id;
    ok(`已存在，复用 ID = ${id}`);
    return id;
  }
  const created = runJson(`npx wrangler d1 create ${D1_NAME}`);
  if (created) {
    const id = created.uuid || created.database_id || created.id;
    ok(`已创建，ID = ${id}`);
    return id;
  }
  // Text fallback (create doesn't support --json on older wrangler)
  const raw = run(`npx wrangler d1 create ${D1_NAME}`, { ignoreError: true });
  const m = raw.match(/database_id\s*=\s*"([0-9a-f-]+)"/i) || raw.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (m) {
    ok(`已创建，ID = ${m[1]}`);
    return m[1];
  }
  // create likely failed with "already exists" (race) → re-list
  const list2 = runJson('npx wrangler d1 list');
  const found2 = Array.isArray(list2) ? list2.find((d) => d.name === D1_NAME || d.database === D1_NAME) : null;
  if (found2) {
    const id = found2.uuid || found2.database_id || found2.id;
    ok(`已存在，复用 ID = ${id}`);
    return id;
  }
  die(`无法创建或查找 D1 database_id，请手动执行：npx wrangler d1 create ${D1_NAME}`);
}

function getOrCreateKV() {
  log(`KV Namespace：${KV_TITLE}`);
  let list = runJson('npx wrangler kv namespace list');
  let existing = Array.isArray(list)
    ? list.find((n) => n.title === KV_TITLE || (n.title || '').endsWith(`__${KV_TITLE}`))
    : null;
  if (existing) {
    ok(`已存在，复用 ID = ${existing.id}`);
    return existing.id;
  }
  const created = runJson(`npx wrangler kv namespace create ${KV_TITLE}`);
  if (created && created.id) {
    ok(`已创建，ID = ${created.id}`);
    return created.id;
  }
  // Text fallback (create doesn't support --json)
  const raw = run(`npx wrangler kv namespace create ${KV_TITLE}`, { ignoreError: true });
  const m = raw.match(/id["'\s:=]+([0-9a-f]{32})/i);
  if (m) {
    ok(`已创建，ID = ${m[1]}`);
    return m[1];
  }
  // create likely failed with "already exists" (race) → re-list
  const list2 = runJson('npx wrangler kv namespace list');
  const found2 = Array.isArray(list2)
    ? list2.find((n) => n.title === KV_TITLE || (n.title || '').endsWith(`__${KV_TITLE}`))
    : null;
  if (found2) {
    ok(`已存在，复用 ID = ${found2.id}`);
    return found2.id;
  }
  die(`无法创建或查找 KV namespace id，请手动执行：npx wrangler kv namespace create ${KV_TITLE}`);
}

function generateProdConfig(d1Id, kvId) {
  log(`生成 wrangler.prod.toml`);
  const content = `# 自动生成于 ${new Date().toISOString()} — 请勿手动编辑。
# 生产配置：包含真实 Cloudflare 资源 ID（D1/KV）。
# Secrets（AUTH_TOKEN / JWT_SECRET）通过 \`wrangler secret put\` 设置，不在本文件中。
# 本文件已在 .gitignore 中，不会提交到版本控制。

name = "${WORKER_NAME}"
main = "src/index.ts"
compatibility_date = "2026-06-11"
compatibility_flags = ["nodejs_compat"]

kv_namespaces = [
  { binding = "CLIENT_CONFIGS", id = "${kvId}" }
]

[[d1_databases]]
binding = "DB"
database_name = "${D1_NAME}"
database_id = "${d1Id}"
migrations_dir = "${MIGRATIONS_DIR}"

# 请求日志级别（debug|info|warn|error|silent）
[vars]
LOG_LEVEL = "info"

# Workers Logs：控制台自动收集/索引/查询所有 console.* 输出
[observability]
enabled = true
`;
  writeFileSync(PROD_TOML, content, 'utf8');
  ok(`已写入 ${PROD_TOML}`);
}

function applyMigrations() {
  log(`应用远程 D1 迁移`);
  run(`npx wrangler d1 migrations apply DB --remote --config ${PROD_TOML}`);
  ok('迁移完成');
}

function deployWorker() {
  log(`部署 Worker`);
  const out = run(`npx wrangler deploy --config ${PROD_TOML}`);
  const urlMatch = out.match(/https:\/\/[^\s]+\.workers\.dev/i);
  const url = urlMatch ? urlMatch[0] : `https://${WORKER_NAME}.<your-subdomain>.workers.dev`;
  ok(`已部署：${url}`);
  return url;
}

function resolveSecretValue(name) {
  if (process.env[name]) return process.env[name];
  if (existsSync(PROD_VARS)) {
    const existing = readFileSync(PROD_VARS, 'utf8');
    const m = existing.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`));
    if (m) return m[1];
  }
  return randomBytes(32).toString('hex');
}

function setSecret(name, value) {
  run(`npx wrangler secret put ${name} --config ${PROD_TOML}`, { input: `${value}\n` });
  ok(`${name} 已设置为 secret`);
}

function writeProdVars(values) {
  const content = `# 生产环境密钥 —— 由 setup-prod.mjs 生成，已在 .gitignore 中。
# 仅供本地查阅，Worker 运行时通过 Cloudflare secrets 读取。
AUTH_TOKEN = "${values.AUTH_TOKEN}"
JWT_SECRET = "${values.JWT_SECRET}"
`;
  writeFileSync(PROD_VARS, content, 'utf8');
  ok(`密钥已写入 ${PROD_VARS}（gitignored，供查阅）`);
}

async function seed(url, authToken) {
  log(`初始化种子数据（协议模板）`);
  try {
    const loginRes = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: authToken }),
    });
    if (!loginRes.ok) {
      warn(`登录失败 (${loginRes.status})，跳过自动 seed`);
      printManualSeed(url, authToken);
      return;
    }
    const { accessToken } = await loginRes.json();
    if (!accessToken) {
      warn(`未获取到 JWT，跳过自动 seed`);
      printManualSeed(url, authToken);
      return;
    }
    const seedRes = await fetch(`${url}/api/admin/seed`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await seedRes.json().catch(() => ({}));
    if (seedRes.ok) {
      ok(`种子数据已写入：${(data.seeded || []).length} 条（幂等，可重复执行）`);
    } else {
      warn(`seed 返回 ${seedRes.status}: ${JSON.stringify(data)}`);
      printManualSeed(url, authToken);
    }
  } catch (e) {
    warn(`自动 seed 失败：${e.message}`);
    printManualSeed(url, authToken);
  }
}

function printManualSeed(url, authToken) {
  console.log(`  手动执行（两步，需 jq）：`);
  console.log(`    JWT=$(curl -s -X POST ${url}/api/auth/login -H "Content-Type: application/json" -d '{"token":"${authToken}"}' | jq -r .accessToken)`);
  console.log(`    curl -X POST ${url}/api/admin/seed -H "Authorization: Bearer $JWT"`);
}

function preflight() {
  log(`前置检查：Wrangler 认证`);
  const whoami = run('npx wrangler whoami', { ignoreError: true });
  if (/logged in|account/i.test(whoami)) {
    ok('已通过 wrangler login 认证');
    return;
  }
  if (process.env.CLOUDFLARE_API_TOKEN) {
    ok('检测到 CLOUDFLARE_API_TOKEN 环境变量');
    return;
  }
  die('未认证 Cloudflare。请先执行 `npx wrangler login` 或设置 CLOUDFLARE_API_TOKEN 环境变量。');
}

async function main() {
  console.log('\x1b[1m\n  ChorusCloud 生产环境初始化\n\x1b[0m');
  preflight();

  const d1Id = getOrCreateD1();
  const kvId = getOrCreateKV();
  generateProdConfig(d1Id, kvId);

  applyMigrations();
  const url = deployWorker();

  log(`设置生产 Secrets`);
  const values = {
    AUTH_TOKEN: resolveSecretValue('AUTH_TOKEN'),
    JWT_SECRET: resolveSecretValue('JWT_SECRET'),
  };
  setSecret('AUTH_TOKEN', values.AUTH_TOKEN);
  setSecret('JWT_SECRET', values.JWT_SECRET);
  writeProdVars(values);

  await seed(url, values.AUTH_TOKEN);

  console.log(`\n\x1b[1;32m  ✅ 部署完成\n\x1b[0m`);
  console.log(`  Worker URL : ${url}`);
  console.log(`  健康检查   : curl ${url}/health`);
  console.log(`  AUTH_TOKEN : ${values.AUTH_TOKEN} (见 .prod.vars)`);
  console.log(`  登录换 JWT : curl -s -X POST ${url}/api/auth/login -H "Content-Type: application/json" -d '{"token":"${values.AUTH_TOKEN}"}'`);
  console.log(`\n  后续更新只需：pnpm deploy\n`);
}

main();
