# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Chaos-MCP is an MCP (Model Context Protocol) **stdio server** that runs isolated mutation testing against a target codebase to find holes in its test suite. It exposes three tools: `audit_code_resilience` (one file), `triage_test_coverage` (rank a tree weakest-first), and `estimate_audit` (cheap pre-flight mutant count / timing estimate, no test cycle). It wraps four language-specific mutation tools — StrykerJS (TS/JS), cosmic-ray (Python), cargo-mutants (Rust), Infection (PHP). Pre-release: not on npm; source is public at github.com/AraneaDev/Chaos-MCP, install from source. ESM throughout (`"type": "module"`, `.js` import specifiers that resolve to `.ts`).

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
- CI (`ci.yml`) runs `npm run check` on Node 22/24 — both must pass.

## Architecture: the request pipeline

`index.ts` (`startServer`) registers three tools and dispatches by name. The server now advertises `resources` and `prompts` capabilities alongside `tools`. A `ToolContext` (abort signal + optional token-gated progress reporter) is built per call via `makeToolContext` (`src/tool-context.ts`) and threaded as an optional last arg into all three tool handlers — when omitted, all context-gated behaviour is a no-op, preserving existing callers. Cancellation flows via `RunOptions.signal` from the handler through the engine into the in-flight subprocess. The non-trivial logic lives in the handlers, not the entry point:

1. **`handler.ts` → `handleToolCall`** (the `audit_code_resilience` path) is the orchestrator and the file to read first. Flow:
   - Validate `filePath` and enforce the **workspace boundary** — `isRealPathInside` resolves symlinks and rejects any path outside `process.cwd()` (an LLM must not be tricked into auditing arbitrary host files).
   - `detectProjectType` (by extension) → `detectEnvironment` (test runner, workspace root, package manager) → `makeEngine`.
   - Re-anchor the target path to `env.workspaceRoot` (matters in monorepos where the root is a subdir of cwd).
   - `validateToolArgs` runs an **ordered list of per-field validators** (`TOOL_ARG_VALIDATORS`) — strict checks the coarse JSON schema can't express. Runs **before** the sandbox copy so bad input is rejected for free.
   - `computeScope` resolves line scoping on the **real tree** (before the expensive copy) from `diffBase` (A2, diff-aware), `baseline` (A3, verify mode), or `runId` (verify by cached id, loaded via `loadRun` before the sandbox) — mutually exclusive. A "no changes" diff short-circuits with a synthetic 100% result; no sandbox is provisioned. Unknown/expired `runId` errors here before any sandbox is created.
   - `createSandbox` copies the workspace to a tmpdir, then `auditFile` builds `RunOptions`, optionally runs the (gated) prebuild, and calls `engine.run`. The sandbox is **always** cleaned up in a `finally`.
   - Post-run, `suppress`/`unsuppress` entries write to `suppressionsPath`; `applySuppressions` then filters the result and adjusts the score (`suppressedCount` in output).
   - `formatAuditOutput` renders standard vs. verify-mode output and appends a note listing any StrykerJS-only options the resolved engine ignored.
2. **`triage-handler.ts` / `triage.ts`** (the `triage_test_coverage` path) walks a tree (`discoverFiles`), audits each file, and `rankResults` sorts weakest-first (score asc, survived desc, file asc). Both the audit and triage paths accept `minScore` (0–100); a failing gate writes `gate: { minScore, passed }` on audit and `gate: { minScore, passed, failingFiles }` on triage — never an error.
3. **`estimate-handler.ts`** (the `estimate_audit` path) enforces the workspace boundary and calls `estimateAudit` (`src/estimate.ts`). `estimate.ts` runs `cargo mutants --list` for an exact Rust count (`fidelity: "exact"`), or applies a source-parse heuristic (`src/estimate-heuristic.ts`) for TS/JS/Python (`fidelity: "approx"`). When `withTiming: true`, a sandbox is provisioned and `src/baseline-timing.ts` drives a one-off test-suite run to compute `baselineMs`/`estimatedMs`/`concurrency`.
4. **`gate.ts`** — `evaluateGate(scoreText, minScore)` grades a formatted score string against the threshold and returns `{ minScore, passed }`. `validateMinScore` validates the input (0–100). Called by both the audit and triage handlers.

### Engines (`src/engines/`)
- `base.ts` defines `BaseEngine` (abstract `run()`), plus the `RunOptions` / `MutationResult` / `Vulnerability` contracts. **`RunOptions` is the canonical doc** for which options each engine honors — most are StrykerJS-only (see `STRYKER_ONLY_OPTIONS` in `handler.ts`).
- `registry.ts` is the **single source of truth per language**: `ENGINE_REGISTRY` maps each `SupportedProjectType` → `{ make, configKey, supportsLineScope, prebuild? }`. Adding a language touches three places: implement a `BaseEngine`, add an entry here, add detection in `project-detector.ts` and a config section in `config-loader.ts`. Only TypeScript (`supportsLineScope: true`) supports `lineScope`/diff-scoping/verify-rescoping; the others always run whole-file.
- Engines shell out via `invokeMutationTool` (from `utils/exec-classify.ts`) over `utils/exec.ts`. **All subprocess execution is async** (`execFile`/`exec`); only the one-time sandbox copy is sync. A non-zero exit is thrown as `ExecFailureError` so callers distinguish "expected survivors" (non-zero) from real crashes (signal) or missing binary (`ENOENT`); startup failures become `MutationToolStartupError`. `BaseEngine.toExecFailure` normalizes this for the Rust engine.

