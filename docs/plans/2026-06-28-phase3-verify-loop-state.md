# Phase 3 — Verify Loop & State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the server memory — a `runId`-keyed survivor cache so verify mode needs only an id, and a durable equivalent-mutant suppression list that auto-filters reports.

**Architecture:** Two new pure utils (`run-cache.ts` in `os.tmpdir()`, `suppression.ts` under `.chaos-mcp/`) sit below the handler. `audit` mints a `runId` on every non-verify run and accepts `runId`/`suppress`/`unsuppress` args; reads auto-filter suppressed mutants and recompute the score. `triage` mints a per-row `runId` and filters too. No engine code changes — everything lives in the handler/util/format layer.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, Node `fs`/`os`/`crypto`, `@modelcontextprotocol/sdk`.

## Global Constraints

- ESM throughout: every relative import uses a `.js` specifier that resolves to `.ts`.
- `npm test` REQUIRES a prior `npm run build` (several tests import `../build/index.js`).
- Each task runs the FULL gate before committing: `npm run build && npm run lint && npm run format:check && npm test`.
- Preserve audit-tag comments (`C2`, `H5`, `Med#`, `A2`/`A3`, etc.) on any line you touch.
- `APP_VERSION` stays the literal `export const APP_VERSION = '<semver>';` in `src/index.ts` — do not touch.
- Importing `index.ts` must stay side-effect free.
- Workspace boundary (C2): never read/write outside `workspaceRoot`/`process.cwd()`. Suppressions live under `workspaceRoot`; the run cache lives in `os.tmpdir()`.
- Conventional Commits (`feat:`/`fix:`/`refactor:`/`test:`/`docs:`).
- All file I/O degrades gracefully — a missing/corrupt cache or suppression file is a miss/empty, never a crash. Writes use temp-file + atomic `rename` (the triage worker pool runs writes concurrently).

---

### Task 1: Run cache util (`src/utils/run-cache.ts`)

**Files:**
- Create: `src/utils/run-cache.ts`
- Test: `src/__tests__/run-cache.test.ts`

**Interfaces:**
- Consumes: nothing (leaf util). Uses Node `os`, `fs`, `path`, `crypto`.
- Produces:
  ```ts
  export interface RunCacheEntry {
    runId: string;
    file: string;                 // workspace-relative target
    projectType: string;
    createdAt: number;            // epoch ms
    survivors: { line: number; mutators: Record<string, number> }[];
    noCoverage: { line: number; mutators: Record<string, number> }[];
  }
  export interface RunCacheOptions { dir?: string; ttlMs?: number; max?: number; now?: number; }
  export function saveRun(entry: Omit<RunCacheEntry, 'runId' | 'createdAt'>, opts?: RunCacheOptions): string;
  export function loadRun(runId: string, opts?: RunCacheOptions): RunCacheEntry | undefined;
  ```
  Defaults: `dir = path.join(os.tmpdir(), 'chaos-mcp-runs')`, `ttlMs = 24*60*60*1000`, `max = 200`. `now` is injectable for deterministic tests (defaults to `Date.now()`).

- [ ] **Step 1: Write failing tests**

```ts
// src/__tests__/run-cache.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveRun, loadRun } from '../utils/run-cache.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-test-'));
});

describe('run-cache', () => {
  it('round-trips a saved run by id', () => {
    const id = saveRun(
      { file: 'src/a.ts', projectType: 'typescript', survivors: [{ line: 1, mutators: { Foo: 1 } }], noCoverage: [] },
      { dir },
    );
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    const got = loadRun(id, { dir });
    expect(got?.file).toBe('src/a.ts');
    expect(got?.survivors).toEqual([{ line: 1, mutators: { Foo: 1 } }]);
    expect(got?.createdAt).toBeTypeOf('number');
  });

  it('returns undefined for an unknown id', () => {
    expect(loadRun('deadbeef', { dir })).toBeUndefined();
  });

  it('treats an entry older than the TTL as a miss', () => {
    const id = saveRun({ file: 'a.ts', projectType: 'typescript', survivors: [], noCoverage: [] }, { dir, now: 1000 });
    expect(loadRun(id, { dir, now: 1000 + 10 })).toBeDefined();
    expect(loadRun(id, { dir, ttlMs: 5, now: 1000 + 10 })).toBeUndefined();
  });

  it('treats a corrupt file as a miss', () => {
    writeFileSync(join(dir, 'bad.json'), '{not json');
    expect(loadRun('bad', { dir })).toBeUndefined();
  });

  it('evicts oldest entries beyond max on write', () => {
    saveRun({ file: 'a', projectType: 't', survivors: [], noCoverage: [] }, { dir, max: 2, now: 1 });
    saveRun({ file: 'b', projectType: 't', survivors: [], noCoverage: [] }, { dir, max: 2, now: 2 });
    saveRun({ file: 'c', projectType: 't', survivors: [], noCoverage: [] }, { dir, max: 2, now: 3 });
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).length).toBeLessThanOrEqual(2);
  });

  it('evicts entries older than the TTL on write', () => {
    saveRun({ file: 'old', projectType: 't', survivors: [], noCoverage: [] }, { dir, ttlMs: 100, now: 1000 });
    saveRun({ file: 'new', projectType: 't', survivors: [], noCoverage: [] }, { dir, ttlMs: 100, now: 5000 });
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).length).toBe(1);
  });
});

// cleanup after suite
import { afterEach } from 'vitest';
afterEach(() => rmSync(dir, { recursive: true, force: true }));
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/__tests__/run-cache.test.ts`
Expected: FAIL — `Cannot find module '../utils/run-cache.js'`.

- [ ] **Step 3: Implement**

