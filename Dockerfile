# chorus-cloud 自托管镜像（Node + SQLite 版）。
# 构建上下文是仓库根目录：
#   docker build -f packages/cloud/Dockerfile -t chorus-cloud .
# 或直接用 compose：cd packages/cloud && docker compose up -d --build
FROM node:22-slim AS build
WORKDIR /app
RUN npm install -g pnpm@11.5.0

# 先拷贝 workspace 清单，依赖层可被 Docker 缓存
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/panel/package.json packages/panel/
COPY packages/ctl/package.json packages/ctl/
COPY packages/cloud/package.json packages/cloud/
RUN pnpm install --frozen-lockfile --filter chorus-cloud...

COPY packages/cloud packages/cloud
# 构建单文件 Node 入口，再用 pnpm deploy 裁剪出独立的生产依赖树。
# --legacy：pnpm v10+ 默认要求 injected workspace，本包没有 workspace 依赖，
# legacy 语义完全等价且更简单。
RUN pnpm --filter chorus-cloud build:node \
 && pnpm --filter chorus-cloud deploy --prod --legacy /out

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    CHORUS_CLOUD_DB=/data/chorus-cloud.db
VOLUME /data
# 只取运行时必需的三样（deploy legacy 模式会拷全包，按需挑选保持镜像干净）
COPY --from=build /out/dist-node ./dist-node
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./
EXPOSE 8787
CMD ["node", "dist-node/entry.mjs"]
