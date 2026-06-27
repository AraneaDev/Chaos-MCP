# Phase 1 — Output & Enrichment Layer

**Date:** 2026-06-27
**Status:** Approved design (pending written-spec sign-off)
**Branch:** `feat/phase1-output-enrichment`
**Roadmap:** `2026-06-27-chaos-mcp-agent-improvements-roadmap.md`

## Goal

Make the `audit_code_resilience` output richer, ranked, bounded, and machine-consumable —
the foundation every later phase renders through. Five features: structured output (#4),
enrich-by-default + cap (#5), `suggestedTestFile` (#9), Go enrichment (#10, Go only),
`severityFloor` (#12).

Scope note: all changes here apply to `audit_code_resilience` only. `triage_test_coverage`
gains `severityFloor`/inline-survivors in Phase 2.

## Approved decisions

1. **Enrich default:** on by default; severity-ranked; capped at `maxSurvivors` (default 10),
   overridable per-call and via config. `summary.worstSeverity` included.
2. **structuredContent:** additive — always return `structuredContent` (object) **plus** a
   text content block. `json` mode → text block is serialized JSON (compat fallback);
   `text` mode → text block is the human summary.
3. **suggestedTestFile:** project-aware discovery (real-tree existence check) with a
   conventional fallback candidate.
4. **#10:** Go enrichment via the go-mutesting JSON reporter + a mutator-name→category map.
   Python stays `unknown` (revisited in Phase 3). Graceful fallback if the JSON reporter is
   unavailable.
5. **Arg name:** `maxSurvivors` (not `topN`).

## Components

### 1. Result payload refactor (`src/format.ts`)

`formatResultAsJson` currently returns a `JSON.stringify(...)` string (`format.ts:185`).
Split data construction from serialization:

```
buildResultPayload(result, opts) -> ResultPayload   // pure object
formatResultAsJson(result, opts) = JSON.stringify(buildResultPayload(...))
formatResultAsText(result, opts) = human-readable rendering of the same data
```

`ResultPayload` (the `structuredContent` and `outputSchema` contract):

```jsonc
{
  "target": "src/utils/math.ts",
  "mutationScore": "87.50%",
  "summary": {
    "total": 40, "killed": 35, "survived": 5,
    "worstSeverity": "high"          // present only when enriched and survivors exist
  },
  "survivors": [
    { "line": 42,
      "mutators": { "ConditionalExpression": 2 },
      "changes": ["a > b -> a >= b"],   // capped, optional
      "severity": "high",               // enrichment fields, present when enriched
      "why": "...", "hint": "...",
      "context": ["41: ...", "42: ...", "43: ..."] }
  ],
  "noCoverage": [ /* same shape */ ],
  "survivorsTruncated": 0,            // count hidden by maxSurvivors (survivors list)
  "noCoverageTruncated": 0,
  "survivorsFiltered": 0,            // count hidden by severityFloor (survivors list)
  "noCoverageFiltered": 0,
  "suggestedTestFile": { "path": "src/utils/math.test.ts", "exists": true },  // when survivors
  "ignoredOptions": ["concurrency"], // StrykerJS-only opts ignored for this engine
  "scopeNote": "...",                // when present
  "enrichNote": "...",               // when some mutants unclassifiable
  "note": "..."                      // existing human guidance string
}
```

Backwards-compat note: the existing string fields (`note`, `scopeNote`, `enrichNote`) are
preserved. New fields are additive.

### 2. Enrichment default + `maxSurvivors` + `severityFloor` (`src/format.ts`, `src/handler.ts`)

- **Default flip:** `buildEnrichContext` (`handler.ts:380`) gate changes from `args.enrich === true`
  to `args.enrich !== false`. Enrich is built unless the caller explicitly passes `enrich:false`.
- **Pipeline order (per list, survivors and noCoverage independently):**
  1. group by line (existing `compactSurvivors`)
  2. enrich + sort severity-desc, line-asc (existing `enrichGroups`)
  3. compute `worstSeverity` over the **full** enriched set
  4. apply `severityFloor` filter → increment `*Filtered` by the drop count
  5. slice to `maxSurvivors` → set `*Truncated` to the remainder
- **`maxSurvivors`:** integer ≥ 1. Precedence: arg > `config.defaultMaxSurvivors` > default `10`.
- **`severityFloor`:** `'high' | 'medium' | 'low'`. Drops groups with
  `SEVERITY_RANK[severity] < SEVERITY_RANK[floor]`. `unknown` (rank 0) is always dropped by any
  floor; the drop is counted in `*Filtered` so suppression is never silent.
- **Degradation:** if `enrich:false`, `severityFloor` is ignored and an `enrichNote` explains
  that severity filtering requires enrichment. No severity sort in that case; `maxSurvivors`
  still applies in line order.

### 3. `suggestedTestFile` (`src/test-file.ts`, new)

```
suggestTestFile(targetFile, projectType, workspaceRoot) -> { path, exists } | undefined
```

Per-language conventional candidates, checked against the real tree in priority order; first
existing match wins, else the top candidate is returned with `exists:false`:

- **TS/JS:** co-located `<base>.test.<ext>`, `<base>.spec.<ext>`; `__tests__/<base>.test.<ext>`;
  `test/` or `tests/` mirror.
- **Python:** co-located `test_<base>.py`; `tests/test_<base>.py`.
- **Go:** co-located `<base>_test.go` (Go convention is always co-located).
- **Rust:** in-file `#[cfg(test)]` is the convention → suggest the source file itself; fallback
  `tests/<base>.rs`.

Emitted only when there are survivors/noCoverage. Any filesystem error degrades to omitting the
field (never fails the audit). Called from the handler with the already workspace-validated
`resolvedFile` and `env.workspaceRoot`.

### 4. Go enrichment (`src/engines/go.ts`, `src/enrich.ts`)

- **Engine:** enable go-mutesting's JSON reporter so each mutant carries a `mutator` name
  (`GoMutestingJsonOutput.mutants[].mutator` already modelled, `go.ts:24`). Populate
  `Vulnerability.mutator` with the real name (and `original`/`mutated` if exposed) instead of
  the generic `'Go Mutation Operator'`.
- **Spike (implementation risk):** the JSON reporter is enabled via a config/flag that varies by
  go-mutesting version. First implementation task is a short spike to confirm the invocation. If
  unavailable, the engine keeps text-mode output and Go severities stay `unknown` — graceful, no
  crash, no behavior regression.
- **Mapping (`canonicalizeMutator`, `enrich.ts:140`):** add a `projectType === 'go'` branch that
  maps go-mutesting mutator names to canonical categories, e.g. `branch/*` → `ConditionalExpression`,
  `arithmetic/*` → `ArithmeticOperator`, `expression/remove` / `statement/remove` → `BlockStatement`,
  `numbers/*` → `ArithmeticOperator` (exact name set finalized during the spike). Unmapped names
  fall through to `unknown`.

### 5. Schema, config, validation

- **`src/tool-schema.ts`:**
  - add `maxSurvivors` (integer ≥ 1) and `severityFloor` (enum `high|medium|low`)
  - rewrite `enrich` description to state it now defaults to **true** (pass `false` to disable)
  - add a static `outputSchema` mirroring `ResultPayload`
- **`src/utils/config-loader.ts`:** add `defaultMaxSurvivors` (and optional `defaultSeverityFloor`)
  with validation consistent with existing config fields.
- **`src/handler.ts`:** add `validateMaxSurvivors` and `validateSeverityFloor` to the ordered
  `TOOL_ARG_VALIDATORS` list (`handler.ts:239`), preserving stable first-failure reporting.

## Error handling

All changes are additive and degrade gracefully:
- `suggestTestFile` read failure → field omitted.
- Go JSON reporter unavailable → text-mode fallback, Go severities `unknown`.
- `severityFloor` without enrichment → ignored with an `enrichNote`.
- Invalid `maxSurvivors` / `severityFloor` → rejected by validators before the sandbox copy
  (consistent with the existing "validate before expensive work" rule, `handler.ts:659`).

## Testing

New/updated unit tests:
- `buildResultPayload` shape (all fields, presence conditions).
- enrich-by-default behavior (on unless `enrich:false`).
- `maxSurvivors` slicing + `*Truncated` counts; default and override precedence.
- `severityFloor` filtering + `*Filtered` counts; `unknown` always dropped by any floor; ignored
  when enrich is off.
- `suggestTestFile`: candidate generation + existence resolution per language.
- Go mutator-name → category mapping (table-driven).
- `structuredContent` present in both `json` and `text` modes; text block compat shape.

Migration cost (expected): enrich-by-default + the string→object payload refactor change output
for existing callers, so a number of `format.test.ts` / `handler.test.ts` expectations are
updated as part of this work.

Gate: `npm run check` (build → lint → format:check → test) must pass on Node 22/24, and the
self-mutation smoke (`scripts/audit-self.js`, `scripts/meta-test.js`) must stay green.

## Out of scope (Phase 1)

- `triage` changes (Phase 2).
- Python enrichment (Phase 3).
- Server-side state, `runId`, ignore lists (Phase 3).
- `estimate_audit`, gate mode, progress/cancellation, resources/prompts (Phases 4–5).