```ts
// src/utils/run-cache.ts
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RunCacheEntry {
  runId: string;
  file: string;
  projectType: string;
  createdAt: number;
  survivors: { line: number; mutators: Record<string, number> }[];
  noCoverage: { line: number; mutators: Record<string, number> }[];
}

export interface RunCacheOptions {
  dir?: string;
  ttlMs?: number;
  max?: number;
  now?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX = 200;

function cacheDir(opts?: RunCacheOptions): string {
  return opts?.dir ?? join(tmpdir(), 'chaos-mcp-runs');
}

/** Read every cache file with its createdAt; unreadable/corrupt files are skipped. */
function listEntries(dir: string): { id: string; createdAt: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: { id: string; createdAt: number }[] = [];
  for (const n of names) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, n), 'utf8')) as RunCacheEntry;
      out.push({ id: n.slice(0, -'.json'.length), createdAt: parsed.createdAt ?? 0 });
    } catch {
      // Corrupt file: drop it so it cannot accumulate.
      try {
        rmSync(join(dir, n), { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
  return out;
}

/** Best-effort eviction: drop TTL-expired entries, then trim oldest beyond `max`. */
function evict(dir: string, ttlMs: number, max: number, now: number): void {
  const entries = listEntries(dir);
  for (const e of entries) {
    if (now - e.createdAt > ttlMs) {
      try {
        rmSync(join(dir, `${e.id}.json`), { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
  const live = entries
    .filter((e) => now - e.createdAt <= ttlMs)
    .sort((a, b) => a.createdAt - b.createdAt);
  for (let i = 0; i < live.length - max; i++) {
    try {
      rmSync(join(dir, `${live[i].id}.json`), { force: true });
    } catch {
      /* best-effort */
    }
  }
}

export function saveRun(
  entry: Omit<RunCacheEntry, 'runId' | 'createdAt'>,
  opts?: RunCacheOptions,
): string {
  const dir = cacheDir(opts);
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const max = opts?.max ?? DEFAULT_MAX;
  const now = opts?.now ?? Date.now();
  mkdirSync(dir, { recursive: true });
  evict(dir, ttlMs, max, now);

  const runId = randomUUID().slice(0, 8);
  const full: RunCacheEntry = { ...entry, runId, createdAt: now };
  const dest = join(dir, `${runId}.json`);
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(full), 'utf8');
  renameSync(tmp, dest);
  return runId;
}

export function loadRun(runId: string, opts?: RunCacheOptions): RunCacheEntry | undefined {
  const dir = cacheDir(opts);
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts?.now ?? Date.now();
  const file = join(dir, `${runId}.json`);
  try {
    statSync(file);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as RunCacheEntry;
    if (typeof parsed.createdAt !== 'number' || now - parsed.createdAt > ttlMs) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/__tests__/run-cache.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/utils/run-cache.ts src/__tests__/run-cache.test.ts
git commit -m "feat: run-cache util for runId-keyed survivor baselines"
```

---

### Task 2: Suppression util (`src/utils/suppression.ts`)

**Files:**
- Create: `src/utils/suppression.ts`
- Test: `src/__tests__/suppression.test.ts`

**Interfaces:**
- Consumes: `MutationResult` from `../engines/base.js`. Uses Node `fs`/`path`.
- Produces:
  ```ts
  export interface SuppressionInput { line: number; mutator: string; reason?: string; }
  export function loadSuppressions(workspaceRoot: string, configPath?: string): Map<string, Set<string>>;
  export function addSuppressions(workspaceRoot: string, relFile: string, entries: SuppressionInput[], configPath?: string): void;
  export function removeSuppressions(workspaceRoot: string, relFile: string, keys: { line: number; mutator: string }[], configPath?: string): void;
  export function applySuppressions(result: MutationResult, suppressed: Set<string> | undefined): { result: MutationResult; suppressedCount: number };
  ```
  Key string is `` `${line} ${mutator}` ``. `loadSuppressions` returns `relFile → Set<key>`. Default file path: `path.join(workspaceRoot, '.chaos-mcp', 'suppressions.json')`, overridable by `configPath` (resolved relative to `workspaceRoot` if not absolute).

- [ ] **Step 1: Write failing tests**

