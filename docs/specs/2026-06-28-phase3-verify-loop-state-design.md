# Phase 3 — The Verify Loop & State

**Date:** 2026-06-28
**Status:** Approved design (pending written-spec sign-off)
**Branch:** `feat/phase3-verify-loop-state`
**Roadmap:** `2026-06-27-chaos-mcp-agent-improvements-roadmap.md`

## Goal

Close the agent's natural loop — *triage → drill into the weakest file → write tests →
re-verify → repeat* — by giving the server memory. Two roadmap items:

- **#2** `runId`: every `audit` mints an id and caches its survivor baseline server-side, so
  verify mode needs only the id instead of the whole baseline object shuttled back by hand.
- **#8** Equivalent-mutant suppression: a persisted ignore list keyed by `file+line+mutator`
  so unkillable (equivalent) mutants stop depressing the score and cluttering output.

This is the first phase to introduce persistence. It builds directly on Phase 1
(`buildResultPayload`, structured output) and Phase 2 (triage payload), both merged to `main`.
`audit_code_resilience` and `triage_test_coverage` keep their existing contracts additively.

## Approved decisions

1. **State splits by lifecycle.** The run cache is *transactional* (it only needs to survive an
   agent's verify round-trip) → `os.tmpdir()`. The suppression list is *durable knowledge*
   ("this mutant is equivalent, never flag it again") → a repo file the user may gitignore or
   commit.
2. **`runId` is a new dedicated arg.** `baseline` stays an object for inline use; `runId` is a
   string. They (and `diffBase`/`lineScope`) are mutually exclusive — all set the run's scope.
3. **Suppression write path = `suppress` / `unsuppress` args on `audit`.** Reads always
   auto-filter and report a `suppressedCount`. `unsuppress` is included so a wrong entry can be
   removed (a permanent-only ignore list is a footgun).
4. **Python enrichment (#10 remainder) is deferred** — independent of the state shift; ships on
   its own later.

## State stores

| Store | Location | Lifecycle | Owner |
|---|---|---|---|
| Run cache (#2) | `os.tmpdir()/chaos-mcp-runs/<runId>.json` | Ephemeral — TTL + count-cap eviction, lazily pruned on write | `src/utils/run-cache.ts` |
| Suppressions (#8) | `<workspaceRoot>/.chaos-mcp/suppressions.json` | Durable — user gitignores or commits | `src/utils/suppression.ts` |

Both writes stay inside their boundary: the run cache lives in `os.tmpdir()`; suppressions are
written under `workspaceRoot`, consistent with the C2 workspace-boundary invariant (never write
outside `process.cwd()`/`workspaceRoot`). No engine code changes — both features live in the
handler/util layer above `engine.run`.

## Component 1 — Run cache (`src/utils/run-cache.ts`), item #2

New util, no engine coupling:

```ts
export interface RunCacheEntry {
  runId: string;
  file: string;            // workspace-relative target
  projectType: SupportedProjectType;
  createdAt: number;       // epoch ms
  survivors: { line: number; mutators: Record<string, number> }[];
  noCoverage: { line: number; mutators: Record<string, number> }[];
}

export function saveRun(entry: Omit<RunCacheEntry, 'runId' | 'createdAt'>): string; // returns runId
export function loadRun(runId: string): RunCacheEntry | undefined; // undefined = missing/expired/corrupt
```

- **runId generation:** `crypto.randomUUID().slice(0, 8)` (the server runs on normal Node — no
  workflow-script restriction on `crypto`/`Date.now`). Collisions are vanishingly unlikely; on
  the off chance a file exists, regenerate.
- **Write:** serialize to `os.tmpdir()/chaos-mcp-runs/<runId>.json` via temp-file + atomic
  `rename`. Before writing, run eviction (below).
- **Read:** parse the file; a missing file, JSON parse error, or `createdAt` older than the TTL
  → `undefined` (treated as a cache miss, never a crash).
- **Eviction:** on each `saveRun`, delete entries older than `runCacheTtlMs` (default
  `24h`) and, if more than `runCacheMax` (default `200`) remain, delete oldest-first by
  `createdAt` until at the cap. Eviction failures are swallowed (best-effort housekeeping).

### Write integration (handler / triage-handler)

- After a successful non-verify `audit`, call `saveRun({ file, projectType, survivors,
  noCoverage })` using the same compacted `{line, mutators}` groups the payload already exposes,
  and surface `runId` in the structured payload and the text block.
- Triage: each audited row mints its own `runId` (same per-file baseline), carried on the
  `TriageRow` so an agent can verify any single file from a triage scan without re-auditing.
- Verify-mode runs do **not** mint a new id (they consume one); they may, however, be filtered
  by suppressions (Component 2).

### Read integration (verify via `runId`)

- New `runId` string arg on `audit`. In `computeScope`, when `runId` is set: `loadRun(runId)`.
  - Miss → tool error: `"run <id> not found or expired; re-run audit to get a fresh runId."`
  - `entry.file` ≠ the requested target (workspace-relative) → tool error: `"runId <id> was for
    <file>, not <requested>; verify against the file it audited."`
  - Hit → build `BaselineInput` from `entry.survivors`/`entry.noCoverage`, then reuse the
    **existing** `parseBaseline` → `baselineLines` → scope path. The rest of verify mode
    (`computeVerifyDelta`, formatters) is unchanged.
- **Mutual exclusion:** `runId` is rejected together with `baseline`, `diffBase`, or `lineScope`
  (validator, below). All four set the run's scope; only one at a time.

## Component 2 — Suppression list (`src/utils/suppression.ts`), item #8

File schema (`<workspaceRoot>/.chaos-mcp/suppressions.json`):

```jsonc
{
  "version": 1,
  "entries": {
    "src/foo.ts": [
      { "line": 42, "mutator": "ConditionalExpression", "reason": "equivalent — guard is unreachable", "addedAt": 1719500000000 }
    ]
  }
}
```

```ts
export interface SuppressionEntry { line: number; mutator: string; reason?: string; addedAt: number; }
export interface SuppressionInput { line: number; mutator: string; reason?: string; }

export function loadSuppressions(workspaceRoot: string, configPath?: string): Map<string, Set<string>>;
//   → file-rel → set of "line mutator" keys, for O(1) filtering. Missing/corrupt → empty + warn.

export function addSuppressions(workspaceRoot, relFile, entries: SuppressionInput[], configPath?): void;
export function removeSuppressions(workspaceRoot, relFile, keys: { line: number; mutator: string }[], configPath?): void;
//   add/remove dedupe by (line, mutator); create .chaos-mcp/ if absent; atomic write.

export function applySuppressions(
  result: MutationResult,
  relFile: string,
  suppressed: Set<string>,
): { result: MutationResult; suppressedCount: number };
```

### Write path — `suppress` / `unsuppress` args on `audit`

- `suppress: [{ line, mutator, reason? }]` → `addSuppressions` (append, deduped, stamps
  `addedAt`). `unsuppress: [{ line, mutator }]` → `removeSuppressions`.
- These run **alongside** a normal audit: the file is audited as usual, the write happens, and
  the post-filter (below) reflects the just-added entries — so a `suppress` call returns the
  cleaned-up report in the same round-trip. They are not mutually exclusive with scoping args.
- Both target the resolved audit file (workspace-relative). Writing under `workspaceRoot` honors
  the C2 boundary.

### Read path — always-on auto-filter

Applied in both `audit` and `triage`, before payload construction, via `applySuppressions`:

- Drop every `vulnerability` whose `"<line> <mutator>"` is in the file's suppressed set.
- `suppressedCount` = number dropped. Because equivalent mutants are **unkillable**, they leave
  the denominator: `totalMutants -= suppressedCount`; `mutationScore = killed / totalMutants`
  recomputed (divide-by-zero → `"100.00%"` with all mutants suppressed, treated as no
  measurable mutants). `survived` clamped to `max(0, survived - suppressedCount)` (best-effort;
  the authoritative signals are the vulnerabilities list and the recomputed score).
- Payload gains `suppressedCount`; when `> 0`, a note explains the score is adjusted for
  equivalent mutants.
- **Verify mode:** suppressed keys are removed from both the baseline keys and the re-run
  vulnerabilities before `computeVerifyDelta`, so a known-equivalent mutant never reports as
  "still surviving."

### Staleness caveat (documented, not solved)

Entries are keyed `file + line + mutator`. Line-shifting edits can stale an entry (suppress a
mutant that has since moved). `reason` + `addedAt` are recorded so a human can audit and prune
the list. This is the standard, accepted trade-off for line-keyed ignore lists; auto-migrating
entries across diffs is out of scope.

## Component 3 — Schema, config, validation

- **`tool-schema.ts` (audit):** add inputs `runId` (string), `suppress` (array of
  `{line:int≥1, mutator:string, reason?:string}`), `unsuppress` (array of `{line:int≥1,
  mutator:string}`). `outputSchema` gains `runId` (string) and `suppressedCount` (integer).
- **`tool-schema.ts` (triage):** per-row `outputSchema` gains `runId` (string) and
  `suppressedCount` (integer).
- **`config-loader.ts`:** add `suppressionsPath` (string, default `.chaos-mcp/suppressions.json`),
  `runCacheTtlMs` (integer > 0), `runCacheMax` (integer ≥ 1) to `KNOWN_KEYS`, `ChaosConfig`,
  `buildConfig` (validated), `validateConfig` (warning on invalid).
- **Handler validators** (added to `TOOL_ARG_VALIDATORS`, ordered):
  - `validateRunIdArg`: non-empty string; rejected if `baseline`, `diffBase`, or `lineScope`
    is also present ("runId is mutually exclusive with baseline/diffBase/lineScope").
  - `validateSuppressArg` / `validateUnsuppressArg`: array of `{line:int≥1, mutator:non-empty
    string}` (`reason` optional string for suppress).

## Error handling

- Run-cache miss / corrupt / expired → `undefined` (cache miss); a `runId` verify against a
  miss is a clear tool error, never a crash.
- runId/file mismatch → tool error (don't verify a baseline against the wrong file).
- Suppressions file missing or corrupt → treated as empty (warn to stderr); never fatal.
- All cache/suppression file I/O is wrapped so a filesystem failure degrades gracefully (a
  failed `saveRun` omits `runId` from the payload with a note; a failed suppression write
  surfaces a tool error since the user explicitly asked to write).
- Atomic writes (temp + rename) for both stores to avoid torn files under the triage worker pool.

## Testing

Unit:
- `run-cache`: save→load round-trip; TTL prune; count-cap eviction (oldest-first); atomic write;
  missing / corrupt / expired file → `undefined`; runId uniqueness/collision regen.
- `suppression`: load (missing/corrupt → empty + warn); add/remove with dedupe; `applySuppressions`
  count + score recompute; divide-by-zero (all suppressed) → `"100.00%"`; survived clamp.
- Handler: runId verify happy path; unknown id error; file-mismatch error; mutual-exclusion
  (runId × baseline/diffBase/lineScope); `suppress` → next report filters it + adjusted score;
  `unsuppress` round-trip; verify mode filters suppressed keys.
- Triage: per-row `runId` minted; suppression filtering applied per file; payload shape.
- Validators: runId, suppress, unsuppress; config `suppressionsPath`/`runCacheTtlMs`/`runCacheMax`.
- Schema: `outputSchema` includes `runId`/`suppressedCount` (audit + triage).

Gate: `npm run check` green on Node 22/24; existing audit/triage tests updated for the additive
payload fields; self-mutation smoke best-effort.

## Out of scope (Phase 3)

- Python enrichment (#10 remainder) — deferred.
- `estimate_audit`, gate mode, progress/cancellation, resources/prompts (Phases 4–5).
- Sharing / merging suppression lists across machines, or auto-migrating suppression entries
  across diffs (line-shift handling).
- Caching anything beyond the per-run survivor baseline (no full-result cache, no cross-run
  score history).
