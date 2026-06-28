# Phase 4 — Capability Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cheap pre-flight `estimate_audit` tool (mutant count ± timing) and a `minScore` gate (pass/fail) on `audit` and `triage`.

**Architecture:** Pure helpers (`gate.ts`, `estimate-heuristic.ts`, `baseline-timing.ts`) under a thin orchestrator (`estimate.ts`) and a new MCP tool handler. `estimate_audit` dispatches per language: Rust uses `cargo mutants --list` (exact); TS/Python/Go use a source-parse heuristic (approx, labeled). The gate is a small comparison threaded additively into the existing audit/triage payloads — never `isError`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, `@modelcontextprotocol/sdk`, Node child_process via existing `invokeMutationTool`/`runShell`.

## Global Constraints

- ESM throughout: every relative import uses a `.js` specifier that resolves to `.ts`.
- `npm test` REQUIRES a prior `npm run build` (several tests import `../build/index.js`).
- Each task runs the FULL gate before committing: `npm run build && npm run lint && npm run format:check && npm test`. If prettier/eslint flag, run `npm run format` and re-check.
- Preserve audit-tag comments (`C2`, `H5`, `Med#`, `A2`/`A3`, `A9`, etc.) on any line you touch.
- `APP_VERSION` stays the literal `export const APP_VERSION = '<semver>';` in `src/index.ts` — do not touch.
- Importing `index.ts` must stay side-effect free (the `isDirectRun` guard at the bottom).
- Workspace boundary (C2): `estimate_audit` must boundary-check `filePath` with `isRealPathInside` (exported from `src/handler.ts`) and never read/run outside the workspace. Engine subprocesses (cargo-mutants, test suites) run only in a sandbox, never on the real tree.
- A failing gate is NEVER `isError` — it is a data field on a success result.
- Conventional Commits (`feat:`/`fix:`/`test:`/`docs:`).
- The estimate heuristic is explicitly APPROXIMATE — `fidelity: 'approx'` is the contract. Tests assert monotonicity, comment/string exclusion, and ballpark — NOT exact engine parity.

---

### Task 1: Gate evaluation + validation (`src/gate.ts`)

**Files:**
- Create: `src/gate.ts`
- Test: `src/__tests__/gate.test.ts`

**Interfaces:**
- Consumes: nothing (leaf).
- Produces:
  ```ts
  export interface GateResult { minScore: number; passed: boolean; }
  export function evaluateGate(scoreText: string, minScore: number): GateResult;
  export function validateMinScore(value: unknown): string | null; // null = ok, else error message
  ```
  `evaluateGate` parses the leading number out of a `"NN.NN%"` string; an unparseable/empty score → `passed: true` (a clean file with no gradable score must not spuriously fail). `validateMinScore` returns `null` when the arg is absent (optional) or a number in `[0,100]`, else an error string.

- [ ] **Step 1: Write the failing tests**

```ts
// src/__tests__/gate.test.ts
import { describe, it, expect } from 'vitest';
import { evaluateGate, validateMinScore } from '../gate.js';

describe('evaluateGate', () => {
  it('passes when score >= minScore', () => {
    expect(evaluateGate('87.50%', 80)).toEqual({ minScore: 80, passed: true });
  });
  it('passes on exact equality', () => {
    expect(evaluateGate('80.00%', 80)).toEqual({ minScore: 80, passed: true });
  });
  it('fails when score < minScore', () => {
    expect(evaluateGate('72.00%', 80)).toEqual({ minScore: 80, passed: false });
  });
  it('parses a score without a percent sign', () => {
    expect(evaluateGate('90', 80).passed).toBe(true);
  });
  it('treats an unparseable score as passing', () => {
    expect(evaluateGate('n/a', 80)).toEqual({ minScore: 80, passed: true });
    expect(evaluateGate('', 80).passed).toBe(true);
  });
});

describe('validateMinScore', () => {
  it('accepts undefined (optional)', () => {
    expect(validateMinScore(undefined)).toBeNull();
  });
  it('accepts 0..100', () => {
    expect(validateMinScore(0)).toBeNull();
    expect(validateMinScore(80)).toBeNull();
    expect(validateMinScore(100)).toBeNull();
    expect(validateMinScore(72.5)).toBeNull();
  });
  it('rejects out-of-range and non-numbers', () => {
    expect(validateMinScore(-1)).toMatch(/minScore/);
    expect(validateMinScore(101)).toMatch(/minScore/);
    expect(validateMinScore('80')).toMatch(/minScore/);
    expect(validateMinScore(NaN)).toMatch(/minScore/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/__tests__/gate.test.ts`
Expected: FAIL — `Cannot find module '../gate.js'`.

- [ ] **Step 3: Implement**

```ts
// src/gate.ts

/** Outcome of grading a mutation score against a threshold. */
export interface GateResult {
  minScore: number;
  passed: boolean;
}

/**
 * Grade a formatted mutation score (e.g. "87.50%") against `minScore`.
 * An unparseable or empty score is treated as PASSING — a file with no
 * gradable mutants must never spuriously fail the gate.
 */
export function evaluateGate(scoreText: string, minScore: number): GateResult {
  const match = /-?\d+(?:\.\d+)?/.exec(scoreText ?? '');
  if (match === null) return { minScore, passed: true };
  const score = parseFloat(match[0]);
  if (Number.isNaN(score)) return { minScore, passed: true };
  return { minScore, passed: score >= minScore };
}

/**
 * Validate a `minScore` tool argument. Returns null when absent (optional) or
 * a number in [0, 100]; otherwise an error message.
 */
export function validateMinScore(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > 100) {
    return 'minScore must be a number between 0 and 100. Example: 80.';
  }
  return null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/__tests__/gate.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/gate.ts src/__tests__/gate.test.ts
git commit -m "feat: gate evaluation + minScore validation helper"
```

