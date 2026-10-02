import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The fake-CLI tests spawn real processes and wait on them; the default 5s
    // is too tight for the ones that include a deliberate delay.
    testTimeout: 20000,
  },
});