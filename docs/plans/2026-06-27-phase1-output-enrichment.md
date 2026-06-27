# Phase 1 — Output & Enrichment Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `audit_code_resilience` output richer, severity-ranked, bounded, and machine-consumable (`structuredContent`), enrich by default, suggest where tests should go, and bring Go survivors into the severity model.

**Architecture:** Split data construction from serialization in `format.ts` (new `buildResultPayload`), make the formatter apply a `severityFloor` filter and a `maxSurvivors` cap, add a standalone `test-file.ts` helper, extend `enrich.ts` to canonicalize Go mutator names, and wire it together in `handler.ts` which now enriches by default and returns `structuredContent` alongside the existing text block.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers resolving to `.ts`), Vitest, `@modelcontextprotocol/sdk`.

## Global Constraints

- ESM throughout: every relative import uses a `.js` specifier (e.g. `import { x } from './enrich.js'`).
- `npm test` REQUIRES a prior `npm run build` (several tests import `../build/index.js`). Run `npm run build` before `npm test` in every verify step.
- Full gate before considering the phase done: `npm run check` (build → lint → format:check → test) must pass.
- Importing `index.ts` must stay side-effect free (no server start on import).
- Preserve audit-tag comments (`C2`, `H5`, `Med#10`, `A2`/`A3`, etc.) on any code you touch.
- Conventional Commits for every commit (`feat:`/`refactor:`/`test:`/`docs:`).
- All changes additive and graceful: a failure in an enrichment/suggestion path must never fail the audit.
- Changes in this phase apply to `audit_code_resilience` ONLY. Do not touch `triage_test_coverage` behavior.

---

### Task 1: Extract `buildResultPayload` (pure object) from `formatResultAsJson`

Pure refactor — no behavior change. Establishes the object that becomes `structuredContent` and the `outputSchema` contract.

**Files:**
- Modify: `src/format.ts` (around `formatResultAsJson`, `format.ts:185-228`)
- Test: `src/__tests__/format-payload.test.ts` (create)

**Interfaces:**
- Produces: `export interface ResultPayload { target: string; mutationScore: string; summary: { total: number; killed: number; survived: number; worstSeverity?: Severity }; survivors: LineGroup[]; noCoverage: LineGroup[]; suggestedTestFile?: { path: string; exists: boolean }; ignoredOptions?: string[]; survivorsTruncated?: number; noCoverageTruncated?: number; survivorsFiltered?: number; noCoverageFiltered?: number; scopeNote?: string; enrichNote?: string; note: string }`
- Produces: `export interface ResultPayloadOpts { enrich?: EnrichContext; maxSurvivors?: number; severityFloor?: Severity; suggestedTestFile?: { path: string; exists: boolean }; ignoredOptions?: string[] }`
- Produces: `export function buildResultPayload(result: MutationResult, opts?: ResultPayloadOpts): ResultPayload`
- Consumes: existing `compactSurvivors`, `enrichGroups`, `LineGroup`, `EnrichedGroup`, `SEVERITY_RANK`, `Severity`, `EnrichContext`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/format-payload.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildResultPayload } from '../format.js';
import type { MutationResult } from '../engines/base.js';

function result(overrides: Partial<MutationResult> = {}): MutationResult {
  return {
    target: 'src/foo.ts',
    totalMutants: 10,
    killed: 8,
    survived: 2,
    mutationScore: '80.00%',
    vulnerabilities: [],
    ...overrides,
  };
}