```ts
// src/__tests__/suppression.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadSuppressions,
  addSuppressions,
  removeSuppressions,
  applySuppressions,
} from '../utils/suppression.js';
import type { MutationResult } from '../engines/base.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sup-test-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeResult(): MutationResult {
  return {
    target: 'src/a.ts',
    totalMutants: 10,
    killed: 6,
    survived: 4,
    mutationScore: '60.00%',
    vulnerabilities: [
      { line: 1, mutator: 'A', description: 'x' },
      { line: 1, mutator: 'B', description: 'x' },
      { line: 2, mutator: 'A', description: 'no test reached this line' },
    ],
  };
}

describe('suppression', () => {
  it('missing file → empty map', () => {
    expect(loadSuppressions(root).size).toBe(0);
  });

  it('corrupt file → empty map, no throw', () => {
    mkdirSync(join(root, '.chaos-mcp'), { recursive: true });
    writeFileSync(join(root, '.chaos-mcp', 'suppressions.json'), '{bad');
    expect(loadSuppressions(root).size).toBe(0);
  });

  it('add then load round-trips, deduped', () => {
    addSuppressions(root, 'src/a.ts', [
      { line: 1, mutator: 'A', reason: 'equivalent' },
      { line: 1, mutator: 'A' }, // dup
    ]);
    const map = loadSuppressions(root);
    expect([...(map.get('src/a.ts') ?? [])]).toEqual(['1 A']);
  });

  it('remove deletes a specific key', () => {
    addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }, { line: 2, mutator: 'B' }]);
    removeSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]);
    expect([...(loadSuppressions(root).get('src/a.ts') ?? [])]).toEqual(['2 B']);
  });

  it('applySuppressions filters vulnerabilities and recomputes score', () => {
    const { result, suppressedCount } = applySuppressions(makeResult(), new Set(['1 A', '2 A']));
    expect(suppressedCount).toBe(2);
    expect(result.vulnerabilities).toEqual([{ line: 1, mutator: 'B', description: 'x' }]);
    expect(result.totalMutants).toBe(8); // 10 - 2
    expect(result.survived).toBe(2); // 4 - 2
    expect(result.mutationScore).toBe('75.00%'); // 6 / 8
  });

  it('applySuppressions with undefined set is a no-op', () => {
    const r = makeResult();
    const { result, suppressedCount } = applySuppressions(r, undefined);
    expect(suppressedCount).toBe(0);
    expect(result.totalMutants).toBe(10);
  });

  it('all mutants suppressed → 100.00% (no measurable mutants)', () => {
    const r: MutationResult = { ...makeResult(), totalMutants: 2, killed: 0, survived: 2,
      vulnerabilities: [{ line: 1, mutator: 'A', description: 'x' }, { line: 1, mutator: 'B', description: 'x' }] };
    const { result } = applySuppressions(r, new Set(['1 A', '1 B']));
    expect(result.totalMutants).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/__tests__/suppression.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/utils/suppression.ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { MutationResult } from '../engines/base.js';

export interface SuppressionInput {
  line: number;
  mutator: string;
  reason?: string;
}

interface StoredEntry {
  line: number;
  mutator: string;
  reason?: string;
  addedAt: number;
}
interface SuppressionFile {
  version: number;
  entries: Record<string, StoredEntry[]>;
}

const keyOf = (line: number, mutator: string): string => `${line} ${mutator}`;

function filePath(workspaceRoot: string, configPath?: string): string {
  if (configPath) return isAbsolute(configPath) ? configPath : join(workspaceRoot, configPath);
  return join(workspaceRoot, '.chaos-mcp', 'suppressions.json');
}

function readFile(workspaceRoot: string, configPath?: string): SuppressionFile {
  try {
    const raw = JSON.parse(readFileSync(filePath(workspaceRoot, configPath), 'utf8')) as SuppressionFile;
    if (!raw || typeof raw !== 'object' || typeof raw.entries !== 'object' || raw.entries === null) {
      return { version: 1, entries: {} };
    }
    return { version: raw.version ?? 1, entries: raw.entries };
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeFile(workspaceRoot: string, data: SuppressionFile, configPath?: string): void {
  const dest = filePath(workspaceRoot, configPath);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, dest);
}

export function loadSuppressions(workspaceRoot: string, configPath?: string): Map<string, Set<string>> {
  const data = readFile(workspaceRoot, configPath);
  const map = new Map<string, Set<string>>();
  for (const [file, list] of Object.entries(data.entries)) {
    if (!Array.isArray(list)) continue;
    const set = new Set<string>();
    for (const e of list) {
      if (e && Number.isInteger(e.line) && typeof e.mutator === 'string') set.add(keyOf(e.line, e.mutator));
    }
    if (set.size > 0) map.set(file, set);
  }
  return map;
}

export function addSuppressions(
  workspaceRoot: string,
  relFile: string,
  entries: SuppressionInput[],
  configPath?: string,
): void {
  if (entries.length === 0) return;
  const data = readFile(workspaceRoot, configPath);
  const list = data.entries[relFile] ?? [];
  const seen = new Set(list.map((e) => keyOf(e.line, e.mutator)));
  const now = Date.now();
  for (const e of entries) {
    const k = keyOf(e.line, e.mutator);
    if (seen.has(k)) continue;
    seen.add(k);
    list.push({ line: e.line, mutator: e.mutator, reason: e.reason, addedAt: now });
  }
  data.entries[relFile] = list;
  writeFile(workspaceRoot, data, configPath);
}

export function removeSuppressions(
  workspaceRoot: string,
  relFile: string,
  keys: { line: number; mutator: string }[],
  configPath?: string,
): void {
  if (keys.length === 0) return;
  const data = readFile(workspaceRoot, configPath);
  const list = data.entries[relFile];
  if (!Array.isArray(list)) return;
  const drop = new Set(keys.map((k) => keyOf(k.line, k.mutator)));
  const kept = list.filter((e) => !drop.has(keyOf(e.line, e.mutator)));
  if (kept.length > 0) data.entries[relFile] = kept;
  else delete data.entries[relFile];
  writeFile(workspaceRoot, data, configPath);
}

/**
 * Drop suppressed (equivalent) mutants from a result. Equivalent mutants are
 * unkillable, so they leave the denominator: total shrinks, score is recomputed,
 * survived is clamped down. Returns a new result; the input is not mutated.
 */
export function applySuppressions(
  result: MutationResult,
  suppressed: Set<string> | undefined,
): { result: MutationResult; suppressedCount: number } {
  if (!suppressed || suppressed.size === 0) return { result, suppressedCount: 0 };
  const kept = result.vulnerabilities.filter((v) => !suppressed.has(keyOf(v.line, v.mutator)));
  const suppressedCount = result.vulnerabilities.length - kept.length;
  if (suppressedCount === 0) return { result, suppressedCount: 0 };
  const totalMutants = Math.max(0, result.totalMutants - suppressedCount);
  const survived = Math.max(0, result.survived - suppressedCount);
  const score = totalMutants === 0 ? 100 : (result.killed / totalMutants) * 100;
  return {
    result: {
      ...result,
      vulnerabilities: kept,
      totalMutants,
      survived,
      mutationScore: `${score.toFixed(2)}%`,
    },
    suppressedCount,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/__tests__/suppression.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/utils/suppression.ts src/__tests__/suppression.test.ts
git commit -m "feat: suppression util — equivalent-mutant ignore list with score recompute"
```

---

### Task 3: Config keys (`src/utils/config-loader.ts`)

**Files:**
- Modify: `src/utils/config-loader.ts` (KNOWN_KEYS ~line 7, ChaosConfig ~line 104, buildConfig ~line 303, validateConfig ~line 429)
- Test: `src/__tests__/config-loader.test.ts` (append cases)

**Interfaces:**
- Produces on `ChaosConfig`: `suppressionsPath?: string; runCacheTtlMs?: number; runCacheMax?: number;`

- [ ] **Step 1: Write failing tests** — append to `src/__tests__/config-loader.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig } from '../utils/config-loader.js';

describe('phase3 config keys', () => {
  function withConfig(obj: unknown): { warnings: string[]; config: ReturnType<typeof validateConfig>['config'] } {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const p = join(dir, 'chaos-mcp.config.json');
    writeFileSync(p, JSON.stringify(obj));
    try {
      return validateConfig(p);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('accepts suppressionsPath / runCacheTtlMs / runCacheMax', () => {
    const { config, warnings } = withConfig({ suppressionsPath: '.x/sup.json', runCacheTtlMs: 1000, runCacheMax: 5 });
    expect(config.suppressionsPath).toBe('.x/sup.json');
    expect(config.runCacheTtlMs).toBe(1000);
    expect(config.runCacheMax).toBe(5);
    expect(warnings).toHaveLength(0);
  });

  it('warns on invalid runCacheMax', () => {
    const { warnings } = withConfig({ runCacheMax: 0 });
    expect(warnings.some((w) => w.includes('runCacheMax'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run src/__tests__/config-loader.test.ts -t 'phase3 config keys'`
Expected: FAIL — `config.suppressionsPath` is `undefined`.

- [ ] **Step 3: Implement**

In `KNOWN_KEYS` (the `new Set([...])`) add `'suppressionsPath'`, `'runCacheTtlMs'`, `'runCacheMax'`.

