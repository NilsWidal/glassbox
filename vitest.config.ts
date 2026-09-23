import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Live CLI tests run only with GLASSBOX_IT=1; they can take a while.
    testTimeout: process.env.GLASSBOX_IT === '1' ? 180_000 : 5_000,
  },
});
