# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Chaos-MCP is an MCP (Model Context Protocol) **stdio server** that runs isolated mutation testing against a target codebase to find holes in its test suite. It exposes two tools: `audit_code_resilience` (one file) and `triage_test_coverage` (rank a tree weakest-first). It wraps four language-specific mutation tools — StrykerJS (TS/JS), Mutmut (Python), go-mutesting (Go), cargo-mutants (Rust). Pre-release: not on npm; install from source. ESM throughout (`"type": "module"`, `.js` import specifiers that resolve to `.ts`).

## Commands

```bash
npm run build              # tsc → build/index.js, then postbuild restores the shebang + chmod +x
npm run check              # FULL gate: build → lint → format:check → test (run before pushing)
npm test                   # vitest run — all unit + integration tests (REQUIRES a prior build)
npx vitest run src/__tests__/handler.test.ts        # single test file
npx vitest run -t 'name of test'                    # single test by name
npm run test:watch         # watch mode for iterative dev
npm run test:coverage      # v8 coverage (measures src/**/*.ts only)
npm run lint               # eslint src/   (lint:fix to auto-fix)
npm run format:check       # prettier --check (format to write)
```

- `npm test` requires `build/` to exist — several tests (`build-output`, `version-sync`, the `audit-self`/`meta-test` scripts) import from `../build/index.js`, not `src/`.
- **E2E tests are opt-in** behind env-var gates inside the test files themselves: `E2E=1 npx vitest run src/__tests__/e2e-mcp.test.ts` (spawns a real server) and `E2E_STRYKER=1 npx vitest run src/__tests__/e2e-stryker.test.ts` (real Stryker run). Without the flag they load and noop. CI runs them only via the `e2e.yml` workflow (manual dispatch or the `run-e2e` PR label).
- CI (`ci.yml`) runs `npm run check` on Node 20/22/24 — all three must pass.

## Architecture: the request pipeline

`index.ts` (`startServer`) registers two tools and dispatches by name. The non-trivial logic lives in the handlers, not the entry point:

1. **`handler.ts` → `handleToolCall`** (the `audit_code_resilience` path) is the orchestrator and the file to read first. Flow:
   - Validate `filePath` and enforce the **workspace boundary** — `isRealPathInside` resolves symlinks and rejects any path outside `process.cwd()` (an LLM must not be tricked into auditing arbitrary host files).
   - `detectProjectType` (by extension) → `detectEnvironment` (test runner, workspace root, package manager) → `makeEngine`.
   - Re-anchor the target path to `env.workspaceRoot` (matters in monorepos where the root is a subdir of cwd).
   - `validateToolArgs` runs an **ordered list of per-field validators** (`TOOL_ARG_VALIDATORS`) — strict checks the coarse JSON schema can't express. Runs **before** the sandbox copy so bad input is rejected for free.
   - `computeScope` resolves line scoping on the **real tree** (before the expensive copy) from `diffBase` (A2, diff-aware) or `baseline` (A3, verify mode) — mutually exclusive. A "no changes" diff short-circuits with a synthetic 100% result; no sandbox is provisioned.
   - `createSandbox` copies the workspace to a tmpdir, then `auditFile` builds `RunOptions`, optionally runs the (gated) prebuild, and calls `engine.run`. The sandbox is **always** cleaned up in a `finally`.
   - `formatAuditOutput` renders standard vs. verify-mode output and appends a note listing any StrykerJS-only options the resolved engine ignored.
2. **`triage-handler.ts` / `triage.ts`** (the `triage_test_coverage` path) walks a tree (`discoverFiles`), audits each file, and `rankResults` sorts weakest-first (score asc, survived desc, file asc).

