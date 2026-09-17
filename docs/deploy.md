# ChorusCloud 部署指南

将 `chorus-cloud` Worker 部署到 Cloudflare 的生产环境。

> 本指南对应重构后的部署流程：**本地调试零配置** + **生产环境一键初始化**。
> 不再需要手动复制 D1/KV 的 UUID，secrets 不再以明文写入 `wrangler.toml`。

---

## 设计概览

| 文件 | 用途 | 是否提交 |
| --- | --- | --- |
| `wrangler.toml` | **本地开发**配置：占位 ID（`00000000-...`），无 secrets。`wrangler dev` 用 `.wrangler/state/` 下的本地模拟 D1/KV | ✅ 提交 |
| `wrangler.prod.toml` | **生产**配置：真实资源 ID。由 `setup-prod.mjs` 自动生成 | ❌ gitignored |
| `.dev.vars` | 本地 secrets（`AUTH_TOKEN` / `JWT_SECRET`） | ❌ gitignored |
| `.prod.vars` | 生产 secrets 的本地查阅副本（仅供查阅，Worker 运行时读 Cloudflare secrets） | ❌ gitignored |
| `.dev.vars.example` | 本地 secrets 模板 | ✅ 提交 |
| `scripts/setup-prod.mjs` | 生产环境一键初始化脚本 | ✅ 提交 |

**核心原理**：Wrangler 在 `wrangler dev` 时默认使用**本地模拟**的 D1（SQLite）和 KV，不读真实的 `database_id`，所以本地开发完全不需要真实资源 ID。真实 ID 只在 `wrangler deploy` 时用到，且由脚本自动写入 `wrangler.prod.toml`。D1/KV 的 ID 是**标识符而非密钥**（访问由 API Token 控制），但本方案仍将其放入 gitignored 的 prod 配置，保持 `wrangler.toml` 干净。

---

## 前置条件

- Node.js >= 18
- pnpm（推荐）或 npm
- Cloudflare 账号
- Wrangler CLI（已包含在 `packages/cloud` 的 devDependencies 中）

> **重要**：所有 `pnpm`/`wrangler` 命令都需在 `packages/cloud` 目录下执行（`cd packages/cloud`）。
> 仓库根 `package.json` 声明了 `packageManager: "bun"`，在根目录跑 `pnpm install` 会被拒绝。
> `packages/cloud/pnpm-workspace.yaml` 已配置好 esbuild/workerd/sharp 的 build 脚本白名单，使 pnpm 在该子包内正常工作。

```bash
# 首次部署前登录一次（浏览器授权）
cd packages/cloud
npx wrangler login
```

> CI 环境用 API Token 替代登录：设置 `CLOUDFLARE_API_TOKEN` 环境变量即可（见 §CI/CD）。

---

## 1. 本地开发（零配置）

```bash
cd packages/cloud
pnpm install
cp .dev.vars.example .dev.vars     # 复制 secrets 模板，填入本地值
pnpm cf-typegen                    # 根据 wrangler.toml + package.json 生成 TS 类型
pnpm db:migrate:local              # 应用迁移到本地模拟 D1（.wrangler/state/）
pnpm dev                           # 启动 http://localhost:8787
```

`.dev.vars` 内容示例：

```
AUTH_TOKEN = "dev-token-随便填"
JWT_SECRET = "dev-jwt-随便填"
```

> `wrangler dev` 会用本地模拟资源，**不需要**真实的 D1/KV ID，`wrangler.toml` 里的占位 ID 仅供本地模式作为存储键使用。

---

## 2. 生产环境一键初始化（首次部署）

```bash
cd packages/cloud
pnpm setup:prod
```

`scripts/setup-prod.mjs` 会**幂等**地完成全部首次部署步骤（可重复执行）：

1. **前置检查** Wrangler 认证（`wrangler login` 或 `CLOUDFLARE_API_TOKEN`）
2. **获取或创建 D1 数据库** `chorus-cloud-prod`（已存在则复用 ID）
3. **获取或创建 KV Namespace** `CLIENT_CONFIGS`（已存在则复用 ID）
4. **生成 `wrangler.prod.toml`**（写入真实资源 ID，不含 secrets）
5. **应用远程 D1 迁移**（`migrations/` 下全部 SQL）
6. **部署 Worker**
7. **设置生产 Secrets**：
   - `AUTH_TOKEN` / `JWT_SECRET` 的取值优先级：环境变量 > 已存在的 `.prod.vars` > 随机生成 64 字符 hex
   - 生成/取到的值写入 `.prod.vars`（gitignored，供本地查阅）
   - 通过 `wrangler secret put` 加密存储到 Cloudflare 侧
8. **自动 seed 协议模板**：用 AUTH_TOKEN 调 `/api/auth/login` 换 JWT，再用 JWT 调 `/api/admin/seed`（幂等，可重复执行）
9. **打印部署 URL 与登录命令**

### 指定密钥（可选）

如需自定义密钥（而非随机生成），通过环境变量传入：