In `interface ChaosConfig` add:
```ts
  suppressionsPath?: string;
  runCacheTtlMs?: number;
  runCacheMax?: number;
```

In `buildConfig`, after the `defaultFileConcurrency` block, add:
```ts
  if (typeof raw.suppressionsPath === 'string' && raw.suppressionsPath.trim().length > 0) {
    result.suppressionsPath = raw.suppressionsPath;
  }
  if (typeof raw.runCacheTtlMs === 'number' && Number.isInteger(raw.runCacheTtlMs) && raw.runCacheTtlMs > 0) {
    result.runCacheTtlMs = raw.runCacheTtlMs;
  }
  if (typeof raw.runCacheMax === 'number' && Number.isInteger(raw.runCacheMax) && raw.runCacheMax >= 1) {
    result.runCacheMax = raw.runCacheMax;
  }
```

In `validateConfig`, after the `defaultFileConcurrency` warning block, add:
```ts
  if ('suppressionsPath' in raw && (typeof raw.suppressionsPath !== 'string' || raw.suppressionsPath.trim().length === 0)) {
    warnings.push('suppressionsPath must be a non-empty string.');
  }
  if ('runCacheTtlMs' in raw && (typeof raw.runCacheTtlMs !== 'number' || !Number.isInteger(raw.runCacheTtlMs) || raw.runCacheTtlMs <= 0)) {
    warnings.push(`runCacheTtlMs must be an integer > 0, got ${typeof raw.runCacheTtlMs === 'number' ? raw.runCacheTtlMs : typeof raw.runCacheTtlMs}.`);
  }
  if ('runCacheMax' in raw && (typeof raw.runCacheMax !== 'number' || !Number.isInteger(raw.runCacheMax) || raw.runCacheMax < 1)) {
    warnings.push(`runCacheMax must be an integer >= 1, got ${typeof raw.runCacheMax === 'number' ? raw.runCacheMax : typeof raw.runCacheMax}.`);
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run src/__tests__/config-loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/utils/config-loader.ts src/__tests__/config-loader.test.ts
git commit -m "feat: config keys suppressionsPath / runCacheTtlMs / runCacheMax"
```

---

### Task 4: Audit validators — runId / suppress / unsuppress (`src/handler.ts`)

**Files:**
- Modify: `src/handler.ts` (add three validators before `TOOL_ARG_VALIDATORS` ~line 267; register them in the array)
- Test: `src/__tests__/handler.test.ts` (append `describe`)

**Interfaces:**
- Consumes: `ToolArgs`, `validateToolArgs` (existing). Produces: three new validator functions wired into `TOOL_ARG_VALIDATORS`.
- Note: `runId` is mutually exclusive with `baseline`, `diffBase`, `lineScope`. `suppress`/`unsuppress` are orthogonal (no exclusion).

- [ ] **Step 1: Write failing tests** — append to `src/__tests__/handler.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateToolArgs } from '../handler.js';

describe('phase3 validators', () => {
  const ok = (args: Record<string, unknown>) => validateToolArgs(args) === null;
  const errText = (args: Record<string, unknown>) =>
    (validateToolArgs(args)?.content?.[0] as { text?: string } | undefined)?.text ?? '';

  it('accepts a valid runId alone', () => {
    expect(ok({ filePath: 'a.ts', runId: 'a1b2c3d4' })).toBe(true);
  });
  it('rejects empty runId', () => {
    expect(errText({ filePath: 'a.ts', runId: '' })).toContain('runId');
  });
  it('rejects runId with baseline/diffBase/lineScope', () => {
    expect(errText({ filePath: 'a.ts', runId: 'x', diffBase: 'HEAD' })).toContain('mutually exclusive');
    expect(errText({ filePath: 'a.ts', runId: 'x', baseline: { survivors: [] } })).toContain('mutually exclusive');
    expect(errText({ filePath: 'a.ts', runId: 'x', lineScope: { start: 1, end: 2 } })).toContain('mutually exclusive');
  });
  it('accepts valid suppress / unsuppress', () => {
    expect(ok({ filePath: 'a.ts', suppress: [{ line: 1, mutator: 'X', reason: 'eq' }] })).toBe(true);
    expect(ok({ filePath: 'a.ts', unsuppress: [{ line: 1, mutator: 'X' }] })).toBe(true);
  });
  it('rejects malformed suppress entries', () => {
    expect(errText({ filePath: 'a.ts', suppress: [{ line: 0, mutator: 'X' }] })).toContain('suppress');
    expect(errText({ filePath: 'a.ts', suppress: [{ line: 1, mutator: '' }] })).toContain('suppress');
    expect(errText({ filePath: 'a.ts', suppress: 'nope' })).toContain('suppress');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run src/__tests__/handler.test.ts -t 'phase3 validators'`
Expected: FAIL — runId currently passes through without exclusion; suppress unvalidated.

- [ ] **Step 3: Implement** — add before the `TOOL_ARG_VALIDATORS` declaration:

```ts
/** runId (verify-from-cache): non-empty string, mutually exclusive with baseline/diffBase/lineScope. */
function validateRunIdArg(args: ToolArgs): string | null {
  if (args.runId === undefined) return null;
  if (typeof args.runId !== 'string' || args.runId.trim().length === 0) {
    return 'runId must be a non-empty string returned by a prior audit. Example: "a1b2c3d4".';
  }
  if (args.baseline !== undefined || args.diffBase !== undefined || args.lineScope !== undefined) {
    return 'runId is mutually exclusive with baseline, diffBase, and lineScope — use only one at a time.';
  }
  return null;
}

/** Shared shape check for suppress/unsuppress arrays. `field` names the arg in errors. */
function validateMutantKeyArray(value: unknown, field: string, allowReason: boolean): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) {
    return `${field} must be a non-empty array of { line: integer >= 1, mutator: string${allowReason ? ', reason?: string' : ''} }.`;
  }
  for (const e of value) {
    const entry = e as Record<string, unknown> | null;
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      !Number.isInteger(entry.line) ||
      (entry.line as number) < 1 ||
      typeof entry.mutator !== 'string' ||
      entry.mutator.trim().length === 0 ||
      (allowReason && entry.reason !== undefined && typeof entry.reason !== 'string')
    ) {
      return `each ${field} entry must be { line: integer >= 1, mutator: non-empty string${allowReason ? ', reason?: string' : ''} }.`;
    }
  }
  return null;
}

function validateSuppressArg(args: ToolArgs): string | null {
  return validateMutantKeyArray(args.suppress, 'suppress', true);
}

function validateUnsuppressArg(args: ToolArgs): string | null {
  return validateMutantKeyArray(args.unsuppress, 'unsuppress', false);
}
```

