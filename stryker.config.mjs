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
//   Since @stryker-mutator/* devDeps are uninstalled at HEAD (see the chore()
//   commit that parked this bootstrap), `npx stryker run --configFile
//   stryker.config.mjs` is unreachable from the project's normal usage paths:
//   the binary is not in node_modules. This file is effectively documentation-
//   only at HEAD.
//
//   If a future resurrection attempt re-installs StrykerJS, this file WILL
//   load, BUT Stryker 9.6's dry-run phase will still fail with the same
//   `ConfigError: No tests were executed` wall that prompted the park. The
//   empty mutate-scope does NOT bypass the dry-run enumeration step; it only
//   prevents the mutation-side-effects (zero mutants processed) if someone
//   wires up Stryker without first fixing the dry-run wall.
export default {
  mutate: [],
  testRunner: 'vitest',
};
