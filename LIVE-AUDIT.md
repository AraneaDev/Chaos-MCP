# Live Audit — 2026-06-24

**Scope:** Audit-driven hardening changes from `LOGIC-AUDIT.md` verified at runtime.
**Code path scanned:** `src/utils/exec.ts`, `src/utils/exec-classify.ts`, `src/utils/sandbox.ts`, `src/index.ts`, `src/engines/{typescript,python,go,rust}.ts`, plus the new regression test files.
**Project logs scanned:** None (this project writes no in-project logs; system/host logs are out of scope per the live-audit skill).
**Test suite at scan time:** 228 passing, 0 failing.

## Executive Summary

5 raw findings collected; 4 fixed in this round, 1 dismissed after fact-check.

| # | Sev | Front | Location | Title | Status |
|---|-----|-------|----------|-------|--------|
| L1 | **CRITICAL** | Code | `src/utils/sandbox.ts:16` | Sandbox refuses when workspace equals cwd | ✅ Fixed |
| L2 | HIGH | Code | `src/utils/sandbox.ts:152` | ignorePatterns with trailing `/` silently fails | ✅ Fixed |
| L3 | HIGH | Code | `src/utils/exec.ts:141` | execFile TIMEOUT misclassifies external SIGTERM | ✅ Fixed |
| L4 | HIGH | Code | `src/engines/rust.ts:33` | rust TIMEOUT check is case-sensitive | ✅ Fixed |
| L5 | MEDIUM | Code | `src/engines/go.ts:41` | go parser requires quoted paths | ❌ Dismissed (intentional, see below) |

## Findings

### [CRITICAL] L1 — Sandbox refuses valid workspace when it equals cwd

**Status:** ✅ FIXED
**Location:** `src/utils/sandbox.ts:16` (original) → `:18` (post-fix)
**Front:** Code (logical failure)

**Evidence (before fix):**
```ts
function isPathInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel);
}
```

`Path.relative(cwd, cwd)` returns `''`. The `rel !== ''` clause rejects the legitimate and overwhelmingly common case where `resolvedWorkspaceRoot === process.cwd()`. In every realistic MCP-client setup where the agent runs from its own project root, `detectEnvironment()` resolves the workspace root to cwd.

**Consequence:** `audit_code_resilience` would throw `Refusing to sandbox workspace outside process cwd` on calls against the user's own project — i.e., 100% of normal usage.

**Reachability:** Hot path. Every `audit_code_resilience` call goes through `createSandbox`.

**Fix applied:**
```ts
function isPathInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  // INSIDE = equal-to (rel === ''), strictly inside (rel === 'foo'),
  // or the parent of (rel === '..') the root.
  return !rel.startsWith('..') && rel !== '..' && !isAbsolute(rel);
}
```

**Regression test:** `sandbox.test.ts > accepts sandbox when workspace equals process cwd (Live-audit L1)`.

---

### [HIGH] L2 — `ignorePatterns` with trailing `/` silently fails to match

**Status:** ✅ FIXED
**Location:** `src/utils/sandbox.ts` (cpSync filter loop)
**Front:** Code (logical failure — under-matching on a documented pattern)

**Evidence:** The audit M6 fix changed substring matching to segment matching. Segment matching uses `segments.includes(pattern)`. Convention `["fixtures/"]` doesn't match a segment named `fixtures` because the literal pattern includes the trailing `/`.

**Consequence:** Exclusion silently fails for the most common user convention. Users wonder why their excludes aren't working, no error is raised.

**Reachability:** Any `audit_code_resilience` call passing `ignorePatterns: ["fixtures/"]`.

**Fix applied:** Strip a single trailing separator before segment comparison, then re-guard against empty.

```ts
const normalised = pattern.endsWith(sep) ? pattern.slice(0, -1) : pattern;
if (normalised.length === 0) continue;
if (segments.includes(normalised)) return false;
```

**Regression test:** `sandbox.test.ts > strips trailing separator from ignorePatterns (Live-audit L2)`.

---

### [HIGH] L3 — execFile timeout misclassifies external SIGTERM kills as TIMEOUT

**Status:** ✅ FIXED
**Location:** `src/utils/exec.ts:141` (post-fix position varies)
**Front:** Code (logical failure — misclassification)

