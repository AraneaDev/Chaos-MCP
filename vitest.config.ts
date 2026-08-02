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
    // Restore every mock to its original implementation before each test.
    // `vi.clearAllMocks()` (which many suites call in `beforeEach`) only clears
    // call history — it does NOT drain the `mockResolvedValueOnce` /
    // `mockImplementationOnce` queue and does not undo a `vi.spyOn` or a
    // persistent `mockReturnValue`. That let a test which under-consumed its
    // queued values silently corrupt every later test in the same file, and let
    // a stubbed module function (e.g. `symlinkSync` throwing) leak forward.
    // `restoreMocks` drains the once-queue and resets persistent values while
    // preserving the implementation a `vi.mock()` factory passed to `vi.fn(impl)`,
    // so the factory pattern used throughout this suite keeps working.
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      // Only measure first-party source — never the compiled build/ output or tests.
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**'],
      reporter: ['text', 'html'],
    },
  },
});
