# Chaos-MCP Logic Audit Report

**Date:** 2026-06-24
**Version audited:** chaos-mcp 1.1.0 (commit `b4aca81`, 215 tests passing)
**Audit scope:** Every file under `src/`, all 4 mutation engines, MCP handler, sandbox, project detector, exec helper, config loader, plus test suite.
**Methodology:** Four parallel deep-analysis agents (engine correctness, contracts, data flow, async lifecycle) → centralized fact-check against the actual source → ranked by severity.

---

## Executive Summary

| Severity | Count |
|---|---|
| Critical | 2 |
| High | 5 |
| Medium | 9 |
| Low | 6 |
| **Total** | **22 distinct, fact-checked issues** |

**Most dangerous single flaw:** `ExecFailureError.exit` is always `null` because `runShell` reads the (never-set) `err.status` field rather than `err.code`. Every engine's exit-code branching is downstream of this — Stryker's "distinguish exit 1 vs 2" guard, Go/Rust "if no parseable stdout → fake-100% score" trap, and Python's "baseline test failure" detection all silently misfire.

**Highest-risk architectural flaw:** The sandbox is conceptually isolated, but (a) `target/` is symlinked back into the host workspace for Rust builds (corrupts the real `target/`), and (b) ignores absolute-path `filePath`, allowing `cpSync` of `/` into the sandbox — escaping the intended workspace.

**Biggest maintainability problem:** Engine-output parsers are spread across `python.ts`, `go.ts`, and `rust.ts` as inline functions with different shape assumptions, duplicated try/catch+ExecFailureError unwrapping patterns (the exact block that hides the exit-code bug is repeated 4×). A shared `parseMutationToolOutput(tool, stdout, stderr, exit)` would have prevented this whole class.

