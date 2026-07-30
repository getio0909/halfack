import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    environment: 'node',
    fileParallelism: false,
    globals: false,
    include: ['test/**/*.test.ts'],
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
