import { defineConfig } from 'vitest/config';

// Node-environment vitest config for tests that need Node built-ins
// (node:child_process / fs / os) which the Cloudflare Workers pool (workerd)
// cannot provide. Run via: vitest run --config vitest.config.node.ts
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/plugins/singbox-check.spec.ts', 'tests/node/**/*.spec.ts'],
  },
});
