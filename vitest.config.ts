import { defineConfig } from 'vitest/config';

// Default config: runs the FULL suite (unit + e2e/spawn tests) for `npm test`
// and `npm run check`. Self-mutation-testing runs the BUILT tool against its
// own source via scripts/audit-self.js and scripts/meta-test.js (not a Stryker
// config in this repo).
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      // Only measure first-party source — never the compiled build/ output or tests.
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**'],
      reporter: ['text', 'html'],
    },
  },
});
