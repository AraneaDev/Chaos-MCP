import { defineConfig } from 'vitest/config';

// Default config: runs the FULL suite (unit + e2e/spawn tests) for `npm test`
// and `npm run check`. Self-mutation-testing runs the BUILT tool against its
// own source via scripts/audit-self.js and scripts/meta-test.js (not a Stryker
// config in this repo). StrykerJS lives at stryker.internal.mjs (separate config).
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
    // Reset every mock to a clean slate before each test.
    //
    // Vitest 4 split what vitest 3's `restoreMocks` did alone. In v3,
    // `vi.restoreAllMocks()` walked every registered mock; in v4 it walks only
    // the spies `vi.spyOn` registered (`MOCK_RESTORE`), and `vi.fn()` mocks are
    // never touched by it. Since most suites here build their doubles as
    // `vi.fn(impl)` inside a `vi.mock()` factory, `restoreMocks` alone stopped
    // draining the `mockResolvedValueOnce` / `mockImplementationOnce` queue on
    // the v4 upgrade — 157 tests failed, each one a later test consuming a
    // value an earlier test had queued and under-consumed.
    //
    // The pair below restores the v3 contract. Vitest applies them in this
    // order (restore, then reset, then clear):
    //   restoreMocks -> vi.restoreAllMocks(): un-spies `vi.spyOn`, putting the
    //     original property descriptor back.
    //   mockReset    -> vi.resetAllMocks(): walks every registered mock, so
    //     `vi.fn()` doubles drain their once-queue and reset persistent values.
    //     A mock built as `vi.fn(impl)` resets TO `impl`, which is what keeps
    //     the factory pattern used throughout this suite working.
    //
    // `clearMocks` is deliberately not set: `mockReset` already clears call
    // history, so it would only add a redundant third pass.
    restoreMocks: true,
    mockReset: true,
    coverage: {
      provider: 'v8',
      // Only measure first-party source — never the compiled build/ output or tests.
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**'],
      // json-summary feeds scripts/coverage-badge.mjs; text/html are for humans.
      reporter: ['text', 'html', 'json-summary'],
    },
  },
});