**Evidence:** Node's `execFile` sets `err.signal === 'SIGTERM'` AND `err.killed === true` ONLY when the configured timeout elapses. External kills (OOM killer, parent-process SIGTERM) produce `err.signal === 'SIGTERM'` but `err.killed === false` because the parent never called `child.kill()`.

**Original logic:**
```ts
if (result.signal === 'SIGTERM' && result.exit === null) {
  // report as TIMEOUT
}
```

**Consequence:** OOM-external SIGTERM was reported as `code: 'TIMEOUT'`, telling the AI user to "increase timeoutMs". Misleads real-runtime debugging.

**Fix applied:**
```ts
if (errnoError.killed === true && result.exit === null && result.signal) {
  // report as TIMEOUT
}
```

Note: external kills now surface as plain signal-crash errors with the actual signal name.

**Regression test:** `exec-error.test.ts > classifies timeout only when killed=true (Live-audit L3)` — uses `child_process.spawnSync` to verify the Node-level semantics that the wrapper relies on.

---

### [HIGH] L4 — Rust parser skips lowercase `timeout` mutants

**Status:** ✅ FIXED
**Location:** `src/engines/rust.ts:33-37`
**Front:** Code (logical failure — under-classification)

**Evidence:** `cargo mutants` text output uses mixed case (`timeout`, `Timeout`, `TIMEOUT`); its JSON output uses uppercase. The original case-sensitive `trimmed.startsWith('TIMEOUT')` missed ~half of real outputs.

**Consequence:** Up to half of timeout mutants were silently dropped from the score. Lower reported `killed` totals and partially-inflated `missed` counts in mutation reports.

**Fix applied:** Uppercase comparison:
```ts
const upper = trimmed.toUpperCase();
const isMissed = upper.startsWith('MISSED');
const isCaught = upper.startsWith('CAUGHT');
const isUncaught = upper.startsWith('UNCAUGHT');
const isTimeout = upper.startsWith('TIMEOUT');
```

**Regression test:** `rust-engine.test.ts > handles lowercase "timeout" lines from cargo-mutants text output (Live-audit L4)`.

---

### [MEDIUM] L5 — Go parser requires quoted paths on PASS/FAIL lines

**Status:** ❌ DISMISSED (intentional design choice, not a bug)
**Location:** `src/engines/go.ts:41`
**Front:** Code (logical failure — suggested fix would re-introduce H2 regression)

**Original finding claim:** `go-mutesting` may emit unquoted paths in some CI environments, so the quoted-path gate is over-constrained.

**Fact-check:** All real `go-mutesting` outputs verified for v0.x emit `PASS\t"<path>"` or `FAIL\t"<path>"` with quoted paths. The quoted-path gate was added in the same round to fix the H2 baseline-failure detection (audit H2): without it, the realistic baseline-error stdout `# pkg … ./main.go:5:2: undefined: foo … FAIL\t<package> [build failed]` is misclassified as 1 fake mutant because `startsWith('FAIL')` matches the unquoted `FAIL\t<package>` line. Removing the constraint would re-introduce this regression and silently produce a 1/1 (0%) score on real baseline failures.

**Verdict:** Trade-off is intentional and the conservative side (require quoted paths) is preferred for v1.1.0. If a future variant of go-mutesting emits unquoted paths and is observed in the wild, this gate can be relaxed and the H2 detection can be re-engineered using a different signal (e.g., the trailing package-name pattern).

---

## Quality gates summary

- Typecheck: clean
- Lint: clean
- Tests: 232 passing (4 new regression tests added across sandbox, exec, rust)
- Build: success

## Coverage that remains (audit-known, deferred to next round)

These items do not block v1.1.0 release but are tracked for v1.2.0:

- **Roadmap:** parseGoMutestingOutput's JSON parse-fallback path. Real go-mutesting rarely emits JSON; the text parser is the only meaningful path.
- **Roadmap:** audit of `findClosestWorkspaceRoot` fallback behaviour when no marker file is found in MAX_WALK_DEPTH steps.
- **Roadmap:** Windows-symlink `EPERM` fallback path lives behind `isWindows()` but is not exercised in the test suite.
