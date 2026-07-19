# Knossos architecture scan of Chaos-MCP — 2026-07-19

Read-only dogfeeding run: the Knossos PHP architecture-graph server was pointed at this
repository. Two kinds of result are recorded — what it found out about Chaos-MCP, and what
it got wrong about an unfamiliar repository.

Nothing in `src/` was modified by this exercise. Every claim in section 2 was confirmed by
opening the cited source line; Knossos output alone was treated as a lead, never as evidence.

---

## 1. What was run

**Tool:** Knossos `0.1.0-dev` (`php bin/knossos version --json` → `{"name":"knossos","version":"0.1.0-dev"}`),
run from `/root/Knossos-MCP` against `/root/Chaos-MCP` @ `076991d` (clean worktree).

```bash
# Scan (full mode, the number quoted below)
time php bin/knossos scan /root/Chaos-MCP --mode=full --json > /tmp/chaos-scan-full.json

PID=project_f96c0e638b40794e42aac9dfee685905829dad0fb88862e8fa539aeb51f4c3a6
php bin/knossos architecture-summary "$PID" --json  > /tmp/chaos-summary.json
php bin/knossos file-metrics "$PID" --sort-by=line_count --order=desc --limit=20 --json > /tmp/chaos-metrics.json
php bin/knossos dependency-cycles "$PID" --json     > /tmp/chaos-cycles.json
php bin/knossos architecture-health "$PID" --json   > /tmp/chaos-health.json
php bin/knossos architecture-health "$PID" --limit=100 --json > /tmp/chaos-health100.json
php bin/knossos list-boundaries "$PID" --json       > /tmp/chaos-boundaries.json

# Top files by line count, per the brief
php bin/knossos architecture-context "$PID" src/__tests__/handler.test.ts --json
php bin/knossos architecture-context "$PID" src/__tests__/project-detector.test.ts --json
php bin/knossos architecture-context "$PID" src/__tests__/config-loader.test.ts --json
php bin/knossos architecture-context "$PID" src/handler.ts --json
php bin/knossos architecture-context "$PID" src/handler.ts --max-chars=100000 --json

# MCP surface, to exercise staleness / next_steps / verbosity
php bin/knossos serve --allow-root=/root/Chaos-MCP   # driven over stdio JSON-RPC
```

**Measured results**

| Metric | Value |
| --- | --- |
| Scan wall-clock (`--mode=full`) | **16.3 s** (`real 0m16.348s`); reported `elapsed_ms` 14 524 |
| Repeat full scan | 15.4 s — identical counts, deterministic |
| Files discovered / parsed | 103 / 103 |
| Nodes | 1 374 |
| Edges | 4 455 |
| Diagnostics / unresolved nodes | 248 / 304 |
| Peak memory | 37.8 MB |
| Stage split | `scanner_typescript` 5 890 ms, `reconciliation` 8 617 ms, discovery 6.5 ms |
| Languages | typescript 97, javascript 6 |
| Boundaries inferred | 6 |
| Dependency cycles | 3 |

Node kinds: property 587, function 262, external_function 137, external_method 106,
module 103, interface 61, external_class 41, method 16, class 14, type_alias 14, package 13.
Edge kinds: calls 2 263, contains 954, references 519, imports 439, constructs 144,
returns 117, extends 12, injects 4, re_exports 2, uses_hook 1.

**Ignore behaviour (brief Step 1):** correct. The tree holds 4 230 `*.ts` files in total but
only 97 outside `node_modules/`, `build/`, `coverage/`; Knossos discovered 103 files
(97 TS + 6 JS). `grep -c node_modules /tmp/chaos-scan-full.json` → `0`. No wall-clock penalty
from vendored trees.

---

## 2. Findings about Chaos-MCP

### 2.1 `handleTriageCall` is a ~370-line single function — MEDIUM

**Claim.** `src/triage-handler.ts` contains essentially one function. It spans the whole file
below its two small helpers, and it is the highest-fan-out first-party symbol in the repo.

