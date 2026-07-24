// StrykerJS config for chaos-mcp INTERNAL mutation testing.
//
// STATUS (2026-07-18): ACTIVE, via Stryker's built-in COMMAND runner.
//
// Previously parked because @stryker-mutator/vitest-runner@9.x relies on
// vitest 2's `--related` / `config.related` API, which vitest 3 removed — the
// native runner enumerates zero tests and aborts. The unblock: Stryker's
// command runner (`testRunner: 'command'`) ships INSIDE @stryker-mutator/core
// (there is NO separate `@stryker-mutator/command-runner` package — the earlier
// "404, not published" wall was a misdiagnosis). It runs a plain test command
// as a black box per mutant and grades on the exit code, so it never touches
// the vitest-runner plugin and works with vitest 3.
//
// DO NOT run this bare (`npx stryker run`): the command runner cannot per-mutant
// scope, so a whole-repo `mutate` would run the FULL suite for EVERY mutant and
// peg the machine. `mutate` is therefore an empty no-op by default. Drive it
// through the wrapper, which scopes BOTH the mutated files and the test command:
//
//   npm run mutation -- src/gate.ts
//   npm run mutation -- src/utils --concurrency 2
//
// The wrapper (scripts/mutate.mjs) passes `--mutate <targets>` and sets
// STRYKER_TEST_COMMAND to `vitest related <targets> --run` (only the tests whose
// module graph includes the mutated files). tests/global-setup.ts short-circuits
// its rebuild when a STRYKER env var is present, so per-mutant runs stay lean.
const command = process.env.STRYKER_TEST_COMMAND ?? 'npm test';

export default {
  testRunner: 'command',
  commandRunner: { command },
  // Required for the command runner: it has no coverage instrumentation.
  coverageAnalysis: 'off',
  // Empty by default so a bare run is a no-op; scripts/mutate.mjs passes
  // `--mutate` to scope each run to an explicit target.
  mutate: [],
  reporters: ['clear-text', 'progress'],
  tempDirName: '.stryker-tmp',
  // Modest default so a scoped run never oversubscribes; override with
  // Keep this at 2: command-runner mutants each launch a test process, so
  // higher values can saturate developer machines quickly.
  concurrency: 2,
};