```bash
AUTH_TOKEN=$(openssl rand -hex 32) \
JWT_SECRET=$(openssl rand -hex 32) \
pnpm setup:prod
```

> 首次执行后，密钥会写入 `.prod.vars`，**后续重跑会复用同一组密钥**（保持稳定，不会破坏已签发的 token）。

### 首次执行后的输出示例

```
  Worker URL : https://chorus-cloud.<your-subdomain>.workers.dev
  健康检查   : curl https://chorus-cloud.<your-subdomain>.workers.dev/health
  AUTH_TOKEN : <64 字符 hex> (见 .prod.vars)
  登录换 JWT : curl -s -X POST .../api/auth/login -H "Content-Type: application/json" -d '{"token":"<AUTH_TOKEN>"}'
```

---

## 3. 验证部署 & 初始化数据

```bash
# 健康检查（期望 {"status":"ok","service":"chorus-cloud"}）
curl https://chorus-cloud.<your-subdomain>.workers.dev/health

# 查看公开模板列表（无需鉴权）
curl https://chorus-cloud.<your-subdomain>.workers.dev/api/templates
```

> `setup:prod` 已自动完成 seed，**无需再手动调用**。若需手动重跑 seed，注意 admin 路由鉴权用的是 **JWT**（24h 过期），不是 AUTH_TOKEN 本身——需先用 AUTH_TOKEN 换 JWT：

```bash
# 1) 用 AUTH_TOKEN 换 JWT（body 是 JSON，不是 Bearer header）
JWT=$(curl -s -X POST https://chorus-cloud.<your-subdomain>.workers.dev/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$(grep AUTH_TOKEN .prod.vars | cut -d'\"' -f2)\"}" | jq -r .accessToken)

# 2) 用 JWT 调 seed（幂等：存在则 UPDATE，不存在则 INSERT）
curl -X POST https://chorus-cloud.<your-subdomain>.workers.dev/api/admin/seed \
  -H "Authorization: Bearer $JWT"
```

`AUTH_TOKEN` 在 `.prod.vars` 中查阅（或在 setup:prod 的输出里直接看到）。

---

## 4. 更新生产部署（日常发版）

代码改动后，一行命令重新部署：

```bash
cd packages/cloud
pnpm deploy:prod
```

`pnpm deploy:prod` 等价于：

```bash
wrangler d1 migrations apply DB --remote --config wrangler.prod.toml \
  && wrangler deploy --config wrangler.prod.toml
```

> 注意：`pnpm deploy`（不带 `:prod`）走的是默认 `wrangler.toml`，供「Deploy to Cloudflare 按钮」流程使用（见 §9）。按钮部署的仓库中没有 `wrangler.prod.toml`，请勿用它更新 setup:prod 创建的生产环境。

> Wrangler 会保留已设置的 secrets，无需每次重设。新增的 migration 文件会被自动应用。

### 创建新的迁移

```bash
pnpm migrate:create add_new_feature
# 编辑 migrations/<timestamp>_add_new_feature.sql
pnpm deploy:prod   # 应用到生产
```

### 自定义域名

```bash
npx wrangler deploy --config wrangler.prod.toml \
  --routes https://api.yourdomain.com/*
```

并在 Cloudflare Dashboard → DNS 中添加指向 Worker 的记录（橙色云图标）。

---

## 5. CI/CD 集成（GitHub Actions）

`wrangler.prod.toml` 是 gitignored 的，CI 需要在流水线里重新生成。由于 `setup:prod` 幂等，**CI 直接调用它**即可——已存在的 D1/KV 会被复用，`wrangler.prod.toml` 会被重新生成（ID 不变）。

创建 `.github/workflows/deploy-cloud.yml`：

```yaml
name: Deploy ChorusCloud

on:
  push:
    branches: [main]
    paths: ["packages/cloud/**"]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Verify (typegen + tests)
        working-directory: packages/cloud
        run: |
          pnpm cf-typegen
          pnpm test

      - name: First-time setup or update (idempotent)
        working-directory: packages/cloud
        run: pnpm setup:prod
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          AUTH_TOKEN: ${{ secrets.CC_AUTH_TOKEN }}
          JWT_SECRET: ${{ secrets.CC_JWT_SECRET }}
```

### 需要在 GitHub 配置的 Secrets

在仓库 **Settings → Secrets and variables → Actions** 中添加：

| Secret 名 | 用途 | 生成方式 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | 部署凭据 | Cloudflare Dashboard → My Profile → API Tokens → 创建「Edit Workers」模板 token |
| `CC_AUTH_TOKEN` | 生产 AUTH_TOKEN | `openssl rand -hex 32`（与本地 `.prod.vars` 保持一致） |
| `CC_JWT_SECRET` | 生产 JWT_SECRET | `openssl rand -hex 32`（与本地 `.prod.vars` 保持一致） |

