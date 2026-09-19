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
    // Budget a test gets before Vitest calls it hung.
    //
    // The default 5s produced rare timeouts in the largest suite file
    // (triage-handler.test.ts, 113 tests) whenever the machine was busy with
    // something else, e.g. an npm install finishing in another terminal. Tests
    // that normally finish in under 30ms reported "timed out in 5000ms", in
    // consecutive runs, which is the shape of the whole worker process being
    // descheduled rather than of any one test being slow.
    //
    // It was hunted before it was widened, and the number below comes out of
    // what that hunt measured. Ruled out, each by reproduction rather than by
    // argument: cache-directory size (a 268-entry run-cache moved the file's
    // total test time 155ms -> 188ms), memory pressure (swap was never touched,
    // MemAvailable never fell below 3.2GB), CPU starvation (all 8 cores pegged
    // for a whole run: zero failures, slowest test 65ms), a cold transform cache
    // (zero failures), heavy concurrent /tmp I/O (zero failures, slowest test
    // 30ms), and the real `mintRunId` disk writes those tests perform (all 68
    // write cycles together cost 2.6ms). The triage path contains no timer, no
    // sleep and no deadline-polling loop, so nothing there can wait at all.
    //
    // That is what makes a wider budget honest here rather than a way of hiding
    // a defect. Across 29,416 passing observations in 8 full runs the slowest
    // healthy test was 1321ms and only 2 exceeded 1000ms, so no legitimate test
    // lives anywhere near this number. And because nothing in the suite can
    // deliberately wait, a genuine hang is unbounded: it still fails, just later.
    // There is no failure mode that takes between 1.3s and 30s, which is exactly
    // the band this widening gives away.
    testTimeout: 30_000,
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
