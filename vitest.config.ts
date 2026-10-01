import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@datix/shared': fileURLToPath(new URL('./shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['server/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    pool: 'forks',
  },
});
