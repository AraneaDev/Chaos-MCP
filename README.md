# Chaos-MCP

> On-demand micro-mutation sandbox for AI test verification — maps holes in unit tests by running isolated mutation testing via the Model Context Protocol.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![status: in development](https://img.shields.io/badge/status-in%20development-orange.svg)](#)

> **Pre-release / in active development.** Chaos-MCP is **not yet published to npm** and is **not on a public host** — it currently lives in a private [Forgejo](https://forgejo.org/) repository. Install from source (see [Installation](#installation)). Any `npm install -g` / `npx` commands in this README describe the planned published experience and do not work yet.

Chaos-MCP is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes three tools — `audit_code_resilience` (audit a single file), `triage_test_coverage` (rank a whole tree weakest-first), and `estimate_audit` (cheap pre-flight mutant count / timing estimate) — which run isolated mutation testing against your source to find weaknesses in the local test suite. It intentionally injects logical faults (like changing `>` to `>=`) and checks whether your tests catch them. Surviving mutants indicate test coverage holes.

## Features

- **4 Languages Supported** — TypeScript/JavaScript (StrykerJS), Python (Mutmut), Go (go-mutesting), Rust (cargo-mutants)
- **Sandbox Isolation** — all mutation runs execute in temporary directories; your real workspace is never touched
- **Auto-Detection** — automatically detects project type, test runner, and workspace root
- **Async Subprocesses** — all mutation-tool execution uses async `execFile`/`exec` (subprocess runs never block the event loop; the one-time sandbox copy is synchronous)
- **Rich Tool Schema** — supports line scoping, mutator denylists, concurrency control, dry-run mode, incremental runs, and output format selection
- **Pre-flight Estimation** — `estimate_audit` gives a fast mutant count (exact for Rust, approximate for others) and optional timing estimate before you commit to a full run
- **Gate Mode** — pass `minScore` to `audit_code_resilience` or `triage_test_coverage` to get a machine-readable pass/fail field for CI pipelines
- **Cross-Platform** — works on macOS, Linux, and Windows (with junction fallback for symlinks)

## Installation

While in development, the only supported install path is **from source** — clone the private repo, build, and register the built entrypoint with your MCP client.

```bash
git clone https://forgejo.aranea.dev/AraneaDevelopment/ChaosMCP.git
cd ChaosMCP
npm install
npm run build      # compiles to build/index.js
```

Register it with an MCP client (Claude Code example):

```bash
claude mcp add chaos-mcp -- node /absolute/path/to/ChaosMCP/build/index.js
```

> **Planned (not available yet):** once published, install will be `npm install -g chaos-mcp` or run on demand via `npx chaos-mcp`. These do not work until the package ships to npm.

## Quick Start

### 1. Start the Server

Normally your MCP client launches the server for you (see [Installation](#installation)). To run it directly from a source checkout:

```bash
# From the repo root, after `npm run build`
npm start                                  # → node build/index.js
node build/index.js --verbose              # diagnostic logging to stderr
node build/index.js --config ./chaos-mcp.config.json
```

### 2. Call the Tool from Your MCP Client

The primary tool is `audit_code_resilience` (the batch tool `triage_test_coverage` is documented [below](#batch-triage--triage_test_coverage); the lightweight pre-flight tool `estimate_audit` is documented [below](#pre-flight-estimate--estimate_audit)).

**Minimal example:**
```json
{
  "filePath": "src/utils/math.ts"
}
```

**Full example with all options:**
```json
{
  "filePath": "src/utils/math.ts",
  "timeoutMs": 120000,
  "lineScope": { "start": 10, "end": 80 },
  "mutatorDenylist": ["StringLiteral"],
  "concurrency": 4,
  "incremental": true,
  "ignorePatterns": ["fixtures/", "snapshots/"],
  "outputFormat": "text",
  "enrich": false,
  "maxSurvivors": 20,
  "severityFloor": "medium"
}
```

**Get enriched, severity-ranked guidance on survivors (on by default):**

Enrichment is enabled by default. Each surviving / no-coverage line is augmented with four fields: a `severity` rating (`high`, `medium`, or `low`) based on the mutator's semantics (e.g. boundary operators and logical operators rank high), a `why` explanation of why the gap is dangerous, a `hint` describing the kind of test that would kill it, and a `context` snippet of the surrounding source lines. Survivors are re-ranked severity-first so the most critical gaps appear first. To disable enrichment and return the plain unranked output, pass `"enrich": false`.

TypeScript targets produce the richest output because StrykerJS exposes per-mutant operator detail; Go targets can also produce severity-ranked output when the mutation tool emits structured data with mutator names; Python targets report `severity: "unknown"` with a generic why/hint because mutmut does not expose per-mutant operator detail.

**Cap and filter the survivor list:**
```json
{
  "filePath": "src/utils/math.ts",
  "maxSurvivors": 5,
  "severityFloor": "high"
}
```
`maxSurvivors` caps how many survivor (and no-coverage) line groups are returned after severity ranking (default: 10; configurable via `defaultMaxSurvivors`). Hidden groups are counted in `survivorsTruncated` / `noCoverageTruncated` in the output. `severityFloor` drops groups below the given severity level (requires enrichment, which is on by default); dropped groups are counted in `survivorsFiltered` / `noCoverageFiltered`.

**Scope to just your uncommitted changes:**
```json
{
  "filePath": "src/utils/math.ts",
  "diffBase": "HEAD"
}
```
Mutation-tests only the lines you've changed since the last commit.

**Verify your new tests killed the previous survivors:**
```json
{
  "filePath": "src/utils/math.ts",
  "baseline": { "survivors": [{ "line": 42, "mutators": { "ConditionalExpression": 1 } }] }
}
```
Re-runs only the baseline lines and reports which previously-uncaught mutants are now killed:
```json
{ "mode": "verify", "baselineTotal": 1, "killedCount": 1,
  "nowKilled": [{ "line": 42, "mutator": "ConditionalExpression" }],
  "stillSurviving": [], "newSurvivors": [] }
```

### 3. Interpret the Results

The output is **bundled and deduplicated** to stay token-efficient: mutants are grouped by line (with a per-line count of each mutator type), `survivors` (tests ran but didn't catch) and `noCoverage` (no test reached the mutant) are reported separately at line+mutator granularity, and the explanatory note appears once instead of being repeated for every mutant. Because the split is per-mutator, the same line can appear in both lists (e.g. a live expression that survived next to an unreachable fallback that no test reached). Survivors and no-coverage entries also include a `changes` sample — a capped, deduped list of `original → mutated` edits — for TypeScript and Rust targets (best-effort; absent for Go/Python, which don't expose per-mutant detail). When `diffBase` is used, the output may include a `scopeNote` (a top-level JSON field / a `Scope:` text line) reporting scoping decisions — e.g. a skipped run when nothing changed, or a whole-file fallback for Go/Python/Rust targets.

**JSON output (default — emitted as a single compact line):**
```json
{
  "target": "src/utils/math.ts",
  "mutationScore": "91.67%",
  "summary": { "total": 12, "killed": 11, "survived": 1, "worstSeverity": "high" },
  "survivors": [
    {
      "line": 42, "mutators": { "ConditionalExpression": 1 }, "changes": ["a > b → a >= b"],
      "severity": "high",
      "why": "a branch condition was forced to a constant; a test passed without exercising both arms.",
      "hint": "add tests that take BOTH the true and the false branch.",
      "context": ["41: if (a > b) {", "42:   return a;", "43: }"]
    }
  ],
  "noCoverage": [],
  "suggestedTestFile": { "path": "src/utils/__tests__/math.test.ts", "exists": false },
  "note": "survivors: mutants your tests ran but did not kill. noCoverage: mutants no test reached (per line+mutator, so a line may appear here and in survivors). mutators = type→count. Add or strengthen tests targeting these. changes = sampled original→mutated edits for that line (capped)."
}
```

The tool response also carries a `structuredContent` field (in addition to the standard text content block) so MCP clients that support it can consume the data directly without parsing JSON from text. The text block is retained for compatibility with clients that read `content[0].text`.

`suggestedTestFile` is included when there are survivors or no-coverage entries (i.e. when the mutation score is below 100%), pointing to the conventional test file path for the audited source file (e.g. `src/utils/__tests__/math.test.ts` for `src/utils/math.ts`). The `exists` flag indicates whether the file already exists on disk.

**Text output** (`"outputFormat": "text"`):
```
Chaos-MCP Audit Report: src/utils/math.ts
Mutation score: 91.67% (11/12 killed, 1 survived)
Survivors (line: mutators):
  42: ConditionalExpression  (a > b → a >= b)
Add or strengthen tests targeting these lines to kill the survivors.
```

## Tool Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | `string` | Yes | Workspace-relative path to the file (`.ts`, `.js`, `.tsx`, `.jsx`, `.py`, `.go`, `.rs`) |
| `timeoutMs` | `number` | No | Max run time in ms (default: 300000 / 5 min) |
| `lineScope` | `{ start, end }` | No | 1-based line range (StrykerJS only) |
| `diffBase` | `string` | No | Auto-scope mutation to git-changed lines. `"HEAD"` (uncommitted), `"staged"`, or a git ref (e.g. `"main"`, via merge-base). Mutually exclusive with `lineScope`. Line-level scoping is StrykerJS-only; other languages run whole-file with a note. No changes vs base → run skipped. |
| `baseline` | `object` | No | Verify mode. Pass back a prior run's `{ survivors, noCoverage }` to re-test only those mutants and get a delta (`nowKilled` / `stillSurviving` / `newSurvivors`). Re-run auto-scopes to the baseline lines (StrykerJS) or whole-file (other languages). Mutually exclusive with `diffBase`/`lineScope`. Verify mode keys on line numbers, so run it after **adding tests** — not after editing the source under test, since edits shift line numbers and would misreport which mutants were killed. |
| `mutatorAllowlist` | `string[]` | No | Not supported in StrykerJS v9 — ignored (use `mutatorDenylist`) |
| `mutatorDenylist` | `string[]` | No | Stryker mutator names to exclude |
| `concurrency` | `number` | No | Parallel mutation workers (StrykerJS only) |
| `dryRun` | `boolean` | No | Validate test suite only, no mutations (StrykerJS only) |
| `outputFormat` | `"json"` \| `"text"` | No | Output format (default: `"json"`) |
| `incremental` | `boolean` | No | Reuse previous run results (StrykerJS only) |
| `ignorePatterns` | `string[]` | No | Substring patterns to exclude from sandbox copy |
| `enrich` | `boolean` | No | Annotate each survivor with severity, why-it-matters, a test hint, and source context — and rank severity-first. **Default: `true`** (pass `false` to disable and return plain unranked output). Richest for TypeScript; Go can produce severity-ranked output when structured mutator data is available; Python degrades to `severity: "unknown"`. |
| `maxSurvivors` | `integer ≥ 1` | No | Cap on how many survivor (and no-coverage) line groups are returned after severity ranking. Hidden groups counted in `survivorsTruncated`/`noCoverageTruncated`. Precedence: arg > `defaultMaxSurvivors` config > 10. |
| `severityFloor` | `"high"` \| `"medium"` \| `"low"` | No | Drop survivor groups below this severity (requires enrichment, on by default). Dropped groups counted in `survivorsFiltered`/`noCoverageFiltered`. `"unknown"`-severity groups are below `"low"` and are dropped by any floor. |
| `runId` | `string` | No | Verify mode by cached id: re-run against the survivor baseline saved from a prior audit (the `runId` it returned). Mutually exclusive with `baseline`, `diffBase`, and `lineScope`. Unknown or expired ids (cache TTL: ~24 h) return an error. |
| `suppress` | `object[]` | No | Mark mutants as equivalent (unkillable). Each entry: `{ "line": N, "mutator": "MutatorName" }` (reason is an optional string explaining why the mutant is equivalent). Persisted to `.chaos-mcp/suppressions.json`; suppressed mutants are auto-excluded from the score denominator and from future `audit` and `triage` output. The output field `suppressedCount` reports how many were excluded. |
| `unsuppress` | `object[]` | No | Remove previously-suppressed mutants for this file. Each entry: `{ "line": N, "mutator": "MutatorName" }`. |
| `minScore` | `number 0–100` | No | Gate threshold. When the mutation score is below this value, the output includes `gate: { minScore, passed: false }`. Never an error. Uses the suppression-adjusted score. |

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development setup and the full parameter semantics.

## State & the verify loop

### Verify loop via `runId`

Every successful, non-verify `audit_code_resilience` call returns a `runId` (an 8-character id) in its JSON output. Use it to re-verify without copying the full `baseline` object:

1. **Audit:** `{ "filePath": "src/utils/math.ts" }` → response includes `"runId": "a1b2c3d4"`.
2. **Fix or add tests.**
3. **Verify:** `{ "filePath": "src/utils/math.ts", "runId": "a1b2c3d4" }` → reports which previously-surviving mutants are now killed.

`runId` is mutually exclusive with `baseline`, `diffBase`, and `lineScope`. The baseline cache lives in `os.tmpdir()/chaos-mcp-runs/` and is ephemeral (default TTL: 24 h; default max: 200 entries). Passing an unknown or expired `runId` returns an error.

`triage_test_coverage` also mints and returns a `runId` per ranking row, so you can drill into a weak file and immediately verify after fixing its tests.

### Suppressing equivalent mutants

Some mutants are _equivalent_ — logically identical to the original under all possible inputs — and cannot be killed by any test. Suppress them so they stop appearing in the output and stop dragging down the score:

```json
{
  "filePath": "src/utils/math.ts",
  "suppress": [{ "line": 99, "mutator": "StringLiteral", "reason": "guard always true for this type" }]
}
```

Suppressed mutants are:

- **Persisted** to `<workspaceRoot>/.chaos-mcp/suppressions.json` (keyed by workspace-relative file path).
- **Auto-excluded** from every future `audit` and `triage` call for that file — no flag needed.
- **Removed from the score denominator** — `mutationScore` rises and the output field `suppressedCount` tells you how many were excluded.
- **Excluded from verify mode** — suppressed mutants won't appear as "still surviving".

To undo a wrong suppression:

```json
{
  "filePath": "src/utils/math.ts",
  "unsuppress": [{ "line": 99, "mutator": "StringLiteral" }]
}
```

**`.gitignore` or commit?** Add `.chaos-mcp/` to `.gitignore` if the suppression list is personal, or commit it to share the equivalent-mutant list with the team. Suppression keys are workspace-relative, so the file is portable across machines.

**Staleness caveat:** entries are keyed by `file + line + mutator`. Edits that shift line numbers can stale an entry. Each entry records an optional `reason` and an `addedAt` timestamp so you can audit and prune the list over time.

### Config keys for state

| Key | Default | Description |
|-----|---------|-------------|
| `suppressionsPath` | `.chaos-mcp/suppressions.json` | Path to the suppression file (workspace-relative or absolute) |
| `runCacheTtlMs` | `86400000` (24 h) | Run-cache entry TTL in milliseconds |
| `runCacheMax` | `200` | Max cached run entries; oldest are evicted when exceeded |

## Batch Triage — `triage_test_coverage`

A second tool ranks where your test suite is weakest across many files in one call.

```json
{ "paths": ["src/utils", "src/index.ts"], "maxFiles": 25 }
```

Directories are recursively expanded to supported source files (test files skipped), audited in **bounded parallel** (default `max(1, min(4, cpus-1))` files at a time; capped at `maxFiles`; precedence `maxFiles` arg → `defaultMaxFiles` config → 25), and ranked weakest-first by mutation score:

```json
{ "mode": "triage",
  "summary": { "filesDiscovered": 30, "filesAudited": 25, "filesSkipped": 5, "filesErrored": 0 },
  "ranking": [ { "file": "src/a.ts", "mutationScore": "62.50%", "total": 16, "killed": 10, "survived": 5, "noCoverage": 1 } ],
  "errors": [],
  "note": "Ranked weakest-first by mutation score. Drill into a file with audit_code_resilience for survivor detail." }
```

The tool response carries a `structuredContent` field (in addition to the text block) so MCP clients can consume the ranked payload directly without parsing JSON. The `outputSchema` on the tool definition describes the payload shape.

Drill into a weak file with `audit_code_resilience` for per-mutant survivor detail.

**PR-diff scan — `diffBase`:**

Pass `diffBase` to limit the triage to files changed in a PR or branch. `paths` becomes optional in this mode:

```json
{ "diffBase": "main" }
```

`diffBase` alone audits every changed supported source file in the workspace (relative to `main` via merge-base). Passing both limits the scan to changed files under those paths:

```json
{ "diffBase": "main", "paths": ["src/utils"] }
```

TypeScript files are mutated only on the changed lines; Python, Go, and Rust files run whole-file (a per-file `scopeNote` is included in the ranking row).

**Inline survivor detail — `survivorsPerFile`:**

```json
{ "paths": ["src"], "survivorsPerFile": 3 }
```

`survivorsPerFile` (default `0`, scores-only) inlines the top-N severity-ranked, enriched survivor groups into each ranking row so you can triage and inspect in one call. Set it to `0` for the compact leaderboard; raise it when you want to see the worst gaps immediately.

**Parallel file auditing — `fileConcurrency`:**

```json
{ "paths": ["src"], "fileConcurrency": 8 }
```

`fileConcurrency` controls how many files are audited in parallel (default `max(1, min(4, cpus-1))`; range 1–64). When `fileConcurrency > 1` and the file is TypeScript, each StrykerJS run's worker count is automatically capped (`floor((cpus-1) / fileConcurrency)`) so total CPU use stays near the core count rather than oversubscribing. Other languages run their mutation tool without a worker-count override (they ignore the concurrency cap).

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `paths` | `string[]` | Workspace-relative files/dirs to triage. Optional when `diffBase` is provided. |
| `maxFiles` | `integer ≥ 1` | Cap on files audited (precedence: arg → `defaultMaxFiles` config → 25). |
| `timeoutMs` | `number` | Per-file mutation-run timeout in ms (default: 300000). |
| `mutatorDenylist` | `string[]` | Stryker mutator names to exclude, applied to every TypeScript/JS file. |
| `outputFormat` | `"json"` \| `"text"` | Output format (default: `"json"`). |
| `diffBase` | `string` | Auto-scope to git-changed files. `"HEAD"`, `"staged"`, or any git ref/SHA. Makes `paths` optional; with `paths`, intersects changed files under those paths. TypeScript: changed lines only. Other languages: whole-file. |
| `survivorsPerFile` | `integer ≥ 0` | Inline top-N enriched survivors per ranked file (default `0` = scores-only). |
| `fileConcurrency` | `integer 1–64` | Files audited in parallel (default `max(1, min(4, cpus-1))`). Per-file StrykerJS worker count is automatically capped (TypeScript/StrykerJS only; other engines ignore the worker-count cap). |
| `minScore` | `number 0–100` | Gate threshold. Per-row `passed` field + top-level `gate: { minScore, passed, failingFiles }` in output. Never an error. |

## Pre-flight Estimate — `estimate_audit`

Before committing to a full mutation run, use `estimate_audit` to check how many mutants a file will produce and (optionally) how long the run will take. It never runs the mutation test cycle by default.

```json
{ "filePath": "src/utils/math.ts" }
```

**Output:**
```json
{
  "target": "src/utils/math.ts",
  "language": "typescript",
  "mutants": 47,
  "fidelity": "approx",
  "basis": "source heuristic: 23 constructs",
  "note": "Approximate mutant count from a source-parse heuristic; the real audit may differ. Run audit_code_resilience for exact results."
}
```

**With timing** (`withTiming: true`): runs the test suite once to measure a baseline, then estimates total wall-clock time as `mutants × baseline / concurrency`. This provisions a sandbox and counts against your machine's resources — use it when you want a time budget before a large audit.

```json
{ "filePath": "src/utils/math.ts", "withTiming": true }
```

Additional output fields when `withTiming: true`:
```json
{
  "baselineMs": 4200,
  "estimatedMs": 197400,
  "concurrency": 1
}
```

### Fidelity

| Language | Fidelity | Basis |
|----------|----------|-------|
| Rust | `exact` | `cargo-mutants --list` (no tests run) |
| TypeScript / JavaScript | `approx` | source-parse heuristic |
| Python | `approx` | source-parse heuristic |
| Go | `approx` | source-parse heuristic |

For Rust, the estimate is exact because `cargo mutants --list` enumerates every planned mutant without running tests. For all other languages the count is approximate — a lightweight heuristic over the source AST; the actual audit may differ. Run `audit_code_resilience` for exact results.

If `cargo-mutants` is not installed, the Rust path falls back to the heuristic and reports `fidelity: "approx"` with a note.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | `string` | Yes | Workspace-relative path to the file to estimate. |
| `withTiming` | `boolean` | No | When `true`, runs the test suite once to measure `baselineMs` and computes `estimatedMs`. Default: `false`. |

### Use case

Call `estimate_audit` first when you are unsure whether a file is too large to audit interactively:

1. `estimate_audit { "filePath": "src/big.ts" }` → 300 mutants, approx.
2. Consider scoping with `lineScope` or `diffBase`, or scheduling the full run with a longer `timeoutMs`.
3. `audit_code_resilience { "filePath": "src/big.ts", "diffBase": "HEAD" }` → audits only your changed lines.

## Gate Mode — `minScore`

Both `audit_code_resilience` and `triage_test_coverage` accept a `minScore` parameter (0–100). When the mutation score falls below the threshold, the result reports the gate as failed. **A failing gate is never an error** — it is a data field for an agent or CI pipeline to read and act on.

### Gate on a single file

```json
{ "filePath": "src/utils/math.ts", "minScore": 80 }
```

If the mutation score is below 80, the output includes:
```json
{ "gate": { "minScore": 80, "passed": false } }
```

If the score meets or exceeds the threshold, `gate.passed` is `true`. The field is absent when `minScore` is not provided.

The gate uses the suppression-adjusted mutation score (i.e. equivalent mutants excluded via `suppress` are not counted against the denominator).

### Gate on a triage run

```json
{ "paths": ["src"], "minScore": 75 }
```

Each ranking row gains a `passed` field. The top-level output includes:
```json
{
  "gate": {
    "minScore": 75,
    "passed": false,
    "failingFiles": ["src/utils/math.ts", "src/parser.ts"]
  }
}
```

`gate.passed` is `false` if any file's score is below `minScore`. `failingFiles` lists the workspace-relative paths that did not pass. Files that errored during triage are reported in `errors[]` and do not affect the gate.

### CI use case

```bash
# Fail CI if any audited file scores below 80%
mcp call triage_test_coverage '{"paths":["src"],"minScore":80}' \
  | jq -e '.gate.passed'
```

An agent or CI script reads `gate.passed` and decides whether to block the build, open an issue, or continue. The tool call itself always succeeds (never `isError`) regardless of the gate outcome.

## Configuration

Create a `chaos-mcp.config.json` in your workspace root for default settings:

```json
{
  "defaultTimeoutMs": 300000,
  "mutatorDenylist": ["StringLiteral"],
  "concurrency": 4,
  "defaultMaxFiles": 25,
  "defaultMaxSurvivors": 10,
  "defaultSeverityFloor": "medium",
  "defaultFileConcurrency": 4
}
```

Tool call arguments override config defaults.

| Config key | Type | Default | Description |
|------------|------|---------|-------------|
| `defaultTimeoutMs` | `number` | `300000` | Per-file timeout in ms |
| `mutatorDenylist` | `string[]` | `[]` | Mutator names to exclude globally |
| `concurrency` | `number` | `4` | Parallel mutation workers |
| `defaultMaxFiles` | `number` | `25` | Default triage file cap (integer ≥ 1); overridden by the `maxFiles` argument |
| `defaultMaxSurvivors` | `number` | `10` | Default cap on survivor/no-coverage groups returned by `audit_code_resilience` (integer ≥ 1); overridden by the `maxSurvivors` argument |
| `defaultSeverityFloor` | `"high"` \| `"medium"` \| `"low"` | — | Default severity floor for survivor reporting; overridden by the `severityFloor` argument |
| `defaultFileConcurrency` | `number` | `max(1, min(4, cpus-1))` | Default parallel file count for `triage_test_coverage` (integer 1–64); overridden by the `fileConcurrency` argument |

### Enabling `prebuildCommand`

The `prebuildCommand` tool argument runs an arbitrary shell command inside the sandbox, which can reach outside it. It is **disabled by default**. Enable it explicitly with `"allowPrebuild": true` in `chaos-mcp.config.json`, or by setting the `CHAOS_MCP_ALLOW_PREBUILD=1` environment variable. Auto-detected prebuilds for Go (`go mod download`) and Rust (`cargo check`) run without this flag.

## Supported Test Runners (Auto-Detected)

| Language | Mutation Tool | Detected Runners |
|----------|--------------|------------------|
| TypeScript/JS | StrykerJS | vitest, jest, mocha, jasmine, bun, node:test |
| Python | Mutmut | pytest, tox, nox |
| Go | go-mutesting | go test, testify, ginkgo |
| Rust | cargo-mutants | cargo test, cargo-nextest |

## CLI Flags

```
chaos-mcp [flags]

  --version   Print version and exit
  --help      Show help text and exit
  --config    Path to a JSON config file
  --verbose   Enable diagnostic logging to stderr
```

## Development

```bash
npm run check         # Full CI pipeline: build + lint + format + test
npm run test:watch    # Watch mode for iterative development
npm run test:coverage # Tests with coverage report
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for detailed development setup and contribution guidelines.

## License

MIT — See [LICENSE](LICENSE) for details.

## Links

- [MCP Documentation](https://modelcontextprotocol.io/)
- [StrykerJS](https://stryker-mutator.io/)
- [Mutmut](https://github.com/boxed/mutmut)
- [go-mutesting](https://github.com/zimmski/go-mutesting)
- [cargo-mutants](https://github.com/sourcefrog/cargo-mutants)
- [Changelog](CHANGELOG.md)