describe('buildResultPayload', () => {
  it('returns the same shape formatResultAsJson serializes (clean run)', () => {
    const payload = buildResultPayload(result({ survived: 0, killed: 10, mutationScore: '100.00%' }));
    expect(payload).toMatchObject({
      target: 'src/foo.ts',
      mutationScore: '100.00%',
      summary: { total: 10, killed: 10, survived: 0 },
      survivors: [],
      noCoverage: [],
      note: 'No surviving mutants — the test suite caught every mutation.',
    });
  });

  it('groups survivors by line with mutator counts', () => {
    const payload = buildResultPayload(
      result({
        vulnerabilities: [
          { line: 3, mutator: 'ConditionalExpression', description: 'survived' },
          { line: 3, mutator: 'ConditionalExpression', description: 'survived' },
        ],
      }),
    );
    expect(payload.survivors).toEqual([{ line: 3, mutators: { ConditionalExpression: 2 } }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/format-payload.test.ts`
Expected: FAIL — `buildResultPayload` is not exported.

- [ ] **Step 3: Implement the extraction**

In `src/format.ts`, add the interfaces and `buildResultPayload`, then make `formatResultAsJson` delegate to it. Move the body of the current `formatResultAsJson` into `buildResultPayload`, returning the object instead of `JSON.stringify(...)`:

```ts
export interface ResultPayload {
  target: string;
  mutationScore: string;
  summary: { total: number; killed: number; survived: number; worstSeverity?: Severity };
  survivors: LineGroup[];
  noCoverage: LineGroup[];
  suggestedTestFile?: { path: string; exists: boolean };
  ignoredOptions?: string[];
  survivorsTruncated?: number;
  noCoverageTruncated?: number;
  survivorsFiltered?: number;
  noCoverageFiltered?: number;
  scopeNote?: string;
  enrichNote?: string;
  note: string;
}

export interface ResultPayloadOpts {
  enrich?: EnrichContext;
  maxSurvivors?: number;
  severityFloor?: Severity;
  suggestedTestFile?: { path: string; exists: boolean };
  ignoredOptions?: string[];
}

export function buildResultPayload(result: MutationResult, opts: ResultPayloadOpts = {}): ResultPayload {
  const { enrich } = opts;
  const compact = compactSurvivors(result);
  let survivors: LineGroup[] = compact.survivors;
  let noCoverage: LineGroup[] = compact.noCoverage;
  const clean = survivors.length === 0 && noCoverage.length === 0;

  let worstSeverity: Severity | undefined;
  let enrichNote: string | undefined;
  if (enrich) {
    const s = enrichGroups(survivors, enrich);
    const n = enrichGroups(noCoverage, enrich);
    survivors = s.groups;
    noCoverage = n.groups;
    if (survivors.length > 0) worstSeverity = s.worst;
    if (s.hasUnknown || n.hasUnknown) {
      enrichNote =
        'some mutants could not be classified — this language\'s mutation tool doesn\'t expose per-mutant operator detail (severity reported as "unknown").';
    }
  }

  const hasChanges = [...survivors, ...noCoverage].some((g) => g.changes);
  const baseNote =
    'survivors: mutants your tests ran but did not kill. noCoverage: mutants no test reached (per line+mutator, so a line may appear here and in survivors). mutators = type→count. Add or strengthen tests targeting these.';

  const summary: ResultPayload['summary'] = {
    total: result.totalMutants,
    killed: result.killed,
    survived: result.survived,
  };
  if (worstSeverity) summary.worstSeverity = worstSeverity;

  const payload: ResultPayload = {
    target: result.target,
    mutationScore: result.mutationScore,
    summary,
    survivors,
    noCoverage,
    note: clean
      ? 'No surviving mutants — the test suite caught every mutation.'
      : hasChanges
        ? `${baseNote} changes = sampled original→mutated edits for that line (capped).`
        : baseNote,
  };
  if (enrichNote) payload.enrichNote = enrichNote;
  if (result.scopeNote) payload.scopeNote = result.scopeNote;
  return payload;
}

export function formatResultAsJson(result: MutationResult, enrich?: EnrichContext): string {
  return JSON.stringify(buildResultPayload(result, { enrich }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run src/__tests__/format-payload.test.ts src/__tests__/format.test.ts`
Expected: PASS (existing `format.test.ts` still green — output bytes unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/format.ts src/__tests__/format-payload.test.ts
git commit -m "refactor: extract buildResultPayload from formatResultAsJson"
```

---

### Task 2: `maxSurvivors` cap in the formatter

**Files:**
- Modify: `src/format.ts` (`buildResultPayload`, `formatResultAsText`)
- Test: `src/__tests__/format-payload.test.ts`

**Interfaces:**
- Consumes: `ResultPayloadOpts.maxSurvivors`
- Produces: helper `function capGroups(groups: LineGroup[], max: number | undefined): { groups: LineGroup[]; truncated: number }`
- Produces: `formatResultAsText(result, enrich?, opts?: { maxSurvivors?: number; severityFloor?: Severity })` — extended signature (both new params optional, default behavior unchanged when omitted).

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/format-payload.test.ts`:

```ts
function manySurvivors(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    line: i + 1,
    mutator: 'ConditionalExpression',
    description: 'survived',
  }));
}

describe('buildResultPayload maxSurvivors', () => {
  it('caps survivors and records how many were truncated', () => {
    const payload = buildResultPayload(result({ vulnerabilities: manySurvivors(15) }), {
      maxSurvivors: 10,
    });
    expect(payload.survivors).toHaveLength(10);
    expect(payload.survivorsTruncated).toBe(5);
  });

  it('omits the truncation count when nothing is dropped', () => {
    const payload = buildResultPayload(result({ vulnerabilities: manySurvivors(3) }), {
      maxSurvivors: 10,
    });
    expect(payload.survivors).toHaveLength(3);
    expect(payload.survivorsTruncated).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/format-payload.test.ts -t maxSurvivors`
Expected: FAIL — `survivorsTruncated` undefined / no cap applied.

- [ ] **Step 3: Implement the cap**

In `src/format.ts` add the helper and apply it in `buildResultPayload` after the (optional) enrich step:

```ts
function capGroups(groups: LineGroup[], max: number | undefined): { groups: LineGroup[]; truncated: number } {
  if (typeof max !== 'number' || groups.length <= max) return { groups, truncated: 0 };
  return { groups: groups.slice(0, max), truncated: groups.length - max };
}
```

In `buildResultPayload`, after enrichment assigns `survivors`/`noCoverage`, before building `payload`:

```ts
  const sCap = capGroups(survivors, opts.maxSurvivors);
  const nCap = capGroups(noCoverage, opts.maxSurvivors);
  survivors = sCap.groups;
  noCoverage = nCap.groups;
```

Then after constructing `payload`:

```ts
  if (sCap.truncated > 0) payload.survivorsTruncated = sCap.truncated;
  if (nCap.truncated > 0) payload.noCoverageTruncated = nCap.truncated;
```

Update `formatResultAsText` to accept and apply the same cap. Change its signature to `formatResultAsText(result: MutationResult, enrich?: EnrichContext, opts: { maxSurvivors?: number; severityFloor?: Severity } = {})`. After `compactSurvivors` and the optional `enrichGroups`, apply `capGroups(survivors, opts.maxSurvivors)` / `capGroups(noCoverage, opts.maxSurvivors)` and, when truncated > 0, push a line `  …${truncated} more (raise maxSurvivors to see them)` after the respective group list.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run src/__tests__/format-payload.test.ts src/__tests__/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/format.ts src/__tests__/format-payload.test.ts
git commit -m "feat: cap survivors at maxSurvivors with truncation count"
```

---

### Task 3: `severityFloor` filter in the formatter

**Files:**
- Modify: `src/format.ts` (`buildResultPayload`, `formatResultAsText`)
- Test: `src/__tests__/format-payload.test.ts`

**Interfaces:**
- Consumes: `ResultPayloadOpts.severityFloor`, `SEVERITY_RANK`, `Severity`
- Produces: helper `function floorGroups(groups: LineGroup[], floor: Severity | undefined, enriched: boolean): { groups: LineGroup[]; filtered: number }`
- Filter order in `buildResultPayload`: enrich → **floor** → cap. (Floor runs before cap so the cap applies to surviving-the-floor groups.)

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/format-payload.test.ts`:

```ts
describe('buildResultPayload severityFloor', () => {
  it('drops groups below the floor and counts them, when enriched', () => {
    const payload = buildResultPayload(
      result({
        vulnerabilities: [
          { line: 1, mutator: 'ConditionalExpression', description: 'survived' }, // high
          { line: 2, mutator: 'StringLiteral', description: 'survived' }, // low
        ],
      }),
      { enrich: { projectType: 'typescript' }, severityFloor: 'high' },
    );
    expect(payload.survivors).toHaveLength(1);
    expect(payload.survivors[0].line).toBe(1);
    expect(payload.survivorsFiltered).toBe(1);
  });

  it('ignores severityFloor when not enriched and notes why', () => {
    const payload = buildResultPayload(
      result({ vulnerabilities: [{ line: 1, mutator: 'ConditionalExpression', description: 'survived' }] }),
      { severityFloor: 'high' },
    );
    expect(payload.survivors).toHaveLength(1);
    expect(payload.survivorsFiltered).toBeUndefined();
    expect(payload.enrichNote).toContain('severityFloor');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/format-payload.test.ts -t severityFloor`
Expected: FAIL.

- [ ] **Step 3: Implement the filter**

Add to `src/format.ts`:

```ts
function floorGroups(
  groups: LineGroup[],
  floor: Severity | undefined,
  enriched: boolean,
): { groups: LineGroup[]; filtered: number } {
  if (!enriched || !floor) return { groups, filtered: 0 };
  const min = SEVERITY_RANK[floor];
  const kept = groups.filter((g) => SEVERITY_RANK[(g as EnrichedGroup).severity ?? 'unknown'] >= min);
  return { groups: kept, filtered: groups.length - kept.length };
}
```

In `buildResultPayload`, between enrichment and the cap step:

```ts
  const enriched = Boolean(enrich);
  const sFloor = floorGroups(survivors, opts.severityFloor, enriched);
  const nFloor = floorGroups(noCoverage, opts.severityFloor, enriched);
  survivors = sFloor.groups;
  noCoverage = nFloor.groups;
  if (!enriched && opts.severityFloor) {
    enrichNote =
      'severityFloor was ignored: it requires enrichment (severity classification), which is off for this run.';
  }
```

After building `payload`, attach counts:

```ts
  if (sFloor.filtered > 0) payload.survivorsFiltered = sFloor.filtered;
  if (nFloor.filtered > 0) payload.noCoverageFiltered = nFloor.filtered;
```

Note: `enrichNote` is declared with `let` in Task 1; this assignment reuses it. The enrich-on `enrichNote` (unclassifiable mutants) and the severityFloor-ignored note are mutually exclusive (the former needs `enrich`, the latter needs `!enrich`), so they never overwrite each other.

Update `formatResultAsText` to apply `floorGroups` before `capGroups` using `opts.severityFloor` and the same `enriched` flag.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run src/__tests__/format-payload.test.ts src/__tests__/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/format.ts src/__tests__/format-payload.test.ts
git commit -m "feat: add severityFloor report-time filter with filtered count"
```

---

### Task 4: `suggestTestFile` helper module

**Files:**
- Create: `src/test-file.ts`
- Test: `src/__tests__/test-file.test.ts` (create)

**Interfaces:**
- Produces: `export function suggestTestFile(targetFile: string, projectType: SupportedProjectType, workspaceRoot: string): { path: string; exists: boolean } | undefined`
- `targetFile` is workspace-root-relative; `workspaceRoot` is absolute. Returned `path` is workspace-root-relative.
- Consumes: `SupportedProjectType` from `./engines/registry.js`; `existsSync`, `join`, `dirname`, `basename`, `extname` from node.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/test-file.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { suggestTestFile } from '../test-file.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chaos-suggest-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('suggestTestFile', () => {
  it('returns an existing co-located TS test with exists:true', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), '');
    writeFileSync(join(root, 'src', 'math.test.ts'), '');
    expect(suggestTestFile('src/math.ts', 'typescript', root)).toEqual({
      path: 'src/math.test.ts',
      exists: true,
    });
  });

  it('falls back to the conventional candidate with exists:false', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), '');
    expect(suggestTestFile('src/math.ts', 'typescript', root)).toEqual({
      path: 'src/math.test.ts',
      exists: false,
    });
  });

  it('uses Go co-located convention', () => {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'calc.go'), '');
    expect(suggestTestFile('pkg/calc.go', 'go', root)).toEqual({
      path: 'pkg/calc_test.go',
      exists: false,
    });
  });

  it('uses Python test_ convention and finds it under tests/', () => {
    mkdirSync(join(root, 'app'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'app', 'calc.py'), '');
    writeFileSync(join(root, 'tests', 'test_calc.py'), '');
    expect(suggestTestFile('app/calc.py', 'python', root)).toEqual({
      path: 'tests/test_calc.py',
      exists: true,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/test-file.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `src/test-file.ts`:

```ts
import { existsSync } from 'fs';
import { join, dirname, basename, extname } from 'path';
import type { SupportedProjectType } from './engines/registry.js';

/**
 * Candidate test-file paths (workspace-root-relative) for a target, in priority
 * order. The first that exists on disk wins; if none exist, the first candidate
 * is returned as the "would create" suggestion.
 */
function candidates(targetFile: string, projectType: SupportedProjectType): string[] {
  const dir = dirname(targetFile);
  const ext = extname(targetFile);
  const base = basename(targetFile, ext);
  const j = (...p: string[]) => p.join('/').replace(/^\.\//, '');

  switch (projectType) {
    case 'typescript': {
      return [
        j(dir, `${base}.test${ext}`),
        j(dir, `${base}.spec${ext}`),
        j(dir, '__tests__', `${base}.test${ext}`),
        j('test', `${base}.test${ext}`),
        j('tests', `${base}.test${ext}`),
      ];
    }
    case 'python':
      return [j(dir, `test_${base}.py`), j('tests', `test_${base}.py`)];
    case 'go':
      return [j(dir, `${base}_test.go`)];
    case 'rust':
      // Rust convention is in-file #[cfg(test)]; suggest the source file itself,
      // then an integration-test fallback under tests/.
      return [targetFile, j('tests', `${base}.rs`)];
    default:
      return [];
  }
}

export function suggestTestFile(
  targetFile: string,
  projectType: SupportedProjectType,
  workspaceRoot: string,
): { path: string; exists: boolean } | undefined {
  let cands: string[];
  try {
    cands = candidates(targetFile, projectType);
  } catch {
    return undefined;
  }
  if (cands.length === 0) return undefined;
  for (const rel of cands) {
    try {
      if (existsSync(join(workspaceRoot, rel))) return { path: rel, exists: true };
    } catch {
      // ignore and keep probing
    }
  }
  return { path: cands[0], exists: false };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run src/__tests__/test-file.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/test-file.ts src/__tests__/test-file.test.ts
git commit -m "feat: add suggestTestFile project-aware test path helper"
```

---

### Task 5: Tool schema — `maxSurvivors`, `severityFloor`, enrich default, `outputSchema`

**Files:**
- Modify: `src/tool-schema.ts` (`TOOL_DEFINITION`)
- Test: `src/__tests__/tool-schema.test.ts`

**Interfaces:**
- Produces: `TOOL_DEFINITION.inputSchema.properties.maxSurvivors`, `.severityFloor`, an updated `enrich` description, and `TOOL_DEFINITION.outputSchema`.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/tool-schema.test.ts` (match the file's existing import/style):

```ts
import { TOOL_DEFINITION } from '../tool-schema.js';

describe('TOOL_DEFINITION phase-1 additions', () => {
  it('declares maxSurvivors and severityFloor inputs', () => {
    const props = TOOL_DEFINITION.inputSchema.properties as Record<string, any>;
    expect(props.maxSurvivors.type).toBe('integer');
    expect(props.maxSurvivors.minimum).toBe(1);
    expect(props.severityFloor.enum).toEqual(['high', 'medium', 'low']);
  });

  it('documents enrich as default-on', () => {
    const props = TOOL_DEFINITION.inputSchema.properties as Record<string, any>;
    expect(props.enrich.description.toLowerCase()).toContain('default');
    expect(props.enrich.description.toLowerCase()).toContain('true');
  });

  it('exposes an outputSchema with survivors and summary', () => {
    const out = (TOOL_DEFINITION as any).outputSchema;
    expect(out.type).toBe('object');
    expect(out.properties.summary).toBeDefined();
    expect(out.properties.survivors).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/tool-schema.test.ts -t phase-1`
Expected: FAIL.

- [ ] **Step 3: Implement the schema additions**

In `src/tool-schema.ts`, add to `inputSchema.properties`:

```ts
      maxSurvivors: {
        type: 'integer',
        minimum: 1,
        description:
          'Cap on how many survivor (and how many no-coverage) line groups are returned, after severity ranking. ' +
          'Hidden groups are counted in survivorsTruncated/noCoverageTruncated. ' +
          'Precedence: this arg > config.defaultMaxSurvivors > 10. Example: 20',
      },
      severityFloor: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description:
          'Report-time filter: drop survivor groups below this severity (requires enrichment, which is on by default). ' +
          'Dropped groups are counted in survivorsFiltered/noCoverageFiltered. "unknown"-severity groups are below "low" and are dropped by any floor. ' +
          'Ignored (with a note) when enrich is false. Example: "high"',
      },
```

Rewrite the `enrich` description to state it now defaults to **true**:

```ts
      enrich: {
        type: 'boolean',
        description:
          'Augment each surviving / no-coverage line with deterministic guidance: severity (high/medium/low), ' +
          'a "why it matters" explanation, a test-writing hint, and a source-context snippet — and rank survivors severity-first. ' +
          'Defaults to TRUE; pass false to disable and return the plain (unranked, unclassified) output. ' +
          'Richest for TypeScript and Go; Python reports severity "unknown".',
      },
```

Add a sibling `outputSchema` to `TOOL_DEFINITION` (after `inputSchema`):

```ts
  outputSchema: {
    type: 'object' as const,
    properties: {
      target: { type: 'string' },
      mutationScore: { type: 'string' },
      summary: {
        type: 'object',
        properties: {
          total: { type: 'integer' },
          killed: { type: 'integer' },
          survived: { type: 'integer' },
          worstSeverity: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
        },
        required: ['total', 'killed', 'survived'],
      },
      survivors: { type: 'array', items: { type: 'object' } },
      noCoverage: { type: 'array', items: { type: 'object' } },
      suggestedTestFile: {
        type: 'object',
        properties: { path: { type: 'string' }, exists: { type: 'boolean' } },
      },
      ignoredOptions: { type: 'array', items: { type: 'string' } },
      survivorsTruncated: { type: 'integer' },
      noCoverageTruncated: { type: 'integer' },
      survivorsFiltered: { type: 'integer' },
      noCoverageFiltered: { type: 'integer' },
      scopeNote: { type: 'string' },
      enrichNote: { type: 'string' },
      note: { type: 'string' },
    },
    required: ['target', 'mutationScore', 'summary', 'survivors', 'noCoverage', 'note'],
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run src/__tests__/tool-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tool-schema.ts src/__tests__/tool-schema.test.ts
git commit -m "feat: add maxSurvivors/severityFloor inputs + outputSchema to tool definition"
```

---

### Task 6: Config — `defaultMaxSurvivors` and `defaultSeverityFloor`

**Files:**
- Modify: `src/utils/config-loader.ts` (`KNOWN_KEYS`, `ChaosConfig`, `buildConfig`, `validateConfig`)
- Test: `src/__tests__/config-loader.test.ts`

**Interfaces:**
- Produces: `ChaosConfig.defaultMaxSurvivors?: number`, `ChaosConfig.defaultSeverityFloor?: 'high' | 'medium' | 'low'`.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/config-loader.test.ts` (reuse the file's existing tmp-config helpers; this snippet shows the assertions — adapt the file-writing to the existing helper):

```ts
it('loads defaultMaxSurvivors and defaultSeverityFloor', () => {
  const cfg = loadConfigFromObject({ defaultMaxSurvivors: 20, defaultSeverityFloor: 'high' });
  expect(cfg.defaultMaxSurvivors).toBe(20);
  expect(cfg.defaultSeverityFloor).toBe('high');
});

it('rejects invalid defaultMaxSurvivors and defaultSeverityFloor with warnings', () => {
  const { config, warnings } = validateConfigFromObject({
    defaultMaxSurvivors: 0,
    defaultSeverityFloor: 'critical',
  });
  expect(config.defaultMaxSurvivors).toBeUndefined();
  expect(config.defaultSeverityFloor).toBeUndefined();
  expect(warnings.join(' ')).toContain('defaultMaxSurvivors');
  expect(warnings.join(' ')).toContain('defaultSeverityFloor');
});
```

If the test file writes a temp JSON file and calls `loadConfig(path)` / `validateConfig(path)` rather than `*FromObject` helpers, follow that existing pattern instead — the assertions above are what matters.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/config-loader.test.ts -t defaultMaxSurvivors`
Expected: FAIL.

- [ ] **Step 3: Implement the config fields**

In `src/utils/config-loader.ts`:

Add to `KNOWN_KEYS`: `'defaultMaxSurvivors'`, `'defaultSeverityFloor'`.

Add to `interface ChaosConfig`:

```ts
  /** Default cap on survivor/no-coverage groups returned by audit_code_resilience (integer >= 1; default 10). */
  defaultMaxSurvivors?: number;
  /** Default severity floor for audit_code_resilience survivor reporting. */
  defaultSeverityFloor?: 'high' | 'medium' | 'low';
```

In `buildConfig`, after the `defaultMaxFiles` block:

```ts
  if (
    typeof raw.defaultMaxSurvivors === 'number' &&
    Number.isInteger(raw.defaultMaxSurvivors) &&
    raw.defaultMaxSurvivors >= 1
  ) {
    result.defaultMaxSurvivors = raw.defaultMaxSurvivors;
  }
  if (
    raw.defaultSeverityFloor === 'high' ||
    raw.defaultSeverityFloor === 'medium' ||
    raw.defaultSeverityFloor === 'low'
  ) {
    result.defaultSeverityFloor = raw.defaultSeverityFloor;
  }
```

In `validateConfig`, in the global-fields section:

```ts
  if (
    'defaultMaxSurvivors' in raw &&
    (typeof raw.defaultMaxSurvivors !== 'number' ||
      !Number.isInteger(raw.defaultMaxSurvivors) ||
      raw.defaultMaxSurvivors < 1)
  ) {
    warnings.push(
      `defaultMaxSurvivors must be an integer >= 1, got ${typeof raw.defaultMaxSurvivors === 'number' ? raw.defaultMaxSurvivors : typeof raw.defaultMaxSurvivors}.`,
    );
  }
  if (
    'defaultSeverityFloor' in raw &&
    raw.defaultSeverityFloor !== 'high' &&
    raw.defaultSeverityFloor !== 'medium' &&
    raw.defaultSeverityFloor !== 'low'
  ) {
    warnings.push(
      `defaultSeverityFloor must be one of "high"|"medium"|"low", got ${JSON.stringify(raw.defaultSeverityFloor)}.`,
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run src/__tests__/config-loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/config-loader.ts src/__tests__/config-loader.test.ts
git commit -m "feat: add defaultMaxSurvivors/defaultSeverityFloor config fields"
```

---

### Task 7: Handler argument validators — `maxSurvivors`, `severityFloor`

**Files:**
- Modify: `src/handler.ts` (add validators + register in `TOOL_ARG_VALIDATORS`, `handler.ts:239`)
- Test: `src/__tests__/handler.test.ts` (or `handler-helpers.test.ts`, wherever `validateToolArgs` is exercised)

**Interfaces:**
- Produces: `validateMaxSurvivorsArg(args)` and `validateSeverityFloorArg(args)` appended to `TOOL_ARG_VALIDATORS`.

- [ ] **Step 1: Write the failing test**

Add to the validator test file (mirror existing `validateToolArgs` tests):

```ts
import { validateToolArgs } from '../handler.js';

describe('validateToolArgs phase-1 args', () => {
  it('rejects non-integer maxSurvivors', () => {
    const err = validateToolArgs({ maxSurvivors: 2.5 });
    expect(err?.isError).toBe(true);
    expect((err?.content[0] as any).text).toContain('maxSurvivors');
  });
  it('rejects maxSurvivors < 1', () => {
    expect(validateToolArgs({ maxSurvivors: 0 })?.isError).toBe(true);
  });
  it('accepts a valid maxSurvivors', () => {
    expect(validateToolArgs({ maxSurvivors: 25 })).toBeNull();
  });
  it('rejects an unknown severityFloor', () => {
    const err = validateToolArgs({ severityFloor: 'critical' });
    expect(err?.isError).toBe(true);
    expect((err?.content[0] as any).text).toContain('severityFloor');
  });
  it('accepts a valid severityFloor', () => {
    expect(validateToolArgs({ severityFloor: 'high' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/handler.test.ts -t "phase-1 args"`
Expected: FAIL.

- [ ] **Step 3: Implement the validators**

In `src/handler.ts`, define the two validators (next to the existing ones):

```ts
/** maxSurvivors: integer >= 1 when present. */
function validateMaxSurvivorsArg(args: ToolArgs): string | null {
  if (
    args.maxSurvivors !== undefined &&
    (typeof args.maxSurvivors !== 'number' ||
      !Number.isInteger(args.maxSurvivors) ||
      args.maxSurvivors < 1)
  ) {
    return 'maxSurvivors must be an integer >= 1. Example: 20.';
  }
  return null;
}

/** severityFloor: one of high|medium|low when present. */
function validateSeverityFloorArg(args: ToolArgs): string | null {
  if (
    args.severityFloor !== undefined &&
    args.severityFloor !== 'high' &&
    args.severityFloor !== 'medium' &&
    args.severityFloor !== 'low'
  ) {
    return 'severityFloor must be one of "high", "medium", or "low". Example: "high".';
  }
  return null;
}
```

Register both at the end of `TOOL_ARG_VALIDATORS`:

```ts
const TOOL_ARG_VALIDATORS: ((args: ToolArgs) => string | null)[] = [
  validatePerMutantTimeoutMs,
  validatePrebuildCommand,
  validateConcurrencyArg,
  validateLineScopeArg,
  validateDiffBaseArg,
  validateBaselineArg,
  validateEnrichArg,
  validateMaxSurvivorsArg,
  validateSeverityFloorArg,
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run src/__tests__/handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/handler.ts src/__tests__/handler.test.ts
git commit -m "feat: validate maxSurvivors and severityFloor tool args"
```

---

### Task 8: Handler wiring — enrich-by-default, resolve caps, suggestion, structuredContent

This is the integration task that makes the user-visible behavior change.

**Files:**
- Modify: `src/handler.ts` (`buildEnrichContext` `handler.ts:380`, `formatAuditOutput` `handler.ts:557`, the call site `handler.ts:755`)
- Test: `src/__tests__/handler.test.ts`

**Interfaces:**
- Consumes: `buildResultPayload`, `formatResultAsJson`, `formatResultAsText` (extended opts) from `./format.js`; `suggestTestFile` from `./test-file.js`; `ResultPayload` type.
- Produces: `formatAuditOutput` now returns a `CallToolResult` whose first content block is the text rendering AND which carries `structuredContent: ResultPayload`.

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/handler.test.ts` an integration-style test using a fake engine result. If the file already has a helper that drives `handleToolCall` against a fixture, reuse it; otherwise assert at the `formatAuditOutput` seam by exporting it. Target assertions:

```ts
// Given a MutationResult with a high + low survivor, default behavior (no enrich arg):
//  - result.structuredContent.summary.worstSeverity === 'high'   (enriched by default)
//  - result.structuredContent.survivors[0].severity === 'high'   (severity-ranked)
//  - result.content[0].text is parseable JSON equal to structuredContent (json mode)
//  - passing enrich:false yields survivors without a `severity` field
expect(res.structuredContent).toBeDefined();
expect((res.structuredContent as any).summary.worstSeverity).toBe('high');
const parsed = JSON.parse((res.content[0] as any).text);
expect(parsed).toEqual(res.structuredContent);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/handler.test.ts -t structuredContent`
Expected: FAIL — no `structuredContent` on the result.

- [ ] **Step 3: Implement the wiring**

In `src/handler.ts`:

(a) Flip the enrich default in `buildEnrichContext`:

```ts
export function buildEnrichContext(
  args: ToolArgs,
  resolvedFile: string,
  projectType: SupportedProjectType,
): EnrichContext | undefined {
  if (args.enrich === false) return undefined; // default-on: only an explicit false disables
  let sourceLines: string[] | undefined;
  try {
    sourceLines = readFileSync(resolvedFile, 'utf8').split(/\r?\n/);
  } catch {
    sourceLines = undefined;
  }
  return { projectType, sourceLines };
}
```

(b) Add a resolver for the cap/floor near `buildRunOptions` (precedence arg > config > default):

```ts
const DEFAULT_MAX_SURVIVORS = 10;

function resolveMaxSurvivors(args: ToolArgs, cfg: ChaosConfig): number {
  if (typeof args.maxSurvivors === 'number' && Number.isInteger(args.maxSurvivors) && args.maxSurvivors >= 1) {
    return args.maxSurvivors;
  }
  if (typeof cfg.defaultMaxSurvivors === 'number') return cfg.defaultMaxSurvivors;
  return DEFAULT_MAX_SURVIVORS;
}

function resolveSeverityFloor(args: ToolArgs, cfg: ChaosConfig): Severity | undefined {
  const a = args.severityFloor;
  if (a === 'high' || a === 'medium' || a === 'low') return a;
  return cfg.defaultSeverityFloor;
}
```

Import `Severity` and the payload builder at the top: `import { formatResultAsText, formatResultAsJson, buildResultPayload, type EnrichContext } from './format.js';` and `import type { Severity } from './enrich.js';` and `import { suggestTestFile } from './test-file.js';`.

(c) Rewrite `formatAuditOutput` to build the payload once and return both representations. The verify-mode branch is unchanged (keeps its own formatters, no structuredContent). New non-verify branch:

```ts
  const enrichOpts = {
    enrich: enrichCtx,
    maxSurvivors: resolveMaxSurvivors(args, cfg),
    severityFloor: resolveSeverityFloor(args, cfg),
  };
  const ignored = ignoredOptionsFor(projectType, args);
  const suggestion =
    auditResults.survived > 0 || auditResults.vulnerabilities.length > 0
      ? suggestTestFile(targetFile, projectType, env.workspaceRoot)
      : undefined;

  const payload = buildResultPayload(auditResults, {
    ...enrichOpts,
    suggestedTestFile: suggestion,
    ignoredOptions: ignored.length > 0 ? ignored : undefined,
  });

  const text =
    args.outputFormat === 'text'
      ? formatResultAsText(auditResults, enrichCtx, enrichOpts)
      : JSON.stringify(payload);

  const content: { type: 'text'; text: string }[] = [{ type: 'text', text }];
  if (ignored.length > 0) {
    content.push({
      type: 'text',
      text: `Note: the following option(s) are StrykerJS-only and were ignored for this ${projectType} target: ${ignored.join(', ')}.`,
    });
  }
  return { content, structuredContent: payload };
```

`formatAuditOutput` needs `cfg` and `env` — add them to its parameter list and pass them from the call site (`handler.ts:755`). The `suggestedTestFile`/`ignoredOptions` must also be reflected in `buildResultPayload` output — confirm `ResultPayload` carries them (Task 1) and add them to the payload object construction in `buildResultPayload`:

In `src/format.ts` `buildResultPayload`, after building `payload`:

```ts
  if (opts.suggestedTestFile) payload.suggestedTestFile = opts.suggestedTestFile;
  if (opts.ignoredOptions && opts.ignoredOptions.length > 0) payload.ignoredOptions = opts.ignoredOptions;
```

(d) Update the call site to pass `cfg`, `env`, and the resolved `enrichCtx`:

```ts
      const enrichCtx = buildEnrichContext(args, resolvedFile, projectType);
      return formatAuditOutput(auditResults, args, projectType, baselineKeys, targetFile, enrichCtx, cfg, env);
```

- [ ] **Step 4: Run tests to verify they pass + update existing expectations**

Run: `npm run build && npx vitest run src/__tests__/handler.test.ts src/__tests__/format.test.ts`
Expected: PASS. Existing handler tests that asserted the old no-`structuredContent` / non-enriched default output must be updated to expect the new default (enriched, severity-ranked, `structuredContent` present). This is the expected migration cost called out in the spec.

- [ ] **Step 5: Commit**

```bash
git add src/handler.ts src/format.ts src/__tests__/handler.test.ts src/__tests__/format.test.ts
git commit -m "feat: enrich by default and return structuredContent from audit_code_resilience"
```

---

### Task 9: Go enrichment — JSON reporter spike + mutator→category mapping

The mapping function is unconditionally deliverable and unit-testable; the engine JSON wiring is gated on the spike and falls back to `unknown` if unavailable.

**Files:**
- Modify: `src/enrich.ts` (`canonicalizeMutator` `enrich.ts:140`, add a Go map)
- Modify: `src/engines/go.ts` (enable JSON reporter if the spike confirms support; populate `Vulnerability.mutator`)
- Test: `src/__tests__/enrich-canonicalize.test.ts`, `src/__tests__/go-engine.test.ts`

**Interfaces:**
- Produces: a `GO_MUTATOR_MAP: Record<string, string>` consulted by `canonicalizeMutator` when `projectType === 'go'`.
- Consumes: `MUTATOR_SEMANTICS` keys (`ConditionalExpression`, `EqualityOperator`, `BlockStatement`, `MethodExpression`, `ArithmeticOperator`).

- [ ] **Step 1: Spike — confirm go-mutesting structured output**

Run (in the repo, with go-mutesting installed) and record the result in the commit message:

```bash
go-mutesting --help 2>&1 | grep -iE 'json|reporter|format' || echo "no structured-output flag found"
```

Decision:
- **If a JSON/structured reporter flag exists:** implement Step 4 (engine wiring) so each mutant carries its `mutator` name.
- **If not:** skip Step 4; Go survivors keep `mutator: 'Go Mutation Operator'` and stay `severity: unknown`. The mapping (Steps 2–3) still lands so enrichment activates automatically once a structured reporter is available. Note the finding in the commit message.

- [ ] **Step 2: Write the failing test for the mapping**

Append to `src/__tests__/enrich-canonicalize.test.ts`:

```ts
import { canonicalizeMutator } from '../enrich.js';

describe('canonicalizeMutator (go)', () => {
  it('maps go-mutesting branch mutators to ConditionalExpression', () => {
    expect(canonicalizeMutator('branch/if', 'go')).toBe('ConditionalExpression');
    expect(canonicalizeMutator('branch/else', 'go')).toBe('ConditionalExpression');
    expect(canonicalizeMutator('branch/case', 'go')).toBe('ConditionalExpression');
  });
  it('maps comparison/remove mutators', () => {
    expect(canonicalizeMutator('expression/comparison', 'go')).toBe('EqualityOperator');
    expect(canonicalizeMutator('expression/remove', 'go')).toBe('MethodExpression');
    expect(canonicalizeMutator('statement/remove', 'go')).toBe('BlockStatement');
  });
  it('falls back to unknown for unmapped go mutators', () => {
    expect(canonicalizeMutator('something/weird', 'go')).toBe('unknown');
    expect(canonicalizeMutator('Go Mutation Operator', 'go')).toBe('unknown');
  });
});
```

- [ ] **Step 3: Implement the Go mapping**

In `src/enrich.ts`, add the map and a `go` branch in `canonicalizeMutator`:

```ts
/**
 * go-mutesting mutator name → canonical category. go-mutesting names its
 * mutators "<group>/<name>" (e.g. "branch/if"). Unmapped names → unknown.
 */
const GO_MUTATOR_MAP: Record<string, string> = {
  'branch/if': 'ConditionalExpression',
  'branch/else': 'ConditionalExpression',
  'branch/case': 'ConditionalExpression',
  'expression/comparison': 'EqualityOperator',
  'expression/remove': 'MethodExpression',
  'statement/remove': 'BlockStatement',
};
```

In `canonicalizeMutator`, before the final `return 'unknown'`:

```ts
  if (projectType === 'go') {
    return GO_MUTATOR_MAP[rawMutator] ?? 'unknown';
  }
```

- [ ] **Step 4: (Conditional on Step 1) Wire the engine to emit mutator names**

Only if the spike found a structured reporter. In `src/engines/go.ts`, pass the reporter flag in the `invokeMutationTool` args, and in `parseGoMutestingOutput`'s JSON branch set `mutator: m.mutator ?? 'Go Mutation Operator'` (already present, `go.ts:126`). Ensure the survivor `Vulnerability.mutator` carries `m.mutator` verbatim so `canonicalizeMutator` can map it. Add a `go-engine.test.ts` case feeding a JSON stdout sample with `"mutator": "branch/if"` and asserting the parsed vulnerability's `mutator === 'branch/if'`.

If the spike found no reporter, write a one-line comment in `go.ts` above the engine class documenting that Go enrichment is pending structured-output support, and skip the test addition.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build && npx vitest run src/__tests__/enrich-canonicalize.test.ts src/__tests__/go-engine.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/enrich.ts src/engines/go.ts src/__tests__/enrich-canonicalize.test.ts src/__tests__/go-engine.test.ts
git commit -m "feat: map go-mutesting mutator names to canonical severity categories"
```

---

### Task 10: Full gate + self-mutation smoke + docs

**Files:**
- Modify: `README.md` (document the new args + default-on enrichment + structuredContent), `CHANGELOG.md`
- No new test file.

- [ ] **Step 1: Run the full gate**

Run: `npm run check`
Expected: build, lint, format:check, and all tests PASS on the local Node version.

- [ ] **Step 2: Run the self-mutation smoke**

Run: `node scripts/audit-self.js src/format.ts` then `node scripts/meta-test.js`
Expected: completes without crashing; survivors (if any) are genuine gaps, not regressions. Do not chase equivalent mutants.

- [ ] **Step 3: Update docs**

In `README.md`, document: `enrich` now defaults to true, the new `maxSurvivors` and `severityFloor` args, the `suggestedTestFile` field, Go severity support, and that the tool now returns `structuredContent` (with the text block retained for compatibility). Add a `CHANGELOG.md` entry under a new unreleased heading summarizing Phase 1.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document Phase 1 output/enrichment changes"
```

---

## Self-Review

**Spec coverage:**
- #4 structuredContent → Tasks 1, 5 (outputSchema), 8 (wiring). ✓
- #5 enrich default-on + maxSurvivors → Tasks 2, 6 (config default), 7 (validation), 8 (default flip + resolution). ✓
- #9 suggestedTestFile → Tasks 4, 8 (wiring). ✓
- #10 Go enrichment → Task 9 (mapping unconditional; engine gated on spike). ✓
- #12 severityFloor → Tasks 3, 6 (config default), 7 (validation), 8 (resolution). ✓
- Schema/config/validation → Tasks 5, 6, 7. ✓
- Testing + migration + gate → embedded per task + Task 10. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to" — every code step shows full code. The one investigative step (Task 9 Step 1) is an explicit spike with a concrete command and a binary decision, plus a defined graceful fallback; the rest of Task 9 lands unconditionally and is unit-tested.

**Type consistency:** `ResultPayload`/`ResultPayloadOpts` defined in Task 1 are consumed unchanged in Tasks 2, 3, 8. `capGroups`/`floorGroups` signatures match their call sites. `resolveMaxSurvivors`/`resolveSeverityFloor` return types (`number` / `Severity | undefined`) match `ResultPayloadOpts`. `suggestTestFile` signature is identical across Tasks 4 and 8. `canonicalizeMutator('…', 'go')` is called with the existing 2-arg form (changeText optional). `formatAuditOutput`'s new `cfg`/`env` params are threaded from the single call site.

**Note on ordering:** Tasks 1–7 and 9 are independent and individually green. Task 8 is the integration point and depends on 1–4, 6, 7. Task 10 is the final gate.
