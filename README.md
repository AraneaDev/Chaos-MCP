<div align="center">

# Chaos-MCP

**Break your code on purpose, and find out what your tests never noticed.**

[![Release](https://img.shields.io/github/v/release/AraneaDev/Chaos-MCP?label=release)](https://github.com/AraneaDev/Chaos-MCP/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/AraneaDev/Chaos-MCP/ci.yml?label=CI)](https://github.com/AraneaDev/Chaos-MCP/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FAraneaDev%2FChaos-MCP%2Fgh-pages%2Fcoverage.json)](https://github.com/AraneaDev/Chaos-MCP/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/AraneaDev/Chaos-MCP?label=license&color=yellow)](./LICENSE)
[![Language](https://img.shields.io/github/languages/top/AraneaDev/Chaos-MCP)](https://github.com/AraneaDev/Chaos-MCP)
[![Last commit](https://img.shields.io/github/last-commit/AraneaDev/Chaos-MCP?label=last%20commit)](https://github.com/AraneaDev/Chaos-MCP/commits/main)
[![Conventional Commits](https://img.shields.io/badge/commits-conventional-fe5196?logo=conventionalcommits&logoColor=white)](https://www.conventionalcommits.org/)
[![MCP Observatory](https://mcpobservatory.com/servers/github:AraneaDev/Chaos-MCP/badge.svg)](https://mcpobservatory.com/servers/github:AraneaDev/Chaos-MCP/security)
[![Status](https://img.shields.io/badge/status-in%20development-orange)](#quick-start)

</div>

> **Chaos** (Χάος) is the first thing that existed in Greek cosmogony, the yawning void Hesiod
> puts before everything else in the *Theogony*. Order came out of it, not the other way round.
> The name means "gap" or "chasm", which is also what this tool is looking for.

Chaos-MCP is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that
exposes three tools: `audit_code_resilience` (audit a single file), `triage_test_coverage`
(rank a whole tree weakest-first), and `estimate_audit` (a cheap pre-flight mutant count and
timing estimate). They run isolated mutation testing against your source to find weaknesses in
the local test suite. It deliberately injects logical faults, such as changing `>` to `>=`, and
checks whether your tests catch them. Surviving mutants mark the gaps.

> **Status:** pre-release. Chaos-MCP is **not yet published to npm**. The source is public on
> [GitHub](https://github.com/AraneaDev/Chaos-MCP), so install from source (see
> [Installation](#installation)). Any `npm install -g` or `npx` command in this README
> describes the planned published experience and does not work yet.

---

## Features

- **4 Languages Supported**: TypeScript/JavaScript (StrykerJS), Python (cosmic-ray), Rust (cargo-mutants), PHP (Infection)
- **Sandbox Isolation**: all mutation runs execute in temporary directories, and the target's real path is verified to live inside the sandbox before any engine runs, so a symlinked source file (or one under a symlinked directory) is refused rather than mutated in place through the link. Dependency directories are shared cheaply by default and entry-linked, so a write to a new path stays sandboxed while a write through an existing package entry still reaches the host. The exception is PHP's `vendor/`, which is always copied because Composer's autoloader resolves `__DIR__` through symlinks back to the real workspace; see `sandbox.dependencies` in `chaos://config-schema` for the `copy`/`share` alternatives
- **Pinned Container Runners**: release-matched OCI images provide all four mutation engines without installing them on the host
- **Auto-Detection**: automatically detects project type, test runner, and workspace root
- **Async Subprocesses**: all mutation-tool execution uses async `execFile`/`exec`, and the sandbox's workspace copy uses async `fs.cp`, so neither blocks the event loop; the entry-linking pass that follows runs synchronously afterward and scales with the number of installed packages, not workspace size
- **Rich Tool Schema**: supports line scoping, mutator denylists, concurrency control, dry-run mode, incremental runs, and output format selection
- **Pre-flight Estimation**: `estimate_audit` gives a fast mutant count and an optional timing estimate before you commit to a full run. For Rust it is an exact count of the mutants `cargo-mutants --list` **generates**; the audit itself scores fewer, because mutants that fail to compile leave its denominator and are reported as `incompetent`. The other three languages use a source heuristic
- **Gate Mode**: pass `minScore` to `audit_code_resilience` or `triage_test_coverage` to get a machine-readable pass/fail field for CI pipelines
- **Cross-Platform**: works on macOS, Linux, and Windows (with junction fallback for symlinks)

## Installation

While in development, the only supported install path is **from source**: clone the repo, build, and register the built entrypoint with your MCP client.

```bash
git clone https://github.com/AraneaDev/Chaos-MCP.git
cd Chaos-MCP
npm install
npm run build      # compiles to build/index.js
```

Register it with an MCP client (Claude Code example):

```bash
claude mcp add chaos-mcp -- node /absolute/path/to/ChaosMCP/build/index.js
```

> **Planned (not available yet):** once published, install will be `npm install -g chaos-mcp` or run on demand via `npx chaos-mcp`. These do not work until the package ships to npm.

### Prerequisites: language mutation tools

Native mode (the default) shells out to mutation engines installed on the host.
Install only the engine(s) for the languages you audit. Alternatively, enable
[container execution](#container-execution) to use the release-matched,
pinned engines without installing them on the host. Missing native tools return
a clear error naming the exact install command.

| Language                | Engine                                                       | Install                                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript / JavaScript | [StrykerJS](https://stryker-mutator.io/)                     | `npm install --save-dev @stryker-mutator/core` (in the target project). Note: StrykerJS 9.x's vitest-runner is not compatible with vitest 3.x's dropped `--related` API. If the target uses vitest 3.x, downgrade it to `vitest@^2.1.x` for the audit, or wait for StrykerJS 10.x. |
| Python                  | [cosmic-ray](https://github.com/sixty-north/cosmic-ray)      | `pipx install cosmic-ray`, or `pip install cosmic-ray` inside a virtualenv                                                                                                                                                                                                         |
| Rust                    | [cargo-mutants](https://github.com/sourcefrog/cargo-mutants) | `cargo install cargo-mutants`                                                                                                                                                                                                                                                       |
| PHP                     | [Infection](https://infection.github.io/)                    | `composer require --dev infection/infection`, and enable a coverage driver (Xdebug or PCOV)                                                                                                                                                                                       |

Notes:

- In native mode, the tool must be on `PATH` (or, for StrykerJS, resolvable from the target project's `node_modules`), and its language toolchain must be installed.
- **PHP / Infection:** set `failOnWarning="true"` in your `phpunit.xml`. Infection writes a PHPUnit config per mutant with `stopOnDefect="true"`, so the suite stops as soon as a mutant looks killed. But a PHP warning is a _defect_ without being a _failure_, so under `failOnWarning="false"` a mutant that makes an earlier test warn stops the run with exit 0 and is reported as **survived** before the asserting test runs. Scores are only ever depressed by this, never inflated. Chaos-MCP reads your PHPUnit config and attaches a `fidelityNote` to any PHP result that reports survivors while the setting is off.
- **Python / cosmic-ray (native mode):** on modern distros a bare `pip install cosmic-ray` is blocked by [PEP 668](https://peps.python.org/pep-0668/) ("externally-managed-environment"); use `pipx install cosmic-ray` or an activated virtualenv. Chaos-MCP generates cosmic-ray's config and runs `baseline → init → exec → dump` in the sandbox. Use `testSelection` and `excludeOperators` to keep large audits tractable.
- These engines run **inside the sandbox** against a copy of your workspace; Chaos-MCP never installs or modifies anything in your real project.

For container mode, install Docker or Podman. Both runtimes normally pull a
missing image while creating the first audit container, but pre-pulling avoids
making a large download compete with the container startup timeout:

```bash
CHAOS_MCP_TAG="v$(node -p "require('./package.json').version")"
docker pull "ghcr.io/araneadev/chaos-mcp-typescript:${CHAOS_MCP_TAG}"
docker pull "ghcr.io/araneadev/chaos-mcp-python:${CHAOS_MCP_TAG}"
docker pull "ghcr.io/araneadev/chaos-mcp-rust:${CHAOS_MCP_TAG}"
docker pull "ghcr.io/araneadev/chaos-mcp-php:${CHAOS_MCP_TAG}"

# From a source checkout:
node build/index.js --container-doctor
```

Use `podman pull` instead when `"runtime": "podman"` is configured. Each
Chaos-MCP release selects its matching `vX.Y.Z` image tags automatically.

## Quick start

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

TypeScript targets produce the richest output because StrykerJS exposes per-mutant operator detail; Python (cosmic-ray) targets also produce severity-ranked output, mapping the tool's authoritative operator name to a canonical category; targets whose tool can't expose a per-mutant operator fall back to `severity: "unknown"` with a generic why/hint.

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
{
  "mode": "verify",
  "baselineTotal": 1,
  "killedCount": 1,
  "nowKilled": [{ "line": 42, "mutator": "ConditionalExpression" }],
  "stillSurviving": [],
  "newSurvivors": []
}
```

### 3. Interpret the Results

The output is **bundled and deduplicated** to stay token-efficient: mutants are grouped by line (with a per-line count of each mutator type), `survivors` (tests ran but didn't catch) and `noCoverage` (no test reached the mutant) are reported separately at line+mutator granularity, and the explanatory note appears once instead of being repeated for every mutant. Because the split is per-mutator, the same line can appear in both lists (e.g. a live expression that survived next to an unreachable fallback that no test reached). Survivors and no-coverage entries also include a `changes` sample, a capped and deduped list of per-mutant edits, for all four languages (best-effort). TypeScript (StrykerJS) and Python (cosmic-ray, read from each mutant's diff) report the full `original → mutated` form; Rust (cargo-mutants) and PHP (Infection) expose only the mutated side, so their entries carry just that. When `diffBase` is used, the output may include a `scopeNote` (a top-level JSON field / a `Scope:` text line) reporting scoping decisions, for example a skipped run when nothing changed, or a whole-file fallback for Python/Rust targets.

**JSON output (default, emitted as a single compact line):**

```json
{
  "target": "src/utils/math.ts",
  "mutationScore": "91.67%",
  "summary": { "total": 12, "killed": 11, "survived": 1, "worstSeverity": "high" },
  "survivors": [
    {
      "line": 42,
      "mutators": { "ConditionalExpression": 1 },
      "changes": ["a > b → a >= b"],
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

## Tool parameters

| Parameter          | Type                              | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | --------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filePath`         | `string`                          | Yes      | Workspace-relative path to the file (`.ts`, `.js`, `.tsx`, `.jsx`, `.py`, `.rs`, `.php`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `timeoutMs`        | `number`                          | No       | Max run time in ms (default: 300000 / 5 min)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `lineScope`        | `{ start, end }`                  | No       | 1-based line range (StrykerJS only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `diffBase`         | `string`                          | No       | Auto-scope mutation to git-changed lines. `"HEAD"` (uncommitted), `"staged"`, or a git ref (e.g. `"main"`, via merge-base). Mutually exclusive with `lineScope`. Line-level scoping is StrykerJS-only; other languages run whole-file with a note. No changes vs base → run skipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `baseline`         | `object`                          | No       | Verify mode. Pass back a prior run's `{ survivors, noCoverage }` to re-test only those mutants and get a delta (`nowKilled` / `stillSurviving` / `newSurvivors`). Re-run auto-scopes to the baseline lines (StrykerJS) or whole-file (other languages). Mutually exclusive with `diffBase`/`lineScope`. Verify mode keys on line numbers, so run it after **adding tests**, not after editing the source under test, since edits shift line numbers and would misreport which mutants were killed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `mutatorAllowlist` | `string[]`                        | No       | Not supported in StrykerJS v9, ignored (use `mutatorDenylist`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `mutatorDenylist`  | `string[]`                        | No       | Stryker mutator names to exclude                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `concurrency`      | `number`                          | No       | Parallel mutation workers (StrykerJS only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `dryRun`           | `boolean`                         | No       | Validate test suite only, no mutations (StrykerJS only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `outputFormat`     | `"json"` \| `"text"`              | No       | Output format (default: `"json"`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `incremental`      | `boolean`                         | No       | Reuse previous run results (StrykerJS only). State is cached per (workspace, file) OUTSIDE the sandbox, because the sandbox is deleted after each run and without that the option would have nothing to reuse                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ignorePatterns`   | `string[]`                        | No       | Path segments to exclude from the sandbox, in addition to the built-in exclusions. A path is skipped when any of its segments **equals** the pattern exactly, not a substring match, so `"dist"` excludes `dist/` but not `src/dist-utils.js`. One trailing path separator is stripped (`"fixtures/"` works; on Windows that is a trailing `\`); empty patterns are ignored. Naming a dependency directory (`node_modules`, `.venv`/`venv`, `vendor`) also suppresses the dependency link, so the sandbox is left without it and the run will usually fail. Chaos-MCP warns when an exclusion does that to a directory that exists, except under `sandbox.dependencies: "copy"`, which links nothing to warn about and drops the directory silently.                                                                                                                                                                                                                                                                                 |
| `enrich`           | `boolean`                         | No       | Annotate each survivor with severity, why-it-matters, a test hint, and source context, and ranks severity-first. **Default: `true`** (pass `false` to disable and return plain unranked output). Richest for TypeScript; Python degrades to `severity: "unknown"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `maxSurvivors`     | `integer ≥ 1`                     | No       | Cap on how many survivor (and no-coverage) line groups are returned after severity ranking. Hidden groups counted in `survivorsTruncated`/`noCoverageTruncated`. Precedence: arg > `defaultMaxSurvivors` config > 10.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `severityFloor`    | `"high"` \| `"medium"` \| `"low"` | No       | Drop survivor groups below this severity (requires enrichment, on by default). Dropped groups counted in `survivorsFiltered`/`noCoverageFiltered`. `"unknown"`-severity groups are below `"low"` and are dropped by any floor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `runId`            | `string`                          | No       | Verify mode by cached id: re-run against the survivor baseline saved from a prior audit (the `runId` it returned). Mutually exclusive with `baseline`, `diffBase`, and `lineScope`. Unknown or expired ids (cache TTL: ~24 h) return an error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `suppress`         | `object[]`                        | No       | Mark mutants as equivalent (unkillable). Each entry: `{ "line": N, "mutator": "MutatorName" }`, plus an optional `reason` explaining why the mutant is equivalent and an optional `change` (the `"original → mutated"` string) naming **which** mutant when one line carries several of that mutator. Omit `change` and it is resolved from this run's survivors; if several match, the entry is refused and the candidates are listed. Persisted to `.chaos-mcp/suppressions.json`; suppressed mutants are auto-excluded from the score denominator and from future `audit` and `triage` output. An entry is identified by its mutator and change rather than its line, so it follows the code when an edit moves it, and the stored line is rewritten when it does. The output fields `suppressedCount`, `relocatedSuppressions`, `driftedSuppressions`, `unverifiedSuppressions`, `orphanedSuppressions` and `rejectedSuppressions` report how many were excluded, moved, rejected, unverifiable, inert, and refused at write time. |
| `unsuppress`       | `object[]`                        | No       | Remove previously-suppressed mutants for this file. Each entry: `{ "line": N, "mutator": "MutatorName" }`, plus an optional `change` to remove one specific entry; omit it to remove every entry for that mutator. The `line` is ignored when matching, so an entry that has relocated is still removable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `minScore`         | `number 0–100`                    | No       | Gate threshold. When the mutation score is below this value, the output includes `gate: { minScore, passed: false }`. Never an error. Uses the suppression-adjusted score.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development setup and the full parameter semantics.

## State & the verify loop

### Verify loop via `runId`

Every successful, non-verify `audit_code_resilience` call returns a `runId` (an 8-character id) in its JSON output. Use it to re-verify without copying the full `baseline` object:

1. **Audit:** `{ "filePath": "src/utils/math.ts" }` → response includes `"runId": "a1b2c3d4"`.
2. **Fix or add tests.**
3. **Verify:** `{ "filePath": "src/utils/math.ts", "runId": "a1b2c3d4" }` → reports which previously-surviving mutants are now killed.

`runId` is mutually exclusive with `baseline`, `diffBase`, and `lineScope`. The baseline cache lives in `os.tmpdir()/chaos-mcp-runs/<hash-of-server-cwd>/`, partitioned per server working directory so two checkouts served by two servers never read each other's entries, and is ephemeral (default TTL: 24 h; default max: 200 entries). Passing an unknown or expired `runId` returns an error.

`triage_test_coverage` also mints and returns a `runId` per ranking row, so you can drill into a weak file and immediately verify after fixing its tests.

### Suppressing equivalent mutants

Some mutants are _equivalent_, logically identical to the original under all possible inputs, and cannot be killed by any test. Suppress them so they stop appearing in the output and stop dragging down the score:

```json
{
  "filePath": "src/utils/math.ts",
  "suppress": [
    { "line": 99, "mutator": "StringLiteral", "reason": "guard always true for this type" }
  ]
}
```

Suppressed mutants are:

- **Persisted** to `<workspaceRoot>/.chaos-mcp/suppressions.json` (keyed by workspace-relative file path).
- **Identified by content**: an entry names the mutator _and the change the mutant makes_, not the line it sits on, so it follows the code when an edit moves it.
- **Auto-excluded** from every future `audit` and `triage` call for that file, with no flag needed.
- **Removed from the score denominator**: `mutationScore` rises and the output field `suppressedCount` tells you how many were excluded.
- **Excluded from verify mode**: suppressed mutants won't appear as "still surviving".

To undo a wrong suppression:

```json
{
  "filePath": "src/utils/math.ts",
  "unsuppress": [{ "line": 99, "mutator": "StringLiteral" }]
}
```

**`.gitignore` or commit?** Add `.chaos-mcp/` to `.gitignore` if the suppression list is personal, or commit it to share the equivalent-mutant list with the team. Suppression keys are workspace-relative, so the file is portable across machines.

#### Naming which mutant: the `change` field

One line can carry several mutants of the same mutator. This single line emits **four** `ConditionalExpression` mutants and **two** `LogicalOperator` mutants:

```ts
if (typeof g !== 'object' || g === null || Array.isArray(g)) return false;
```

A `{ line, mutator }` pair cannot say which of them you mean, so an entry identifies its mutant by the **change** it makes: the `"original → mutated"` string, the same form the report's `changes` field uses:

```json
{
  "suppress": [
    {
      "line": 331,
      "mutator": "ConditionalExpression",
      "change": "g === null → false",
      "reason": "the null case is rejected by the group.line check below"
    }
  ]
}
```

`change` is **optional**. Omit it and Chaos-MCP resolves it from that run's survivors, so the ordinary two-field call still works. When several distinct mutants match, the entry is **refused** rather than suppressing all of them, and the response lists the candidate `change` values to choose from. The report's own `changes` field is capped at three per line and aggregated across mutators, so on exactly these lines it cannot show them all.

Replacement text alone is not enough to identify a mutant: several `ConditionalExpression` mutants on one line can all replace their span with `true`, and only the _original_ span tells them apart. That is why the change carries both halves.

#### Staleness is detected, and usually repaired

Each entry also stores a `fingerprint`: a digest of the normalized source line (trimmed, internal whitespace collapsed) it was recorded against. Every run resolves each stored entry through a ladder, and **ambiguity at any step is a refusal, nothing is ever guessed**:

| Outcome    | Meaning                                                                            | Applied?                                      |
| ---------- | ---------------------------------------------------------------------------------- | --------------------------------------------- |
| applied    | the stored line still matches the stored fingerprint                               | yes, counted in `suppressedCount`            |
| relocated  | the line moved, or was edited and the mutant found by its change; entry re-pointed | yes, also counted in `relocatedSuppressions` |
| drifted    | the mutant could not be placed, or more than one candidate matched                 | **no**, counted in `driftedSuppressions`     |
| unverified | the entry has no fingerprint (written before v2)                                   | **no**, counted in `unverifiedSuppressions`  |
| orphaned   | the entry was placed but matched no surviving mutant, inert                       | n/a, counted in `orphanedSuppressions`       |

A **relocation is written back** to `suppressions.json`, so the repair happens once rather than on every run. Expect the file to show up in `git status` after an edit that moved a suppressed line.

An entry relocates in one of two ways. If the **line's content is unchanged** and simply moved, the match is exact and the move is reported as a bare count. If the **line itself was edited**, reflowed or a variable renamed or a comment appended, the mutant is found by its change instead, and that one can be wrong: if the original site was _deleted_ and an unrelated site happens to produce the same change, the entry lands on code its `reason` was never written about. Those moves are reported individually, with the reason quoted, so you can confirm or drop them.

The bias throughout is deliberate: a suppression that is not applied lowers your score _visibly_, while one applied to the wrong code hides a real coverage gap _invisibly_. To restore a drifted or unverified entry, re-issue the same `suppress` argument, which re-stamps the fingerprint and keeps the existing `reason` and `addedAt` (a new `reason`, if you pass one, replaces the old).

An `orphaned` entry means one of three things and Chaos-MCP cannot tell which: the mutant is now killed, its identity no longer exists, or a `mutatorDenylist` entry stopped it being generated. It is inert either way, so drop it with `unsuppress` unless you know the mutant still exists.

**Migrating an older file.** `version: 1` and `version: 2` files load unchanged; every entry keeps its `line`, `mutator`, `reason` and `addedAt`, and nothing is deleted or back-filled.

- **v1** entries have no fingerprint and report as `unverified` until re-confirmed.
- **v2** entries have no `change`, so they fall back to mutator-only identity, _broader_ than the mutant they were filed against, since one entry then covers every mutant of that mutator on its line, including ones added later.

To migrate a v2 corpus, run `node scripts/migrate-suppressions-v3.mjs --write`. It re-points entries whose line moved but whose content is unchanged, refuses to guess at anything ambiguous, and writes a replay payload; feeding those entries back through `audit_code_resilience` resolves each `change` from that run's survivors.

### Config keys for state

| Key                | Default                        | Description                                                   |
| ------------------ | ------------------------------ | ------------------------------------------------------------- |
| `suppressionsPath` | `.chaos-mcp/suppressions.json` | Path to the suppression file (workspace-relative or absolute) |
| `runCacheTtlMs`    | `86400000` (24 h)              | Run-cache entry TTL in milliseconds                           |
| `runCacheMax`      | `200`                          | Max cached run entries; oldest are evicted when exceeded      |

## Batch triage: `triage_test_coverage`

A second tool ranks where your test suite is weakest across many files in one call.

```json
{ "paths": ["src/utils", "src/index.ts"], "maxFiles": 25 }
```

Directories are recursively expanded to supported source files (test files skipped), audited in **bounded parallel** (default `max(1, min(4, cpus-1))` files at a time; capped at `maxFiles`; precedence `maxFiles` arg → `defaultMaxFiles` config → 25), and ranked weakest-first by mutation score:

```json
{
  "mode": "triage",
  "summary": { "filesDiscovered": 30, "filesAudited": 25, "filesSkipped": 5, "filesErrored": 0 },
  "ranking": [
    {
      "file": "src/a.ts",
      "mutationScore": "62.50%",
      "total": 16,
      "killed": 10,
      "survived": 5,
      "noCoverage": 1
    }
  ],
  "errors": [],
  "note": "Ranked weakest-first by mutation score. Drill into a file with audit_code_resilience for survivor detail."
}
```

The tool response carries a `structuredContent` field (in addition to the text block) so MCP clients can consume the ranked payload directly without parsing JSON. The `outputSchema` on the tool definition describes the payload shape.

Drill into a weak file with `audit_code_resilience` for per-mutant survivor detail.

**PR-diff scan (`diffBase`):**

Pass `diffBase` to limit the triage to files changed in a PR or branch. `paths` becomes optional in this mode:

```json
{ "diffBase": "main" }
```

`diffBase` alone audits every changed supported source file in the workspace (relative to `main` via merge-base). Passing both limits the scan to changed files under those paths:

```json
{ "diffBase": "main", "paths": ["src/utils"] }
```

TypeScript files are mutated only on the changed lines; Python and Rust files run whole-file (a per-file `scopeNote` is included in the ranking row).

**Inline survivor detail (`survivorsPerFile`):**

```json
{ "paths": ["src"], "survivorsPerFile": 3 }
```

`survivorsPerFile` (default `0`, scores-only) inlines the top-N severity-ranked, enriched survivor groups into each ranking row so you can triage and inspect in one call. Set it to `0` for the compact leaderboard; raise it when you want to see the worst gaps immediately.

**Parallel file auditing (`fileConcurrency`):**

```json
{ "paths": ["src"], "fileConcurrency": 8 }
```

`fileConcurrency` controls how many files are audited in parallel (default `max(1, min(4, cpus-1))`; range 1–64). When `fileConcurrency > 1` and the file is TypeScript, each StrykerJS run's worker count is automatically capped (`floor((cpus-1) / fileConcurrency)`) so total CPU use stays near the core count rather than oversubscribing. Other languages run their mutation tool without a worker-count override (they ignore the concurrency cap).

**Parameters:**

| Parameter          | Type                 | Description                                                                                                                                                                                                                   |
| ------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paths`            | `string[]`           | Workspace-relative files/dirs to triage. Optional when `diffBase` is provided.                                                                                                                                                |
| `maxFiles`         | `integer ≥ 1`        | Cap on files audited (precedence: arg → `defaultMaxFiles` config → 25).                                                                                                                                                       |
| `timeoutMs`        | `number > 0`         | Per-file mutation-run timeout in ms (default: 300000). Also clamped by whatever remains of `totalTimeoutMs`.                                                                                                                  |
| `totalTimeoutMs`   | `number > 0`         | Wall-clock budget for the whole sweep (default: 900000 = 15 min). Files not started before it runs out are returned in `unaudited` with `stoppedReason: "time_budget_exhausted"`, so a large sweep still returns its ranking. |
| `mutatorDenylist`  | `string[]`           | Stryker mutator names to exclude, applied to every TypeScript/JS file.                                                                                                                                                        |
| `outputFormat`     | `"json"` \| `"text"` | Output format (default: `"json"`).                                                                                                                                                                                            |
| `diffBase`         | `string`             | Auto-scope to git-changed files. `"HEAD"`, `"staged"`, or any git ref/SHA. Makes `paths` optional; with `paths`, intersects changed files under those paths. TypeScript: changed lines only. Other languages: whole-file.     |
| `survivorsPerFile` | `integer ≥ 0`        | Inline top-N enriched survivors per ranked file (default `0` = scores-only).                                                                                                                                                  |
| `fileConcurrency`  | `integer 1–64`       | Files audited in parallel (default `max(1, min(4, cpus-1))`). Per-file StrykerJS worker count is automatically capped (TypeScript/StrykerJS only; other engines ignore the worker-count cap).                                 |
| `minScore`         | `number 0–100`       | Gate threshold. Per-row `passed` field + top-level `gate: { minScore, passed, failingFiles }` in output. Never an error. A row whose audit was cut short (`complete: false`) fails the gate regardless of its score.          |

## Pre-flight estimate: `estimate_audit`

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

**With timing** (`withTiming: true`): runs the test suite once to measure a baseline, then estimates total wall-clock time as `mutants × baseline / concurrency`. This provisions a sandbox and counts against your machine's resources, so use it when you want a time budget before a large audit.

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

| Language                | Fidelity | Basis                                                    |
| ----------------------- | -------- | -------------------------------------------------------- |
| Rust                    | `exact`  | `cargo-mutants --list` (generated mutants; no tests run) |
| TypeScript / JavaScript | `approx` | source-parse heuristic                                   |
| Python                  | `approx` | source-parse heuristic                                   |

For Rust, the estimate is exact for the mutants `cargo mutants --list` _generates_ without running tests. The audit itself scores fewer, since mutants that fail to compile are excluded from its denominator and reported as `incompetent`. For all other languages the count is approximate, a lightweight heuristic over the source AST, and the actual audit may differ. Run `audit_code_resilience` for exact results.

If `cargo-mutants` is not installed, the Rust path falls back to the heuristic and reports `fidelity: "approx"` with a note.

### Parameters

| Parameter    | Type      | Required | Description                                                                                                 |
| ------------ | --------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `filePath`   | `string`  | Yes      | Workspace-relative path to the file to estimate.                                                            |
| `withTiming` | `boolean` | No       | When `true`, runs the test suite once to measure `baselineMs` and computes `estimatedMs`. Default: `false`. |

### Use case

Call `estimate_audit` first when you are unsure whether a file is too large to audit interactively:

1. `estimate_audit { "filePath": "src/big.ts" }` → 300 mutants, approx.
2. Consider scoping with `lineScope` or `diffBase`, or scheduling the full run with a longer `timeoutMs`.
3. `audit_code_resilience { "filePath": "src/big.ts", "diffBase": "HEAD" }` → audits only your changed lines.

## Gate mode: `minScore`

Both `audit_code_resilience` and `triage_test_coverage` accept a `minScore` parameter (0–100). When the mutation score falls below the threshold, the result reports the gate as failed. **A failing gate is never an error**. It is a data field for an agent or CI pipeline to read and act on.

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
    "failingFiles": ["src/utils/math.ts", "src/parser.ts"],
    "notGraded": { "errored": 0, "unaudited": 0 },
    "reason": "below_threshold"
  }
}
```

**The triage gate fails closed.** `gate.passed` is `false` if any file's score is below `minScore` **or if any requested file was never measured**: one that errored during the sweep (also listed in `errors[]`) or that the `totalTimeoutMs` budget never reached (also listed in `unaudited[]`). Grading a sweep on whichever subset happened to finish would let a CI step keyed on `gate.passed` go green over ungraded code, so an incomplete sweep never passes. A file audited only partially (its `complete` is `false`) fails on the same basis.

The gate object always carries `minScore`, `passed`, `failingFiles`, and `notGraded` whenever `minScore` was supplied:

- `failingFiles`: workspace-relative paths that were measured and scored below `minScore`.
- `notGraded`: `{ "errored": <count>, "unaudited": <count> }`, the files that produced no score at all.
- `reason`: present only on a failure, and the only machine-readable way to tell the two causes apart:
  - `"below_threshold"`: at least one file was measured and scored too low (`failingFiles` is non-empty).
  - `"files_not_graded"`: every measured file passed, but something was never measured (`failingFiles` is empty and `notGraded` is non-zero).

A `passed: false` with an empty `failingFiles` is therefore expected, not a bug: check `reason` and `notGraded` before assuming a score problem.

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
  "defaultFileConcurrency": 4,
  "container": {
    "mode": "auto",
    "runtime": "docker",
    "cpus": 2,
    "memoryMb": 4096
  }
}
```

Tool call arguments override config defaults.

| Config key               | Type                              | Default                              | Description                                                                                                                             |
| ------------------------ | --------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultTimeoutMs`       | `number`                          | `300000`                             | Per-file timeout in ms                                                                                                                  |
| `mutatorDenylist`        | `string[]`                        | `[]`                                 | Mutator names to exclude globally                                                                                                       |
| `concurrency`            | `number`                          | `4`                                  | Parallel mutation workers                                                                                                               |
| `defaultMaxFiles`        | `number`                          | `25`                                 | Default triage file cap (integer ≥ 1); overridden by the `maxFiles` argument                                                            |
| `defaultMaxSurvivors`    | `number`                          | `10`                                 | Default cap on survivor/no-coverage groups returned by `audit_code_resilience` (integer ≥ 1); overridden by the `maxSurvivors` argument |
| `defaultSeverityFloor`   | `"high"` \| `"medium"` \| `"low"` | –                                    | Default severity floor for survivor reporting; overridden by the `severityFloor` argument                                               |
| `defaultFileConcurrency` | `number`                          | `max(1, min(4, cpus-1))`             | Default parallel file count for `triage_test_coverage` (integer 1–64); overridden by the `fileConcurrency` argument                     |
| `container`              | `object`                          | `{ "mode": "native" }`               | Optional shared OCI execution backend for TypeScript, Python, Rust, and PHP                                                             |
| `sandbox`                | `object`                          | `{ "dependencies": "link-entries" }` | Sandbox provisioning. `dependencies` chooses how `node_modules`, `.venv`/`venv` and `vendor` are materialised , see below               |

### Sandbox dependencies

```json
{ "sandbox": { "dependencies": "link-entries" } }
```

| `dependencies` | What the sandbox gets                                                   | A write under it                                                                                                                    |
| -------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `link-entries` | **Default.** A real directory holding one symlink per installed package | To a **new** path (`.vite-temp`, a lockfile, a cache) stays in the sandbox; **through** an existing package still reaches your tree |
| `copy`         | A full copy of the tree                                                 | Always stays in the sandbox. The only mode that fully contains a suite which writes through its own dependencies , and the slowest  |
| `share`        | One symlink for the whole directory (the pre-1.8 behaviour)             | Always reaches your real workspace. Opt in knowingly                                                                                |

PHP's `vendor/` is always copied regardless of this setting, because Composer's
autoloader resolves `__DIR__` through symlinks back to the real workspace.
An unrecognised value is dropped and the default applies.

### Container execution

Container mode removes the need to install StrykerJS, Cosmic Ray,
cargo-mutants, or Infection on the host. Chaos-MCP starts one hardened,
short-lived container per audit, mounts the temporary sandbox at `/workspace`,
and runs both prebuild and mutation commands in that session. The real
workspace is never mounted. Recognized dependency trees linked into the
sandbox may be mounted separately and read-only, as described below.

```json
{
  "container": {
    "mode": "container",
    "runtime": "docker",
    "network": "bridge",
    "cpus": 2,
    "memoryMb": 4096,
    "pidsLimit": 512,
    "startupTimeoutMs": 60000,
    "tmpfsSizeMb": 2048
  }
}
```

Modes:

- `native` (default) preserves the existing host-subprocess behavior.
- `container` requires Docker or Podman and fails clearly when unavailable.
- `auto` uses containers when the configured runtime is reachable and otherwise
  falls back to native. Image or project failures do not silently fall back.

Each image carries exactly one language runtime, so a suite that spawns another
language's toolchain cannot run inside it. Override the mode for just that
language rather than giving up containers everywhere:

```json
{
  "container": {
    "mode": "container",
    "modes": { "php": "native" }
  }
}
```

Container settings:

| Key                | Type                          | Default                   | Description                                                                                                                                                                                                                |
| ------------------ | ----------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`             | `native \| container \| auto` | `native`                  | Select the execution backend or runtime-only fallback behavior                                                                                                                                                             |
| `modes`            | per-language mode map         | none                      | Override `mode` for `typescript`, `python`, `rust`, or `php` individually; wins over `mode` for that language                                                                                                              |
| `runtime`          | `docker \| podman`            | `docker`                  | OCI-compatible command used to create and manage audit containers                                                                                                                                                          |
| `network`          | `string`                      | `bridge`                  | Container network mode or name; use `none` when project tests need no network                                                                                                                                              |
| `cpus`             | positive number               | `2`                       | CPU limit for each audit container                                                                                                                                                                                         |
| `memoryMb`         | positive integer              | `4096`                    | Memory limit in MiB for each audit container                                                                                                                                                                               |
| `pidsLimit`        | positive integer              | `512`                     | Maximum number of processes in each audit container                                                                                                                                                                        |
| `startupTimeoutMs` | positive integer              | 60 s startup; 10 s probe  | Override the timeout for runtime probing, container creation, and startup                                                                                                                                                  |
| `tmpfsSizeMb`      | positive integer              | `2048`                    | Size of the writable `/tmp`. The container root filesystem is read-only and host dependency directories are mounted read-only, so `/tmp` holds every toolchain cache (Cargo registry, npm cache, per-mutant working files) |
| `images`           | per-language image map        | release-matched GHCR tags | Override the `typescript`, `python`, `rust`, or `php` image                                                                                                                                                                |

The images pin the language runtime and mutation engine, while the project
still supplies its own test dependencies. Which dependency trees get mounted
follows `sandbox.dependencies`: under `link-entries` (the default) and `share`
the **host** trees (`node_modules`, `.venv`/`venv`, and `vendor`) are
bind-mounted read-only at their own absolute paths, which is what makes the
sandbox's symlinks into them resolve inside the container, with one exception:
`node_modules/.vite-temp` gets a small writable tmpfs, because Vite writes a
bundled copy of the config it is loading there and a read-only tree would fail
the config load of every vitest project. The scratch is discarded with the
container and project test code still cannot write to the real dependency tree.
Under `copy` nothing extra is mounted and no tmpfs is needed, because the copies
already live inside the sandbox, which is itself mounted writable at
`/workspace`.
Dependencies containing native
extensions must be compatible with the selected Linux image; use an image
override when the project requires another runtime or platform build.
Chaos-MCP selects release-matched GHCR images for all four languages by
default; the optional `images` map accepts per-language tags or digest-pinned
references for private mirrors and custom runtimes.

The official images are published for Linux AMD64 and ARM64:

| Language                | Default image                                   |
| ----------------------- | ----------------------------------------------- |
| TypeScript / JavaScript | `ghcr.io/araneadev/chaos-mcp-typescript:vX.Y.Z` |
| Python                  | `ghcr.io/araneadev/chaos-mcp-python:vX.Y.Z`     |
| Rust                    | `ghcr.io/araneadev/chaos-mcp-rust:vX.Y.Z`       |
| PHP                     | `ghcr.io/araneadev/chaos-mcp-php:vX.Y.Z`        |

The server never installs target-project dependencies. It reuses the recognized
dependency directories the project already has (`node_modules`, `.venv`/`venv`,
and `vendor`), mounting the host trees read-only under `link-entries` and
`share` and using the sandbox's own copies under `copy`. Install the target
project's dependencies before auditing it.

Containers run with a read-only root filesystem, all Linux capabilities
dropped, `no-new-privileges`, a private temporary filesystem, and configurable
CPU, memory, and PID limits. Resource usage defaults to a conservative two CPUs
and 4096 MiB of memory. The entire container is forcibly removed on timeout,
cancellation, normal completion, or engine failure.

Network mode is part of the audit's isolation boundary. The `bridge` default
allows outbound access for tests or dependency resolution; use
`"network": "none"` for untrusted code or offline audits that do not require
network access. Avoid host networking unless the target project explicitly
requires it and you accept the reduced isolation.

Check runtime connectivity and whether all four configured images are already
present without pulling anything:

```sh
node build/index.js --container-doctor
```

The doctor exits non-zero when the runtime is unavailable or any configured
image is missing. Pull the reported image, or set a matching entry in
`container.images`, and run it again. `startupTimeoutMs` only governs runtime
probing and container startup; `defaultTimeoutMs` and per-tool `timeoutMs`
govern the mutation audit itself.

### Enabling `prebuildCommand`

The `prebuildCommand` tool argument runs an arbitrary shell command inside the sandbox, which can reach outside it. It is **disabled by default**. Enable it explicitly with `"allowPrebuild": true` in `chaos-mcp.config.json`, or by setting the `CHAOS_MCP_ALLOW_PREBUILD=1` environment variable. The auto-detected prebuild for Rust (`cargo check`) runs without this flag.

### Python test commands declared by the audited project

Mutation testing runs the audited project's test suite. That is the job, but
the Python engine resolves its test command partly from the **audited
project's own** `pyproject.toml`, via the `[tool.mutmut] runner` key, and
cosmic-ray executes that string through a shell once per mutant. Accepting an
arbitrary command line from repository content is the same hazard
`prebuildCommand` is gated for, so it is bounded the same way:

- A **bare executable name** (`nose2`, `ward`, `green`) is accepted. It can name
  a program to run and nothing else: no arguments, no `;`, `|`, `&&`, `$(...)`,
  or redirects.
- Anything else is **refused with an explanation** rather than silently replaced
  with pytest, which would quietly change which tests can kill a mutant.

To run such a command deliberately, either set it in **your** config (which is
trusted, being your file):

```json
{ "cosmicray": { "testRunner": "python -m unittest discover" } }
```

or set `CHAOS_MCP_ALLOW_REPO_TEST_COMMAND=1` to trust project-declared commands
in this workspace.

### Auditing workspaces outside the working directory

By default Chaos-MCP only audits files beneath the directory the process was
launched in: the workspace-root walk stops at `process.cwd()`, and the sandbox
refuses to copy anything that escapes it. For an MCP server, which is launched
once with a fixed cwd, that means a server started in project A cannot audit
project B at all.

Set `CHAOS_ALLOWED_ROOTS` to name additional roots, separated by the platform
path delimiter (`:` on POSIX, `;` on Windows):

```json
{
  "mcpServers": {
    "chaos-mcp": {
      "command": "node",
      "args": ["/path/to/Chaos-MCP/build/index.js"],
      "env": { "CHAOS_ALLOWED_ROOTS": "/srv/project-b:/srv/project-c" }
    }
  }
}
```

A workspace is accepted when it is inside the working directory **or** inside
one of these roots; everything else is still refused. Descendants of a listed
root are included, siblings and parents are not. When roots nest (a monorepo and
one of its packages), the innermost match bounds the root walk. Leaving the
variable unset keeps the cwd-only behaviour exactly as before.

## Supported test runners (auto-detected)

| Language      | Mutation Tool | Detected Runners                             |
| ------------- | ------------- | -------------------------------------------- |
| TypeScript/JS | StrykerJS     | vitest, jest, mocha, jasmine, bun, node:test |
| Python        | cosmic-ray    | pytest, unittest                             |
| Rust          | cargo-mutants | cargo test, cargo-nextest                    |
| PHP           | Infection     | phpunit                                      |

## CLI flags

```
chaos-mcp [flags]

  --version   Print version and exit
  --help      Show help text and exit
  --config    Path to a JSON config file
  --container-doctor
              Check runtime connectivity and whether all four configured
              container images are present without pulling them
  --verbose   Enable diagnostic logging to stderr
```

## Protocol features

### Progress notifications

When an MCP client includes a `progressToken` in a tool call's `_meta` field, Chaos-MCP emits `notifications/progress` events during the run. Clients that omit `progressToken` receive no notifications , there is zero overhead for clients that do not opt in.

**Triage** emits one notification per file as it completes:

| Field      | Value                  |
| ---------- | ---------------------- |
| `progress` | files completed so far |
| `total`    | total files to audit   |
| `message`  | `"audited X/N"`        |

**Audit** emits four coarse milestones:

| `progress` | `total` | `message`                   |
| ---------- | ------- | --------------------------- |
| 1          | 4       | `"validating"`              |
| 2          | 4       | `"provisioning sandbox"`    |
| 3          | 4       | `"running mutation engine"` |
| 4          | 4       | `"complete"`                |

**Estimate** does not emit progress notifications.

### Cancellation

Cancelling an in-flight MCP request aborts the run cleanly:

- The abort signal propagates through the tool handler into `RunOptions.signal` and from there into the mutation engine subprocess, terminating it.
- The sandbox is always cleaned up even if cancellation occurs mid-run.
- The cancelled call returns `"Operation cancelled."` as a tool error rather than throwing.

All three tools (`audit_code_resilience`, `triage_test_coverage`, `estimate_audit`) respect cancellation.

### Resources

The server exposes three static resources, discoverable via `resources/list` and readable via `resources/read`:

| URI                     | MIME type          | Contents                                                                                                                                          |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chaos://languages`     | `application/json` | Per-language entry: engine name, `supportsLineScope`, estimate fidelity (`"exact"` or `"approx"`), config key, and whether an auto-prebuild runs. |
| `chaos://config-schema` | `application/json` | Every `chaos-mcp.config.json` key with its type and a short description.                                                                          |
| `chaos://capabilities`  | `text/markdown`    | All three tools (args summary) and the triage → audit → verify workflow loop.                                                                     |

### Prompts

The server exposes two prompts, discoverable via `prompts/list` and retrieved via `prompts/get`:

| Prompt           | Required argument | Purpose                                                                                                                                                             |
| ---------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harden_file`    | `filePath`        | Returns a `user`-role message walking an agent through: optional estimate → audit → write tests for survivors → verify by `runId` → repeat until clean.             |
| `triage_changes` | `diffBase`        | Returns a `user`-role message walking an agent through: triage changed files weakest-first → harden the weakest → move down the ranking until the score bar is met. |

## Development

```bash
npm run check         # Full CI pipeline: build + lint + format + test
npm run test:watch    # Watch mode for iterative development
npm run test:coverage # Tests with coverage report
```

The suite runs on every push/PR to `main` via [CI](./.github/workflows/ci.yml) (Node 22/24). v8 line/statement coverage of `src/` sits at **~99%**, and the source is additionally hardened by running Chaos-MCP against its own code, so the suite is graded by mutation score rather than by line coverage alone.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for detailed development setup and contribution guidelines.

## License

MIT. See [LICENSE](LICENSE) for details.

## Links

- [MCP Documentation](https://modelcontextprotocol.io/)
- [StrykerJS](https://stryker-mutator.io/)
- [cosmic-ray](https://github.com/sixty-north/cosmic-ray)
- [cargo-mutants](https://github.com/sourcefrog/cargo-mutants)
- [Infection](https://infection.github.io/)
- [Changelog](CHANGELOG.md)