**Knossos output.** `architecture-health` hub rank #3 (behind only the ambient types
`Promise`/`Error`/`Record`):

```
function src/triage-handler.ts#handleTriageCall  in=2 out=63 score=65  confidence=certain
```

63 outgoing edges from a single function is the largest first-party fan-out in the graph.

**Confirmed in source.** `src/triage-handler.ts:48` declares `handleTriageCall`; the next and
final top-level `}` in the file is `src/triage-handler.ts:417`. The only other top-level
definitions are `triageError` (`src/triage-handler.ts:30`) and `resolveStrykerConcurrency`
(`src/triage-handler.ts:38`). Inside the one function: argument validation
(`src/triage-handler.ts:98`, `:127`), discovery, per-file engine construction
(`src/triage-handler.ts:224`), diff-range computation (`src/triage-handler.ts:248`), ranking
and formatting (`src/triage-handler.ts:407`–`:412`).

**Severity.** Medium — no defect proven, but it is the module with the highest structural
coupling in the codebase and the hardest to mutation-test in isolation.

### 2.2 `src/handler.ts` is the largest non-test module, with a 287-line entrypoint — MEDIUM

**Claim.** `handler.ts` is 969 lines; its MCP entrypoint `handleToolCall` is ~287 of them.

**Knossos output.** `file-metrics --sort-by=line_count`: `src/handler.ts`, 41 196 bytes,
969 lines — the largest file that is not a test. `architecture-health` hub rank #17:
`function src/handler.ts#handleToolCall in=4 out=41 score=45`.

**Confirmed in source.** `wc -l src/handler.ts` → 969. `handleToolCall` is declared at
`src/handler.ts:683` and the file ends at 969. The other long functions in the same file are
`computeScope` (`src/handler.ts:441`, ~134 lines) and `formatAuditOutput`
(`src/handler.ts:575`, ~108 lines). `handler.ts` also owns argument validation
(`src/handler.ts:135`), option building (`src/handler.ts:196`), engine construction
(`src/handler.ts:414`) and the audit core (`src/handler.ts:362`) — five distinct
responsibilities in one module.

**Severity.** Medium.

### 2.3 Two near-duplicate recursive directory walkers with divergent safety bounds — LOW

**Claim.** The repo contains two hand-rolled recursive file walkers. One is explicitly
bounded in depth and breadth; the other has no bound at all.

**Knossos output.** `dependency-cycles` reported exactly 3 cycles, all size-1 self-loops, and
two of them are these walkers:

```
src/triage.ts#walk            self calls edge, evidence src/triage.ts:66
src/test-file.ts#collectByName self calls edge, evidence src/test-file.ts:84
```

**Confirmed in source.** `src/test-file.ts:74` opens with
`if (depth > 8 || out.length >= 16) return;` and threads a `depth` parameter
(`src/test-file.ts:67`–`:87`). The equivalent walker at `src/triage.ts:56`–`:71` takes no
depth parameter and applies no cap on `out`; it recurses at `src/triage.ts:66` and appends
without limit at `src/triage.ts:69`. Its only protection is the fixed `IGNORE_DIRS` set at
`src/triage.ts:35`–`:45`. The result is capped only afterwards, by `maxFiles` in
`discoverFiles` (`src/triage.ts:88`).

**Severity.** Low. Not a crash risk (see 4.4), but on a large monorepo `triage_test_coverage`
walks the entire tree and materialises every match before discarding all but `maxFiles`
(default 25, `src/triage-handler.ts:34`). Two functions doing the same job with different
safety stances is the durable problem.

### 2.4 Test code outweighs product code better than 2:1, concentrated in one file — LOW

**Claim.** `src/**/*.test.ts` totals 20 091 lines against 9 181 lines of non-test `src`, and a
single test file is 3.4× the size of its subject.

**Knossos output.** The top four files by line count are all tests; the largest first-party
non-test file only appears at rank 5:

