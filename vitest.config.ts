import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    globals: true,
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        singleWorker: true,
        minWorkers: 1,
        maxWorkers: 1,
        // 覆盖 wrangler.toml 的 LOG_LEVEL=info：测试输出只保留 warn/error。
        miniflare: { vars: { LOG_LEVEL: 'error' } },
      },
    },
    include: ['tests/**/*.spec.ts'],
    exclude: ['tests/plugins/singbox-check.spec.ts', 'tests/node/**'],
  },
});
