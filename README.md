# Chaos-MCP

> On-demand micro-mutation sandbox for AI test verification — maps holes in unit tests by running isolated mutation testing via the Model Context Protocol.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![status: in development](https://img.shields.io/badge/status-in%20development-orange.svg)](#)

> **Pre-release / in active development.** Chaos-MCP is **not yet published to npm** and is **not on a public host** — it currently lives in a private [Forgejo](https://forgejo.org/) repository. Install from source (see [Installation](#installation)). Any `npm install -g` / `npx` commands in this README describe the planned published experience and do not work yet.

Chaos-MCP is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes two tools — `audit_code_resilience` (audit a single file) and `triage_test_coverage` (rank a whole tree weakest-first) — which run isolated mutation testing against your source to find weaknesses in the local test suite. It intentionally injects logical faults (like changing `>` to `>=`) and checks whether your tests catch them. Surviving mutants indicate test coverage holes.

## Features

- **4 Languages Supported** — TypeScript/JavaScript (StrykerJS), Python (Mutmut), Go (go-mutesting), Rust (cargo-mutants)
- **Sandbox Isolation** — all mutation runs execute in temporary directories; your real workspace is never touched
- **Auto-Detection** — automatically detects project type, test runner, and workspace root
- **Async Subprocesses** — all mutation-tool execution uses async `execFile`/`exec` (subprocess runs never block the event loop; the one-time sandbox copy is synchronous)
- **Rich Tool Schema** — supports line scoping, mutator denylists, concurrency control, dry-run mode, incremental runs, and output format selection
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

The primary tool is `audit_code_resilience` (the batch tool `triage_test_coverage` is documented [below](#batch-triage--triage_test_coverage)).

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
  "outputFormat": "text"
}
```

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
  "summary": { "total": 12, "killed": 11, "survived": 1 },
  "survivors": [
    { "line": 42, "mutators": { "ConditionalExpression": 1 }, "changes": ["a > b → a >= b"] }
  ],
  "noCoverage": [],
  "note": "survivors: mutants your tests ran but did not kill. noCoverage: mutants no test reached (per line+mutator, so a line may appear here and in survivors). mutators = type→count. Add or strengthen tests targeting these. changes = sampled original→mutated edits for that line (capped)."
}
```

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

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development setup and the full parameter semantics.

## Batch Triage — `triage_test_coverage`

A second tool ranks where your test suite is weakest across many files in one call.

```json
{ "paths": ["src/utils", "src/index.ts"], "maxFiles": 25 }
```

Directories are recursively expanded to supported source files (test files skipped), audited **serially** (capped at `maxFiles`; precedence `maxFiles` arg → `defaultMaxFiles` config → 25), and ranked weakest-first by mutation score:

```json
{ "mode": "triage",
  "summary": { "filesDiscovered": 30, "filesAudited": 25, "filesSkipped": 5, "filesErrored": 0 },
  "ranking": [ { "file": "src/a.ts", "mutationScore": "62.50%", "total": 16, "killed": 10, "survived": 5, "noCoverage": 1 } ],
  "errors": [],
  "note": "Ranked weakest-first by mutation score. Drill into a file with audit_code_resilience for survivor detail." }
```

Drill into a weak file with `audit_code_resilience` for per-mutant survivor detail.

**Parameters:** `paths` (required array of files/dirs), `maxFiles` (integer ≥ 1), `timeoutMs` (per-file), `mutatorDenylist`, `outputFormat`.

## Configuration

Create a `chaos-mcp.config.json` in your workspace root for default settings:

```json
{
  "defaultTimeoutMs": 300000,
  "mutatorDenylist": ["StringLiteral"],
  "concurrency": 4,
  "defaultMaxFiles": 25
}
```

Tool call arguments override config defaults.

| Config key | Type | Default | Description |
|------------|------|---------|-------------|
| `defaultTimeoutMs` | `number` | `300000` | Per-file timeout in ms |
| `mutatorDenylist` | `string[]` | `[]` | Mutator names to exclude globally |
| `concurrency` | `number` | `4` | Parallel mutation workers |
| `defaultMaxFiles` | `number` | `25` | Default triage file cap (integer ≥ 1); overridden by the `maxFiles` argument |

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