```
src/__tests__/handler.test.ts           3317 lines
src/__tests__/project-detector.test.ts  1408
src/__tests__/config-loader.test.ts      1301
src/__tests__/typescript-engine.test.ts  1195
src/handler.ts                            969
```

Six of the top-20 hubs are test modules (`triage-handler.test.ts` out=63,
`sandbox.test.ts` out=62, `handler.test.ts` out=61, …).

**Confirmed in source.** `wc -l src/__tests__/handler.test.ts` → 3 317 against
`wc -l src/handler.ts` → 969. Aggregate `find src -name '*.test.ts' | xargs wc -l` → 20 091;
`find src -name '*.ts' -not -name '*.test.ts' | xargs wc -l` → 9 181.

**Severity.** Low, maintainability only. Worth noting because 2.1 and 2.2 identify the two
modules that would be hardest to split — and `handler.test.ts` is the file that would have to
be split with them.

### 2.5 Shared argument validation is entrypoint-specific — LOW

**Claim.** The 15-validator registry runs on one of the three MCP tool entrypoints only; the
other two hand-roll their own checks.

**Knossos output.** All 15 `src/tool-args-validation.ts#validate*Arg` functions appear in
`architecture-health --limit=100` as dead-code candidates with
`reason: "No selected inbound static dependency references this component."` That reason is
wrong (see 3.2), but it did point at a real asymmetry.

**Confirmed in source.** `TOOL_ARG_VALIDATORS` (`src/tool-args-validation.ts:270`–`:286`) is
consumed only by `validateToolArgs` (`src/handler.ts:135`–`:144`), which has exactly one
call site: `src/handler.ts:752`, inside `handleToolCall`. `handleTriageCall` performs its own
`minScore` check at `src/triage-handler.ts:98` and its own `outputFormat` check at
`src/triage-handler.ts:127`–`:136`; `handleEstimateCall` validates independently at
`src/estimate-handler.ts:42`–`:47`. `src/index.ts:97`–`:105` dispatches to all three.

**Severity.** Low. No exploitable gap was proven — see 4.5 — but three entrypoints with three
validation strategies is a place where the next added argument gets checked in one path only.

---

## 3. Findings about Knossos

### 3.1 `architecture-summary --json` prints its payload twice, producing invalid JSON — HIGH

`php bin/knossos architecture-summary "$PID" --json` writes two identical JSON documents on
two lines. `json_decode(file_get_contents(...))` on the captured file returns `null`, so the
exact pipeline the brief specifies (`> /tmp/chaos-summary.json`, then decode) silently yields
nothing. It is the only command of the seven run that does this; every other `--json` output
was a single valid document.

Cause, read in Knossos source: `/root/Knossos-MCP/src/Cli/Command/QueryCommand.php:141-142`
calls `$c->output($result->jsonSerialize(), isset($o['json']), $result->summary);` twice in
a row. Not fixed — this audit is read-only.

### 3.2 Dead-code detection misses identifier-as-value references, and says so as fact — MEDIUM-HIGH

`architecture-health --limit=100` returned 100 dead-code candidates, 33 of them non-test.
At least 21 are demonstrably referenced. Every one of them is referenced by *name as a value*
— stored in a registry array/object or passed as a callback — never by a call expression:

| Reported dead | Actually referenced at |
| --- | --- |
| all 15 `validate*Arg` in `src/tool-args-validation.ts` | `src/tool-args-validation.ts:270`–`:286` (`TOOL_ARG_VALIDATORS` array literal) |
| `parseStrykerConfig`, `parseCosmicRayConfig`, `parseCargoMutantsConfig`, `parseInfectionConfig` | `src/utils/config-loader.ts:340`–`:343` (`ENGINE_CONFIG_SECTIONS` table) |
| `detectRawPhpRunner` | `src/utils/project-detector.ts:559` (`LANGUAGE_DETECTORS.php.rawRunner`) |
| `compareTriageRows` | imported at `src/triage-handler.ts:11`, used at `src/triage-handler.ts:407`, and used at `src/triage.ts:162` |

