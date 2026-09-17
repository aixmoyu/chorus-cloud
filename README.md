# ChorusCloud

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/aixmoyu/singchorus/tree/main/packages/cloud)

Cloudflare Workers-based cloud service for the SingChorus project. Handles template management, configuration generation, client tracking, user management, and subscription distribution.

## Quick Start

```bash
# Install dependencies
pnpm install

# Generate TypeScript types from wrangler config
pnpm cf-typegen

# Run tests
pnpm test
```

## Deploy

单击上方按钮一键部署到 Cloudflare，或手动操作：

```bash
pnpm setup:prod   # 首次：创建 D1/KV + 部署 + 设置 secrets + 自动 seed（一键完成）
pnpm deploy       # 日常发版：迁移 + 重新部署
```

> admin 路由用 JWT 鉴权（非 AUTH_TOKEN 本身）。手动重跑 seed 需两步：先 `POST /api/auth/login` body `{"token":"<AUTH_TOKEN>"}` 换 JWT，再 `POST /api/admin/seed` 带 `Authorization: Bearer <JWT>`。

完整流程见 [docs/deploy.md](./docs/deploy.md)。

## Deploy（自托管 VPS / 本地 Node）

不想用 Cloudflare？同一份代码提供 Node 入口（SQLite 存储，无外部服务依赖）：

```bash
pnpm build:node && pnpm start:node   # 或 cd packages/cloud && docker compose up -d --build
```

完整说明（含 Docker、systemd、从 Cloudflare 迁移数据）见 [docs/deploy-vps.md](./docs/deploy-vps.md)。

## API Endpoints

### Public
- `GET /health` - Health check
- `GET /api/templates` - List protocol templates (public)
- `GET /api/templates/:id` - Get template by ID
- `POST /api/generate` - Generate config from template + params
- `GET /api/subscribe/:userId` - Get subscription config for user

### Admin (requires Bearer token)
- `POST /api/templates` - Create template
- `PUT /api/templates/:id` - Update template
- `DELETE /api/templates/:id` - Delete template
- `PUT /api/clients` - Store client config
- `GET /api/clients` - List client configs
- `DELETE /api/clients/:id` - Delete client config
- `POST /api/users` - Create user
- `GET /api/users` - List users
- `POST /api/admin/seed` - Seed protocol templates

## Development

```bash
pnpm dev     # Start local dev server
pnpm test    # Run tests
pnpm deploy  # Deploy to Cloudflare
```
