# ChorusCloud 自托管部署指南（VPS / 本地 Node）

chorus-cloud 是**同一份业务代码、两个运行时入口**：

| | Cloudflare Workers 版 | Node/VPS 版 |
| --- | --- | --- |
| 入口 | `src/index.ts`（wrangler 部署） | `src/node/entry.ts`（本指南） |
| 数据库 | D1（云端 SQLite） | SQLite 单文件（better-sqlite3） |
| 客户端配置缓存 | KV Namespace | 同一 SQLite 文件里的 `kv_store` 表 |
| Secrets | `wrangler secret put` | 环境变量 / 首次启动自动生成 |
| 路由 / 认证 / 渲染引擎 | **完全一致**（同一个 Hono app，注入不同的存储适配器） | |

存储适配层（`src/node/d1-sqlite.ts`、`src/node/kv-sqlite.ts`）只实现业务代码实际
用到的 D1/KV 接口面，并由 `tests/node/api.spec.ts` 在 CI 中钉死该契约——路由若
用到适配层不支持的方法会直接挂测试，不会等到线上才暴露。

---

## 方式一：Docker Compose（推荐）

```bash
cd packages/cloud
docker compose up -d --build
curl http://localhost:8787/health   # {"status":"ok","service":"chorus-cloud"}
```

数据（SQLite + secrets.json）都在 `cloud-data` 卷里，备份即备份该卷：

```bash
docker run --rm -v singchorus_cloud-data:/data -v "$PWD":/backup alpine \
  cp /data/chorus-cloud.db /backup/
```

生产建议在前面挂一层反代（Caddy / Nginx）做 TLS——`AUTH_TOKEN` 走公网明文是大忌。

## 方式二：裸机 Node（≥ 20）

```bash
cd packages/cloud
pnpm install
pnpm build:node        # esbuild 打包单文件 → dist-node/entry.mjs
pnpm start:node        # 默认监听 0.0.0.0:8787，数据在 ./data/
```

开发模式（改代码自动重载）：`pnpm dev:node`

systemd 单元示例（`/etc/systemd/system/chorus-cloud.service`）：

```ini
[Unit]
Description=ChorusCloud (Node)
After=network-online.target

[Service]
WorkingDirectory=/opt/singchorus/packages/cloud
Environment=PORT=8787
Environment=CHORUS_CLOUD_DB=/var/lib/chorus-cloud/chorus.db
EnvironmentFile=-/etc/chorus-cloud.env
ExecStart=/usr/bin/node dist-node/entry.mjs
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；反代/本机专用场景可改 `127.0.0.1` |
| `CHORUS_CLOUD_DB` | `./data/chorus-cloud.db` | SQLite 文件路径（自动建目录，WAL 模式） |
| `AUTH_TOKEN` | 自动生成 | 管理员登录凭证；**不设置时首次启动随机生成并写入 `<db目录>/secrets.json`**，重启/重建后沿用 |
| `JWT_SECRET` | 自动生成 | JWT 签名密钥，同上 |
| `CHORUS_CLOUD_SUB_RATE_LIMIT_RPM` | 不限流 | 订阅接口限流（次/分钟/订阅）。Workers 版的限流 binding 在免费版下未绑定，此默认值与之对齐 |
| `CHORUS_CLOUD_LOG_LEVEL` | `info` | 日志级别（`debug`/`info`/`warn`/`error`/`silent`）。日志为 JSON 一行一条输出到 stdout，由 docker logs / journald 收集；排查时用 `docker logs \| jq 'select(.requestId=="...")'` 按请求追踪 |
| `LOG_FORMAT` | `json` | 本地调试可设 `pretty` 输出人读格式；生产保持 `json` |

> AUTH_TOKEN 首次启动后到 `secrets.json` 里查看（权限 600）：
> `sudo cat /var/lib/chorus-cloud/secrets.json`

---

## 从 Cloudflare 迁移数据

D1 本质是 SQLite，直接导出导入即可：

```bash
cd packages/cloud
npx wrangler d1 export chorus-cloud-prod --remote --output dump.sql
# VPS 上（先停服务或确保无写入）：
sqlite3 /var/lib/chorus-cloud/chorus.db < dump.sql
```

**KV（`CLIENT_CONFIGS`）不需要迁移**：里面只有客户端配置缓存、订阅投递缓存和
tag 索引，全部带 TTL 且可由客户端重新同步/注册再生。节点（panel）会通过
`/api/nodes/register` 心跳自动回到 online 状态。

迁移后把 panel 的 cloud URL 指向新地址即可（panel 设置里的 cloud 地址 /
`core_url`），panel 对两种部署形态无感知——协议都是同一套 HTTP API。

---

## 与 Workers 版的行为差异

| 点 | Workers 版 | Node/VPS 版 |
| --- | --- | --- |
| KV 一致性 | 最终一致（写后全球传播 ≤60s） | 强一致 |
| KV 配额 | 免费版 list 1000 次/天等配额 | 无配额 |
| `expirationTtl` 下限 | 60s | 无下限 |
| 订阅限流 | binding 未绑定 → 不限流 | 默认不限流，设 env 开启（内存滑窗） |
| 多实例横向扩展 | 天然（D1/KV 共享） | 单进程单文件；多实例需共享 SQLite（不建议，用 NFS 会有锁问题） |
| 后台任务 | `waitUntil` | fire-and-forget promise |

其余语义（认证/吊销、模板渲染、订阅投递、审计日志）完全一致，由两套测试套件
共同保证：`pnpm test:workers`（workerd + 真实 D1/KV 模拟）与 `pnpm test:node`
（SQLite 适配器 + Node runtime）。

## 构建说明

- `pnpm build:node`：esbuild 打包 `src/node/entry.ts` → `dist-node/entry.mjs`
  （单文件，仅 `better-sqlite3` 保持外部依赖）。Workers 构建仍走 wrangler，
  两者互不影响——`src/node/` 不会被 Workers bundle 引用。
- 首次启动即建表（`src/db/schema.ts` 的 eager init），无需单独跑迁移；
  从旧版 Cloudflare 导出的 dump 已是最终 schema。