Then add to the `TOOL_ARG_VALIDATORS` array (after `validateSeverityFloorArg`):
```ts
  validateRunIdArg,
  validateSuppressArg,
  validateUnsuppressArg,
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run src/__tests__/handler.test.ts -t 'phase3 validators'`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/handler.ts src/__tests__/handler.test.ts
git commit -m "feat: validators for runId / suppress / unsuppress audit args"
```

---

### Task 5: Payload fields — runId / suppressedCount (`src/format.ts`)

**Files:**
- Modify: `src/format.ts` (`ResultPayload` ~line 232, `ResultPayloadOpts` ~line 249, `buildResultPayload` body)
- Test: `src/__tests__/format-payload.test.ts` (append cases)

**Interfaces:**
- Produces: `ResultPayload` gains `runId?: string; suppressedCount?: number;`. `ResultPayloadOpts` gains `runId?: string; suppressedCount?: number;`. When `suppressedCount && > 0`, the payload `note` mentions the score is adjusted for equivalent mutants.

- [ ] **Step 1: Write failing tests** — append to `src/__tests__/format-payload.test.ts`:

```ts
it('threads runId and suppressedCount into the payload', () => {
  const result = { target: 'a.ts', totalMutants: 8, killed: 6, survived: 2, mutationScore: '75.00%', vulnerabilities: [] };
  const payload = buildResultPayload(result, { runId: 'abc123de', suppressedCount: 2 });
  expect(payload.runId).toBe('abc123de');
  expect(payload.suppressedCount).toBe(2);
  expect(payload.note).toContain('suppressed');
});

it('omits runId/suppressedCount when not provided', () => {
  const result = { target: 'a.ts', totalMutants: 4, killed: 4, survived: 0, mutationScore: '100.00%', vulnerabilities: [] };
  const payload = buildResultPayload(result, {});
  expect(payload.runId).toBeUndefined();
  expect(payload.suppressedCount).toBeUndefined();
});
```

(Make sure `buildResultPayload` is imported in this test file — it is already used elsewhere in this suite.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run src/__tests__/format-payload.test.ts -t 'runId'`
Expected: FAIL — `payload.runId` is `undefined`.

- [ ] **Step 3: Implement**

In `interface ResultPayload` add:
```ts
  runId?: string;
  suppressedCount?: number;
```

In `interface ResultPayloadOpts` add:
```ts
  runId?: string;
  suppressedCount?: number;
```

In `buildResultPayload`, just before the final `return payload;` (after the payload object is assembled and `note` computed), add:
```ts
  if (opts.runId) payload.runId = opts.runId;
  if (opts.suppressedCount && opts.suppressedCount > 0) {
    payload.suppressedCount = opts.suppressedCount;
    payload.note += ` ${opts.suppressedCount} equivalent mutant(s) suppressed and excluded from the score.`;
  }
```

(If `buildResultPayload` returns a freshly-built object literal rather than a mutable `payload` variable, first hoist it into `const payload: ResultPayload = { ... }`, then apply the additions above, then `return payload`. Read the function before editing.)

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run src/__tests__/format-payload.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/format.ts src/__tests__/format-payload.test.ts
git commit -m "feat: runId / suppressedCount fields on the result payload"
```

---

### Task 6: Tool schema — audit inputs + output, triage outputs (`src/tool-schema.ts`)

**Files:**
- Modify: `src/tool-schema.ts` (audit `inputSchema.properties` ~near `baseline`/`maxSurvivors`; audit `outputSchema.properties` ~near `enrichNote`; triage `outputSchema` ranking item props)
- Test: `src/__tests__/tool-schema.test.ts` (append cases)

**Interfaces:**
- Produces: audit input props `runId`, `suppress`, `unsuppress`; audit output props `runId`, `suppressedCount`; triage ranking-item props `runId`, `suppressedCount`.

- [ ] **Step 1: Write failing tests** — append to `src/__tests__/tool-schema.test.ts`:

```ts
it('audit input schema exposes runId / suppress / unsuppress', () => {
  const props = AUDIT_TOOL_DEFINITION.inputSchema.properties as Record<string, unknown>;
  expect(props.runId).toBeDefined();
  expect(props.suppress).toBeDefined();
  expect(props.unsuppress).toBeDefined();
});

it('audit output schema exposes runId / suppressedCount', () => {
  const props = (AUDIT_TOOL_DEFINITION.outputSchema?.properties ?? {}) as Record<string, unknown>;
  expect(props.runId).toBeDefined();
  expect(props.suppressedCount).toBeDefined();
});

it('triage ranking items expose runId / suppressedCount', () => {
  const ranking = (TRIAGE_TOOL_DEFINITION.outputSchema?.properties?.ranking ?? {}) as {
    items?: { properties?: Record<string, unknown> };
  };
  expect(ranking.items?.properties?.runId).toBeDefined();
  expect(ranking.items?.properties?.suppressedCount).toBeDefined();
});
```

(Confirm `AUDIT_TOOL_DEFINITION` and `TRIAGE_TOOL_DEFINITION` are imported at the top of the test file — adjust the import names to whatever the file already uses for the audit/triage definitions.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run src/__tests__/tool-schema.test.ts -t 'runId'`
Expected: FAIL — props undefined.

- [ ] **Step 3: Implement**

In the audit `inputSchema.properties`, add:
```ts
      runId: {
        type: 'string',
        description:
          'Verify mode by id: re-run against the cached survivor baseline from a prior audit (the runId it returned). ' +
          'Auto-scoped to the baseline lines (StrykerJS) or whole-file (other languages). ' +
          'Mutually exclusive with baseline, diffBase, and lineScope. Example: "a1b2c3d4".',
      },
      suppress: {
        type: 'array',
        description:
          'Mark mutants as equivalent (unkillable) so future runs exclude them from the score and output. ' +
          'Appended to .chaos-mcp/suppressions.json for this file. Example: [{ "line": 42, "mutator": "ConditionalExpression", "reason": "guard unreachable" }].',
        items: {
          type: 'object',
          properties: {
            line: { type: 'integer', minimum: 1 },
            mutator: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['line', 'mutator'],
        },
      },
      unsuppress: {
        type: 'array',
        description: 'Remove previously-suppressed mutants for this file (undo a wrong suppress).',
        items: {
          type: 'object',
          properties: { line: { type: 'integer', minimum: 1 }, mutator: { type: 'string' } },
          required: ['line', 'mutator'],
        },
      },
```

