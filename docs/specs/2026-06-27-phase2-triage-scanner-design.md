# Phase 2 — Triage as a First-Class Scanner

**Date:** 2026-06-27
**Status:** Approved design (pending written-spec sign-off)
**Branch:** `feat/phase2-triage-scanner`
**Roadmap:** `2026-06-27-chaos-mcp-agent-improvements-roadmap.md`

## Goal

Make `triage_test_coverage` the one-call scanner an agent reaches for: "triage what
this PR changed," with optional per-file survivor detail, run in bounded parallel, and
returned as machine-consumable structured content. Three roadmap items (#1 `diffBase`,
#3 inline survivors, #11 bounded-parallel) plus a small consistency add-on (triage
`structuredContent`, approved).

Scope note: all changes here apply to `triage_test_coverage`. `audit_code_resilience`
is unchanged. Builds directly on Phase 1 (`buildResultPayload`, enrichment, output
schema) which is merged to `main`.

## Approved decisions

1. **diffBase × paths:** `diffBase` makes `paths` optional. `diffBase` alone = all changed
   supported source files repo-wide; `diffBase` + `paths` = changed files that also fall
   under those paths; `paths` alone = today's behavior. Handler requires **paths OR diffBase**.
2. **Per-file scope under diffBase:** line-scope each TypeScript file to its changed hunks
   (reusing `computeChangedRanges` → `auditFile`'s `lineRanges`); Go/Python/Rust run
   whole-file with a per-row note. Untracked files → whole file.
3. **Parallelism:** configurable file-level worker pool, default `min(4, cpus-1)`, arg
   `fileConcurrency` + config `defaultFileConcurrency`. When pool size > 1, cap each
   StrykerJS run's worker count to `max(1, floor((cpus-1) / poolSize))` to avoid CPU
   oversubscription; serial engines are unaffected.
4. **Inline survivors:** new `survivorsPerFile` (int ≥ 0, default 0 = scores-only). When
   > 0, each ranked row carries its top-N enriched, severity-ranked survivors.
5. **Triage structuredContent:** triage also returns `structuredContent` + an `outputSchema`,
   text block retained (additive, matching Phase 1).

## Components

### 1. Changed-file discovery (`src/utils/git-diff.ts`)

New function alongside `computeChangedRanges`:

```
listChangedFiles(workspaceRoot, diffBase) -> ChangedFilesResult
```

```ts
type ChangedFilesResult =
  | { kind: 'not-a-repo' }
  | { kind: 'bad-ref'; ref: string }
  | { kind: 'files'; files: string[] };   // workspace-relative, tracked-changed ∪ untracked
```

- Confirm work tree (`git rev-parse --is-inside-work-tree`) → else `not-a-repo`.
- `staged`: `git diff --cached --name-only`. Otherwise resolve `merge-base diffBase HEAD`
  (fail → `bad-ref`) and `git diff --name-only <base>`.
- Add untracked: `git ls-files --others --exclude-standard`.
- Union, dedupe. The caller filters to supported source files and intersects with `paths`.
  Same base-resolution semantics as `computeChangedRanges`, so per-file ranges align.

### 2. File selection in the triage handler (`src/triage-handler.ts`, `src/triage.ts`)

- **paths-only (no diffBase):** unchanged — `discoverFiles(paths, root, maxFiles)`.
- **diffBase given:** call `listChangedFiles`; on `not-a-repo`/`bad-ref` return a clear
  tool error. Filter the file list through `isSupportedSourceFile`. If `paths` also given,
  keep only files whose path is under one of the (resolved, workspace-relative) `paths`
  prefixes. Sort, dedupe, apply `maxFiles` (report skipped count, as today). A diff that
  selects zero files → empty leaderboard with a note ("no changed supported source files
  vs <base>").
- Add `discoverChangedFiles(listResult, paths, root, maxFiles)` to `triage.ts` for the
  filtering/intersection/cap logic (unit-testable, pure given the file list).

### 3. Per-file line scope (`src/triage-handler.ts`)

When `diffBase` is set and the file's engine `supportsLineScope` (TypeScript), call
`computeChangedRanges(file, workspaceRoot, diffBase)` and pass `lineRanges` into the
existing `auditFile`. For `untracked` → no ranges (whole file). For non-line-scope engines
→ whole file + a `scopeNote` on the row. Each diff-scoped TS row carries a `scopeNote`
("scored on changed lines") so a low score on a 3-line change is not misread as whole-file.

### 4. Bounded-parallel execution (`src/utils/pool.ts`, `src/triage-handler.ts`)

New util:

```ts
// Runs `fn` over items with at most `concurrency` in flight; results in INPUT order.
// A rejected fn does not abort the pool — see error handling.
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]>;
```

The handler replaces its serial `for` loop with `mapPool`. Each task provisions its own
sandbox (as today), audits, and cleans up in a `finally`. Concurrency resolution:
`fileConcurrency` arg (int 1–64) > `cfg.defaultFileConcurrency` > `min(4, cpus-1)` (min 1).

**Stryker worker division:** compute `perFileStrykerConcurrency = poolSize > 1 ? max(1,
floor((cpus-1) / poolSize)) : undefined`. When set, pass it as the StrykerJS `concurrency`
RunOption for TypeScript files only (other engines ignore it). `undefined` lets a
single-file (or poolSize 1) run use Stryker's own auto-detect, preserving today's behavior.

### 5. Inline survivors (`src/triage.ts`, `src/triage-handler.ts`)

`survivorsPerFile` (int ≥ 0, default 0). When > 0, after a file's `MutationResult` is in
hand, build a per-file payload via Phase 1's `buildResultPayload(result, { enrich,
maxSurvivors: survivorsPerFile })` and lift `survivors`, `noCoverage`, and
`summary.worstSeverity` onto the `TriageRow`. `enrich` context reads the file's source for
context snippets (same as audit; read failure → no snippets, never fatal). When 0, rows are
unchanged (scores only). `rankResults` ordering is unchanged (score asc, survived desc,
file asc); `worstSeverity` is an informational field, not a sort key.

`TriageRow` gains optional fields:

```ts
interface TriageRow {
  file: string; mutationScore: string;
  total: number; killed: number; survived: number; noCoverage: number;
  scopeNote?: string;                 // diff-scoping note (section 3)
  worstSeverity?: Severity;           // when survivorsPerFile > 0
  survivors?: LineGroup[];            // top-N enriched, when survivorsPerFile > 0
  noCoverageGroups?: LineGroup[];     // top-N enriched, when survivorsPerFile > 0
}
```

### 6. Triage structuredContent (`src/triage.ts`)

Split `formatTriageAsJson` into `buildTriagePayload(rows, errors, discovered, skipped,
note) -> TriagePayload` (object) + `JSON.stringify`. The handler returns
`{ content: [{ type:'text', text }], structuredContent: payload }` (text = the serialized
payload in json mode, the human table in text mode), matching the audit additive pattern.

```jsonc
// TriagePayload (= outputSchema contract)
{
  "mode": "triage",
  "summary": { "filesDiscovered": N, "filesAudited": N, "filesSkipped": N, "filesErrored": N },
  "ranking": [ /* TriageRow objects, weakest-first */ ],
  "errors": [ { "file": "...", "error": "..." } ],
  "scopeNote": "...",   // present in diffBase mode (base used, scoping summary)
  "note": "..."
}
```

### 7. Schema / config / validation

- **`TRIAGE_TOOL_DEFINITION` (`src/tool-schema.ts`):** add `diffBase` (string),
  `survivorsPerFile` (integer, minimum 0), `fileConcurrency` (integer, minimum 1,
  maximum 64); add `outputSchema` mirroring `TriagePayload`. Remove `paths` from `required`
  (now paths-OR-diffBase, enforced in handler). Keep `paths`/`maxFiles`/`timeoutMs`/
  `mutatorDenylist`/`outputFormat` as-is.
- **`config-loader.ts`:** add `defaultFileConcurrency` (integer 1–64) to `KNOWN_KEYS`,
  `ChaosConfig`, `buildConfig` (validated), `validateConfig` (warning on invalid).
- **Handler validation:** require `paths` OR `diffBase` (error naming both if neither);
  validate `diffBase` (non-empty string, not `-`-prefixed — reuse audit's rule shape),
  `survivorsPerFile` (integer ≥ 0), `fileConcurrency` (integer 1–64). Surface
  `not-a-repo`/`bad-ref` from `listChangedFiles` as tool errors.

## Error handling

- Per-file audit failures are collected into `errors[]`, never fatal (as today); with
  `mapPool`, a rejected task maps to an error entry, not a pool abort.
- `listChangedFiles` git failures classified (`not-a-repo`/`bad-ref`) → clear tool error.
- Empty selection (diff matched nothing supported) → empty ranking + explanatory note,
  not an error.
- Enrichment/source-read failures degrade to no survivor detail for that row.
- Sandboxes always cleaned in `finally`, per task.

## Testing

Unit:
- `listChangedFiles`: files / untracked union / bad-ref / not-a-repo / staged path
  (mock `runShell`).
- `discoverChangedFiles`: supported-file filter, paths intersection, dedupe, maxFiles cap.
- `mapPool`: never exceeds `concurrency` in flight (instrument a counter), results in input
  order, one rejecting task does not sink the others.
- Stryker worker-division math: `poolSize=1 → undefined`; `poolSize>1 → floor((cpus-1)/poolSize)`
  clamped to ≥1 (inject a cpu count so the test is deterministic).
- diffBase selection + TS line-scoping vs whole-file others (row `scopeNote`).
- `survivorsPerFile`: 0 = no survivor fields; >0 = top-N enriched + `worstSeverity`, capped.
- `buildTriagePayload` shape; `structuredContent` present in json and text modes.
- Validators: paths-or-diffBase, diffBase, survivorsPerFile, fileConcurrency; config
  `defaultFileConcurrency`.

Gate: `npm run check` green on Node 22/24; existing triage tests updated for the payload
shape; self-mutation smoke best-effort.

## Out of scope (Phase 2)

- `audit_code_resilience` changes (Phase 1, done).
- runId/baseline cache, equivalent-mutant ignore list (Phase 3).
- `estimate_audit`, gate mode, progress/cancellation, resources/prompts (Phases 4–5).
- Parallelizing the engine's internal work beyond the file-level pool + Stryker worker cap.
