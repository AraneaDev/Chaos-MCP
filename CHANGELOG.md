# Changelog

All notable changes to Chaos-MCP are documented in this file.

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
