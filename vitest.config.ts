import { defineConfig } from 'vitest/config';

// Default config: runs the FULL suite (unit + e2e/spawn tests) for `npm test`
// and `npm run check`. Self-mutation-testing runs the BUILT tool against its
// own source via scripts/audit-self.js and scripts/meta-test.js (not a Stryker
// config in this repo). StrykerJS lives at stryker.config.mjs (separate config).
//
// `globalSetup` rebuilds `./build/index.js` ONLY when the compiled output is
// stale relative to src/index.ts (or missing). This pins the cli-version /
// cli-help / cli-smoke baseline failures: those tests spawn
// `node ./build/index.js --version` and assert stdout matches the version in
// the source. Without a pre-test rebuild, a developer who edits only test
// files (no src rebuild) sees the tests fail against a stale binary. The
// rebuild cost is ~3–8 s on a warm cache; trivial compared to the alternative
// (manually running `npm run build` before every test invocation).
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: false,
    globalSetup: ['tests/global-setup.ts'],
    coverage: {
      provider: 'v8',
      // Only measure first-party source — never the compiled build/ output or tests.
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**'],
      reporter: ['text', 'html'],
    },
  },
});