**Estimated code quality:** 6.5 / 10
**Estimated production readiness:** 6.0 / 10  *(blocked pending fixes to Critical #1 and Critical #2)*
**Estimated technical debt:** 5.5 / 10

---

## Critical Findings

### C1 — `ExecFailureError.exit` is always `null` (exec.ts)
**Severity:** Critical
**Location:** `src/utils/exec.ts:80`
**Description:** The error normalizer reads exit code from `err.status`, but Node's `child_process.execFile` writes the numeric exit code into `err.code` and leaves `err.status` as `undefined`. `?? null` then permanently converts every non-zero exit into `null`.
```ts
exit: (errnoError as { status?: number }).status ?? null,  // ← wrong property
```
**Why it matters:** All four engines branch on `error.exit` to distinguish:
- baseline-test failures (expecting non-zero) from expected survivors,
- tool absence (ENOENT) from worker crash (signal),
- timeout (signal + null exit) from general failure.

With `exit` always `null`, **every code path that reads `error.exit` collapses to "expected, parse stdout"**, silently masking real failures (e.g. a broken baseline test is reported as "all 3 mutants killed → 100.00% score").

**Evidence:** Engines `typescript.ts:144`, `python.ts:175`, `go.ts:153`, `rust.ts:144` all reference `error.exit` and rely on its value to decide whether to parse or throw. Because every value is `null`, none of these guards work.
**Recommended fix:** Replace `status` with `code` and gate on numeric-typed only:
```ts
exit: typeof errnoError.code === 'number' ? errnoError.code : null,
```
**Confidence:** High

---

### C2 — Unbounded `filePath` allows workspace-root escape
**Severity:** Critical
**Location:** `src/index.ts` handler chain → `src/utils/project-detector.ts:51` → `src/utils/sandbox.ts`
**Description:** `filePath` is consumed from MCP arguments and passed verbatim into `resolveWorkspaceRoot`, which walks up looking for project markers. Absolute paths (e.g. `/etc/passwd`) or traversal prefixes (`../../../`) make `startDir = dirname(filePath)`, and after failing to find a marker at every level the resolver falls back to **`startDir` itself** — which can be `/`. `createSandbox` then calls `cpSync(resolve('/'), sandboxDir, {...})`. Whatever the OS allows to be read is copied into the ephemeral directory and audited.
**Why it matters:** The TOOL_DEFINITION says "Workspace-relative path" and "Example: src/utils/math.ts", but the code never enforces either. A prompt-injected LLM session can ask the tool to audit any path the server process has read access to. Combined with MCP text-formatting that surfaces lines and snippets, sensitive file content can be exfiltrated through the audit result.
**Evidence:**
```ts
// src/utils/project-detector.ts (simplified)
const fileDir = dirname(resolve(filePath));          // no validation
// walks up; if no marker found returns startDir
// cpSync(absoluteWorkspace, sandboxDir, ...) follows
```
**Recommended fix:** Resolve `filePath` against `process.cwd()` once at the handler boundary and reject any absolute path or any resolved path that escapes `process.cwd()`:
```ts
const resolvedFile = resolve(process.cwd(), filePath);
if (!resolvedFile.startsWith(resolve(process.cwd()) + sep)) {
  return { isError: true, content: [{ type: 'text', text: `Error: filePath must resolve within the workspace.` }] };
}
```
Add the same guard inside `createSandbox` as a defense-in-depth check.
**Confidence:** High

---

## High Findings

### H1 — Rust `target/` symlink defeats sandbox isolation
**Severity:** High
**Location:** `src/utils/sandbox.ts:24`, `src/utils/sandbox.ts:165`
**Description:** `SYMLINK_DIRS = ['node_modules', '.venv', 'venv', 'target']` causes the sandbox to symlink the real workspace's `target/` into the sandbox. When `cargo mutants` then runs, it writes build artifacts directly to the host's `target/`. The sandbox is no longer isolated — it shares lock files (`target/.rustc_info.json`, `.cargo-lock`) and artifact caches with whatever else is compiling the same workspace at the same time.
**Why it matters:** Two concurrent sandbox runs or a parallel host cargo build will corrupt the build cache. The user's "real" tree is now being mutated by mutation runs.
**Evidence:** `const SYMLINK_DIRS = ['node_modules', '.venv', 'venv', 'target'];` then in the function, `safeSymlink(src, dst)` is called for each present symlink dir. `ALWAYS_EXCLUDE` contains `target` as well — meaning the `filter` callback likely returns `false` for it during `cpSync`, but then it's re-created as a symlink anyway, defeating the exclusion intent.
**Recommended fix:** Remove `'target'` from `SYMLINK_DIRS`. Rust builds should always be cold because incremental compilation cache invalidation is unsafe in a sandbox. Add `'build'` (JS), `'dist'` (any), and `'__pycache__'` (Python) to `SYMLINK_DIRS` instead of `ALWAYS_EXCLUDE` (where they currently live).
**Confidence:** High

---

### H2 — Go engine returns fake 100% when baseline tests fail
**Severity:** High
**Location:** `src/engines/go.ts:152-160`
**Description:** When `go-mutesting` exits non-zero, the engine sets `stdout = error.stdout` and falls through to `parseGoMutestingOutput`. There is **no check** that the failure was due to baseline test breakage vs surviving mutants. A broken baseline that emits zero `PASS/FAIL` lines is parsed as `totalMutants=0`, yielding `mutationScore='100.00%'` — a false perfect score on a suite whose `go test ./...` would already be red.
**Why it matters:** Users will see "✅ No surviving mutants found" while their actual test command is broken. They might then trust the audit report for code that has no test coverage.
**Evidence:** After the non-zero exit branch, only `if (!stdout) throw …` is checked. The score calculation in `parseGoMutestingText` is `total > 0 ? (killed/total*100).toFixed(2) : '100.00'`, so empty stdout → 100%.
**Recommended fix:** Distinguish baseline failures from survivor runs via the (once-fixed) exit code, or by checking `error.stderr` for `FAIL [build failed]` / `FAIL [setup failed]` patterns. Throw a clear error when the tool did not generate any mutants and the exit indicates failure:
```ts
if (error.exit !== 0 && error.exit !== 2) {  // 2 = "mutants survived"
  throw new Error(`go-mutesting baseline failure: ${error.stderr?.slice(0,500) || error.message}`);
}
```
**Confidence:** High

---

### H3 — Rust text parser ignores `TIMEOUT` mutants
**Severity:** High
**Location:** `src/engines/rust.ts:39-46`
**Description:** `parseCargoMutantsText` only counts lines starting with `MISSED`, `CAUGHT`, `UNCAUGHT`. `cargo-mutants` also emits `TIMEOUT` (mutant made tests hang past the per-mutant timeout). The `continue` entirely skips the line, removing the mutant from both `total` and `killed`. A test suite that successfully catches mutants via timeout gets no credit.
**Why it matters:** Score is artificially low (timeout mutants missing from total) and timeouts are not rewarded as kills. Mutants that survived only because tests timed out rather than asserted a specific value are misclassified.
**Evidence:**
```ts
if (!isMissed && !isCaught && !isUncaught) continue;
```
**Recommended fix:**
```ts
const isTimeout = trimmed.startsWith('TIMEOUT');
if (!isMissed && !isCaught && !isUncaught && !isTimeout) continue;

total++;
if (isCaught || isTimeout) { killed++; continue; }
// perished mutants go to vulnerabilities
```
**Confidence:** High

---

### H4 — Python `parseMutmutResults` treats mutant IDs as category headers after trimming
**Severity:** High
**Location:** `src/engines/python.ts:97-101`
**Description:** `parseMutmutResults` does:
```ts
const line = rawLine.trim();
if (line.includes(MUTMUT_CATEGORIES.survived.emoji) || /^survived\b/i.test(line)) {
  currentCategory = 'survived';
  survived = parseCategoryCount(line);
  continue;
}
```
Once the line is trimmed, an indented mutant ID whose path starts with `survived` (e.g. `survived_logic.py:7`) becomes a falsy "category header" with `(0)` count, **resetting `survived` to 0**. Same vulnerability exists for `killed`, `timeout`, `skipped`, `suspicious`.
**Why it matters:** A common Python file naming idiom (e.g. `survived_test.py`) trips this and silently discards the actual survivor list. Score is misreported.
**Evidence:** All five category checks apply the same `^<name>\b/i.test(line)` over the trimmed line, then call `parseCategoryCount(line)` which returns `0` for paths without `(N)`.
**Recommended fix:**
- Match headers against the untrimmed line (preserving the indentation that distinguishes a section header from a mutant ID listing):
  ```ts
  if (/^Survived\b/.test(rawLine) && rawLine.includes(MUTMUT_CATEGORIES.survived.emoji)) { … }
  ```
  Or better: require the `(N)` count and the emoji together on the same line.
- Mutant IDs are listed indented beneath headers; only treat a line as a header when followed by an indented continuation. The current parser discards the indentation information.
**Confidence:** High

---

### H5 — Handler accepts floats / unbounded values for `concurrency`
**Severity:** High
**Location:** `src/index.ts:255-258`
**Description:** `concurrency: typeof args.concurrency === 'number' && args.concurrency > 0 ? args.concurrency : cfg.concurrency` accepts any positive number, including floats (`2.5`) and arbitrarily large values (`100000`). A hallucinated float passes `--concurrency 2.5` to Stryker, which crashes CLI parsing. A hallucinated large value forks 100k workers and freezes the host.
**Why it matters:** Concurrency affects CPU and memory at process-creation scale. Without bounds the tool is effectively a DoS vector reachable from any LLM tool-use mistake.
**Evidence:** Only one `> 0` check; no integer check, no max.
**Recommended fix:**
```ts
concurrency: Number.isInteger(args.concurrency) && args.concurrency > 0 && args.concurrency <= cpus().length * 2
  ? args.concurrency
  : cfg.concurrency,
```
Add `minimum: 1, maximum: 64` to the JSON schema for `concurrency`. Add `type: 'integer'` to enforce.
**Confidence:** High

---

## Medium Findings

### M1 — TS engine counts `CompileError` / `RuntimeError` in `totalMutants`
**Severity:** Medium
**Location:** `src/engines/typescript.ts:178-188`
**Description:** Stryker emits mutant records with status `CompileError` and `RuntimeError` (mutator generated invalid syntax). These should be excluded from the mutation-score denominator (they are "broken" mutants, not "surviving" mutants).
**Evidence:** `const totalMutants = mutants.length;` includes every status.
**Recommended fix:**
```ts
const valid = mutants.filter(
  (m) => m.status !== 'CompileError' && m.status !== 'RuntimeError' && m.status !== 'Ignored'
);
const totalMutants = valid.length;
const killed = valid.filter(m => m.status === 'Killed' || m.status === 'Timeout').length;
const survived = valid.filter(m => m.status === 'Survived').length;
```

### M2 — TS engine omits `NoCoverage` from vulnerabilities
**Severity:** Medium
**Location:** `src/engines/typescript.ts:194-203`
**Description:** Mutants with status `NoCoverage` (the test suite never touched the mutated code) lower the score but do not appear in the `Vulnerability[]` array, so the user sees a lower score without any actionable line items.
**Recommended fix:** Add `m.status === 'NoCoverage'` to the filter for vulnerabilities. Include `replacement: 'Untested code path'` and `description: 'No tests reached this line; consider adding tests covering this branch.'`.

### M3 — Rust `cargo mutants --json` flag missing
**Severity:** Medium
**Location:** `src/engines/rust.ts:133`
**Description:** `parseCargoMutantsOutput` tries to parse stdout as JSON, but the command `['mutants', '--file', fileName]` defaults to human-readable text. JSON parse will always fail, falling back to text — which is fine but misleading code AND the JSON path has lingering bugs (`summary.total = caught + missed` ignores `timeout` and `unviable`).
**Recommended fix:** Either remove the JSON path entirely (with a comment explaining the format), OR add `--json` and properly inventory `parsed.summary`:
```ts
const { caught = 0, missed = 0, timeout = 0, total } = parsed.summary ?? {};
const effectiveKilled = caught + timeout;
const realTotal = total ?? (caught + missed + timeout);
```

### M4 — Python engine misclassifies mutmut exit 2 as "baseline failure"
**Severity:** Medium
**Location:** `src/engines/python.ts:170-178`
**Description:** The current code throws "baseline test failure" on any non-zero `mutmut run` exit. Mutmut 3.x can exit non-zero (e.g. exit 2) for reasons other than baseline breakage (e.g. internal error). The code's own comment claims `mutmut run exits 0 even when mutants survive` — that's documented in some versions but not all. If the comment is wrong, real survivor runs are rejected.
**Recommended fix:** Surface mutmut exit non-zero as a warning but still attempt `mutmut results` and parse whatever is available:
```ts
} catch (error: ExecFailureError) {
  if (error.exit !== null && error.exit !== 0 && error.exit !== 2 /* survivors */) {
    throw new Error(`mutmut baseline failure (exit ${error.exit}): ${error.stderr?.slice(0,500) ?? error.message}`);
  }
  // fall through — try to read partial results
}
// continue to mutmut results
```

### M5 — `lineScope` lacks logic validation
**Severity:** Medium
**Location:** `src/index.ts:243-254` and `src/engines/typescript.ts:40-46`
**Description:** Handler validates `start` and `end` are numbers but not that `start > 0` or `end >= start`. If the LLM passes `{start: 50, end: 10}`, the value flows down; `buildMutateArg` silently **drops the scope and mutates the whole file** — a multi-minute full-file mutation on a heavily-tested file.
**Recommended fix:** Validate in the handler boundary, then throw a clear MCP error:
```ts
if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
  return { isError: true, content: [{ type: 'text', text: 'lineScope must have integer start ≥ 1 and end ≥ start' }] };
}
```

### M6 — `ignorePatterns` substring matching is overly greedy
**Severity:** Medium
**Location:** `src/utils/sandbox.ts:157`
**Description:** `src.includes(pattern) || basename === pattern || src.endsWith(pattern)` will match anything containing the pattern anywhere in the path string. Pattern `"test"` excludes `src/latest.ts`, `src/rest.ts`, `src/fixtures/`. Pattern `"app"` excludes non-app files like `apps/`.
**Recommended fix:** Use `picomatch`/`minimatch`, or at minimum require a path-segment match:
```ts
const segments = src.split(sep);
if (segments.includes(pattern)) return false;
```

### M7 — `ignorePatterns` element type validation silently filters
**Severity:** Medium
**Location:** `src/index.ts:222-224, 312, 318`
**Description:** `.filter((v) => typeof v === 'string')` silently drops non-string elements rather than rejecting the call. An LLM error like `ignorePatterns: ['.ts', 123]` results in subtle file-exclusion shifts instead of a clear schema error.
**Recommended fix:** When any element is not a string, return `isError: true` with a clear message:
```ts
if (Array.isArray(earlyArgs.ignorePatterns) && earlyArgs.ignorePatterns.some(v => typeof v !== 'string')) {
  return { isError: true, content: [{ type: 'text', text: 'ignorePatterns must be an array of strings' }] };
}
```

### M8 — `incremental: true` is non-functional (Stuck with C1)
**Severity:** Medium
**Location:** `src/engines/typescript.ts:119` and `src/utils/sandbox.ts:203`
**Description:** Stryker writes `.stryker-incremental.json` inside `cwd = sandbox.workDir`. After `sandbox.cleanup()`, `rmSync` removes the directory. Incremental mode therefore has zero cache-hit rate across subsequent invocations.
**Recommended fix:** If `incremental: true`, copy the incremental file from the sandbox back into a stable location (e.g. `<workspaceRoot>/.chaos-mcp-cache/`) before cleanup, and copy it back into the sandbox before Stryker runs.

### M9 — TOOL_DEFINITION description of `lineScope` is missing Rust
**Severity:** Medium
**Location:** `src/index.ts:70`
**Description:** Description says "Only supported by StrykerJS; ignored for Python and Go targets" — missing Rust. `docs/DRAFT.md` and `HELP_TEXT` correctly say "Python, Go, and Rust". A relying LLM may pass `lineScope` for Rust and be silently ignored without warning.
**Recommended fix:** Update the description to match the rest of the documentation.

---

## Low Findings

### L1 — Vulnerability array assumed iterable in formatter
**Location:** `src/index.ts:182`
**Description:** `for (const v of result.vulnerabilities)` will throw if an engine returns `vulnerabilities: undefined`. TypeScript types prevent this, but defensive programming recommends `(result.vulnerabilities ?? [])`.
**Fix:** Use `result.vulnerabilities ?? []`.

### L2 — `concurrency` no upper bound in JSON schema
**Location:** `src/index.ts:83`
**Description:** No `maximum` constraint in the schema. Add `"maximum": 64` to prevent fork-bomb scenarios reaching here.

### L3 — `loadedConfig` is loaded once at server start
**Location:** `src/index.ts` at the bottom (`if (isDirectRun) { loadedConfig = loadConfig(...) }`)
**Description:** In long-running MCP server mode, updates to `chaos-mcp.config.json` require a restart. Acceptable for now; document in `CONTRIBUTING.md`.
**Fix:** Reload per-request, or expose a separate `reload_config` tool.

### L4 — `testRunner` config field not enum-validated
**Location:** `src/utils/config-loader.ts`
**Description:** Any string is accepted for `testRunner`. The four engines each have specific allowed values. Add a per-engine allowlist check at config-load time.

### L5 — `--dryRun` only wired into TypeScript engine
**Location:** `src/engines/typescript.ts:115`
**Description:** Passing `dryRun: true` to Python/Go/Rust is silently ignored, not surfaced as a warning. Add an early-return guard in the handler if `dryRun` is set for non-TS projects.

### L6 — `formatResultAsText` lacks truncation for huge vulnerability lists
**Location:** `src/index.ts:175-189`
**Description:** A 1000-mutant file produces an inordinately large text response, blowing LLM context. Add a top-N cap with "and N more" suffix.

---

## Documentation & Test Coverage Gaps

| Gap | Severity |
|---|---|
| Integration test (`integration.test.ts`) mocks the engine — never exercises the real ExecFailureError path that contains C1 | High |
| `build-output.test.ts` validates shebang but not the postbuild script's idempotency run-from-`build/index.js` smoke | Low |
| No test verifies `MIN_NODE_VERSION` actually fires when run under `node` with a downgraded `--version` flag | Low |
| `parseMutmutResults` test covers regular output but **not the regex-over-match bug from H4** (no test with `survived_*.py` filename) | High |
| `parseCargoMutantsText` test covers MISSED/CAUGHT but **not TIMEOUT** (H3) | High |
| `TypeScriptEngine.parseReport` test covers Survived but **not `CompileError`/`RuntimeError`/`NoCoverage` paths** (M1, M2) | Medium |
| No test for the H5 concurrency-as-float crash | Medium |
| No test for the C2 path-traversal scenario (passing absolute filePath) | High |

---

## Performance Opportunities

1. **`detectEnvironment` is called twice** in some flows (once for project type, once for full env). Cache per `(workspaceRoot, requestedAt)` for 60 seconds.
2. **`estimateWorkspaceSize` walks the full directory tree** even when excluded directories will be skipped during copy. Walk with the same `ALWAYS_EXCLUDE` filter and break early.
3. **Stryker `--cleanTempDir=true` is hard-coded** even when `incremental: true` — these contradict each other (`cleanTempDir` wipes `.stryker-tmp` between runs, undermining incremental reuse).
4. **Sandbox `cpSync` uses default concurrency** — pinning it to `cpus().length / 2` on large workspaces measurably reduces wall time on Linux but currently is single-threaded.

---

## Security Recommendations

1. **Apply C2 fix unconditionally** (defense-in-depth: validate in handler AND sandbox).
2. **Sanitize warnings:** `logger.log` writes to `process.stderr` (correct for MCP), but it can include absolute paths the user did not intend to share in cross-session logs. Add a `--quiet` mode that omits paths.
3. **Tool args are shell-safe** (we use `execFile`, not `exec`) — verified. But the **command names themselves** are interpolated from `args[0] = 'npx'`. Audit suggests hard-coding the four tool names.
4. **Symlinks in workspace are copied verbatim** (`dereference: false` in `cpSync`). A malicious workspace (or one with a botched commit) could include a symlink to `/etc/shadow`, allowing test commands to read sensitive files. Consider a final sanitizer pass that replaces symlinks crossing into `cwd` boundary with empty regular files.

---

## Single Highest-Impact Improvement

> **Fix `ExecFailureError.exit` (C1) and add a centralized `parseMutationToolOutput(tool, result | error)` helper, called from every engine instead of duplicating the try/catch/ENOENT/TIMEOUT/signal/exit/throw pattern.**

This one refactor:
- Eliminates a real cross-cutting bug affecting all four engines.
- Reduces ~80 lines of triplicated error-handling code.
- Creates a single, testable surface to validate exit-code semantics.
- Makes future engines (Java, Kotlin when you add them) a 20-line copy-paste.

Estimated time-to-implement: 1–2 hours including updating the 4 engine test suites.

---

## Final Summary

A small (≈1000 LOC), tight, well-tested mutation-testing MCP server with a clean architecture. **Two critical defects must be fixed before production deployment**: the universal exit-code misread in `runShell` (C1) and the unmarshalled workspace boundary (C2). After those are patched, the bulk of the medium findings are one-line hardening jobs in the handler boundary. The codebase exhibits good test coverage discipline (215 tests across 12 files) but several branches that *should* be tested (H3 TIMEOUT, H4 regex over-match, M1/M2 Stryker status filtering) are not — so the bugs they would catch have survived.

**Recommended next steps:**
1. Fix C1, C2, H1 immediately — these block production readiness.
2. Add regression tests for H3, H4, M1, M2.
3. Refactor to shared `parseMutationToolOutput` helper to prevent C1-class regressions.
4. Tighten handler boundary validation per H5/M5/M7 to fail fast on bad input rather than silently falling back.
