import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // .tsx as well as .ts: the UI is rendered to a string and asserted on the
    // markup, which needs JSX and no DOM.
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    testTimeout: 20000,
  },
});