In the audit `outputSchema.properties`, add:
```ts
      runId: { type: 'string' },
      suppressedCount: { type: 'integer' },
```

In the triage `outputSchema` ranking item `properties`, add:
```ts
          runId: { type: 'string' },
          suppressedCount: { type: 'integer' },
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run src/__tests__/tool-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/tool-schema.ts src/__tests__/tool-schema.test.ts
git commit -m "feat: schema for runId / suppress / unsuppress (audit) + runId/suppressedCount outputs"
```

---

### Task 7: Handler wiring — runId verify, suppression filter, runId mint (`src/handler.ts`)

This is the integration linchpin. Read `handleToolCall`, `computeScope`, and `formatAuditOutput` in full before editing.

**Files:**
- Modify: `src/handler.ts` (`computeScope` ~line 533; the post-audit block ~lines 843–854; `formatAuditOutput` ~line 628)
- Test: `src/__tests__/handler.test.ts` or a new `src/__tests__/handler-phase3.test.ts`

**Interfaces:**
- Consumes: `saveRun`, `loadRun` from `./utils/run-cache.js`; `loadSuppressions`, `addSuppressions`, `removeSuppressions`, `applySuppressions` from `./utils/suppression.js`; `buildResultPayload` opts `runId`/`suppressedCount` (Task 5).
- Produces: `audit` honors `runId` (verify from cache), applies suppression filtering + writes, mints a `runId` on non-verify runs.

- [ ] **Step 1: Write failing tests** (new file `src/__tests__/handler-phase3.test.ts`). These are integration tests over the built engine path; gate them the way the existing handler tests gate real runs — prefer a stubbed engine if the suite already has a stub helper, otherwise scope to the pure seams. Minimum coverage:

```ts
import { describe, it, expect } from 'vitest';
import { loadRun, saveRun } from '../utils/run-cache.js';

describe('phase3 run-cache integration seam', () => {
  it('a saved run is retrievable by the id it returns', () => {
    const id = saveRun({ file: 'src/x.ts', projectType: 'typescript', survivors: [{ line: 3, mutators: { Cond: 1 } }], noCoverage: [] });
    const got = loadRun(id);
    expect(got?.survivors[0].line).toBe(3);
  });
});
```

For the verify-by-runId, unknown-id, and file-mismatch error paths, add tests that call `handleToolCall` with a mocked engine if the existing handler suite provides one (follow the pattern already in `handler.test.ts`). If no engine mock exists, assert the error strings via a thin exported helper (see Step 3) and note the limitation in the task report.

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run src/__tests__/handler-phase3.test.ts`
Expected: FAIL until Step 3 wires the imports/logic.

- [ ] **Step 3: Implement**

(a) **Imports** at the top of `handler.ts`:
```ts
import { saveRun, loadRun } from './utils/run-cache.js';
import {
  loadSuppressions,
  addSuppressions,
  removeSuppressions,
  applySuppressions,
} from './utils/suppression.js';
```

(b) **runId in `computeScope`** — `computeScope` returns the discriminated scope union. Add a `runId` branch alongside the existing `baseline` (A3) handling. Near where `baselineKeys` is derived from `earlyArgs.baseline`:
```ts
  // Verify mode by cached id (A3-by-runId). Mutually exclusive with baseline/diffBase
  // (enforced by validateRunIdArg), so this never collides with the diff path above.
  if (typeof earlyArgs.runId === 'string' && earlyArgs.runId.trim().length > 0) {
    const cached = loadRun(earlyArgs.runId, {
      ttlMs: cfg.runCacheTtlMs,
      max: cfg.runCacheMax,
    });
    if (!cached) {
      return {
        kind: 'result',
        result: toolError(
          `runId "${earlyArgs.runId}" not found or expired; re-run audit to get a fresh runId.`,
        ),
      };
    }
    if (cached.file !== resolvedFile) {
      return {
        kind: 'result',
        result: toolError(
          `runId "${earlyArgs.runId}" was for ${cached.file}, not ${resolvedFile}; verify against the file it audited.`,
        ),
      };
    }
    baselineKeys = parseBaseline({ survivors: cached.survivors, noCoverage: cached.noCoverage });
    diffRanges = baselineLines(baselineKeys).map((l) => ({ start: l, end: l }));
  }
```
Note: `computeScope`'s current signature is `(earlyArgs, targetFile, env, projectType)`. It needs `cfg` (for TTL/max overrides) and `resolvedFile` (workspace-relative, for the file-match check). Thread both in: add `cfg: ChaosConfig` and `resolvedFile: string` params and update the single call site (`const scope = await computeScope(earlyArgs, targetFile, env, projectType, cfg, resolvedFile);`). `resolvedFile` is already computed at line ~744; `config` is in scope at the call site as the handler's `config` param (use `config ?? {}`).

(c) **Suppression writes + filter + runId mint** — in `handleToolCall`, after `auditResults` is obtained and `scopeNote` applied (~line 843), and BEFORE `formatAuditOutput`:
```ts
      // Suppression writes (explicit user action) happen first so the same
      // call reflects them. Then auto-filter equivalent mutants from the result.
      const wsRoot = env.workspaceRoot;
      const supPath = cfg.suppressionsPath;
      if (Array.isArray(args.suppress) && args.suppress.length > 0) {
        addSuppressions(wsRoot, resolvedFile, args.suppress as { line: number; mutator: string; reason?: string }[], supPath);
      }
      if (Array.isArray(args.unsuppress) && args.unsuppress.length > 0) {
        removeSuppressions(wsRoot, resolvedFile, args.unsuppress as { line: number; mutator: string }[], supPath);
      }
      const suppressed = loadSuppressions(wsRoot, supPath).get(resolvedFile);
      const filtered = applySuppressions(auditResults, suppressed);
      auditResults = filtered.result;

      // Mint a runId for non-verify runs so the caller can verify later by id.
      let mintedRunId: string | undefined;
      if (!baselineKeys) {
        try {
          const compact = buildResultPayload(auditResults, {}); // survivors/noCoverage groups
          mintedRunId = saveRun({
            file: resolvedFile,
            projectType,
            survivors: compact.survivors.map((g) => ({ line: g.line, mutators: g.mutators })),
            noCoverage: compact.noCoverage.map((g) => ({ line: g.line, mutators: g.mutators })),
          }, { ttlMs: cfg.runCacheTtlMs, max: cfg.runCacheMax });
        } catch {
          mintedRunId = undefined; // cache failure is non-fatal; omit runId
        }
      }