---

### Task 2: Estimate heuristic (`src/estimate-heuristic.ts`)

**Files:**
- Create: `src/estimate-heuristic.ts`
- Test: `src/__tests__/estimate-heuristic.test.ts`

**Interfaces:**
- Consumes: `SupportedProjectType` from `./engines/registry.js`.
- Produces:
  ```ts
  export interface HeuristicResult { mutants: number; constructs: number; }
  export function estimateHeuristic(source: string, projectType: SupportedProjectType): HeuristicResult;
  ```
  Best-effort, approximate. Strips comments + string/template literals, then counts mutable constructs by category and returns `constructs` (raw match count) and `mutants` (weighted sum). Comparison operators are weighted 2 (boundary+equality territory); all other categories weight 1.

- [ ] **Step 1: Write the failing tests**

```ts
// src/__tests__/estimate-heuristic.test.ts
import { describe, it, expect } from 'vitest';
import { estimateHeuristic } from '../estimate-heuristic.js';

describe('estimateHeuristic', () => {
  it('returns 0 for an empty file', () => {
    expect(estimateHeuristic('', 'typescript')).toEqual({ mutants: 0, constructs: 0 });
  });

  it('counts operators and keywords in real code', () => {
    const src = `function f(a: number, b: number) {
      if (a > b && a !== 0) { return a + b; }
      return false;
    }`;
    const r = estimateHeuristic(src, 'typescript');
    // > , && , !== , + , return x2 , false  → constructs >= 7, mutants > constructs (comparisons weighted)
    expect(r.constructs).toBeGreaterThanOrEqual(7);
    expect(r.mutants).toBeGreaterThan(r.constructs);
  });

  it('does NOT count operators inside comments', () => {
    const withComment = `// a + b > c && d\nconst x = 1;`;
    const noComment = `const x = 1;`;
    expect(estimateHeuristic(withComment, 'typescript').constructs).toBe(
      estimateHeuristic(noComment, 'typescript').constructs,
    );
  });

  it('does NOT count operators inside string literals', () => {
    const withStr = `const s = "a + b > c && d";`;
    const noStr = `const s = "";`;
    expect(estimateHeuristic(withStr, 'typescript').constructs).toBe(
      estimateHeuristic(noStr, 'typescript').constructs,
    );
  });

  it('strips python # comments', () => {
    const withComment = `# a + b > c\nx = 1`;
    const noComment = `x = 1`;
    expect(estimateHeuristic(withComment, 'python').constructs).toBe(
      estimateHeuristic(noComment, 'python').constructs,
    );
  });

  it('is monotonic — more constructs yield more mutants', () => {
    const small = `return a + b;`;
    const big = `return a + b + c + d + e;`;
    expect(estimateHeuristic(big, 'typescript').mutants).toBeGreaterThan(
      estimateHeuristic(small, 'typescript').mutants,
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/__tests__/estimate-heuristic.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/estimate-heuristic.ts
import type { SupportedProjectType } from './engines/registry.js';

export interface HeuristicResult {
  mutants: number;
  constructs: number;
}

/**
 * Strip block comments, line comments, and string/template literals so that
 * operators appearing inside them are not counted. Best-effort and
 * language-approximate — Python uses `#` line comments and triple-quoted
 * strings; the C-family languages use `//` and `/* *\/`. Replacement keeps a
 * space so adjacent tokens don't merge.
 */
function stripNoise(source: string, projectType: SupportedProjectType): string {
  let s = source;
  // Block comments (C-family). Harmless to run for python (none present).
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Triple-quoted python strings before single/double.
  if (projectType === 'python') {
    s = s.replace(/'''[\s\S]*?'''/g, ' ').replace(/"""[\s\S]*?"""/g, ' ');
    s = s.replace(/#[^\n]*/g, ' ');
  } else {
    s = s.replace(/\/\/[^\n]*/g, ' ');
  }
  // Template literals (JS/TS) then ordinary single/double-quoted strings.
  s = s.replace(/`(?:\\[\s\S]|[^`\\])*`/g, ' ');
  s = s.replace(/"(?:\\[\s\S]|[^"\\])*"/g, ' ');
  s = s.replace(/'(?:\\[\s\S]|[^'\\])*'/g, ' ');
  return s;
}

/** Count non-overlapping matches of a global regex. */
function count(re: RegExp, s: string): number {
  const m = s.match(re);
  return m === null ? 0 : m.length;
}

/**
 * Approximate the number of mutants a mutation tool would generate for `source`.
 * Returns the raw construct count and a weighted mutant estimate. APPROXIMATE
 * by design — callers label this `fidelity: 'approx'`. Comparison operators are
 * weighted 2 (relational-boundary + equality mutations); all else weight 1.
 */
export function estimateHeuristic(source: string, projectType: SupportedProjectType): HeuristicResult {
  const s = stripNoise(source, projectType);

  const comparison = count(/(===|!==|==|!=|<=|>=|<|>)/g, s);
  const arithmetic = count(/[+\-*/%]/g, s) - count(/\+\+|--/g, s) * 2; // exclude ++/-- double-count
  const logical = count(/(&&|\|\|)/g, s);
  const conditional = count(/\b(if|while|for)\b/g, s) + count(/\?/g, s);
  const returns = count(/\breturn\b/g, s);
  const booleans = count(/\b(true|false|True|False)\b/g, s);
  const numbers = count(/\b\d+(?:\.\d+)?\b/g, s);
  const incdec = count(/\+\+|--/g, s);

  const safe = (n: number) => (n > 0 ? n : 0);
  const constructs =
    comparison + safe(arithmetic) + logical + conditional + returns + booleans + numbers + incdec;
  // Comparison weighted x2; everything else x1.
  const mutants =
    comparison * 2 + safe(arithmetic) + logical + conditional + returns + booleans + numbers + incdec;

  return { mutants, constructs };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/__tests__/estimate-heuristic.test.ts`
Expected: PASS (6 tests). If a count assertion is off, adjust the test's lower bound (the heuristic is approximate) — do NOT inflate weights to hit an exact number.

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/estimate-heuristic.ts src/__tests__/estimate-heuristic.test.ts
git commit -m "feat: source-parse mutant-count heuristic for estimate_audit"
```

---

### Task 3: Estimate orchestrator + Rust native (`src/estimate.ts`)

**Files:**
- Create: `src/estimate.ts`
- Test: `src/__tests__/estimate.test.ts`

**Interfaces:**
- Consumes: `estimateHeuristic`/`HeuristicResult` (Task 2); `SupportedProjectType` from `./engines/registry.js`; `EnvironmentInfo` from `./utils/project-detector.js`; `ChaosConfig` from `./utils/config-loader.js`; `invokeMutationTool` from `./utils/exec-classify.js`; `ExecFailureError` from `./utils/exec.js`.
- Produces:
  ```ts
  export type Fidelity = 'exact' | 'approx';
  export interface EstimateResult {
    target: string; language: SupportedProjectType; mutants: number;
    fidelity: Fidelity; basis: string;
    baselineMs?: number; estimatedMs?: number; concurrency?: number; note: string;
  }
  export interface EstimateOptions {
    absFile: string; relFile: string; projectType: SupportedProjectType;
    workDir?: string;        // sandbox dir; required for the native (rust) path
    timeoutMs?: number;
  }
  export function estimateNeedsSandbox(projectType: SupportedProjectType, withTiming: boolean): boolean;
  export async function estimateAudit(opts: EstimateOptions): Promise<EstimateResult>;
  ```
  `estimateNeedsSandbox` = `withTiming || projectType === 'rust'`. `estimateAudit` (count-only here — timing added in Task 4) dispatches: Rust → `cargo mutants --list` in `workDir` (count lines that look like mutant entries), `fidelity:'exact'`; on `ENOENT`/startup failure → heuristic fallback with a noted basis; TS/Python/Go → read `absFile` + `estimateHeuristic`, `fidelity:'approx'`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/__tests__/estimate.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/exec-classify.js', () => ({
  invokeMutationTool: vi.fn(),
  MutationToolStartupError: class extends Error {},
}));

import { invokeMutationTool } from '../utils/exec-classify.js';
import { MutationToolStartupError } from '../utils/exec-classify.js';
import { estimateAudit, estimateNeedsSandbox } from '../estimate.js';

const mockInvoke = vi.mocked(invokeMutationTool);

describe('estimateNeedsSandbox', () => {
  it('needs a sandbox for rust or when timing', () => {
    expect(estimateNeedsSandbox('rust', false)).toBe(true);
    expect(estimateNeedsSandbox('typescript', true)).toBe(true);
    expect(estimateNeedsSandbox('typescript', false)).toBe(false);
    expect(estimateNeedsSandbox('go', false)).toBe(false);
  });
});

describe('estimateAudit', () => {
  it('uses the heuristic for typescript (approx)', async () => {
    const r = await estimateAudit({
      absFile: __filename, // this test file — has plenty of constructs
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
    });
    expect(r.fidelity).toBe('approx');
    expect(r.language).toBe('typescript');
    expect(r.mutants).toBeGreaterThan(0);
    expect(r.basis).toMatch(/heuristic/);
  });

  it('uses cargo-mutants --list for rust (exact)', async () => {
    mockInvoke.mockResolvedValueOnce({
      stdout: 'src/lib.rs:1:1: replace foo -> bar\nsrc/lib.rs:2:3: replace a + b with a - b\n',
      stderr: '',
    } as never);
    const r = await estimateAudit({
      absFile: '/ws/src/lib.rs', relFile: 'src/lib.rs', projectType: 'rust', workDir: '/sandbox',
    });
    expect(r.fidelity).toBe('exact');
    expect(r.mutants).toBe(2);
    expect(r.basis).toMatch(/cargo-mutants/);
  });

  it('falls back to heuristic when cargo-mutants is missing', async () => {
    mockInvoke.mockRejectedValueOnce(new MutationToolStartupError('not found', 'ENOENT'));
    const r = await estimateAudit({
      absFile: __filename, relFile: 'src/x.rs', projectType: 'rust', workDir: '/sandbox',
    });
    expect(r.fidelity).toBe('approx');
    expect(r.basis).toMatch(/not installed|heuristic/);
  });
});
```

Note: `MutationToolStartupError` constructor — confirm its real signature in `src/utils/exec-classify.ts` and match the mock/throw to it (it carries a classification like `'ENOENT'`). Adjust the mock class + the thrown instance in the test to the real shape before running.

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run src/__tests__/estimate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/estimate.ts
import { readFileSync } from 'node:fs';
import type { SupportedProjectType } from './engines/registry.js';
import { estimateHeuristic } from './estimate-heuristic.js';
import { invokeMutationTool, MutationToolStartupError } from './utils/exec-classify.js';

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
  absFile: string;
  relFile: string;
  projectType: SupportedProjectType;
  workDir?: string;
  timeoutMs?: number;
}

const ESTIMATE_TIMEOUT_MS = 60_000;

/** Native count is only available for rust today; timing always needs a sandbox. */
export function estimateNeedsSandbox(projectType: SupportedProjectType, withTiming: boolean): boolean {
  return withTiming || projectType === 'rust';
}

/** Heuristic estimate from the file's source. Read failure → 0 with a note. */
function heuristicEstimate(opts: EstimateOptions, basisSuffix = ''): EstimateResult {
  let source = '';
  try {
    source = readFileSync(opts.absFile, 'utf8');
  } catch {
    source = '';
  }
  const h = estimateHeuristic(source, opts.projectType);
  return {
    target: opts.relFile,
    language: opts.projectType,
    mutants: h.mutants,
    fidelity: 'approx',
    basis: `source heuristic: ${h.constructs} constructs${basisSuffix}`,
    note:
      'Approximate mutant count from a source-parse heuristic; the real audit may differ. ' +
      'Run audit_code_resilience for exact results.',
  };
}

/** Count mutants from `cargo mutants --list` output (one mutant per non-empty line). */
function countCargoMutants(stdout: string): number {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0).length;
}

export async function estimateAudit(opts: EstimateOptions): Promise<EstimateResult> {
  if (opts.projectType === 'rust') {
    if (opts.workDir === undefined) {
      // Defensive: caller should have provisioned a sandbox for rust.
      return heuristicEstimate(opts, ' (no sandbox; cargo-mutants skipped)');
    }
    try {
      const res = await invokeMutationTool(
        'cargo-mutants',
        'cargo',
        ['mutants', '--list', '--file', opts.relFile],
        { cwd: opts.workDir, timeoutMs: opts.timeoutMs ?? ESTIMATE_TIMEOUT_MS },
      );
      return {
        target: opts.relFile,
        language: 'rust',
        mutants: countCargoMutants(res.stdout),
        fidelity: 'exact',
        basis: 'cargo-mutants --list',
        note: 'Exact mutant count from cargo-mutants --list (no tests were run).',
      };
    } catch (error: unknown) {
      if (error instanceof MutationToolStartupError) {
        return heuristicEstimate(opts, ' (cargo-mutants not installed)');
      }
      throw error;
    }
  }
  return heuristicEstimate(opts);
}
```

Confirm `invokeMutationTool`'s first arg (`ExecutableTool`) accepts `'cargo-mutants'`/`'cargo'` — match how `src/engines/rust.ts` calls it. Adjust the tool/command args to the real signature.

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run src/__tests__/estimate.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/estimate.ts src/__tests__/estimate.test.ts
git commit -m "feat: estimate_audit orchestrator with native rust count + heuristic fallback"
```

---

### Task 4: Baseline timing (`src/baseline-timing.ts`) + `withTiming` integration

**Files:**
- Create: `src/baseline-timing.ts`
- Modify: `src/estimate.ts` (add `withTiming`/`concurrency` handling to `estimateAudit`)
- Test: `src/__tests__/baseline-timing.test.ts`, extend `src/__tests__/estimate.test.ts`

**Interfaces:**
- Consumes: `EnvironmentInfo` from `./utils/project-detector.js`; `SupportedProjectType`; `runShell` from `./utils/exec.js`.
- Produces:
  ```ts
  export interface BaselineCommand { command: string; args: string[]; }
  export function resolveBaselineTestCommand(env: EnvironmentInfo, projectType: SupportedProjectType): BaselineCommand | undefined;
  export function projectEstimatedMs(mutants: number, baselineMs: number, concurrency: number): number;
  ```
  `resolveBaselineTestCommand` returns a best-effort suite command per language (undefined when it can't resolve). `projectEstimatedMs` = `Math.ceil(mutants * baselineMs / Math.max(1, concurrency))`.
  `estimateAudit` gains `withTiming?: boolean`, `env?: EnvironmentInfo`, `concurrency?: number` on `EstimateOptions`; when `withTiming` and `workDir`+`env` present, run the baseline command once in `workDir`, set `baselineMs`/`estimatedMs`/`concurrency`. A resolution miss or run failure omits timing and appends a note (best-effort).

- [ ] **Step 1: Write failing tests**

```ts
// src/__tests__/baseline-timing.test.ts
import { describe, it, expect } from 'vitest';
import { resolveBaselineTestCommand, projectEstimatedMs } from '../baseline-timing.js';
import type { EnvironmentInfo } from '../utils/project-detector.js';

const env = (over: Partial<EnvironmentInfo> = {}): EnvironmentInfo =>
  ({
    testRunner: 'command', detectedRunner: 'npm', packageManager: 'npm',
    workspaceRoot: '/ws', ...over,
  }) as EnvironmentInfo;

describe('projectEstimatedMs', () => {
  it('scales mutants by baseline over concurrency', () => {
    expect(projectEstimatedMs(100, 1000, 4)).toBe(25000);
  });
  it('treats concurrency < 1 as 1', () => {
    expect(projectEstimatedMs(10, 100, 0)).toBe(1000);
  });
});

describe('resolveBaselineTestCommand', () => {
  it('resolves go and rust', () => {
    expect(resolveBaselineTestCommand(env(), 'go')).toEqual({ command: 'go', args: ['test', './...'] });
    expect(resolveBaselineTestCommand(env(), 'rust')).toEqual({ command: 'cargo', args: ['test'] });
  });
  it('resolves python to pytest', () => {
    expect(resolveBaselineTestCommand(env({ detectedRunner: 'pytest' }), 'python')?.command).toBe('pytest');
  });
  it('resolves a js runner', () => {
    const cmd = resolveBaselineTestCommand(env({ detectedRunner: 'npm' }), 'typescript');
    expect(cmd).toBeDefined();
    expect(cmd?.command).toMatch(/npm|npx/);
  });
});
```

(Extend `estimate.test.ts` with a `withTiming` case that mocks the baseline run and asserts `estimatedMs`/`concurrency` appear; mock `runShell` similarly to `invokeMutationTool`.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run src/__tests__/baseline-timing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/baseline-timing.ts
import type { EnvironmentInfo } from './utils/project-detector.js';
import type { SupportedProjectType } from './engines/registry.js';

export interface BaselineCommand {
  command: string;
  args: string[];
}

/**
 * Best-effort resolution of a one-shot test-suite command per language, used to
 * measure a baseline run time for `estimate_audit --withTiming`. Returns
 * undefined when no sensible default applies (caller omits timing).
 */
export function resolveBaselineTestCommand(
  env: EnvironmentInfo,
  projectType: SupportedProjectType,
): BaselineCommand | undefined {
  switch (projectType) {
    case 'go':
      return { command: 'go', args: ['test', './...'] };
    case 'rust':
      return { command: 'cargo', args: ['test'] };
    case 'python': {
      const runner = env.detectedRunner || 'pytest';
      return { command: runner.includes('pytest') ? 'pytest' : runner, args: [] };
    }
    case 'typescript':
    case 'javascript': {
      const runner = env.detectedRunner || 'npm';
      if (runner === 'npm' || runner === 'yarn' || runner === 'pnpm') {
        return { command: runner, args: ['test'] };
      }
      if (runner === 'bun') return { command: 'bun', args: ['test'] };
      // vitest/jest/mocha → invoke via npx
      return { command: 'npx', args: [runner] };
    }
    default:
      return undefined;
  }
}

/** Rough total-time projection: mutants × baseline / concurrency, rounded up. */
export function projectEstimatedMs(mutants: number, baselineMs: number, concurrency: number): number {
  return Math.ceil((mutants * baselineMs) / Math.max(1, concurrency));
}
```

Then in `src/estimate.ts`: add `withTiming?`, `env?`, `concurrency?` to `EstimateOptions`; after computing the count `EstimateResult`, if `opts.withTiming && opts.workDir && opts.env`, resolve the baseline command, run it via `runShell` (import it), measure elapsed ms with two `Date.now()` reads (the server is normal Node — `Date.now()` is fine here, unlike workflow scripts), set `baselineMs`, `concurrency = opts.concurrency ?? 1`, `estimatedMs = projectEstimatedMs(mutants, baselineMs, concurrency)`; on resolution-miss or run-error, leave timing fields unset and append `' (timing unavailable)'` to the note. Wrap the run in try/catch — timing is best-effort and never fails the estimate.

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run src/__tests__/baseline-timing.test.ts src/__tests__/estimate.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/baseline-timing.ts src/estimate.ts src/__tests__/baseline-timing.test.ts src/__tests__/estimate.test.ts
git commit -m "feat: withTiming baseline measurement + estimatedMs projection"
```

---

### Task 5: Estimate tool schema (`src/tool-schema.ts`)

**Files:**
- Modify: `src/tool-schema.ts` (add `ESTIMATE_TOOL_DEFINITION`)
- Test: `src/__tests__/tool-schema.test.ts` (append)

**Interfaces:**
- Produces: `export const ESTIMATE_TOOL_DEFINITION` with `name: 'estimate_audit'`, `inputSchema` (`filePath` required string, `withTiming` boolean), and an `outputSchema` mirroring `EstimateResult`.

- [ ] **Step 1: Write failing test** — append to `src/__tests__/tool-schema.test.ts`:

```ts
it('exposes estimate_audit definition', () => {
  expect(ESTIMATE_TOOL_DEFINITION.name).toBe('estimate_audit');
  const props = ESTIMATE_TOOL_DEFINITION.inputSchema.properties as Record<string, unknown>;
  expect(props.filePath).toBeDefined();
  expect(props.withTiming).toBeDefined();
  expect(ESTIMATE_TOOL_DEFINITION.inputSchema.required).toContain('filePath');
  const out = (ESTIMATE_TOOL_DEFINITION.outputSchema?.properties ?? {}) as Record<string, unknown>;
  expect(out.mutants).toBeDefined();
  expect(out.fidelity).toBeDefined();
});
```

(Add `ESTIMATE_TOOL_DEFINITION` to the import at the top of the test file.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run src/__tests__/tool-schema.test.ts -t 'estimate_audit'`
Expected: FAIL — `ESTIMATE_TOOL_DEFINITION` undefined.

- [ ] **Step 3: Implement** — add to `src/tool-schema.ts` (match the existing definition style):

```ts
export const ESTIMATE_TOOL_DEFINITION = {
  name: 'estimate_audit',
  description:
    'Cheap pre-flight estimate of how big/long auditing a file will be, WITHOUT running the full ' +
    'mutation test cycle. Returns an approximate mutant count (exact for Rust via cargo-mutants --list; ' +
    'a source heuristic for TS/JS/Python/Go, labeled fidelity:"approx"). Set withTiming:true to also ' +
    'run the test suite once and estimate wall-clock time. Use this before audit_code_resilience to ' +
    'decide whether to audit now, scope down, or skip.',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Path to the source file to estimate, within the workspace. Example: "src/math.ts".',
      },
      withTiming: {
        type: 'boolean',
        description:
          'When true, run the test suite once to measure a baseline and estimate total wall-clock ' +
          'time (mutants × baseline / concurrency). Default false (count only, no test run).',
      },
    },
    required: ['filePath'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string' },
      language: { type: 'string' },
      mutants: { type: 'integer' },
      fidelity: { type: 'string', enum: ['exact', 'approx'] },
      basis: { type: 'string' },
      baselineMs: { type: 'integer' },
      estimatedMs: { type: 'integer' },
      concurrency: { type: 'integer' },
      note: { type: 'string' },
    },
    required: ['target', 'language', 'mutants', 'fidelity', 'basis', 'note'],
  },
} as const;
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run src/__tests__/tool-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/tool-schema.ts src/__tests__/tool-schema.test.ts
git commit -m "feat: estimate_audit tool schema definition"
```

---

### Task 6: Estimate handler + tool registration (`src/estimate-handler.ts`, `src/index.ts`)

**Files:**
- Create: `src/estimate-handler.ts`
- Modify: `src/index.ts` (register `ESTIMATE_TOOL_DEFINITION` in ListTools; dispatch `estimate_audit` in CallTool)
- Test: `src/__tests__/estimate-handler.test.ts`

**Interfaces:**
- Consumes: `estimateAudit`/`estimateNeedsSandbox`/`EstimateResult` (Tasks 3–4); `detectProjectType`/`detectEnvironment` from `./utils/project-detector.js`; `createSandbox` from `./utils/sandbox.js`; `isRealPathInside` from `./handler.js`; `ChaosConfig`; `ESTIMATE_TOOL_DEFINITION` from `./tool-schema.js`.
- Produces: `export async function handleEstimateCall(request, config?): Promise<CallToolResult>`.

- [ ] **Step 1: Write failing tests** (`src/__tests__/estimate-handler.test.ts`) — follow the existing `handler.test.ts`/`triage-handler.test.ts` patterns (mock the engine/sandbox layer the same way they do). Minimum coverage:
  - a `typescript` filePath returns a result with `structuredContent.mutants` and `fidelity: 'approx'` (no sandbox provisioned — assert `createSandbox` not called, if the harness mocks it).
  - a filePath outside the workspace → tool error mentioning the boundary.
  - an unsupported extension → clear tool error (reuse `detectProjectType`'s unsupported handling).
  Use the same stub/mocking approach as the sibling handler tests; if the harness can't express the no-sandbox assertion, cover the happy path + boundary path and note the limit in the report.

```ts
// sketch — adapt to the sibling handler test harness
import { describe, it, expect } from 'vitest';
import { handleEstimateCall } from '../estimate-handler.js';

function req(args: Record<string, unknown>) {
  return { params: { name: 'estimate_audit', arguments: args } } as never;
}

describe('handleEstimateCall', () => {
  it('rejects a path outside the workspace', async () => {
    const res = await handleEstimateCall(req({ filePath: '/etc/passwd' }));
    const text = (res.content?.[0] as { text?: string })?.text ?? '';
    expect(text).toMatch(/workspace|outside|within/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run src/__tests__/estimate-handler.test.ts`
Expected: FAIL — module not found / not wired.

- [ ] **Step 3: Implement**

`src/estimate-handler.ts` — mirror the opening of `handleToolCall`:
1. `const rootCwd = resolve(process.cwd());` resolve `filePath` → `resolvedFile`; `if (!isRealPathInside(resolvedFile, rootCwd)) return toolError(...)` (import/duplicate `toolError` or reuse the exported one — check `handler.ts` for an exported `toolError`; if not exported, export it).
2. Validate args: `filePath` non-empty string; `withTiming` boolean-or-undefined (return toolError on violation).
3. `const projectType = detectProjectType(filePath);` handle the unsupported case exactly as `handleToolCall` does (same error message/shape).
4. `const env = detectEnvironment(...)`; compute `relFile = relative(env.workspaceRoot, resolvedFile)` (same expression the rest of the codebase uses).
5. `const withTiming = args.withTiming === true;`
6. If `estimateNeedsSandbox(projectType, withTiming)`: `createSandbox(...)` (as `handleToolCall` does) → pass `workDir`; ALWAYS clean up in `finally`. Else no sandbox.
7. `const result = await estimateAudit({ absFile: resolvedFile, relFile, projectType, workDir, withTiming, env, concurrency: <resolved> });`
8. Format: `{ content: [{ type:'text', text: JSON.stringify(result) }], structuredContent: result as unknown as Record<string, unknown> }`. (Mirror how audit returns text+structuredContent.)
9. Wrap in try/catch → `toolError("Chaos Engine Halted: ...")` like `handleToolCall`.

`src/index.ts`:
```ts
import { TOOL_DEFINITION, TRIAGE_TOOL_DEFINITION, ESTIMATE_TOOL_DEFINITION } from './tool-schema.js';
import { handleEstimateCall } from './estimate-handler.js';
// ListTools: tools: [TOOL_DEFINITION, TRIAGE_TOOL_DEFINITION, ESTIMATE_TOOL_DEFINITION]
// CallTool dispatch, before the audit fallback:
if (request.params.name === 'estimate_audit') {
  return handleEstimateCall(request, config);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run src/__tests__/estimate-handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/estimate-handler.ts src/index.ts src/__tests__/estimate-handler.test.ts
git commit -m "feat: estimate_audit MCP handler + register as third tool"
```

---

### Task 7: Audit gate wiring (`src/handler.ts`, `src/format.ts`, schema)

**Files:**
- Modify: `src/format.ts` (`ResultPayload.gate?` + `ResultPayloadOpts.gate?`)
- Modify: `src/handler.ts` (validator + thread gate into `formatAuditOutput`/`buildResultPayload`)
- Modify: `src/tool-schema.ts` (audit input `minScore` + output `gate`)
- Test: `src/__tests__/format-payload.test.ts`, `src/__tests__/handler.test.ts` (append)

**Interfaces:**
- Consumes: `evaluateGate`/`validateMinScore` from `./gate.js` (Task 1); `GateResult`.
- Produces: `ResultPayload.gate?: GateResult`; audit honors `minScore`.

- [ ] **Step 1: Write failing tests**

```ts
// format-payload.test.ts — append
import { evaluateGate } from '../gate.js';
it('threads a gate result into the payload', () => {
  const result = { target: 'a.ts', totalMutants: 8, killed: 6, survived: 2, mutationScore: '75.00%', vulnerabilities: [] };
  const payload = buildResultPayload(result, { gate: evaluateGate('75.00%', 80) });
  expect(payload.gate).toEqual({ minScore: 80, passed: false });
});
it('omits gate when not provided', () => {
  const result = { target: 'a.ts', totalMutants: 4, killed: 4, survived: 0, mutationScore: '100.00%', vulnerabilities: [] };
  expect(buildResultPayload(result, {}).gate).toBeUndefined();
});
```

```ts
// handler.test.ts — append to the phase-style suites
import { validateToolArgs } from '../handler.js';
it('rejects out-of-range minScore', () => {
  const res = validateToolArgs({ filePath: 'a.ts', minScore: 150 });
  expect((res?.content?.[0] as { text?: string })?.text ?? '').toMatch(/minScore/);
});
it('accepts a valid minScore', () => {
  expect(validateToolArgs({ filePath: 'a.ts', minScore: 80 })).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run src/__tests__/format-payload.test.ts -t 'gate' && npx vitest run src/__tests__/handler.test.ts -t 'minScore'`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/format.ts`: import `GateResult` from `./gate.js`; add `gate?: GateResult;` to `ResultPayload` and `gate?: GateResult;` to `ResultPayloadOpts`; in `buildResultPayload`, before `return payload;` add `if (opts.gate) payload.gate = opts.gate;`.

`src/handler.ts`:
- Import `evaluateGate, validateMinScore` from `./gate.js`.
- Add a validator `validateMinScoreArg(args)`: `return validateMinScore(args.minScore);` and register it in `TOOL_ARG_VALIDATORS`.
- In `formatAuditOutput`, in the NON-verify branch, compute `const gate = typeof args.minScore === 'number' ? evaluateGate(auditResults.mutationScore, args.minScore) : undefined;` and pass `gate` into the `buildResultPayload` opts. (Verify-mode branch ignores `minScore`.)

`src/tool-schema.ts` (audit `TOOL_DEFINITION`):
- input `properties.minScore`: `{ type: 'number', minimum: 0, maximum: 100, description: 'Gate: if the mutation score is below this (0–100), the result reports gate.passed=false (never an error). Example: 80.' }`.
- output `properties.gate`: `{ type: 'object', properties: { minScore: { type: 'number' }, passed: { type: 'boolean' } } }`.

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run src/__tests__/format-payload.test.ts src/__tests__/handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/format.ts src/handler.ts src/tool-schema.ts src/__tests__/format-payload.test.ts src/__tests__/handler.test.ts
git commit -m "feat: minScore gate on audit_code_resilience"
```

---

### Task 8: Triage gate wiring (`src/triage.ts`, `src/triage-handler.ts`, schema)

**Files:**
- Modify: `src/triage.ts` (`TriageRow.passed?`, `TriagePayload.gate?`, gate computation in `buildTriagePayload`)
- Modify: `src/triage-handler.ts` (validator + pass `minScore` through to `buildTriagePayload`)
- Modify: `src/tool-schema.ts` (triage input `minScore` + output `gate` + per-row `passed`)
- Test: `src/__tests__/triage.test.ts`, `src/__tests__/triage-handler.test.ts` (append)

**Interfaces:**
- Consumes: `evaluateGate`/`validateMinScore` from `./gate.js`.
- Produces: `TriageRow.passed?: boolean`; `TriagePayload.gate?: { minScore: number; passed: boolean; failingFiles: string[] }`. `buildTriagePayload` gains an optional `minScore` parameter (append it to the signature so existing callers are unaffected when omitted).

- [ ] **Step 1: Write failing tests**

```ts
// triage.test.ts — append
it('computes a gate over ranked rows when minScore is given', () => {
  const rows = [
    { file: 'a.ts', mutationScore: '90.00%', total: 10, killed: 9, survived: 1, noCoverage: 0 },
    { file: 'b.ts', mutationScore: '50.00%', total: 10, killed: 5, survived: 5, noCoverage: 0 },
  ];
  const payload = buildTriagePayload(rows, [], 2, 0, undefined, 80);
  expect(payload.gate).toEqual({ minScore: 80, passed: false, failingFiles: ['b.ts'] });
  expect(payload.ranking.find((r) => r.file === 'a.ts')?.passed).toBe(true);
  expect(payload.ranking.find((r) => r.file === 'b.ts')?.passed).toBe(false);
});
it('omits gate when minScore is absent', () => {
  const payload = buildTriagePayload([{ file: 'a.ts', mutationScore: '90.00%', total: 1, killed: 1, survived: 0, noCoverage: 0 }], [], 1, 0);
  expect(payload.gate).toBeUndefined();
});
```

(Confirm `buildTriagePayload`'s current parameter order from `src/triage.ts` and append `minScore?` as the LAST param so the existing call sites keep working. The test above assumes the existing order `(rows, errors, discovered, skipped, scopeNote?, minScore?)` — verify and adjust the test to the real order.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run src/__tests__/triage.test.ts -t 'gate'`
Expected: FAIL — `payload.gate` undefined / extra param ignored.

- [ ] **Step 3: Implement**

`src/triage.ts`:
- Import `evaluateGate` from `./gate.js`.
- Add `passed?: boolean;` to `TriageRow`.
- Add `gate?: { minScore: number; passed: boolean; failingFiles: string[] };` to `TriagePayload`.
- Add a trailing `minScore?: number` param to `buildTriagePayload`. When defined: for each ranked row set `row.passed = evaluateGate(row.mutationScore, minScore).passed` (do this on a shallow copy or in the ranking projection so input rows aren't mutated if that matters — match the existing code's handling); compute `failingFiles` = ranked rows where `!passed`, sorted; set `payload.gate = { minScore, passed: failingFiles.length === 0, failingFiles }`. When `errors.length > 0`, append to the note that N files errored and are not graded.

`src/triage-handler.ts`:
- Import `validateMinScore` from `./gate.js`; add `minScore` to the triage arg validation (return its error if non-null).
- Read `minScore` from args (`typeof args.minScore === 'number' ? args.minScore : undefined`) and pass it as the new trailing arg to BOTH `buildTriagePayload` call sites (the empty-result early return AND the main return).

`src/tool-schema.ts` (`TRIAGE_TOOL_DEFINITION`):
- input `properties.minScore` (same shape as audit's).
- output: add `gate` `{ type:'object', properties: { minScore:{type:'number'}, passed:{type:'boolean'}, failingFiles:{type:'array', items:{type:'string'}} } }`; add `passed: { type: 'boolean' }` to the ranking item properties.

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run src/__tests__/triage.test.ts src/__tests__/triage-handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/triage.ts src/triage-handler.ts src/tool-schema.ts src/__tests__/triage.test.ts src/__tests__/triage-handler.test.ts
git commit -m "feat: minScore gate on triage_test_coverage with failingFiles summary"
```

---

### Task 9: Docs + final gate + self-mutation smoke

**Files:**
- Modify: `README.md` (estimate_audit as the 3rd tool; gate mode on audit/triage)
- Modify: `CLAUDE.md` (note the 3rd tool + `estimate.ts`/`gate.ts`; "two tools" → "three tools")
- No test cycle for docs; this task's gate is `npm run check` + a self-mutation smoke.

- [ ] **Step 1: Update README** — document, with examples:
  - `estimate_audit`: inputs (`filePath`, `withTiming`), output (`mutants`, `fidelity` exact/approx, `basis`, optional `baselineMs`/`estimatedMs`/`concurrency`), that TS/Py/Go are approximate by design and Rust is exact, and that it runs no test cycle by default.
  - Gate mode: `minScore` on `audit` and `triage`, the `gate` object (audit `{minScore,passed}`; triage `{minScore,passed,failingFiles}` + per-row `passed`), that a failing gate is NOT an error, and the CI use case.

- [ ] **Step 2: Update CLAUDE.md** — change "exposes two tools" to three (add `estimate_audit`); in Architecture add one line each for `src/estimate.ts` (+ heuristic/timing helpers) and `src/gate.ts`; note `minScore` on both audit/triage paths.

- [ ] **Step 3: Final gate + self-mutation smoke**

```bash
npm run check
node scripts/audit-self.js src/gate.ts || true        # smoke: exercises the built tool on a new file
```
Note: `audit-self.js` needs `build/` + Stryker devDeps (symlinked into the sandbox). If it can't run in this environment, note that in the report — it is best-effort.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document estimate_audit (3rd tool) + minScore gate mode"
```

---

## Self-Review

**Spec coverage:**
- #6 estimate_audit native+heuristic labeled → Tasks 2 (heuristic), 3 (orchestrator + rust native + fallback), 6 (handler/registration). ✓
- estimate withTiming opt-in → Task 4. ✓
- estimate output fidelity/basis → Task 3; schema → Task 5. ✓
- #7 gate both audit + triage → Tasks 7 (audit), 8 (triage). ✓
- gate = data field, never isError → Tasks 7/8 (no isError path). ✓
- minScore validation 0–100 → Task 1 (`validateMinScore`), wired in 7/8. ✓
- C2 boundary on estimate filePath → Task 6. ✓
- sandbox only for native-or-timing → Task 3 (`estimateNeedsSandbox`), Task 6 (handler honors it). ✓
- Docs + 3-tool registration → Tasks 6 (register), 9 (docs). ✓
- Out of scope (line-scoped estimate, defaultMinScore config, exact non-rust counts) → no tasks. ✓

**Placeholder scan:** every code step has real code; commands have expected output. Tasks 6 and 8 instruct reading the sibling handler/triage code first for the real harness/param order and give exact wiring — guidance-with-code, not placeholders.

**Type consistency:** `EstimateResult`/`EstimateOptions`/`estimateAudit`/`estimateNeedsSandbox` (Task 3) consumed in Tasks 4, 6. `HeuristicResult`/`estimateHeuristic` (Task 2) consumed in Task 3. `GateResult`/`evaluateGate`/`validateMinScore` (Task 1) consumed in Tasks 7, 8. `ResultPayload.gate` (Task 7) matches audit output schema (Task 7). `TriagePayload.gate`/`TriageRow.passed` (Task 8) match triage schema (Task 8). `ESTIMATE_TOOL_DEFINITION` (Task 5) consumed in Task 6. `baselineMs`/`estimatedMs`/`concurrency` consistent across Tasks 3/4/5.

**Known risks flagged for the executor:** (1) `MutationToolStartupError` constructor shape — confirm in `exec-classify.ts` before writing the Task 3 test mock. (2) `invokeMutationTool`'s `ExecutableTool` first-arg union may need `'cargo-mutants'` added — check `rust.ts` and the type; if the union is closed, reuse the exact tool token rust.ts uses. (3) `buildTriagePayload` real parameter order (Task 8) — append `minScore` last and adjust the test. (4) `toolError` may not be exported from `handler.ts` — export it (or replicate a tiny local one) for the estimate handler. (5) the `withTiming` baseline command is best-effort; failures must omit timing, never fail the estimate.
