---

# Chaos-MCP: Comprehensive System Specification

An on-demand Model Context Protocol (MCP) server that empowers AI agents to perform Just-In-Time (JIT) micro-mutation testing. It intentionally injects logical faults into codebase files to confirm if the existing local test suites are truly testing assertions or simply acting as hollow coverage metrics.

Supports **TypeScript/JavaScript** (StrykerJS), **Python** (Mutmut), **Go** (go-mutesting), and **Rust** (cargo-mutants). All mutation runs execute inside isolated sandbox directories — your real working tree is never touched.

---

## 🛠️ System Architecture

Chaos-MCP functions as a language-agnostic orchestration bridge executing over Standard I/O via the `@modelcontextprotocol/sdk`.

```text
       [ AI Agent / IDE Chat Loop ]
                   │
                   ▼ (On-Demand Tool Call)
┌────────────────────────────────────────────────────────────┐
│  Chaos-MCP Server (Node.js + TypeScript Engine)            │
│                                                            │
│  1. Detects project type (TS/JS, Python, Go, Rust)         │
│  2. Auto-detects test runner (vitest, jest, pytest, etc.)  │
│  3. Provisions isolated sandbox in os.tmpdir()             │
│  4. Runs mutation testing via async execFile (no blocking) │
│  5. Parses results and returns structured MutationResult   │
└────────────────────────────────────────────────────────────┘
                   │
         ┌─────────┼─────────┐
         ▼         ▼         ▼
┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐
│ TS Engine │ │ Py Engine │ │ Go Engine │ │ Rs Engine │
│ (Stryker) │ │ (Mutmut)  │ │ (go-mut)  │ │ (cargo-m) │
└───────────┘ └───────────┘ └───────────┘ └───────────┘

```

---

## 📂 Complete File Layout

```text
chaos-mcp/
├── package.json
├── tsconfig.json
├── eslint.config.js
├── vitest.config.ts
├── .github/workflows/
│   ├── ci.yml                # CI pipeline (lint, typecheck, test)
│   └── release.yml           # Release workflow (tag → npm publish)
├── docs/
│   └── DRAFT.md              # This specification document
└── src/
    ├── index.ts              # Main MCP entry point, tool definition & handler
    ├── engines/
    │   ├── base.ts           # Abstract engine blueprint + RunOptions/MutationResult types
    │   ├── typescript.ts     # StrykerJS CLI driver (async, concurrency, dryRun, incremental)
    │   ├── python.ts         # Mutmut CLI adapter (text results parsing)
    │   ├── go.ts             # go-mutesting CLI adapter
    │   └── rust.ts           # cargo-mutants CLI adapter
    ├── utils/
    │   ├── exec.ts           # Async runShell helper + ExecFailureError class
    │   ├── logger.ts         # Verbose-mode logging utility
    │   ├── sandbox.ts        # Sandbox isolation (os.tmpdir, symlinks, size guard)
    │   ├── config-loader.ts  # chaos-mcp.config.json loader
    │   └── project-detector.ts # Project type + test runner auto-detection
    └── __tests__/            # 11 test files, 213 tests total

```

---

## 🔧 Tool API Reference: `audit_code_resilience`

Chaos-MCP exposes a single MCP tool. All parameters are optional except `filePath`.

### Required Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `filePath` | `string` | Workspace-relative path to the file to audit. Must end in `.ts`, `.js`, `.tsx`, `.jsx`, `.py`, `.go`, or `.rs`. |

**Example:**
```json
{ "filePath": "src/utils/math.ts" }
```

### Optional Parameters

#### `timeoutMs` (number)

Maximum time in milliseconds for the entire mutation run. Default: `300000` (5 minutes). Increase for large files or slow test suites.

```json
{ "filePath": "src/utils/math.ts", "timeoutMs": 120000 }
```

#### `lineScope` (object)

Constrain mutations to a 1-based line range (inclusive). **StrykerJS only**; ignored for Python, Go, and Rust targets. Useful for surgically auditing a specific function or block.

```json
{ "filePath": "src/utils/math.ts", "lineScope": { "start": 10, "end": 45 } }
```

#### `mutatorAllowlist` (string[])

Stryker mutator names to include — all others are skipped. **StrykerJS only.** Common mutators: `"ArithmeticOperator"`, `"ConditionalExpression"`, `"BooleanLiteral"`, `"StringLiteral"`.

