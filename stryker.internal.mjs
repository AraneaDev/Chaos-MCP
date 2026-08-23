// StrykerJS config for chaos-mcp INTERNAL mutation testing.
//
// STATUS (2026-08-23): ACTIVE, via the NATIVE vitest runner.
//
// FILENAME, deliberately: this is `stryker.internal.mjs`, NOT any of the
// `stryker.config.*` / `stryker.conf.*` names Stryker discovers by default.
// chaos-mcp's own TypeScript engine scans an audited workspace for those names
// and, when it finds one, imports it as the BASE of the config it generates for
// the run (see STRYKER_CONFIG_NAMES in src/engines/typescript/config.ts). When
// chaos-mcp audits itself — `npm run test:self`, `npm run audit:self` — the
// audited workspace IS this repo, so a file named `stryker.config.mjs` here
// gets spread into the self-audit's generated config. This file configures the
// native vitest runner; the self-audit is forced onto the command runner, and
// mixing the two made the dry run fail with "There were failed tests in the
// initial test run". Renaming removes the collision at the source. Because the
// name is non-standard, scripts/mutate.mjs passes it to Stryker explicitly.
//
// History, because two earlier diagnoses in this file were wrong and the
// corrections are what make the current setup make sense:
//
//   1. "@stryker-mutator/command-runner is not published (404)" — a
//      misdiagnosis. The command runner ships INSIDE @stryker-mutator/core;
//      there has never been a separate package to install.
//   2. "vitest 3 removed the `--related` / `config.related` API" — also
//      wrong. vitest 3 and 4 both still support `related`; it is how this
//      repo's own wrapper scoped tests for a year.
//
// What actually blocked the native runner was @stryker-mutator/vitest-runner
// 9.x against vitest 3. Stryker 10 resolves it: the runner now exposes
// `vitest.related` as a real option and falls back to explicit test files when
// related-mode resolves nothing, and the repo now runs vitest 4 — the version
// upstream develops against (vitest-runner@10 dev-depends on vitest 4.1.x).
//
// Why the native runner beats the command runner we used before: the command
// runner is a black box that grades on a process exit code, so it cannot
// instrument coverage and forces `coverageAnalysis: 'off'` — every mutant
// re-runs the whole related-test set. The native runner supports
// `coverageAnalysis: 'perTest'`, which records which tests cover which mutant
// during the initial run and then runs ONLY those tests per mutant. That is
// the difference between a single file and a `src/utils/**` sweep being
// affordable.
//
// DO NOT run this bare (`npx stryker run`). `mutate` is an empty no-op by
// default so a bare invocation cannot start an unbounded whole-repo sweep on a
// developer machine. Drive it through the wrapper, which scopes the run:
//
//   npm run mutation -- src/core/gate.ts
//   npm run mutation -- src/utils --concurrency 2
//
// tests/global-setup.ts short-circuits its rebuild when a STRYKER env var is
// present, so per-mutant runs stay lean.

export default {
  testRunner: 'vitest',
  vitest: {
    // Pin the config explicitly rather than letting Stryker resolve
    // `vitest.config.*` / `vite.config.*` — this repo has exactly one and the
    // mock-reset semantics in it (restoreMocks + mockReset) are load-bearing
    // for suite isolation, so a silently-resolved different config would
    // produce mutation results that do not match `npm test`.
    configFile: 'vitest.config.ts',
    // Related mode narrows each run to the tests whose module graph includes
    // the mutated file. This is the default; it is spelled out because the
    // previous command-runner setup did the same narrowing by hand and the
    // equivalence is the point.
    related: true,
  },
  // The native runner instruments coverage, so per-mutant test selection is
  // available — the reason this migration was worth doing.
  coverageAnalysis: 'perTest',
  // Empty by default so a bare run is a no-op; scripts/mutate.mjs passes
  // `--mutate` to scope each run to an explicit target.
  mutate: [],
  reporters: ['clear-text', 'progress'],
  tempDirName: '.stryker-tmp',
  // Keep this modest: each concurrent worker runs its own vitest instance, so
  // higher values saturate developer machines quickly.
  concurrency: 2,
};