> **重要**：`CC_AUTH_TOKEN` / `CC_JWT_SECRET` 的值必须与本地首次 `pnpm setup:prod` 后写入 `.prod.vars` 的值**一致**，否则 CI 会把生产 secrets 覆盖成新值，导致旧 token 失效。
> 首次本地执行 `pnpm setup:prod` 后，把 `.prod.vars` 里的两个值原样填入 GitHub Secrets 即可。

> 若希望 CI 不重复跑完整 setup，也可改为只跑 `pnpm deploy:prod`——前提是 `wrangler.prod.toml` 能在 CI 中存在。最简单的做法是把它从 `.gitignore` 移除并提交（ID 不是密钥，提交是 Cloudflare 官方推荐做法），这样 CI 只需 `pnpm deploy:prod`。两种方式任选其一。

---

## 6. 回滚

```bash
# 查看历史版本
npx wrangler versions list --config wrangler.prod.toml

# 回滚到指定版本
npx wrangler rollback --version-id <VERSION_ID> --config wrangler.prod.toml
```

> D1 迁移一旦应用不可自动回滚；如需撤销，需手动编写反向迁移 SQL（新建一个 `migrations/<ts>_rollback_xxx.sql` 再 `pnpm deploy`）。

---

## 7. 监控与日志

```bash
# 实时日志
npx wrangler tail --config wrangler.prod.toml

# JSON 格式（便于管道处理）
npx wrangler tail --config wrangler.prod.toml --format json
```

也可在 Cloudflare Dashboard → **Workers & Pages** → `chorus-cloud` → **Logs** 中查看。

---

## 8. 可选：速率限制（需付费）

`subscriptions.ts` 中通过 try/catch 优雅降级使用 `SUBSCRIPTION_RATE_LIMITER` 绑定。默认未绑定（兼容免费版），缺失时直接放行。

如需启用（需 Workers 付费版 + Rate Limiting API binding），手动在 `wrangler.prod.toml` 追加：

```toml
[[unsafe.bindings]]
name = "SUBSCRIPTION_RATE_LIMITER"
type = "rate_limit"
namespace_id = "<RATE_LIMIT_NAMESPACE_ID>"
```

`namespace_id` 在 Cloudflare Dashboard → **Workers & Pages** → **Rate Limits** 中创建后获取。类型声明见 `src/env.d.ts`（可选绑定，自动合并到生成的 `Env` 接口）。

---

## 9. 一键部署按钮（推荐给新用户）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/aixmoyu/singchorus/tree/main/packages/cloud)

按钮流程由 Cloudflare 官方 [Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/) 支持：

1. **克隆仓库**：Cloudflare 把 `packages/cloud` 子目录克隆到用户自己的 GitHub/GitLab 账号（成为独立仓库，可继续开发）
2. **自动开通资源**：读取 `wrangler.toml`，自动创建并绑定 D1 数据库和 KV 命名空间，回填真实资源 ID
3. **填写 secrets**：部署设置页会提示填写 `AUTH_TOKEN` / `JWT_SECRET`（定义来自 `.dev.vars.example` 与 `package.json` 的 `cloudflare.bindings` 描述），建议用 `openssl rand -hex 32` 生成
4. **构建部署**：执行 `deploy` 脚本（`wrangler d1 migrations apply DB --remote && wrangler deploy`，引用默认 `wrangler.toml`）完成部署

> 即便跳过迁移步骤也不会影响运行——Worker 首次请求时会自动初始化数据库 schema（`ensureDatabaseInitialized`），迁移仅作为显式的 schema 版本管理手段。

### 前提条件

- 仓库必须为 **公开** 的 GitHub/GitLab 仓库（不支持私有仓库与自托管实例）
- 用户需有 Cloudflare 账号（免费版即可）

### 部署后

- 验证：`curl https://chorus-cloud.<你的子域>.workers.dev/health`
- 补种协议模板（可选）：按 §3 的方式用 AUTH_TOKEN 换 JWT 后调 `/api/admin/seed`
- 后续更新：推送代码到用户账号中克隆出的仓库，Workers Builds 自动重新构建部署

---

## 命令速查

| 场景 | 命令 |
| --- | --- |
| 本地开发 | `pnpm dev` |
| 本地迁移 | `pnpm db:migrate:local` |
| 重新生成类型 | `pnpm cf-typegen` |
| 跑测试 | `pnpm test` |
| 首次生产初始化 | `pnpm setup:prod` |
| 日常生产发版 | `pnpm deploy:prod` |
| 按钮流程部署 | `pnpm deploy`（由 Deploy to Cloudflare 按钮调用） |
| 新建迁移 | `pnpm migrate:create <name>` |
| 查看日志 | `npx wrangler tail --config wrangler.prod.toml` |

---

## 参考

- [Wrangler 文档](https://developers.cloudflare.com/workers/wrangler/)
- [Hono + Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [D1 文档](https://developers.cloudflare.com/d1/)
- [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [本地开发与远程资源](https://developers.cloudflare.com/workers/wrangler/configuration/#local-development)