```json
{ "filePath": "src/utils/math.ts", "mutatorAllowlist": ["ConditionalExpression", "BooleanLiteral"] }
```

#### `mutatorDenylist` (string[])

Stryker mutator names to exclude — these are filtered out. **StrykerJS only.** Useful for skipping noisy or irrelevant mutators.

```json
{ "filePath": "src/utils/math.ts", "mutatorDenylist": ["StringLiteral"] }
```

#### `concurrency` (number)

Number of parallel mutation workers. **StrykerJS only.** When omitted, StrykerJS auto-detects CPU core count. Lower this on memory-constrained machines; raise it on CI with spare cores.

```json
{ "filePath": "src/utils/math.ts", "concurrency": 4 }
```

#### `dryRun` (boolean)

If `true`, run only the dry-run phase to validate the test suite passes before mutation testing. **StrykerJS only.** Useful for pre-flight checks to confirm the baseline test suite is green.

```json
{ "filePath": "src/utils/math.ts", "dryRun": true }
```

#### `outputFormat` ("json" | "text")

Output format for the result. `"json"` (default) returns a structured `MutationResult` object. `"text"` returns a human-readable summary with headers, mutant counts, and vulnerability details.

```json
{ "filePath": "src/utils/math.ts", "outputFormat": "text" }
```

**Text output example:**
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

#### `incremental` (boolean)

Enable incremental mode to reuse results from a previous run and skip unchanged mutants. **StrykerJS only.** Speeds up repeat audits of the same file — the incremental state file (`.stryker-incremental.json`) is stored in the sandbox and does not persist between runs.

```json
{ "filePath": "src/utils/math.ts", "incremental": true }
```

#### `ignorePatterns` (string[])

Substring patterns for files/directories to exclude from the sandbox copy, applied in addition to built-in exclusions (`node_modules`, `.git`, `dist`, `build`, `coverage`, `.venv`, `venv`, `target`, etc.). Any path containing the pattern string is skipped during the sandbox copy phase.

```json
{ "filePath": "src/utils/math.ts", "ignorePatterns": [".test.ts", "fixtures/", "snapshots/"] }
```

### Combined Example

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

### Configuration File Defaults

Tool call arguments override config defaults defined in `chaos-mcp.config.json`:

```json
{
  "defaultTimeoutMs": 300000,
  "mutatorDenylist": ["StringLiteral"],
  "concurrency": 4
}
```

---

## 📊 Result Schema

The `MutationResult` object returned by the tool (in JSON format):

```typescript
interface MutationResult {
  target: string;          // The audited file path
  totalMutants: number;    // Total mutants generated
  killed: number;          // Mutants killed by tests (includes timeouts)
  survived: number;        // Mutants that survived (test gap)
  mutationScore: string;   // e.g. "91.67%"
  vulnerabilities: Array<{
    line: number;          // Line number of the surviving mutant
    replacement: string;   // Mutator name or description
    description: string;   // Human-readable explanation of the gap
  }>;
}
```

---

## 🏃 Supported Test Runners (Auto-Detected)

| Language  | Tool           | Detected Runners                                          |
|-----------|----------------|-----------------------------------------------------------|
| TS/JS     | StrykerJS      | vitest, jest, mocha, jasmine, bun, node:test, command     |
| Python    | Mutmut         | pytest, tox, nox                                           |
| Go        | go-mutesting   | go test (default), testify, ginkgo (via go.mod)            |
| Rust      | cargo-mutants  | cargo test (default), cargo-nextest (via nextest.toml)     |

---

## 🚀 Execution Loop Workflow

When your AI Client requests this tool execution payload, it processes the structured findings data array and translates it directly into human readable Markdown reports within your chat editor context UI layout:

```markdown
🔬 **Chaos Audit Feedback: `src/services/billing.ts`**

I spawned 4 active mutants inside a local testing micro-sandbox to isolate coverage regressions. **1 mutant survived.**

* ⚠️ **Surviving Mutant (Line 32):**
  * **Original Syntax:** `if (subtotal > 100)`
  * **Injected Mutation:** `if (subtotal >= 100)`
  * **Result:** Tests still passed. The matching suite is missing concrete input bounds validating logic loops exactly at `100`.

Would you like me to construct an optimized test payload target addressing this logic gap?
```