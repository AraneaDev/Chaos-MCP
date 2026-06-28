# Phase 4 — New Capability Tools

**Date:** 2026-06-28
**Status:** Approved design (pending written-spec sign-off)
**Branch:** `feat/phase4-capability-tools`
**Roadmap:** `2026-06-27-chaos-mcp-agent-improvements-roadmap.md`

## Goal

Two independent new capabilities for the agent loop:

- **#6 `estimate_audit`** — a cheap pre-flight that answers "how big / how long is auditing this
  file?" *without* running the full mutation test cycle, so an agent can decide whether to audit
  now, scope down, or skip.
- **#7 gate mode** — a `minScore` argument on `audit` and `triage` that returns an explicit
  `passed: true/false`, so an agent or CI wrapper can gate on resilience in one call.

Both are additive. Existing `audit_code_resilience` / `triage_test_coverage` behavior with no
`minScore` is byte-identical. Builds on Phase 1–3 (payload builder, triage payload, suppression
score adjustment), all merged to `main`.

## Approved decisions

1. **Estimate strategy: native + heuristic, labeled.** Use each engine's native count where it
   exists (Rust `cargo mutants --list` = exact); for TS/Python/Go fall back to a lightweight
   source-parse heuristic. Every result carries `fidelity: 'exact' | 'approx'` + a `basis` string.
2. **Time estimate: count default, `withTiming` opt-in.** Default returns mutant count only (no
   test cycle — the cheapest possible). `withTiming: true` runs the suite once for a baseline and
   estimates wall-clock.
3. **Gate scope: both audit + triage.** `minScore` on audit → per-file `gate`; on triage →
   per-row `passed` + a top-level gate summary with `failingFiles`.
4. **Gate result: data field only.** A failing gate is a normal success result carrying
   `passed: false`; never set MCP `isError` (reserved for real tool failures).

## Component 1 — `estimate_audit`

### Tool shape

New third MCP tool registered in `index.ts`. Input schema:

```jsonc
{
  "filePath":   { "type": "string" },               // required; workspace-bounded (C2)
  "withTiming": { "type": "boolean" }               // default false
}
```

Whole-file estimate. Line-scoping (`lineScope`/`diffBase`) is NOT applied to the count in this
phase — documented; deferrable. No `mutatorDenylist` input on estimate (whole-file ballpark).

### Output (`EstimateResult`)

```jsonc
{
  "target":      "src/foo.ts",
  "language":    "typescript",
  "mutants":     142,
  "fidelity":    "exact" | "approx",
  "basis":       "cargo-mutants --list" | "source heuristic: 90 constructs",
  "baselineMs":  1234,        // only when withTiming
  "estimatedMs": 56000,       // only when withTiming
  "concurrency": 7,           // only when withTiming
  "note":        "..."
}
```

Returned as both a text block and `structuredContent` (additive pattern, matching audit/triage).

### Language dispatch (`src/estimate.ts`)

```ts
export type Fidelity = 'exact' | 'approx';
export interface EstimateResult {
  target: string;
  language: SupportedProjectType;
  mutants: number;
  fidelity: Fidelity;
  basis: string;
  baselineMs?: number;
  estimatedMs?: number;
  concurrency?: number;
  note: string;
}
export interface EstimateOptions {
  absFile: string;        // absolute, boundary-validated
  relFile: string;        // workspace-relative (target field)
  projectType: SupportedProjectType;
  env: EnvironmentInfo;
  config: ChaosConfig;
  withTiming: boolean;
}
export async function estimateAudit(opts: EstimateOptions): Promise<EstimateResult>;
```

- **Rust (native, exact):** run `cargo mutants --list --file <relFile>` (text or `--json`) via the
  existing `invokeMutationTool`/exec utilities, **in a sandbox** (consistent isolation posture —
  engine tools never run on the real tree). Count listed mutants → `fidelity: 'exact'`,
  `basis: 'cargo-mutants --list'`. On `ENOENT` (cargo-mutants not installed) → fall back to the
  heuristic, `basis: 'source heuristic (cargo-mutants not installed)'`, `fidelity: 'approx'`.
- **TS / Python / Go (heuristic, approx):** read the real file (boundary-checked, **no sandbox**),
  run `estimateHeuristic` → `fidelity: 'approx'`, `basis: 'source heuristic: N constructs'`.

Sandbox is provisioned only when (native engine path) OR (`withTiming`). The common TS count-only
pre-flight reads one file and never copies the workspace — cheap by design.

### Heuristic counter (`src/estimate-heuristic.ts`)

```ts
export interface HeuristicResult { mutants: number; constructs: number; }
export function estimateHeuristic(source: string, projectType: SupportedProjectType): HeuristicResult;
```

Lightweight, best-effort, principled (not exact — the `fidelity: 'approx'` label is the contract):

1. Strip line + block comments and string/template literals (so operators inside them aren't
   counted). Per-language comment/string syntax (`//`,`/* */`,`#`, quotes, backticks, `'''`).
2. Count mutable constructs by category, reusing the canonical mutator vocabulary from
   `enrich.ts`: arithmetic operators (`+ - * / %`), comparison (`< > <= >= == != === !==`),
   logical (`&& || !`), conditional keywords (`if`, `while`, ternary `?`), `return`,
   boolean/numeric/string literals, increment/decrement, assignment operators. Each category
   contributes a small fixed weight (≈ the number of mutations the engine typically applies to
   that construct).
