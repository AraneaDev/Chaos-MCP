// StrykerJS config for chaos-mcp INTERNAL mutation testing.

// STATUS (2026-07-07): PARKED. Reason documented at:
//   docs/stryker-mutation-testing-retrospective.md

// Resurrection paths:
//   A. Wait for StrykerJS 10.x (npm latest is 9.6.1, 2026-04).
//      .github/workflows/check-strykerjs.yml opens a tracking issue when
//      any of three blockers lifts:
//        - @stryker-mutator/core major >= 10
//        - @stryker-mutator/command-runner published
//        - @stryker-mutator/vitest-runner ships a vitest-3 fix
//   B. Downgrade vitest to 2.x. Attempted on branch feat/stryker-vitest2;
//      vitest-runner 9.6 still failed. ROLLED BACK.
//   C. Custom vitest3->stryker9 bridge shim (~150 LOC). Deferred.

// Why { mutate: [] }:
//   Any stray `stryker run --configFile stryker.config.mjs` invocation now
//   exits 0 instantly (0 mutants) instead of implicitly mutating everything.
export default {
  mutate: [],
  testRunner: 'vitest',
};