```
Confirm the `LineGroup` shape exposes `line` and `mutators` (it does — `format.ts` exports `LineGroup`). If the group field is named differently, adapt the `.map`.

Make `auditResults` reassignable: it is declared `let auditResults: MutationResult;` already (line ~821), so reassignment is fine.

(d) **Pass through to `formatAuditOutput`** — add params `suppressedCount: number` and `runId: string | undefined`, and use them:
```ts
      return formatAuditOutput(
        auditResults,
        args,
        projectType,
        baselineKeys,
        targetFile,
        enrichCtx,
        cfg,
        env,
        filtered.suppressedCount,
        mintedRunId,
      );
```
In `formatAuditOutput`, add the two params and pass them into `buildResultPayload`:
```ts
  const payload = buildResultPayload(auditResults, {
    ...enrichOpts,
    suggestedTestFile: suggestion,
    ignoredOptions: ignored.length > 0 ? ignored : undefined,
    runId,
    suppressedCount,
  });
```
The verify-mode early-return branch ignores `runId`/`suppressedCount` (verify keeps its own formatter) — that's fine; pass them but don't use them there.

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run src/__tests__/handler-phase3.test.ts && npx vitest run src/__tests__/handler.test.ts`
Expected: PASS (existing handler tests still green — the formatAuditOutput signature change is internal).

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/handler.ts src/__tests__/handler-phase3.test.ts
git commit -m "feat: audit honors runId verify, suppression filter/writes, and mints runId"
```

---

### Task 8: Triage wiring — per-row runId + suppression (`src/triage.ts`, `src/triage-handler.ts`)

**Files:**
- Modify: `src/triage.ts` (`TriageRow` ~line 7 — add `runId?`, `suppressedCount?`)
- Modify: `src/triage-handler.ts` (`auditOne` ~line 175 — filter + mint per row)
- Test: `src/__tests__/triage.test.ts` and/or `src/__tests__/triage-handler.test.ts` (append)

**Interfaces:**
- Consumes: `saveRun` (run-cache), `loadSuppressions`/`applySuppressions` (suppression), `buildResultPayload`.
- Produces: `TriageRow` gains `runId?: string; suppressedCount?: number;` (already serialized via `buildTriagePayload`, which spreads rows).

- [ ] **Step 1: Write failing tests** — append to `src/__tests__/triage.test.ts`:

```ts
it('TriageRow carries optional runId and suppressedCount', () => {
  const row: import('../triage.js').TriageRow = {
    file: 'a.ts', mutationScore: '50.00%', total: 4, killed: 2, survived: 2, noCoverage: 0,
    runId: 'deadbeef', suppressedCount: 1,
  };
  const payload = buildTriagePayload([row], [], 1, 0);
  expect(payload.ranking[0].runId).toBe('deadbeef');
  expect(payload.ranking[0].suppressedCount).toBe(1);
});
```

(For the handler-level filtering test, follow the existing `triage-handler.test.ts` pattern; if it stubs the engine, assert that a suppressed mutant is absent from a row's survivors and that the row's `suppressedCount` reflects it. If no stub exists, cover the seam via `applySuppressions` directly and note it.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run src/__tests__/triage.test.ts -t 'runId'`
Expected: FAIL — `TriageRow` lacks the fields / payload omits them.

- [ ] **Step 3: Implement**

In `triage.ts`, `interface TriageRow` add:
```ts
  runId?: string;
  suppressedCount?: number;
```
`buildTriagePayload` already spreads/serializes whole rows, so no change there — but verify the ranking maps rows directly (it does; `ranking: rows`). If it constructs a narrowed object per row, add the two fields to that projection.

In `triage-handler.ts` `auditOne`, after `result` is obtained and before building the `row` (~line 241), add suppression filtering and load the suppression map once outside the pool (hoist `const suppressionMap = loadSuppressions(env.workspaceRoot, cfg.suppressionsPath);` above the `mapPool` call, ~line 270, and capture it in the closure):
```ts
      const suppressed = suppressionMap.get(relFromRoot);
      const sup = applySuppressions(result, suppressed);
      const cleanResult = sup.result;
```
Use `cleanResult` in place of `result` for the row's score/counts and for `buildResultPayload` (the `survivorsPerFile > 0` block). Then mint a runId per row:
```ts
      let rowRunId: string | undefined;
      try {
        const compact = buildResultPayload(cleanResult, {});
        rowRunId = saveRun({
          file: relFromRoot,
          projectType: fileProjectType, // the per-file detected type already in scope
          survivors: compact.survivors.map((g) => ({ line: g.line, mutators: g.mutators })),
          noCoverage: compact.noCoverage.map((g) => ({ line: g.line, mutators: g.mutators })),
        }, { ttlMs: cfg.runCacheTtlMs, max: cfg.runCacheMax });
      } catch {
        rowRunId = undefined;
      }
```
Set `row.runId = rowRunId;` and `if (sup.suppressedCount > 0) row.suppressedCount = sup.suppressedCount;` when building the row. (Read `auditOne` to find the exact variable names for the per-file project type and the workspace-relative path — `relFromRoot` is computed at ~line 185.)

Add imports to `triage-handler.ts`:
```ts
import { saveRun } from './utils/run-cache.js';
import { loadSuppressions, applySuppressions } from './utils/suppression.js';
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run src/__tests__/triage.test.ts src/__tests__/triage-handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/triage.ts src/triage-handler.ts src/__tests__/triage.test.ts src/__tests__/triage-handler.test.ts
git commit -m "feat: triage mints per-row runId and applies equivalent-mutant suppression"
```

---

### Task 9: Verify-mode suppression filtering (`src/handler.ts`)

Equivalent mutants must not report as "still surviving" in verify mode.

**Files:**
- Modify: `src/handler.ts` (`formatAuditOutput` verify branch ~line 638)
- Test: `src/__tests__/verify.test.ts` or `handler-phase3.test.ts`

**Interfaces:**
- Consumes: `applySuppressions`, `loadSuppressions` (already imported in Task 7). The verify branch receives `auditResults` (the re-run) and `baselineKeys`.