3. `constructs` = raw match count; `mutants` = weighted sum. Document the weights inline.

The goal is order-of-magnitude accuracy ("is this ~20 or ~2000 mutants"), the agent's real
pre-flight question. Weights need not be perfect; they are tested for monotonicity and rough
calibration, not exact engine parity.

### `withTiming`

When `true`: provision a sandbox, run the project's test suite **once** (reuse the engine's
existing baseline/test invocation path, or a minimal "run tests, measure ms" helper), capture
`baselineMs`. Then `concurrency` = resolved worker count (config/`cpus-1`, same resolution audit
uses), and `estimatedMs = Math.ceil(mutants * baselineMs / concurrency)`. The estimate is a
rough upper-ish bound (ignores per-mutant short-circuits); the `note` says so.

## Component 2 — Gate mode (`minScore`)

### `src/gate.ts`

```ts
export interface GateResult { minScore: number; passed: boolean; }
/** Parse a "NN.NN%" score and compare. A result with no gradable score (e.g. 0 mutants,
 *  score "n/a") passes with a note handled by the caller. */
export function evaluateGate(scoreText: string, minScore: number): GateResult;
```

`evaluateGate` parses the leading number from `mutationScore` (e.g. `"87.50%"` → `87.5`). If the
score is unparseable/empty → treat as passing (caller adds a "no gradable score" note), so a
clean file with zero mutants never spuriously fails.

### audit (`src/handler.ts`)

When `minScore` is present, add `gate: { minScore, passed }` to the result payload (via
`ResultPayload.gate?`). Uses the already-computed, suppression-adjusted `mutationScore`. Never
affects `isError`. The verify-mode branch ignores `minScore` (verify reports a delta, not a score).

### triage (`src/triage.ts` / `src/triage-handler.ts`)

When `minScore` is present:
- Each ranked `TriageRow` gains `passed?: boolean` (`evaluateGate(row.mutationScore, minScore)`).
- `TriagePayload` gains `gate?: { minScore, passed, failingFiles }` where `passed` = every ranked
  row passed and `failingFiles` = the files that didn't (sorted). Errored files remain in
  `errors[]` and do NOT flip the gate (documented — an error is not a low score); the `note`
  mentions errored-file count when > 0 so the caller isn't misled.

## Component 3 — Schema / validation / registration

- **`tool-schema.ts`:** add `ESTIMATE_TOOL_DEFINITION` (`filePath`, `withTiming`, + `outputSchema`
  mirroring `EstimateResult`). Add `minScore` (number, min 0, max 100) to the audit and triage
  input schemas; add `gate` to both output schemas (audit: `{minScore, passed}`; triage:
  `{minScore, passed, failingFiles[]}` + per-row `passed`).
- **`index.ts`:** register `estimate_audit` as the third tool and dispatch by name to the estimate
  handler. Keep import side-effect-free (the `isDirectRun` guard).
- **Validators (`handler.ts` / `triage-handler.ts`):** `validateMinScoreArg` (number 0–100;
  shared between audit and triage). Estimate handler validates `filePath` (non-empty, boundary)
  and `withTiming` (boolean).
- **No new config keys** — `minScore` is inherently per-invocation (CI threshold). Out of scope.

## Error handling

- Estimate: `filePath` outside the workspace → boundary error (C2, reuse `isRealPathInside`).
  Unreadable source → clear tool error. Rust native `ENOENT` → heuristic fallback (non-fatal,
  noted). `withTiming` suite-run failure → return the count with `baselineMs` omitted + a note
  (timing is best-effort; the count is still useful). Sandbox always cleaned in `finally`.
- Gate: invalid `minScore` → validator rejects. Unparseable score → `passed: true` + note.
- All file/subprocess failures degrade gracefully; no new crash surface for `audit`/`triage`.

## Testing

Unit:
- `estimateHeuristic`: per-language construct counting; comment/string stripping (operators in
  comments/strings not counted); monotonicity (more constructs → more mutants); empty file → 0.
- Rust native: parse `cargo mutants --list` output → count; `ENOENT` → heuristic fallback with the
  documented basis/fidelity.
- `withTiming` math: injected `baselineMs` + `mutants` + `concurrency` → `estimatedMs` formula;
  suite-run failure path omits timing.
- `estimateAudit` dispatch: Rust→native, TS/Py/Go→heuristic, correct `fidelity`/`basis`.
- `evaluateGate`: pass/fail boundaries (equal = pass), unparseable/empty → pass, clamping.
- audit gate: payload `gate` present only when `minScore` set; uses suppression-adjusted score;
  no `isError` on fail; verify-mode ignores `minScore`.
- triage gate: per-row `passed`, top-level `passed` = all ranked pass, `failingFiles` correct,
  errored files excluded from the gate + noted.
- Validators (`minScore` 0–100, `withTiming`), schema (estimate def + gate outputs), tool
  registration/dispatch (estimate_audit reachable).

Gate: `npm run check` green on Node 22/24; existing audit/triage tests unaffected (additive);
self-mutation smoke best-effort.

## Out of scope (Phase 4)

- Line-scoped / diff-scoped estimates (whole-file only this phase).
- `defaultMinScore` config (gate is per-call).
- Exact mutant counts for StrykerJS / mutmut / go-mutesting (no clean count-only CLI — heuristic
  by design, labeled `approx`).
- Phase 5: progress notifications + cancellation, MCP resources/prompts.