### Protocol layer (`src/`)
- `tool-context.ts` — `makeToolContext(request, extra)` builds a `ToolContext` with an optional `AbortSignal` (`ctx.signal`) and an optional `reportProgress` function. The progress reporter is created only when both a `progressToken` is present in `request.params._meta` and a `sendNotification` channel is available in `extra`; otherwise `ctx.reportProgress` is `undefined` and callers no-op via optional chaining (`ctx?.reportProgress?.(...)`). Progress sends are fire-and-forget — a rejected notification is swallowed so it can never break an actual run.
- `resources.ts` — `listResources()` / `readResource(uri)` serve three static URIs: `chaos://languages` (JSON, built from `ENGINE_REGISTRY`), `chaos://config-schema` (JSON, inline config-key docs), `chaos://capabilities` (Markdown, tool args + triage→audit→verify loop). Registered in `index.ts` via `ListResourcesRequestSchema` / `ReadResourceRequestSchema`.
- `prompts.ts` — `listPrompts()` / `getPrompt(name, args)` serve two prompts: `harden_file(filePath)` and `triage_changes(diffBase)`. Each returns a `user`-role message that walks an agent through the audit/triage/verify loop. Registered in `index.ts` via `ListPromptsRequestSchema` / `GetPromptRequestSchema`.

### Utils (`src/utils/`)
- `sandbox.ts` — `createSandbox` copies the workspace to `os.tmpdir()`, symlinks `node_modules`/`.venv` (so heavy deps aren't copied), enforces a size guard, and registers exit handlers (`exit`/SIGTERM/SIGINT/SIGHUP/SIGQUIT) that remove leaked sandboxes. Has its own `isPathInside` boundary check (defense-in-depth).
- `project-detector.ts` — extension → `ProjectType`, plus per-language test-runner / package-manager / workspace-root detection.
- `config-loader.ts` — loads/validates `chaos-mcp.config.json`. Engine-specific sections (`stryker`/`cosmicray`/`rust`) override globals; precedence is **args > engine section > global config > detected default** (see `buildRunOptions`).
- `git-diff.ts` — `computeChangedRanges` for diff-aware scoping (returns tagged results: `not-a-repo` / `bad-ref` / `no-changes` / `untracked` / `ranges`).
- `verify.ts` — A3 verify mode: parse a prior-run baseline, re-scope to those lines, and report which previously-surviving mutants are now killed.
- `run-cache.ts` — `saveRun`/`loadRun`; ephemeral baseline cache in `os.tmpdir()/chaos-mcp-runs/` (8-char `runId` returned by every non-verify audit); TTL + count-cap eviction (defaults: 24 h / 200 entries; configurable via `runCacheTtlMs`/`runCacheMax`).
- `suppression.ts` — durable equivalent-mutant list persisted to `<workspaceRoot>/.chaos-mcp/suppressions.json`; `applySuppressions` strips suppressed entries from results and recomputes the score with suppressed mutants removed from the denominator; `suppressedCount` is reported in output. Keyed by `file + line + mutator`; `addedAt`/`reason` fields aid manual pruning.

## Conventions & gotchas

- **`APP_VERSION` must stay `export const APP_VERSION = '<semver>';` in `src/index.ts`** — the npm `version` lifecycle hook (`scripts/sync-app-version.js`) rewrites that literal by regex, and `version-sync.test.ts` asserts it matches `package.json`.
- Importing `index.ts` must have **no side effects** — `startServer` is only invoked via the `isDirectRun` guard at the bottom, so tests can import handlers without starting a server. Keep it that way.
- `prebuildCommand` runs an arbitrary shell command that can escape the sandbox, so it is **opt-in**: gated behind `allowPrebuild: true` in config or `CHAOS_MCP_ALLOW_PREBUILD=1`. Auto-prebuilds declared in `ENGINE_REGISTRY` (Rust `cargo check`) are NOT gated — they're not caller-supplied.
- Many guards/branches carry audit tags in comments (e.g. `C2`, `H5`, `Med#10`, `A2`/`A3`). When touching that code, preserve the tagged behavior — these encode prior security/correctness findings.
- Commits follow **Conventional Commits** (`feat:`/`fix:`/`refactor:`/`test:`/`docs:`/`chore:`). PRs target `main`.

## Self-mutation-testing (dogfooding)

The project mutation-tests its own source by running the built tool against itself:
```bash
node scripts/audit-self.js src/utils/exec-classify.ts   # audit one file, print survivors
node scripts/meta-test.js                                # full-pipeline smoke run
```
This needs `build/` and the Stryker devDeps present (they're symlinked into the sandbox via `node_modules`). When hardening tests against survivors, watch for **equivalent mutants** — mutations with no behavioral difference that can never be killed; don't chase them.
