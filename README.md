# Chaos-MCP

> On-demand micro-mutation sandbox for AI test verification — maps holes in unit tests by running isolated mutation testing via the Model Context Protocol.

[![CI](https://github.com/codebuff/chaos-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/codebuff/chaos-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/chaos-mcp.svg)](https://www.npmjs.com/package/chaos-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Chaos-MCP is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes a single tool — `audit_code_resilience` — which runs isolated mutation testing against a target source file to identify weaknesses in the local test suite. It intentionally injects logical faults (like changing `>` to `>=`) and checks whether your tests catch them. Surviving mutants indicate test coverage holes.

## ✨ Features

- **4 Languages Supported** — TypeScript/JavaScript (StrykerJS), Python (Mutmut), Go (go-mutesting), Rust (cargo-mutants)
- **Sandbox Isolation** — all mutation runs execute in temporary directories; your real workspace is never touched
- **Auto-Detection** — automatically detects project type, test runner, and workspace root
- **Async & Non-Blocking** — all subprocess execution uses async `execFile` (no event loop blocking)
- **Rich Tool Schema** — supports line scoping, mutator allow/denylists, concurrency control, dry-run mode, incremental runs, and output format selection
- **Cross-Platform** — works on macOS, Linux, and Windows (with junction fallback for symlinks)

## 📦 Installation

### As an MCP Server (for AI clients)

```bash
npm install -g chaos-mcp
```

Or use directly via `npx`:

```bash
npx chaos-mcp
```

### For Local Development

```bash
git clone https://github.com/codebuff/chaos-mcp
cd chaos-mcp
npm install
npm run build
```

## 🚀 Quick Start

### 1. Start the Server

```bash
# If installed globally
chaos-mcp

# If installed locally
npm start

# With verbose logging
chaos-mcp --verbose

# With a config file
chaos-mcp --config ./chaos-mcp.config.json
```

### 2. Call the Tool from Your MCP Client

The server exposes a single tool: `audit_code_resilience`.

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

### 3. Interpret the Results

**JSON output (default):**
```json
{
  "target": "src/utils/math.ts",
  "totalMutants": 12,
  "killed": 11,
  "survived": 1,
  "mutationScore": "91.67%",
  "vulnerabilities": [
    {
      "line": 42,
      "replacement": "ConditionalExpression",
      "description": "Logical mutation via [ConditionalExpression] survived. Your tests did not catch this change."
    }
  ]
}
```

**Text output** (`"outputFormat": "text"`):
```
Chaos-MCP Audit Report: src/utils/math.ts
══════════════════════════════════════════════════
  Total mutants:  12
  Killed:         11
  Survived:       1
  Mutation score: 91.67%

⚠️  1 surviving mutant(s) found:

  Line 42: [ConditionalExpression]
    Logical mutation via [ConditionalExpression] survived. Your tests did not catch this change.
```

## 🛠️ Tool Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | `string` | ✅ | Workspace-relative path to the file (`.ts`, `.js`, `.tsx`, `.jsx`, `.py`, `.go`, `.rs`) |
| `timeoutMs` | `number` | ❌ | Max run time in ms (default: 300000 / 5 min) |
| `lineScope` | `{ start, end }` | ❌ | 1-based line range (StrykerJS only) |
| `mutatorAllowlist` | `string[]` | ❌ | Stryker mutator names to include |
| `mutatorDenylist` | `string[]` | ❌ | Stryker mutator names to exclude |
| `concurrency` | `number` | ❌ | Parallel mutation workers (StrykerJS only) |
| `dryRun` | `boolean` | ❌ | Validate test suite only, no mutations (StrykerJS only) |
| `outputFormat` | `"json"` \| `"text"` | ❌ | Output format (default: `"json"`) |
| `incremental` | `boolean` | ❌ | Reuse previous run results (StrykerJS only) |
| `ignorePatterns` | `string[]` | ❌ | Substring patterns to exclude from sandbox copy |

See [`docs/DRAFT.md`](docs/DRAFT.md) for the full API reference with examples.

## 🔧 Configuration

Create a `chaos-mcp.config.json` in your workspace root for default settings:

```json
{
  "defaultTimeoutMs": 300000,
  "mutatorDenylist": ["StringLiteral"],
  "concurrency": 4
}
```

Tool call arguments override config defaults.

## 🏃 Supported Test Runners (Auto-Detected)

| Language | Mutation Tool | Detected Runners |
|----------|--------------|------------------|
| TypeScript/JS | StrykerJS | vitest, jest, mocha, jasmine, bun, node:test |
| Python | Mutmut | pytest, tox, nox |
| Go | go-mutesting | go test, testify, ginkgo |
| Rust | cargo-mutants | cargo test, cargo-nextest |

## 📋 CLI Flags

```
chaos-mcp [flags]

  --version   Print version and exit
  --help      Show help text and exit
  --config    Path to a JSON config file
  --verbose   Enable diagnostic logging to stderr
```

## 🧪 Development

```bash
npm run check         # Full CI pipeline: build + lint + format + test
npm run test:watch    # Watch mode for iterative development
npm run test:coverage # Tests with coverage report
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for detailed development setup and contribution guidelines.

## 📄 License

MIT — See [LICENSE](LICENSE) for details.

## 🔗 Links

- [MCP Documentation](https://modelcontextprotocol.io/)
- [StrykerJS](https://stryker-mutator.io/)
- [Mutmut](https://github.com/boxed/mutmut)
- [go-mutesting](https://github.com/zimmski/go-mutesting)
- [cargo-mutants](https://github.com/sourcefrog/cargo-mutants)
- [Changelog](CHANGELOG.md)
