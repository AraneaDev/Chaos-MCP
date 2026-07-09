# Changelog

All notable changes to Chaos-MCP are documented in this file.

## [1.2.3](https://github.com/AraneaDev/Chaos-MCP/compare/v1.2.2...v1.2.3) (2026-07-09)


### Bug Fixes

* **rust:** parse cargo-mutants summary line for accurate score ([#6](https://github.com/AraneaDev/Chaos-MCP/issues/6)) ([722c5be](https://github.com/AraneaDev/Chaos-MCP/commit/722c5be557a4bbc46ff7a157123a3e551214c602))

## [1.2.2](https://github.com/AraneaDev/Chaos-MCP/compare/v1.2.1...v1.2.2) (2026-07-07)


### Bug Fixes

* **typescript-engine:** return a dry-run result instead of failing ([#3](https://github.com/AraneaDev/Chaos-MCP/issues/3)) ([901f94b](https://github.com/AraneaDev/Chaos-MCP/commit/901f94b7a222d8d536d0e206c9b51c0ef724273d))
* unify cancellation surface, fix WRITE_QUEUE leak, harden prompts + Stryker cleanup ([#5](https://github.com/AraneaDev/Chaos-MCP/issues/5)) ([b492324](https://github.com/AraneaDev/Chaos-MCP/commit/b492324c8343c93e03266252f2b98851b51cbf83))

## [1.2.1](https://github.com/AraneaDev/Chaos-MCP/compare/v1.2.0...v1.2.1) (2026-07-05)


### Bug Fixes

* apply CodeRabbit auto-fixes ([9bd58a4](https://github.com/AraneaDev/Chaos-MCP/commit/9bd58a4a5e7bead093d4f4c129f5ef774829c533))
* **config,cli:** validate infection/cosmicray keys; guard --config flag-value (M2/L2) ([5fbbc39](https://github.com/AraneaDev/Chaos-MCP/commit/5fbbc399a5d70282f63999f6d62c721290fb362c))
* **engines:** derive rust mutator from description; keep php counts consistent (H2/I4/L5) ([6f49f0e](https://github.com/AraneaDev/Chaos-MCP/commit/6f49f0e2192dcc5a5e0dae3a9534c3e55b72bf43))
* **handler,exec:** per-engine ignored-options, abort classification, outputFormat/unknown-tool as toolError (M1/M5/L4/I1) ([7954f88](https://github.com/AraneaDev/Chaos-MCP/commit/7954f8871f9d4bd469af8cefe177d7b9d69929f7))
* resolve 20 logic-audit findings (H/M/L/I) ([8e5cb70](https://github.com/AraneaDev/Chaos-MCP/commit/8e5cb70dfd2b13344da9cedad36e80a9c1de28da))
* **triage,format,schema:** n/a honesty + shared helper, richer schemas, shared timeout, surface incompetent, line-sentinel warning (M3/M6/L6/L7/I2/I3) ([9062a5f](https://github.com/AraneaDev/Chaos-MCP/commit/9062a5f75cca869e85f2da3ab8744bc283ee7a87))
* **utils:** sandbox leak on cwd-guard, run-cache tmp cleanup, addSuppressions array guard (M4/L3/L1) ([7a2b9fb](https://github.com/AraneaDev/Chaos-MCP/commit/7a2b9fb2d45d5a71e105bf67e3cb9b0d7daec72c))
* **verify:** count out-of-baseline regressions for whole-file engines; emit verify structuredContent (H1/H3) ([7665f03](https://github.com/AraneaDev/Chaos-MCP/commit/7665f030dea6e597445ae950b397a7e7c73fdd79))

## [Unreleased]

### Changed — StrykerJS internal-mutation bootstrap parked

- **`@stryker-mutator/*` devDeps uninstalled.** The chaos-mcp-internal mutation-testing bootstrap (the `mutate` script + `stryker.config.mjs`) was parked because the only currently-published Stryker runners are stuck on vitest 2.x and vitest 3.0 dropped the `--related` / `config.related` programmatic API both `@stryker-mutator/vitest-runner@9.6.1` and the (unpublished) `@stryker-mutator/command-runner@9.x` relied on. StrykerJS 10.x has not shipped yet (npm latest is still 9.6.1), so the only realistic revival path is a temporary vitest downgrade. The user-facing STRYKER-ONLY_OPTIONS, `stryker` config section, and `ExecutableTool` enum entries are preserved unchanged — users who install Stryker locally on their target workspace can still invoke `audit_code_resilience` with their own Stryker configuration.
- **`stryker.config.mjs`** — tombstoned with `mutate: []` (explicit empty scope) and full resurrection steps A/B/C documented in the file header. Since `@stryker-mutator/*` devDeps are uninstalled at HEAD, this file is effectively documentation-only: `npx stryker run` is unreachable from the project's normal usage paths because the binary is not in `node_modules`. (If Stryker is later re-installed for resurrection work, this config WILL load — but Stryker 9.6's dry-run phase runs BEFORE mutation processing and would still fail with the same `ConfigError: No tests were executed` that prompted the park. The empty scope only guards the mutation-side-effects, not enumeration. See the in-file header + `docs/stryker-mutation-testing-retrospective.md`.)
- **`scripts/install.sh` / `package.json` scripts** — the `mutate` npm script was removed; `npm run mutate` is no longer wired.
- **`src/__tests__/e2e-stryker.test.ts`** — deleted. It had top-level `import { Stryker } from '@stryker-mutator/core'` and the package is no longer present in `node_modules` (Vite's module loader would fail at file-load time otherwise). The Sibling `e2e-mcp.test.ts` covers the integration regression scenarios.
- **`CONTRIBUTING.md`** — removed the now-stale local-invocation block for `e2e-stryker.test.ts` and the "What gets exercised" Stryker bullet. The remaining `When to trigger an E2E run` entry still mentions Stryker because users commonly upgrade their own Stryker installation (the `npm install --save-dev @stryker-mutator/core` in `README.md` is unchanged for that reason).
- **Path B (vitest@2.x downgrade) attempted and ruled out.** A side branch `feat/stryker-vitest2` pinned `vitest@^2.1.0` + `@stryker-mutator/{core,vitest-runner}@^9.6.1` and re-installed the `mutate` script + a revival `stryker.config.mjs` to attempt the F1 baseline. The dry-run STILL FAILED on vitest@2.x with `ConfigError: No tests were executed` — same wall as on vitest@3.x. StrykerJS 9.6's vitest-runner appears incompatible with this project's `vitest.config.ts` regardless of vitest major, likely due to its `tests/global-setup.ts` rebuild block + include-glob resolution interacting with Stryker's `--related` lookup. Attempt rolled back on the side branch (which is force-pushed to origin and preserved as a documentation tombstone); awaiting StrykerJS 10.x or a vitest3→runner shim (Path C) before any future revival attempt.

### Fixed — `isCancel` regression coverage + cancellation surface unification

- **`src/utils/cancel.ts` (new)** — single `isCancel(error, ctx?)` predicate covers all three cancellation shapes (`ctx.signal.aborted === true`, `error.name === 'AbortError'`, `ExecFailureError.code === 'ABORTED'`). Replaces ad-hoc duplicates in `handler.ts`, `estimate-handler.ts`, and `triage-handler.ts` that had drifted apart (audit C1 followup).
- **`src/__tests__/cancel.test.ts` (new)** — 17 cases across all three branches plus negative interactions.
- **`handler.ts`** — `mapCreateSandboxError` accepts an optional ctx, both create-sandbox and engine catch arms route via `isCancel`.
- **`estimate-handler.ts`** — outer catch routes cancellation to `'Operation cancelled.'` instead of `'Chaos Engine Halted: …'`.
- **`triage-handler.ts`** — per-row `createSandbox` rejection and `auditOne` outer catch both route via `isCancel`.

### Fixed — `WRITE_QUEUE` leak in `suppression.ts`

- Both halves of the cleanup invariant fixed: the chained **`Promise` identity** used to compare unequally in the `.finally` delete step (always leaked a dead reference per workspace per write), and the **return value** was the un-cleaned `next` so callers resumed before cleanup ran. Now the post-cleanup promise is returned and the cleanup comparator matches the actual stored identity.

### Fixed — backtick-fence bypass in `prompts.ts`

- `quoteUserValue` regex now escapes **every** backtick (not just literal 3-backtick sequences). A user-supplied value with 4+ backticks could previously escape the surrounding fenced code block.

### Fixed — cli-* baseline rebuild race via vitest `globalSetup`

- **`tests/global-setup.ts` (new)** + **`vitest.config.ts`** — `globalSetup` rebuilds `./build/index.js` only when missing or when a tracked production source is newer (mtime-gated via `git ls-files` pathspec skip). Skips rebuilds under Stryker (`STRYKER_*` env-var guard — moot now that Stryker is parked, but the guard harmlessly idle-skips). Cleared the recurring `cli-version`, `cli-help`, `cli-smoke`, `cli-validate-config` baseline failures.

### Tests

- **`src/__tests__/suppression.test.ts`** — concurrent stress test (H3): `Promise.all([add, add, add, remove, add, add, add])` on the same workspace key returns the expected merged state and `_writeQueueSize() === 0` after the chain settles.

## [1.2.0] - 2026-07-04

### Fixed — `mutatorDenylist` had no effect on StrykerJS

- **The denylist config shape was invalid** — `writeStrykerMutatorConfig` wrote a top-level `mutators: { Name: false }` map, which is not a StrykerJS option; Stryker silently ignored it and denylisted mutators kept running. The config now writes the schema-valid `mutator.excludedMutations: [...]` array, merging (deduped) with any exclusions already present in the project's own `stryker.config.json`. A legacy `mutators` map found in an existing config is migrated into `excludedMutations` and the invalid key is dropped.
- **`Ignored` mutants are excluded from the score** — Stryker reports excluded mutants with status `Ignored`; `parseReport` previously counted them in the denominator (deflating the score once the denylist actually worked). They now leave the total, matching the existing CompileError/RuntimeError handling.

### Fixed — actionable error when no tests cover the target

- A StrykerJS dry run that executes zero tests (`ConfigError: No tests were executed`) previously surfaced as a raw exit-1 stack dump. It now reports: the file appears to be covered by no tests, with a pointer to add a test file or check the runner configuration.

### Added — recursive test-file discovery for `suggestedTestFile`

- `suggestTestFile` only probed a fixed candidate list (co-located, `__tests__` sibling, top-level `test/`/`tests/`), so nested layouts like `tests/unit/<pkg>/<base>.test.ts` reported `exists: false` with a wrong suggested path even when a test file existed. When no fixed candidate exists, the common test roots (`tests/`, `test/`, `spec/`, `__tests__/`, the target's top-level segment and directory) are now searched recursively (bounded depth/breadth) for a candidate basename. Matches are ranked by shared directory segments with the source file, then by path length, then lexicographically. Rust targets keep the fixed-candidate behaviour (in-file test convention). The recursive walk also skips `dist`, `build`, `coverage`, `target`, `vendor`, `.stryker-tmp`, and `.chaos-mcp`.

### Added — `diffBase` on `triage_test_coverage`

- **`diffBase` argument** — auto-scopes the triage to files changed in git. Accepts `"HEAD"`, `"staged"`, or any git ref/branch/SHA (merge-base with HEAD). `paths` is now optional when `diffBase` is provided: supplying only `diffBase` audits every changed supported source file in the workspace; supplying both intersects changed files under the given paths.
- TypeScript files are mutated only on the changed lines (same line-scoping logic as `audit_code_resilience`). Python, Go, and Rust files always run whole-file; each affected ranking row includes a `scopeNote` field explaining the per-file scoping decision.
- `not-a-repo` and `bad-ref` diff errors are surfaced as clean MCP error responses (not crashes).

### Added — `survivorsPerFile` inline enrichment

- **`survivorsPerFile` argument** (integer ≥ 0; default `0`) — when `> 0`, inlines the top-N severity-ranked, enriched survivor groups directly into each `TriageRow` in the `ranking` array. Fields added to the row when non-empty: `survivors` (grouped by line, enriched), `noCoverageGroups`, `worstSeverity`. Default `0` returns the compact scores-only leaderboard.

### Added — `fileConcurrency` bounded-parallel auditing

- **`fileConcurrency` argument** (integer 1–64; default `max(1, min(4, cpus-1))`) — files are now audited in bounded parallel rather than serially. When `fileConcurrency > 1`, each TypeScript/StrykerJS run's worker count is automatically capped to `floor((cpus-1) / fileConcurrency)` so total CPU use stays near the machine's core count instead of oversubscribing. Other languages (Python/Go/Rust) run whole-file without a worker-count override (they ignore the concurrency cap).
- **`resolveStrykerConcurrency(poolSize, cpuCount)`** — exported helper that computes the per-file Stryker worker cap (returns `undefined` when `poolSize ≤ 1`, i.e. serial mode).

### Added — `structuredContent` + `outputSchema` on `triage_test_coverage`

- **`structuredContent`** is now returned in every `triage_test_coverage` response alongside the text block, matching the behaviour of `audit_code_resilience`. MCP clients can consume the `TriagePayload` directly; the text block is retained for compatibility.
- **`outputSchema`** registered on the `triage_test_coverage` tool definition, describing the `TriagePayload` shape (`mode`, `summary`, `ranking`, `errors`, `scopeNote`, `note`).

### Added — `defaultFileConcurrency` config field

- **`defaultFileConcurrency`** (integer 1–64 in `chaos-mcp.config.json`) — sets the default parallel file count for all `triage_test_coverage` calls. Overridden by the `fileConcurrency` tool argument. Falls back to `max(1, min(4, cpus-1))` when absent.

### Refactored — triage sort-comparator DRY

- Extracted shared `compareTriageRows(a, b)` comparator from the duplicated `scoreNum`/inline-comparator in `triage-handler.ts`. The comparator is now exported from `triage.ts` and reused by both `rankResults` and the handler's final sort. Sort order is byte-identical: score asc, survived desc, file asc.

### Changed — Enrichment on by default

- **`enrich` now defaults to `true`** — survivor/no-coverage groups are enriched and severity-ranked in every audit response unless the caller explicitly passes `"enrich": false`. Prior behaviour (opt-in, off by default) was reversed; callers who relied on unenriched output for token efficiency should now pass `false` to restore it.

### Added — `maxSurvivors` cap

- **`maxSurvivors` tool argument** (integer ≥ 1) — caps how many survivor and no-coverage line groups are returned after severity ranking. Hidden groups are counted in `survivorsTruncated` / `noCoverageTruncated` in the JSON payload. Precedence: `maxSurvivors` arg > `defaultMaxSurvivors` config > 10 (built-in default).

### Added — `severityFloor` filter

- **`severityFloor` tool argument** (`"high"` | `"medium"` | `"low"`) — drops survivor and no-coverage groups whose enriched severity is below the given floor. Dropped groups are counted in `survivorsFiltered` / `noCoverageFiltered`. Requires enrichment (which is on by default); ignored with an explanatory `enrichNote` when `enrich: false` is passed. `"unknown"`-severity groups are treated as below `"low"` and are dropped by any floor.

### Added — `suggestedTestFile` field

- **`suggestedTestFile`** — included in the JSON payload when there are survivors or no-coverage entries (i.e. when the mutation score is below 100%), pointing to the conventional test file path for the audited source file (e.g. `src/utils/__tests__/math.test.ts` for `src/utils/math.ts`). The `exists` field indicates whether the file already exists on disk. Helps the calling agent know where to add or strengthen tests.

### Added — `outputSchema` on the tool definition

- **`outputSchema`** registered on the `audit_code_resilience` tool definition. MCP clients that support it can read the schema to understand the structured payload without parsing JSON from the text block.

### Added — `structuredContent` in the tool response

- **`structuredContent`** is now returned alongside the text content block in every successful (non-verify-mode, non-error) `audit_code_resilience` response. MCP clients can consume the structured payload directly; the text block is retained unchanged for compatibility with clients that read `content[0].text`.

### Added — Go severity support

- **Go mutator name mapping** — `canonicalizeMutator` now maps `<group>/<name>` mutator strings produced by go-mutesting (e.g. `"branch/if"` → `ConditionalExpression`, `"expression/comparison"` → `EqualityOperator`) to canonical severity categories via `GO_MUTATOR_MAP`. The mapping activates unconditionally; it produces severity-ranked output when go-mutesting emits structured data with mutator names, and falls back to `"unknown"` for unmapped names.

### Added — New config fields

- **`defaultMaxSurvivors`** (integer ≥ 1 in `chaos-mcp.config.json`) — sets the default survivor cap for all `audit_code_resilience` calls. Overridden by the `maxSurvivors` tool argument.
- **`defaultSeverityFloor`** (`"high"` | `"medium"` | `"low"` in `chaos-mcp.config.json`) — sets the default severity floor for all `audit_code_resilience` calls. Overridden by the `severityFloor` tool argument.

## [1.1.1] - 2026-06-24

### Added — End-to-End Test Coverage + CI Integration
- **`.github/workflows/e2e.yml`** — new opt-in E2E workflow. Triggers on `workflow_dispatch` (manual) OR `pull_request` labeled with `run-e2e`. Runs the full E2E suite (MCP audit pipeline + Stryker mutations). The `if:` condition gates on `github.event.action == 'labeled'` (not just label presence) to prevent spurious re-runs when a maintainer removes or re-edits the label.
- **`src/__tests__/e2e-mcp.test.ts`** — real MCP audit pipeline E2E against a fixture. Spawns the server as a child process via full-stdio JSON-RPC, exercises the `audit_code_resilience` tool end-to-end against a real workspace. Leak detector is snapshot-relative (captures tmpdir contents in `beforeAll`, only flags dirs created *by this run*) so prior runs and parallel processes don't produce false positives.
- **`src/__tests__/e2e-stryker.test.ts`** — real StrykerJS programmatic mutation test. Builds a temp fixture with a `divide()` function (intentional untested `b === 0` branch for kill-vs-survive mix), symlinks host `node_modules` so no `npm install` is needed in CI, invokes `new Stryker({ testRunner: 'vitest', ... }).runMutationTest()` and asserts at least one mutant killed + one surviving + a mutation score strictly between 0% and 100%. Has install-version detection that prints a `console.error` and skips if `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` major versions are misaligned.

### Added — L3 Negative-Arm Regression Coverage
- **`src/__tests__/exec-error-l3.test.ts`** — regression test for the L3 fix (execFile TIMEOUT classification must require `killed === true` to distinguish real timeouts from external SIGTERM). Covers BOTH arms: positive (real timeout produces a TIMEOUT code) and negative (synthetic `(code: null, signal: 'SIGTERM', killed: false)` error must NOT be classified as TIMEOUT). Uses `vi.mock` + `vi.hoisted` (the ESM-safe pattern; `vi.spyOn` fails at runtime because Node ESM module exports are read-only).

### Changed — Stryker Major Alignment
- `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` both bumped to v9.6.1 (were `^8.7.0` + `^9.6.1` mismatched). Allows `e2e-stryker.test.ts` to actually execute mutations in CI instead of skipping. TypeScript engine JSON parser handles Stryker v9's `mutation.json` schema identically (status / mutatorName / replacement / location.start.line) — no parser change required.

### Changed — Tightened Test Lint Rules
- Added `eslint-plugin-vitest` to `eslint.config.js` with two rules: `vitest/consistent-test-it` (enforces `it` consistency across the suite) and `vitest/no-conditional-expect` (forbids conditional assertions inside test bodies).

### Fixed — Test Suite Hygiene
- **`src/__tests__/exec-error.test.ts`** — removed the broken `vi.spyOn(cp, 'execFile')` block (which threw `TypeError: Cannot spy on export "execFile". Module namespace is not configurable in ESM` at runtime) and the duplicated L3 positive-arm test. File is now C1-regression-only.

### Docs
- **CONTRIBUTING.md** — added "End-to-End Testing" section documenting the two trigger paths (`workflow_dispatch` + `run-e2e` label), local invocation env vars (`E2E=1`, `E2E_STRYKER=1`), what each E2E test exercises, and when to trigger an E2E run.

## [1.1.0] - 2026-06-24

### Added — Engine Optimization
- **Async `runShell` helper** (`src/utils/exec.ts`) — promisified `execFile` with `ExecFailureError` class capturing stdout/stderr, exit code, signal, and ENOENT/timeout normalization. Replaces all `execSync` calls (was blocking the event loop for up to 5 min per mutation run).
- **`concurrency` option** — wired into StrykerJS `--concurrency` flag (was declared but never passed through). Tool args override config defaults.
- **Timeout mutants count as killed** — both TypeScript (Stryker) and Python (mutmut) engines now count `Timeout` status mutants as killed, consistent with Stryker's own mutation score semantics.

### Fixed — Engine Optimization
- **Python engine result parsing** — rewrote to parse `mutmut results` text output (emoji category headers + indented IDs) instead of nonexistent `mutmut json` subcommand. The entire previous parsing path was fictional.
- **Python engine baseline failures** — `mutmut run` exits 0 even when mutants survive; non-zero exit now surfaces as a baseline-test-failure error instead of being swallowed.
- **Python engine mutmut v3 compatibility** — changed from `--paths-to-mutate` flag (v2) to positional arg pattern (v3).
- **Go/Rust empty-stdout guard** — `!stdout` check prevents misleading 100% scores when go-mutesting/cargo-mutants crash with stderr only.
- **Go/Rust stderr capture** — crash messages now include stderr content for diagnostics.
- **TypeScript exit code distinction** — Stryker exit 1 (config error) vs exit 2 (threshold not met) are now distinguished; exit 1 throws, exit 2 proceeds to report parsing.
- **TypeScript defensive catch-all** — non-`ExecFailureError` errors no longer silently fall through to `parseReport`.

### Added — Area 2: Environment Auto-Detection
- **Go test runner detection** — `detectGoTestRunner()` detects testify and ginkgo via `go.mod` dependencies. `detectRawGoRunner()` returns the unmapped value.
- **Rust test runner detection** — `detectRustTestRunner()` detects cargo-nextest (via `nextest.toml` or `.config/nextest.toml`) and criterion benchmarks (via `Cargo.toml`). `detectRawRustTestRunner()` returns the unmapped value.
- **bun.lockb detection** — added as a signal for bun test runner detection.
- **Python venv detection** — `.venv/` and `venv/` directories detected and symlinked into sandbox.
- `detectEnvironment()` updated to use the new Go/Rust detection instead of hardcoded `'go test'` / `'cargo test'`.

### Added — Area 3: Sandbox Isolation
- **`os.tmpdir()`** — replaces hard-coded `/tmp` for cross-platform temp directory support (TMPDIR on macOS/Linux, TEMP/TMP on Windows).
- **Symlink heavyweight directories** — `node_modules`, `.venv`, `venv`, and `target/` are symlinked into the sandbox instead of copied (were previously copied in full or excluded entirely).
- **Windows junction fallback** — `safeSymlink()` tries `symlinkSync('dir')` first, falls back to `symlinkSync('junction')` on Windows when symlinks require admin privileges.
- **Workspace size guard** — warns when workspace exceeds 200MB (verbose mode only, to avoid traversal overhead in normal mode).
- **`ignorePatterns` in sandbox** — user-provided substring patterns are merged into the `cpSync` filter alongside built-in `ALWAYS_EXCLUDE`.
- **`target` added to `ALWAYS_EXCLUDE`** — Rust build artifacts no longer copied.

### Added — Area 4: Tool Schema Extensions
- **`dryRun`** (boolean, StrykerJS only) — validates the test suite passes without mutation testing. Wired to `--dryRun` flag.
- **`outputFormat`** (`'json'` | `'text'`) — `'text'` returns a human-readable summary via `formatResultAsText()`. Default is `'json'`.
- **`incremental`** (boolean, StrykerJS only) — reuses results from a previous run to skip unchanged mutants. Wired to `--incremental` and `--incrementalFile` flags.
- **`ignorePatterns`** (string[]) — substring patterns to exclude files/directories from the sandbox copy.
- **`additionalProperties: false`** — added to tool input schema for MCP compliance.

### Added — Area 5: Deployment & Packaging
- **GitHub release workflow** (`.github/workflows/release.yml`) — tag-triggered CI that builds, tests, and publishes to npm.
- **Shebang preservation** — `postbuild` script prepends `#!/usr/bin/env node` to `build/index.js` (tsc strips shebangs) and sets execute permissions (guarded by platform check for Windows).
- **`prepare` script** — runs build on `npm install` for git dependencies.
- **`prepublishOnly` script** — runs `build` + `check` (build, lint, format check, test) before publishing.
- **`engines` field** — `node >=18.0.0` enforced in package.json.

### Changed — ESLint Configuration
- Switched from `projectService` (with file-count limit) to `project: 'tsconfig.eslint.json'` to resolve "Too many files (>8) matched default project" error.

### Tests
- All 4 engine test files rewritten to mock `runShell`/`ExecFailureError` (ESM-safe top-level imports).
- New `mutmut-parser.test.ts` — unit tests for `parseMutmutResults` covering empty output, missing emoji, suspicious mutants, mixed categories, and v3 numeric IDs.
- Added timeout-status mutant test cases to TypeScript engine tests.
- Added Go/Rust runner detection tests to `project-detector.test.ts`.
- Added `dryRun`, `incremental`, `concurrency`, `ignorePatterns`, and `outputFormat` wiring tests to `handler.test.ts`.
- Added E2E integration test verifying server accepts all new schema options in `tools/call`.
- Fixed pre-existing outdated test (`main.rs` was listed as unsupported but Rust support was already added).
- Updated sandbox tests for `os.tmpdir()`, new symlinks, and `ignorePatterns`.
- Updated integration tests for new schema properties and `additionalProperties: false`.

### Added — Audit-Driven Hardening (`LOGIC-AUDIT.md` + `LIVE-AUDIT.md`)
- **`invokeMutationTool` wrapper** (`src/utils/exec-classify.ts`) — new module centralises startup-failure classification (ENOENT / timeout / signal crash) so each engine's catch block shrinks from ~25 lines of duplicated scaffolding to a single instance check. Eliminated the duplication that allowed audit finding C1 (`err.status` vs `err.code`) to propagate to all 4 engines.
- **`ExecFailureError.exit` reads `err.code`** (`src/utils/exec.ts`) — numeric exit codes are now correctly reported instead of always-null. Fixes Stryker exit-1 (config error) detection, Mutmut baseline-failure detection, and all `cargo mutants` / `go-mutesting` exit-code branches (audit C1).
- **`C2` path-traversal guards** — handler-level check refuses `filePath` values whose `resolve(cwd, …)` escapes `cwd`; defense-in-depth check in `createSandbox` throws `Refusing to sandbox workspace outside process cwd` when `workspaceRoot` itself escapes `cwd`. Defends against an LLM being tricked into auditing host files outside the workspace (audit C2).
- **`H1` Rust `target/` no longer symlinked** — Rust builds compile into a sandbox-local `target/`, leaving the host workspace's build cache intact (audit H1).
- **`H2` Go baseline-failure detection** — when `go-mutesting` exits non-zero with zero parsed mutants, the engine now throws a baseline-failure error rather than silently reporting a fake 100% mutation score. Parser requires quoted paths on PASS/FAIL lines to distinguish mutants from baseline compiler-error output (audit H2).
- **`H3` Rust TIMEOUT mutants counted as killed** — both TypeScript (Stryker) and Rust (cargo-mutants) engines count `Timeout` mutants as killed, consistent with Stryker's own semantics (audit H3).
- **`H4` Python header / path disambiguation** — `parseMutmutResults` now requires a category emoji OR a parens-counted header line, AND rejects lines that look like file paths. Prevents mutant IDs like `survived_logic.py:7` from being misclassified as section headers (audit H4).
- **`H5` concurrency validation** — `concurrency` must be an integer between 1 and 64 (Stryker worker cap). Non-integer / out-of-range values produce a clear MCP error (audit H5).
- **`M1` `CompileError` / `RuntimeError` excluded from mutation score** — Stryker mutants with these statuses don't have a testable outcome; counting them in `total` would inflate scores (audit M1).
- **`M2` `NoCoverage` mutants reported as vulnerabilities** — no test reached that code path; surfaced as first-class vulnerabilities with a dedicated description (audit M2).
- **`M5` `lineScope` validation** — must be `{ start: integer ≥ 1, end: integer ≥ start }`. Invalid values are rejected (audit M5).
- **`M6` segment-based `ignorePatterns` matching** — replaces substring matching so a pattern `test` doesn't over-eagerly exclude `latest.ts` (audit M6).
- **`M7` `ignorePatterns` element-type check** — non-string array elements no longer silently filtered out (audit M7).
- **`M8` `TOOL_DEFINITION` doc fix** — corrected schema descriptions to match actual behaviour (audit M8).

### Fixed — Live-Audit (`LIVE-AUDIT.md`)
- **`L1`** — `createSandbox` no longer refuses the legitimate case where `workspaceRoot === process.cwd()` (the most common case in real usage). The `isPathInside` helper now mirrors the handler's version.
- **`L2`** — `ignorePatterns` with trailing separator (`["fixtures/"]`) is now normalised before segment matching, so the most common user convention works as expected.
- **`L3`** — execFile TIMEOUT classification now requires `killed === true`, distinguishing real timeouts from external SIGTERM (e.g. OOM killer).
- **`L4`** — `parseCargoMutantsText` now case-insensitively matches `timeout`, so lowercase outputs from `cargo mutants` text mode are correctly counted.
- **`L5`** — dismissed after fact-check; the quoted-path gate on the go parser is intentional (preserves the H2 baseline-failure detection).

## [1.0.0] - 2024-06-24

### Added
- **`audit_code_resilience`** MCP tool — on-demand, sandbox-isolated mutation testing
- **TypeScript/JavaScript engine** — StrykerJS integration with programmatic API
- **Python engine** — Mutmut CLI integration with JSON output parsing
- **Go engine** — go-mutesting CLI integration with text + JSON output parsing
- **Sandbox isolation** — all mutation runs execute in temp directories; real workspace never touched
- **Environment auto-detection** — vitest, jest, mocha, jasmine, bun, node:test, pytest, tox, nox
- **Tool schema extensions** — `timeoutMs`, `lineScope`, `mutatorAllowlist`, `mutatorDenylist`
- **Configuration file support** — `chaos-mcp.config.json` for default timeout, mutators, test runner
- **CLI flags** — `--version`, `--help`, `--config`
- **Integration test suite** — spawns MCP server as child process, validates JSON-RPC protocol
- **Package metadata** — npm `files`, `engines`, `prepublishOnly`, `keywords`, `license`