### Engines (`src/engines/`)
- `base.ts` defines `BaseEngine` (abstract `run()`), plus the `RunOptions` / `MutationResult` / `Vulnerability` contracts. **`RunOptions` is the canonical doc** for which options each engine honors — most are StrykerJS-only (see `STRYKER_ONLY_OPTIONS` in `handler.ts`).
- `registry.ts` is the **single source of truth per language**: `ENGINE_REGISTRY` maps each `SupportedProjectType` → `{ make, configKey, supportsLineScope, prebuild? }`. Adding a language touches three places: implement a `BaseEngine`, add an entry here, add detection in `project-detector.ts` and a config section in `config-loader.ts`. Only TypeScript (`supportsLineScope: true`) supports `lineScope`/diff-scoping/verify-rescoping; the others always run whole-file.
- Engines shell out via `invokeMutationTool` (from `utils/exec-classify.ts`) over `utils/exec.ts`. **All subprocess execution is async** (`execFile`/`exec`); only the one-time sandbox copy is sync. A non-zero exit is thrown as `ExecFailureError` so callers distinguish "expected survivors" (non-zero) from real crashes (signal) or missing binary (`ENOENT`); startup failures become `MutationToolStartupError`. `BaseEngine.toExecFailure` normalizes this for the Go/Rust engines.

### Utils (`src/utils/`)
- `sandbox.ts` — `createSandbox` copies the workspace to `os.tmpdir()`, symlinks `node_modules`/`.venv` (so heavy deps aren't copied), enforces a size guard, and registers exit handlers (`exit`/SIGTERM/SIGINT/SIGHUP/SIGQUIT) that remove leaked sandboxes. Has its own `isPathInside` boundary check (defense-in-depth).
- `project-detector.ts` — extension → `ProjectType`, plus per-language test-runner / package-manager / workspace-root detection.
- `config-loader.ts` — loads/validates `chaos-mcp.config.json`. Engine-specific sections (`stryker`/`mutmut`/`go`/`rust`) override globals; precedence is **args > engine section > global config > detected default** (see `buildRunOptions`).
- `git-diff.ts` — `computeChangedRanges` for diff-aware scoping (returns tagged results: `not-a-repo` / `bad-ref` / `no-changes` / `untracked` / `ranges`).
- `verify.ts` — A3 verify mode: parse a prior-run baseline, re-scope to those lines, and report which previously-surviving mutants are now killed.

## Conventions & gotchas

- **`APP_VERSION` must stay `export const APP_VERSION = '<semver>';` in `src/index.ts`** — the npm `version` lifecycle hook (`scripts/sync-app-version.js`) rewrites that literal by regex, and `version-sync.test.ts` asserts it matches `package.json`.
- Importing `index.ts` must have **no side effects** — `startServer` is only invoked via the `isDirectRun` guard at the bottom, so tests can import handlers without starting a server. Keep it that way.
- `prebuildCommand` runs an arbitrary shell command that can escape the sandbox, so it is **opt-in**: gated behind `allowPrebuild: true` in config or `CHAOS_MCP_ALLOW_PREBUILD=1`. Auto-prebuilds declared in `ENGINE_REGISTRY` (Go `go mod download`, Rust `cargo check`) are NOT gated — they're not caller-supplied.
- Many guards/branches carry audit tags in comments (e.g. `C2`, `H5`, `Med#10`, `A2`/`A3`). When touching that code, preserve the tagged behavior — these encode prior security/correctness findings.
- Commits follow **Conventional Commits** (`feat:`/`fix:`/`refactor:`/`test:`/`docs:`/`chore:`). PRs target `main`.

## Self-mutation-testing (dogfooding)

The project mutation-tests its own source by running the built tool against itself:
```bash
node scripts/audit-self.js src/utils/exec-classify.ts   # audit one file, print survivors
node scripts/meta-test.js                                # full-pipeline smoke run
```
This needs `build/` and the Stryker devDeps present (they're symlinked into the sandbox via `node_modules`). When hardening tests against survivors, watch for **equivalent mutants** — mutations with no behavioral difference that can never be killed; don't chase them.