- [ ] **Step 1: Write failing test** — in `src/__tests__/handler-phase3.test.ts`:

```ts
import { computeVerifyDelta } from '../verify.js';
import { applySuppressions } from '../utils/suppression.js';

it('suppressed mutants are excluded from verify "still surviving"', () => {
  const baseline = [{ line: 1, mutator: 'A' }, { line: 2, mutator: 'B' }];
  const rerun = { target: 'a.ts', totalMutants: 2, killed: 0, survived: 2, mutationScore: '0.00%',
    vulnerabilities: [{ line: 1, mutator: 'A', description: 'x' }, { line: 2, mutator: 'B', description: 'x' }] };
  // Suppress "1 A": it should not count as still-surviving.
  const filtered = applySuppressions(rerun, new Set(['1 A']));
  const delta = computeVerifyDelta(baseline.filter((k) => `${k.line} ${k.mutator}` !== '1 A'), filtered.result);
  expect(delta.stillSurviving.find((k) => k.line === 1)).toBeUndefined();
  expect(delta.stillSurviving.find((k) => k.line === 2)).toBeDefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run src/__tests__/handler-phase3.test.ts -t 'still surviving'`
Expected: This unit test passes immediately (it exercises the utils directly). The RED here is the *handler wiring*: confirm the verify branch does NOT yet filter. Add a stricter assertion against `formatAuditOutput` output if the handler suite supports it; otherwise this codifies the intended composition and Step 3 wires it into the branch.

- [ ] **Step 3: Implement** — in `formatAuditOutput`'s verify branch, filter the re-run and the baseline keys by suppressions before `computeVerifyDelta`:
```ts
  if (baselineKeys) {
    const suppressed = loadSuppressions(env.workspaceRoot, cfg.suppressionsPath).get(
      // resolvedFile is not passed here; use targetFile relative to workspaceRoot
      relative(env.workspaceRoot, targetFile) || targetFile,
    );
    const rerun = applySuppressions(auditResults, suppressed).result;
    const keptBaseline = suppressed
      ? baselineKeys.filter((k) => !suppressed.has(`${k.line} ${k.mutator}`))
      : baselineKeys;
    const delta = computeVerifyDelta(keptBaseline, rerun);
    const verifyText =
      args.outputFormat === 'text'
        ? formatVerifyResultAsText(targetFile, delta)
        : formatVerifyResultAsJson(targetFile, delta);
    return { content: [{ type: 'text', text: verifyText }] };
  }
```
Add `import { relative } from 'node:path';` if not already imported in `handler.ts` (it likely is — check the existing imports).

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run src/__tests__/handler-phase3.test.ts && npx vitest run src/__tests__/verify.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/handler.ts src/__tests__/handler-phase3.test.ts
git commit -m "feat: verify mode excludes suppressed equivalent mutants from still-surviving"
```

---

### Task 10: Docs (README + CLAUDE.md)

**Files:**
- Modify: `README.md` (audit args table/section; add a "State & the verify loop" subsection)
- Modify: `CLAUDE.md` (Architecture: note `run-cache.ts` + `suppression.ts`, `.chaos-mcp/`, the new args)

**Interfaces:** none (docs only). No test cycle — this task's gate is `npm run check` plus a manual read.

- [ ] **Step 1: Update README** — document, with examples:
  - `runId` (returned by every audit; pass it back to verify without resending the baseline).
  - `suppress` / `unsuppress` (mark/unmark equivalent mutants; persisted to `.chaos-mcp/suppressions.json`; suggest adding `.chaos-mcp/` to `.gitignore` OR committing it to share with the team).
  - `suppressedCount` in output; the score is computed with equivalent mutants removed from the denominator.
  - config keys `suppressionsPath`, `runCacheTtlMs`, `runCacheMax`.
  - the line-keyed staleness caveat.

- [ ] **Step 2: Update CLAUDE.md** — in the Architecture/Utils section, add one line each for `src/utils/run-cache.ts` (tmpdir, TTL+cap eviction) and `src/utils/suppression.ts` (durable `.chaos-mcp/`, auto-filter + score recompute), and note `runId`/`suppress`/`unsuppress` on the audit path.

- [ ] **Step 3: Gate + commit**

```bash
npm run check
git add README.md CLAUDE.md
git commit -m "docs: document Phase 3 verify loop (runId) + equivalent-mutant suppression"
```

---

## Self-Review

**Spec coverage:**
- #2 runId cache → Tasks 1 (util), 7 (mint + verify-by-id). ✓
- #8 suppression → Tasks 2 (util), 7 (audit filter/writes), 8 (triage), 9 (verify mode). ✓
- Split state (tmp vs `.chaos-mcp/`) → Tasks 1 & 2. ✓
- New `runId` arg + mutual exclusion → Task 4. ✓
- `suppress`/`unsuppress` write path → Tasks 4 (validate), 6 (schema), 7 (wire). ✓
- Auto-filter + denominator-adjusted score → Task 2 (`applySuppressions`), 5 (payload). ✓
- Schema/config/validators → Tasks 3, 4, 6. ✓
- Score recompute + divide-by-zero guard → Task 2. ✓
- Staleness caveat documented → Task 10. ✓
- Python enrichment → explicitly deferred (no task). ✓

**Placeholder scan:** every code step shows real code; commands have expected output. Tasks 7–9 instruct the implementer to read the surrounding function first (the only safe way to wire into a large handler) and give exact insertion points + code; this is guidance-with-code, not a placeholder.

**Type consistency:** `RunCacheEntry`/`saveRun`/`loadRun` (Task 1) used verbatim in Tasks 7, 8. `SuppressionInput`/`applySuppressions` (Task 2) used in Tasks 7, 8, 9. `ResultPayloadOpts.runId/suppressedCount` (Task 5) consumed in Task 7. `TriageRow.runId/suppressedCount` (Task 8) match the schema (Task 6). Key string `` `${line} ${mutator}` `` is consistent across suppression util, handler, and verify filtering. ✓

**Known risk flagged for the executor:** Tasks 7–9 touch a large handler. If `computeScope`/`formatAuditOutput` signatures have drifted, adapt the threading (cfg, resolvedFile, suppressedCount, runId) rather than forcing the exact lines — the *behavior* (load-by-id with miss/mismatch errors; filter then mint; verify excludes suppressed) is the contract.
