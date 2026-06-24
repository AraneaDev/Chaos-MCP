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