`compareTriageRows` is the sharpest case: it is exported, statically imported by another
module, and used in two places, yet Knossos asserts *"No selected inbound static dependency
references this component."* That statement is false, not merely uncertain. The item-level
label is `confidence: "probable"` — too strong for a class of reference the analyser cannot
see at all. The accompanying `uncertainty` string ("Reflection, configuration, templates, or
runtime dispatch may not be visible statically") does not name the actual gap, which is a
plain lexical reference in an array literal.

Recommendation for Knossos: emit a `references` edge for an identifier used as a value, or
downgrade such candidates to `possible` and name callback/registry references in the
uncertainty text.

### 3.3 `hubs` and `static_hotspots` are the same ranking presented as two — MEDIUM

The summary line reads *"Ranked 20 hubs, 20 static hotspots, and 20 unreferenced-code
candidates."* At `--limit=100` the two lists are byte-for-byte the same components in the same
order (verified by comparing component IDs: 100/100 identical). They differ only in one
auxiliary key — `hubs[i].metrics` vs `static_hotspots[i].factors`, where `factors` adds
`cycle_participant` — and both are sorted by the same `score`
(`/root/Knossos-MCP/src/Query/GraphTopologyQueryService.php:312`–`:326`,
returned together at `:350`). A reader spends time cross-referencing two rankings that carry
one ranking's worth of information.

### 3.4 Hub ranking is dominated by ambient TypeScript types and `node_modules` declarations — MEDIUM

The top three hubs for a mutation-testing MCP server are `Promise` (in-degree 86), `Error`
(75) and `Record` (66) — TypeScript built-ins, all `external_class`, `confidence: possible`.
Seven of the top fourteen entries are not Chaos-MCP code at all; four of those carry
`node_modules/` paths (`node_modules/vitest/dist/index.d.ts`,
`node_modules/@vitest/expect/dist/index.d.ts#ExpectStatic`,
`node_modules/@types/node/path.d.ts#path.path.PlatformPath::join`, …).

Note the interaction with 3.6: file *discovery* correctly excluded `node_modules`
(`grep -c node_modules` on the scan output is 0), but the TypeScript program still resolves
declaration files, so `node_modules` paths reappear in query results. A user who checks the
scan output for leakage gets a clean answer and is then surprised by the queries.

A `--first-party-only` filter, or simply excluding `external_*` kinds from hub ranking by
default, would make the first screen of `architecture-health` useful.

### 3.5 `next_steps` recommends inspecting a TypeScript built-in; most tools emit none — MEDIUM

Exercised over the MCP surface (`php bin/knossos serve --allow-root=/root/Chaos-MCP`,
stdio JSON-RPC). `architecture_health` returned exactly one suggestion:

```json
"next_steps": [{"tool":"inspect_component","args":{"component":"Promise"},
                "why":"inspect the top structural hotspot"}]
```

`Promise` is a TypeScript built-in. The planner takes `static_hotspots[0]` unconditionally
with no kind filter (`/root/Knossos-MCP/src/Mcp/NextStepPlanner.php:111`–`:128`), so on any
TS repository whose top hub is an ambient type it will send the caller to inspect the
language, not the codebase.

Coverage is also thin: `plan()` only handles `find_component`, `inspect_component`,
`impact_analysis` and `architecture_health`
(`/root/Knossos-MCP/src/Mcp/NextStepPlanner.php:24`–`:29`). Measured on this repo,
`architecture_summary`, `dependency_cycles`, `file_metrics`, `list_boundaries` and
`architecture_context` all returned `next_steps: null`. `dependency_cycles` returning no
follow-up despite finding 3 cycles is the most visible gap — that is the result a caller is
most likely to want to drill into.

`staleness` and `verbosity`, by contrast, read sensibly and needed no interpretation:
`{"state":"fresh","scanned_at":"2026-07-19T13:41:15Z","age_seconds":645,"changed_files_since":0}`
and `{"result_bytes":6319,"verbosity":"compact","evidence_total":6,"evidence_shown":3}`.
Both were correct and immediately understandable on a repo the tool had never seen. One
caveat: none of these three fields exist on the CLI surface — `ResultEnricher` is wired only
into `ServeCommand` (`/root/Knossos-MCP/src/Cli/Command/ServeCommand.php:34`), so a CLI user
gets no freshness signal at all.

### 3.6 `architecture-context` drops whole sections instead of trimming them — MEDIUM

For `src/handler.ts` at the default budget, the returned context contained the project summary
and nothing else:

```json
"change_impact": {"status":"truncated","reason":"section_budget","original_chars":56532,
                  "summary":"Mapped 1 changed file to 55 direct and 25 impacted components.",
                  "available_keys":[...]},
"dossiers":      {"status":"truncated","reason":"section_budget","original_chars":12561},
"budget": {"max_chars":30000,"actual_chars":1685,
           "allocations":{"summary":6000,"locations":6000,"change_impact":9000,"dossiers":9000},
           "dossier_candidates":55,"dossiers_included":3}
```

1 685 characters of a 30 000-character budget were used — 94 % wasted — because a section that
overruns its per-section allocation is replaced by a stub rather than truncated to fit.
Raising to the maximum the CLI accepts (`--max-chars=100000`; higher is rejected with
`--max-chars must be between 4000 and 100000`) recovers `dossiers` but *not* `change_impact`:
its 56 532 characters still exceed the 30 000 allocated, so that section is unreachable for
this file at any permitted budget. On a repo where the largest module is 969 lines, that is
not an extreme case.

### 3.7 Inferred boundaries do not partition anything, so boundary metrics are inert — MEDIUM

`list-boundaries` returned 6 boundaries; three of them have an **empty** `path_prefix` matcher
and identical membership:

```
module:scripts                   path_prefix:scripts/   members=8
module:src                       path_prefix:src/       members=1054
module:tests                     path_prefix:tests/     members=5
node:chaos-mcp                   path_prefix:           members=1070
typescript:tsconfig.eslint.json  path_prefix:           members=1070
typescript:tsconfig.json         path_prefix:           members=1070
```

Every symbol therefore carries four boundary tags of which three are "the whole repository",
and the two `tsconfig` boundaries are indistinguishable from each other. The measurable
consequence: `cross_boundary_degree` is **0 for all 100 hubs**, so the one metric that depends
on boundaries contributes nothing on this repo.

Missed structure: the boundary model puts 1 054 of 1 070 symbols in `module:src` and makes no
distinction between `src/__tests__/` and product code — on a repository that is 69 % test
lines by volume (20 091 vs 9 181), test/production is the single most useful partition
available, and Knossos does not offer it.

### 3.8 248 diagnostics and 304 unresolved nodes are reported with no way to read them — LOW

Every scan returns `"diagnostics": 248` and `"unresolved_nodes": 304`. `php bin/knossos --help`
lists no command that displays them. A number that cannot be drilled into cannot be acted on;
it also makes it impossible for a user to judge whether the 4 455 edges are trustworthy.

---

## 4. Not findings

### 4.1 `node_modules/`, `build/`, `coverage/` leaking into the graph — checked, did not happen
The brief flagged this as candidate Knossos finding #1. It is not one. 4 230 `*.ts` files exist
on disk; 97 exist outside the vendored/generated directories; Knossos discovered 103 files
(97 TS + 6 JS) and `grep -c node_modules /tmp/chaos-scan-full.json` returned 0. Discovery cost
6.5 ms. (`node_modules` paths *do* appear in query results as external symbols — that is 3.4,
a different issue.)

### 4.2 MCP entrypoints flagged dead because they are reached via a dispatch table — did not happen
The brief predicted this specifically. Knossos got it right: `src/index.ts:97`–`:105`
dispatches by tool name, and Knossos resolved those references —
`src/handler.ts#handleToolCall` has in-degree 4, `src/triage-handler.ts#handleTriageCall`
in-degree 2, and neither `src/index.ts` nor any of the three handlers appears among the 100
dead-code candidates. Discarded as a Knossos finding; recorded as a thing it does well.

### 4.3 Incremental scan producing fewer edges than a full scan — unreproducible, not asserted
The first scan of the session ran in `incremental` mode (7 files re-parsed, 96 replayed) and
reported **4 443** edges; every `--mode=full` run of the identical worktree reports **4 455**
(twice, deterministically), and a fully-replayed incremental run also reports 4 455. The 12-edge
gap looks like a mixed parse/replay reconciliation issue, but it could not be reproduced:
Knossos keys re-parse on content hash, not mtime, so `touch`ing seven `src/*.ts` files yielded
`parsed_files: 0`, and reproducing it properly would require editing Chaos-MCP source, which
this task forbids. Recorded as a lead, not a finding.

### 4.4 Unbounded recursion in `src/triage.ts#walk` as a crash/symlink-loop risk — discarded
`walk` (`src/triage.ts:56`) has no depth cap, and `dependency-cycles` flags it as a self-cycle.
But `readdirSync(absDir, { withFileTypes: true })` at `src/triage.ts:59` yields `Dirent`s whose
`isDirectory()` is false for symlinks (`isSymbolicLink()` is the true predicate), and the
recursion at `src/triage.ts:66` is gated on `entry.isDirectory()` (`src/triage.ts:64`). Symlink cycles therefore
cannot drive infinite recursion, and real filesystem depth bounds the stack. Only the missing
breadth cap survives, kept as the low-severity consistency point in 2.3.

### 4.5 `triage_test_coverage` bypassing `TOOL_ARG_VALIDATORS` as a correctness gap — discarded
`handleTriageCall` never calls `validateToolArgs`, so the natural hypothesis was that
unvalidated arguments reach the engine. They do not, in any way that matters: the only
caller-supplied values forwarded into per-file audits are `args.timeoutMs` and
`args.mutatorDenylist` (`src/triage-handler.ts:233`–`:236`), and `timeoutMs` is independently
guarded by a `typeof … === 'number' && > 0` check before use
(`src/handler.ts:223`–`:226`). The triage input schema also declares
`additionalProperties: false` (`src/tool-schema.ts:369`). The structural asymmetry is real and
kept as 2.5; the correctness claim is withdrawn.

### 4.6 "Dead-code candidates are labelled `certain`" — withdrawn, I misread the field
Initially recorded as a confidence-labelling defect, because every dead-code entry shows
`component.confidence: "certain"`. That field is the *symbol resolution* confidence, not the
dead-code verdict. The verdict lives alongside it as `confidence: "probable"` with a `reason`
and an `uncertainty` string. The labelling is therefore more honest than it first appears. What
survives is 3.2: the `reason` text states as fact something that is false for
`compareTriageRows`, and `probable` is still too strong for a reference class the analyser
cannot observe.

### 4.7 The three reported dependency cycles as a Chaos-MCP architecture problem — discarded
All three "cycles" are size-1 self-loops from ordinary recursive functions:
`src/test-file.ts:84`, `src/__tests__/e2e-mcp.test.ts:154`, `src/triage.ts:66`. The graph data
is technically correct — a self-call is a one-node strongly connected component — but recursion
is not a dependency cycle in the architectural sense, and reporting it under that heading cost
time to dismiss. Chaos-MCP has **no** genuine multi-module dependency cycles, which is a good
result for a 20-module flat `src/`. The walker inconsistency the leads exposed is kept as 2.3.

---

## Verification

- `cd /root/Knossos-MCP && git status --short` → empty. Knossos was not modified.
- `php tests/run.php --group=cli` → `10 tests, 0 failures`.
