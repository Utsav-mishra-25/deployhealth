import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Every file shares one test database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
