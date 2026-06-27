# Phase 2 — Triage Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `triage_test_coverage` a first-class scanner: `diffBase` (audit what a PR changed), optional inline per-file survivors, bounded-parallel execution, and machine-consumable `structuredContent`.

**Architecture:** A new `listChangedFiles` git helper + a `discoverChangedFiles` filter feed the triage handler's file selection; a small `mapPool` util replaces the serial loop (with a Stryker worker-division guard against CPU oversubscription); per-file enrichment reuses Phase 1's `buildResultPayload`; triage output is refactored into `buildTriagePayload` returned as both a text block and `structuredContent`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers resolving to `.ts`), Vitest, `@modelcontextprotocol/sdk`, `git` (read-only) via `runShell`, `os.cpus()`.

## Global Constraints

- ESM throughout: every relative import uses a `.js` specifier (e.g. `from './triage.js'`).
- `npm test` REQUIRES a prior `npm run build` (some tests import `../build/index.js`). Run `npm run build` before `npm test` in every verify step.
- Before EACH commit run the full gate pieces: `npm run build && npm run lint && npm run format:check && npm test` — lint 0 errors, format clean, tests green (run `npm run format` to fix prettier). Not just `npm test`.
- Importing `index.ts` must stay side-effect free.
- Preserve audit-tag comments (H4/H2/L8/C2/Med#2 etc.) on any code you touch.
- Conventional Commits (`feat:`/`refactor:`/`test:`/`docs:`/`chore:`).
- All changes additive and graceful: an enrichment/discovery failure must never crash a triage run; per-file audit failures are collected into `errors[]`, never fatal.
- Changes in this phase apply to `triage_test_coverage` ONLY. Do NOT change `audit_code_resilience` behavior.
- Default file-pool size is `min(4, cpus-1)` (min 1). Stryker per-file worker cap when pool > 1 is `max(1, floor((cpus-1)/poolSize))`.

---

### Task 1: `listChangedFiles` git helper

**Files:**
- Modify: `src/utils/git-diff.ts`
- Test: `src/__tests__/git-diff.test.ts`

**Interfaces:**
- Produces: `export type ChangedFilesResult = { kind: 'not-a-repo' } | { kind: 'bad-ref'; ref: string } | { kind: 'files'; files: string[] }`
- Produces: `export async function listChangedFiles(workspaceRoot: string, diffBase: string): Promise<ChangedFilesResult>` — `files` are workspace-relative, deduped, union of tracked-changed and untracked.
- Consumes: `runShell` from `./exec.js` (already imported in git-diff.ts).

- [ ] **Step 1: Write the failing test**

The existing `git-diff.test.ts` mocks `runShell`. Follow that pattern. Add:

```ts
import { listChangedFiles } from '../git-diff.js';

describe('listChangedFiles', () => {
  it('returns not-a-repo when the work-tree check fails', async () => {
    mockRunShell.mockRejectedValueOnce(new Error('not a git repo'));
    const r = await listChangedFiles('/ws', 'main');
    expect(r).toEqual({ kind: 'not-a-repo' });
  });

  it('returns bad-ref when merge-base fails', async () => {
    mockRunShell
      .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })       // rev-parse work-tree
      .mockRejectedValueOnce(new Error('bad ref'));                  // merge-base
    const r = await listChangedFiles('/ws', 'nope');
    expect(r).toEqual({ kind: 'bad-ref', ref: 'nope' });
  });

  it('unions tracked-changed and untracked, deduped', async () => {
    mockRunShell
      .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })             // work-tree
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' })           // merge-base
      .mockResolvedValueOnce({ stdout: 'src/a.ts\nsrc/b.ts\n', stderr: '' })// diff --name-only
      .mockResolvedValueOnce({ stdout: 'src/b.ts\nsrc/c.ts\n', stderr: '' });// ls-files --others
    const r = await listChangedFiles('/ws', 'main');
    expect(r).toEqual({ kind: 'files', files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] });
  });

  it('uses --cached for staged', async () => {
    mockRunShell
      .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })             // work-tree
      .mockResolvedValueOnce({ stdout: 'src/a.ts\n', stderr: '' })         // diff --cached --name-only
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                  // ls-files --others
    const r = await listChangedFiles('/ws', 'staged');
    expect(r).toEqual({ kind: 'files', files: ['src/a.ts'] });
    // assert no merge-base call happened
    const calls = mockRunShell.mock.calls.map((c) => c[1].join(' '));
    expect(calls.some((c) => c.includes('merge-base'))).toBe(false);
  });
});
```

(Use whatever the file's existing mock variable is named for `runShell`; the snippet assumes `mockRunShell`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/git-diff.test.ts -t listChangedFiles`
Expected: FAIL — `listChangedFiles` is not exported.

- [ ] **Step 3: Implement**

Add to `src/utils/git-diff.ts`:

```ts
/** Classification of the changed-file set against a diff base. */
export type ChangedFilesResult =
  | { kind: 'not-a-repo' }
  | { kind: 'bad-ref'; ref: string }
  | { kind: 'files'; files: string[] };

/**
 * List workspace-relative source paths that changed versus `diffBase`, unioned
 * with untracked files. Read-only git in `workspaceRoot`; never throws for
 * expected conditions. Same base resolution as {@link computeChangedRanges}
 * (merge-base for refs, `--cached` for "staged") so per-file ranges align.
 */
export async function listChangedFiles(
  workspaceRoot: string,
  diffBase: string,
): Promise<ChangedFilesResult> {
  const git = (args: string[]) =>
    runShell('git', args, { cwd: workspaceRoot, timeoutMs: GIT_TIMEOUT_MS });

  try {
    await git(['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { kind: 'not-a-repo' };
  }

  let nameOnly: string[];
  if (diffBase === 'staged') {
    nameOnly = ['diff', '--cached', '--name-only'];
  } else {
    let base: string;
    try {
      base = (await git(['merge-base', diffBase, 'HEAD'])).stdout.trim();
    } catch {
      return { kind: 'bad-ref', ref: diffBase };
    }
    nameOnly = ['diff', '--name-only', base];
  }

  let changed: string;
  try {
    changed = (await git(nameOnly)).stdout;
  } catch {
    return { kind: 'bad-ref', ref: diffBase };
  }

  let untracked = '';
  try {
    untracked = (await git(['ls-files', '--others', '--exclude-standard'])).stdout;
  } catch {
    untracked = ''; // best-effort: untracked discovery failing is non-fatal
  }

  const split = (s: string) => s.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const files = [...new Set([...split(changed), ...split(untracked)])].sort();
  return { kind: 'files', files };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run src/__tests__/git-diff.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/utils/git-diff.ts src/__tests__/git-diff.test.ts
git commit -m "feat: add listChangedFiles git helper for diff-aware triage"
```

---

### Task 2: `discoverChangedFiles` selection filter

**Files:**
- Modify: `src/triage.ts`
- Test: `src/__tests__/triage.test.ts`

**Interfaces:**
- Consumes: `ChangedFilesResult.files` (string[]) from Task 1; `isSupportedSourceFile` (already in triage.ts).
- Produces: `export function discoverChangedFiles(changedFiles: string[], paths: string[] | undefined, maxFiles: number): { files: string[]; discovered: number; skipped: number }` — filters to supported source files, intersects with `paths` prefixes when provided, sorts, dedupes, caps at `maxFiles`.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/triage.test.ts`:

```ts
import { discoverChangedFiles } from '../triage.js';

describe('discoverChangedFiles', () => {
  const changed = ['src/a.ts', 'src/util/b.ts', 'README.md', 'src/a.test.ts', 'pkg/c.go'];

  it('keeps only supported non-test source files', () => {
    const r = discoverChangedFiles(changed, undefined, 25);
    expect(r.files).toEqual(['pkg/c.go', 'src/a.ts', 'src/util/b.ts']);
    expect(r.discovered).toBe(3);
    expect(r.skipped).toBe(0);
  });

  it('intersects with paths prefixes when provided', () => {
    const r = discoverChangedFiles(changed, ['src/util'], 25);
    expect(r.files).toEqual(['src/util/b.ts']);
  });

  it('caps at maxFiles and reports skipped', () => {
    const r = discoverChangedFiles(changed, undefined, 1);
    expect(r.files).toEqual(['pkg/c.go']);
    expect(r.discovered).toBe(3);
    expect(r.skipped).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/triage.test.ts -t discoverChangedFiles`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

Add to `src/triage.ts`:

```ts
/**
 * Filter a raw changed-file list (from listChangedFiles) to supported source
 * files, optionally intersecting with `paths` (treated as directory/file
 * prefixes), then sort, dedupe, and cap at `maxFiles`.
 */
export function discoverChangedFiles(
  changedFiles: string[],
  paths: string[] | undefined,
  maxFiles: number,
): { files: string[]; discovered: number; skipped: number } {
  const underPaths = (rel: string): boolean => {
    if (!paths || paths.length === 0) return true;
    return paths.some((p) => {
      const norm = p.replace(/\/+$/, '');
      return rel === norm || rel.startsWith(`${norm}/`);
    });
  };
  const collected = changedFiles.filter((rel) => isSupportedSourceFile(rel) && underPaths(rel));
  const unique = [...new Set(collected)].sort();
  const discovered = unique.length;
  const files = unique.slice(0, maxFiles);
  return { files, discovered, skipped: discovered - files.length };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run src/__tests__/triage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/triage.ts src/__tests__/triage.test.ts
git commit -m "feat: add discoverChangedFiles selection filter for diffBase triage"
```

---

### Task 3: `mapPool` bounded-concurrency util

**Files:**
- Create: `src/utils/pool.ts`
- Test: `src/__tests__/pool.test.ts` (create)

**Interfaces:**
- Produces: `export async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>` — at most `concurrency` tasks in flight; results in input order; a throwing `fn` stores an `Error` in that slot and does NOT abort siblings.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/pool.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapPool } from '../utils/pool.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('mapPool', () => {
  it('returns results in input order', async () => {
    const out = await mapPool([1, 2, 3, 4], 2, async (n) => {
      await tick();
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it('never exceeds the concurrency bound', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 10 }, (_, i) => i), 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('does not let one rejection sink the others', async () => {
    const out = await mapPool([0, 1, 2], 3, async (n) => {
      if (n === 1) throw new Error('boom');
      await tick();
      return n;
    });
    expect(out[0]).toBe(0);
    expect(out[2]).toBe(2);
    expect(out[1]).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/pool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/utils/pool.ts`:

```ts
/**
 * Run `fn` over `items` with at most `concurrency` tasks in flight, returning
 * results in INPUT order. A throwing `fn` stores the thrown Error in that slot
 * and does not abort the remaining work (callers that wrap their own errors
 * never hit this path; it is a safety net).
 */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = (e instanceof Error ? e : new Error(String(e))) as unknown as R;
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run src/__tests__/pool.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/utils/pool.ts src/__tests__/pool.test.ts
git commit -m "feat: add mapPool bounded-concurrency helper"
```

---

### Task 4: `buildTriagePayload` + structuredContent + TriageRow fields

**Files:**
- Modify: `src/triage.ts` (TriageRow interface, formatters), `src/triage-handler.ts` (return structuredContent)
- Test: `src/__tests__/triage.test.ts`, `src/__tests__/triage-handler.test.ts`

**Interfaces:**
- Produces: `export interface TriagePayload { mode: 'triage'; summary: { filesDiscovered: number; filesAudited: number; filesSkipped: number; filesErrored: number }; ranking: TriageRow[]; errors: TriageError[]; scopeNote?: string; note: string }`
- Produces: `export function buildTriagePayload(rows: TriageRow[], errors: TriageError[], discovered: number, skipped: number, scopeNote?: string): TriagePayload`
- Extends `TriageRow` with optional `scopeNote?: string`, `worstSeverity?: Severity`, `survivors?: LineGroup[]`, `noCoverageGroups?: LineGroup[]`.
- `formatTriageAsJson(rows, errors, discovered, skipped, scopeNote?)` delegates to `buildTriagePayload` + `JSON.stringify`. `formatTriageAsText` gains an optional `scopeNote?` trailing param.
- Consumes: `Severity` from `./enrich.js`, `LineGroup` — note `LineGroup` is currently a private interface in `format.ts`; export it from `format.ts` (it is already referenced by `ResultPayload`, so exporting is safe) and import the type here.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/triage.test.ts`:

```ts
import { buildTriagePayload } from '../triage.js';

describe('buildTriagePayload', () => {
  it('assembles summary + ranking + note', () => {
    const rows = [
      { file: 'a.ts', mutationScore: '50.00%', total: 4, killed: 2, survived: 2, noCoverage: 0 },
    ];
    const p = buildTriagePayload(rows, [], 1, 0);
    expect(p.mode).toBe('triage');
    expect(p.summary).toEqual({ filesDiscovered: 1, filesAudited: 1, filesSkipped: 0, filesErrored: 0 });
    expect(p.ranking).toEqual(rows);
    expect(typeof p.note).toBe('string');
  });

  it('includes scopeNote when provided', () => {
    const p = buildTriagePayload([], [], 0, 0, 'diff vs main');
    expect(p.scopeNote).toBe('diff vs main');
  });
});
```

Append to `src/__tests__/triage-handler.test.ts` (follow its existing harness for invoking `handleTriageCall`):

```ts
it('returns structuredContent matching the JSON text block', async () => {
  // (use the file's existing setup that produces a successful triage result)
  const res = await handleTriageCall(/* request with paths */, /* config */);
  expect(res.structuredContent).toBeDefined();
  const parsed = JSON.parse((res.content[0] as { text: string }).text);
  expect(parsed).toEqual(res.structuredContent);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/triage.test.ts -t buildTriagePayload`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

In `src/format.ts`, change `interface LineGroup` to `export interface LineGroup` (export only; no behavior change).

In `src/triage.ts`:
- Add imports: `import type { Severity } from './enrich.js';` and `import type { LineGroup } from './format.js';`
- Extend `TriageRow`:

```ts
export interface TriageRow {
  file: string;
  mutationScore: string;
  total: number;
  killed: number;
  survived: number;
  noCoverage: number;
  scopeNote?: string;
  worstSeverity?: Severity;
  survivors?: LineGroup[];
  noCoverageGroups?: LineGroup[];
}
```

- Add the payload interface + builder, and refactor `formatTriageAsJson` to use it:

```ts
export interface TriagePayload {
  mode: 'triage';
  summary: { filesDiscovered: number; filesAudited: number; filesSkipped: number; filesErrored: number };
  ranking: TriageRow[];
  errors: TriageError[];
  scopeNote?: string;
  note: string;
}

export function buildTriagePayload(
  rows: TriageRow[],
  errors: TriageError[],
  discovered: number,
  skipped: number,
  scopeNote?: string,
): TriagePayload {
  const payload: TriagePayload = {
    mode: 'triage',
    summary: {
      filesDiscovered: discovered,
      filesAudited: rows.length,
      filesSkipped: skipped,
      filesErrored: errors.length,
    },
    ranking: rows,
    errors,
    note: note(rows, discovered, skipped),
  };
  if (scopeNote) payload.scopeNote = scopeNote;
  return payload;
}

export function formatTriageAsJson(
  rows: TriageRow[],
  errors: TriageError[],
  discovered: number,
  skipped: number,
  scopeNote?: string,
): string {
  return JSON.stringify(buildTriagePayload(rows, errors, discovered, skipped, scopeNote));
}
```

- Update `formatTriageAsText` signature to `(rows, errors, discovered, skipped, scopeNote?: string)` and, when `scopeNote` is set, push it as a line after the header.

In `src/triage-handler.ts`, at the two success return sites (lines ~75 and ~131), build the payload and return both representations. Replace:

```ts
const text = outputFormat === 'text'
  ? formatTriageAsText(ranking, errors, discovered, skipped)
  : formatTriageAsJson(ranking, errors, discovered, skipped);
return { content: [{ type: 'text', text }] };
```

with:

```ts
const payload = buildTriagePayload(ranking, errors, discovered, skipped, scopeNote);
const text = outputFormat === 'text'
  ? formatTriageAsText(ranking, errors, discovered, skipped, scopeNote)
  : JSON.stringify(payload);
return {
  content: [{ type: 'text', text }],
  structuredContent: payload as unknown as Record<string, unknown>,
};
```

For this task `scopeNote` is `undefined` (no diffBase yet) at both sites — declare `const scopeNote: string | undefined = undefined;` for now; Task 8 sets it. Import `buildTriagePayload` in the handler.

- [ ] **Step 4: Run tests to verify they pass + update existing**

Run: `npm run build && npx vitest run src/__tests__/triage.test.ts src/__tests__/triage-handler.test.ts`
Expected: PASS. Existing triage-handler tests that asserted `{ content: [...] }` with no `structuredContent` still pass (additive); if any asserted the EXACT result object shape, update it to include `structuredContent`.

- [ ] **Step 5: Commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/triage.ts src/format.ts src/triage-handler.ts src/__tests__/triage.test.ts src/__tests__/triage-handler.test.ts
git commit -m "feat: add buildTriagePayload and return structuredContent from triage"
```

---

### Task 5: Tool schema — `diffBase`, `survivorsPerFile`, `fileConcurrency`, `outputSchema`

**Files:**
- Modify: `src/tool-schema.ts` (`TRIAGE_TOOL_DEFINITION`)
- Test: `src/__tests__/tool-schema.test.ts`

**Interfaces:**
- Produces: `TRIAGE_TOOL_DEFINITION.inputSchema.properties.{diffBase,survivorsPerFile,fileConcurrency}`, `paths` removed from `required`, and `TRIAGE_TOOL_DEFINITION.outputSchema`.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/tool-schema.test.ts`:

```ts
import { TRIAGE_TOOL_DEFINITION } from '../tool-schema.js';

describe('TRIAGE_TOOL_DEFINITION phase-2 additions', () => {
  it('declares diffBase, survivorsPerFile, fileConcurrency', () => {
    const props = TRIAGE_TOOL_DEFINITION.inputSchema.properties as Record<
      string,
      { type?: string; minimum?: number; maximum?: number }
    >;
    expect(props.diffBase.type).toBe('string');
    expect(props.survivorsPerFile.type).toBe('integer');
    expect(props.survivorsPerFile.minimum).toBe(0);
    expect(props.fileConcurrency.type).toBe('integer');
    expect(props.fileConcurrency.minimum).toBe(1);
    expect(props.fileConcurrency.maximum).toBe(64);
  });

  it('no longer requires paths', () => {
    expect(TRIAGE_TOOL_DEFINITION.inputSchema.required).not.toContain('paths');
  });

  it('exposes an outputSchema with ranking and summary', () => {
    const out = (TRIAGE_TOOL_DEFINITION as { outputSchema?: { properties?: Record<string, unknown> } })
      .outputSchema;
    expect(out?.properties?.ranking).toBeDefined();
    expect(out?.properties?.summary).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/tool-schema.test.ts -t "phase-2 additions"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/tool-schema.ts`, add to `TRIAGE_TOOL_DEFINITION.inputSchema.properties`:

```ts
      diffBase: {
        type: 'string',
        description:
          'Auto-scope the triage to files changed in git. "HEAD" (uncommitted), "staged", or any ' +
          'ref/branch/SHA (merge-base with HEAD). Makes "paths" optional: diffBase alone scans all ' +
          'changed supported source files; diffBase + paths intersects with those paths. TypeScript ' +
          'files are mutated only on changed lines; other languages run whole-file. Example: "main"',
      },
      survivorsPerFile: {
        type: 'integer',
        minimum: 0,
        description:
          'How many top (severity-ranked, enriched) survivor groups to inline per ranked file. ' +
          '0 (default) returns a scores-only leaderboard. Example: 3',
      },
      fileConcurrency: {
        type: 'integer',
        minimum: 1,
        maximum: 64,
        description:
          'How many files to audit in parallel. Default min(4, cpus-1). When >1, each StrykerJS run\'s ' +
          'worker count is capped so total CPU use stays near the core count. Example: 4',
      },
```

Change `required: ['paths']` to `required: []` (paths-or-diffBase is enforced in the handler).

Add a sibling `outputSchema` to `TRIAGE_TOOL_DEFINITION` (after `inputSchema`):

```ts
  outputSchema: {
    type: 'object' as const,
    properties: {
      mode: { type: 'string' },
      summary: {
        type: 'object',
        properties: {
          filesDiscovered: { type: 'integer' },
          filesAudited: { type: 'integer' },
          filesSkipped: { type: 'integer' },
          filesErrored: { type: 'integer' },
        },
        required: ['filesDiscovered', 'filesAudited', 'filesSkipped', 'filesErrored'],
      },
      ranking: { type: 'array', items: { type: 'object' } },
      errors: { type: 'array', items: { type: 'object' } },
      scopeNote: { type: 'string' },
      note: { type: 'string' },
    },
    required: ['mode', 'summary', 'ranking', 'errors', 'note'],
  },
```

If a pre-existing exact-key test enumerates triage input properties, add the three new keys to its expected map.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run src/__tests__/tool-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/tool-schema.ts src/__tests__/tool-schema.test.ts
git commit -m "feat: add diffBase/survivorsPerFile/fileConcurrency + outputSchema to triage tool"
```

---

### Task 6: Config — `defaultFileConcurrency`

**Files:**
- Modify: `src/utils/config-loader.ts`
- Test: `src/__tests__/config-loader.test.ts`

**Interfaces:**
- Produces: `ChaosConfig.defaultFileConcurrency?: number` (integer 1–64).

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/config-loader.test.ts`, following the file's existing temp-config pattern (mock fs / temp file + `loadConfig`/`validateConfig`):

```ts
it('loads a valid defaultFileConcurrency', () => {
  // build config object { defaultFileConcurrency: 4 } via the file's existing helper
  // expect loaded config.defaultFileConcurrency === 4
});

it('rejects an out-of-range defaultFileConcurrency with a warning', () => {
  // { defaultFileConcurrency: 0 } → config.defaultFileConcurrency undefined,
  // warnings include 'defaultFileConcurrency'
});
```

Implement the test bodies in the file's actual style (assertions: valid loads; `0` and `100` and non-integer are dropped with a warning naming `defaultFileConcurrency`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/config-loader.test.ts -t defaultFileConcurrency`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/utils/config-loader.ts`:
- Add `'defaultFileConcurrency'` to `KNOWN_KEYS`.
- Add to `ChaosConfig`:

```ts
  /** Default number of files audited in parallel by triage_test_coverage (integer 1–64). */
  defaultFileConcurrency?: number;
```

- In `buildConfig`, after the `defaultMaxSurvivors` block:

```ts
  if (
    typeof raw.defaultFileConcurrency === 'number' &&
    Number.isInteger(raw.defaultFileConcurrency) &&
    raw.defaultFileConcurrency >= 1 &&
    raw.defaultFileConcurrency <= 64
  ) {
    result.defaultFileConcurrency = raw.defaultFileConcurrency;
  }
```

- In `validateConfig` global-fields section:

```ts
  if (
    'defaultFileConcurrency' in raw &&
    (typeof raw.defaultFileConcurrency !== 'number' ||
      !Number.isInteger(raw.defaultFileConcurrency) ||
      raw.defaultFileConcurrency < 1 ||
      raw.defaultFileConcurrency > 64)
  ) {
    warnings.push(
      `defaultFileConcurrency must be an integer between 1 and 64, got ${typeof raw.defaultFileConcurrency === 'number' ? raw.defaultFileConcurrency : typeof raw.defaultFileConcurrency}.`,
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run src/__tests__/config-loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/utils/config-loader.ts src/__tests__/config-loader.test.ts
git commit -m "feat: add defaultFileConcurrency config field"
```

---

### Task 7: Triage argument validation

**Files:**
- Modify: `src/triage-handler.ts` (validation block near the top of `handleTriageCall`)
- Test: `src/__tests__/triage-handler.test.ts`

**Interfaces:**
- Adds validation: require `paths` OR `diffBase`; `diffBase` non-empty string not `-`-prefixed; `survivorsPerFile` integer ≥ 0; `fileConcurrency` integer 1–64. Each returns the existing `triageError(...)` shape (isError result).

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/triage-handler.test.ts`:

```ts
it('errors when neither paths nor diffBase is given', async () => {
  const res = await handleTriageCall({ params: { name: 'triage_test_coverage', arguments: {} } } as any);
  expect(res.isError).toBe(true);
  expect((res.content[0] as { text: string }).text).toMatch(/paths.*diffBase|diffBase.*paths/);
});

it('rejects a "-"-prefixed diffBase', async () => {
  const res = await handleTriageCall({
    params: { name: 'triage_test_coverage', arguments: { diffBase: '-x' } },
  } as any);
  expect(res.isError).toBe(true);
  expect((res.content[0] as { text: string }).text).toContain('diffBase');
});

it('rejects a negative survivorsPerFile', async () => {
  const res = await handleTriageCall({
    params: { name: 'triage_test_coverage', arguments: { paths: ['src'], survivorsPerFile: -1 } },
  } as any);
  expect(res.isError).toBe(true);
  expect((res.content[0] as { text: string }).text).toContain('survivorsPerFile');
});

it('rejects an out-of-range fileConcurrency', async () => {
  const res = await handleTriageCall({
    params: { name: 'triage_test_coverage', arguments: { paths: ['src'], fileConcurrency: 0 } },
  } as any);
  expect(res.isError).toBe(true);
  expect((res.content[0] as { text: string }).text).toContain('fileConcurrency');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/triage-handler.test.ts -t "diffBase\|survivorsPerFile\|fileConcurrency\|neither paths"`
Expected: FAIL (args currently unvalidated; paths-required check may catch some but not all).

- [ ] **Step 3: Implement**

In `src/triage-handler.ts`, replace the current `paths`-required guard so it allows diffBase, and add the new validations BEFORE discovery. Keep the existing per-element string check for `paths` when present:

```ts
  const hasPaths = Array.isArray(args.paths) && args.paths.length > 0;
  const hasDiffBase = typeof args.diffBase === 'string' && args.diffBase.trim().length > 0;
  if (!hasPaths && !hasDiffBase) {
    return triageError(
      'Provide "paths" (array of workspace-relative files/dirs) or "diffBase" (a git ref) — at least one is required.',
    );
  }
  if (hasPaths && args.paths.some((p) => typeof p !== 'string' || p.trim().length === 0)) {
    return triageError('paths must be an array of non-empty workspace-relative strings.');
  }
  if (args.diffBase !== undefined) {
    if (typeof args.diffBase !== 'string' || args.diffBase.trim().length === 0) {
      return triageError('diffBase must be a non-empty string: "HEAD", "staged", or a git ref.');
    }
    if (args.diffBase.startsWith('-')) {
      return triageError('diffBase must not start with "-" (it would be mistaken for a git option).');
    }
  }
  if (
    args.survivorsPerFile !== undefined &&
    (typeof args.survivorsPerFile !== 'number' ||
      !Number.isInteger(args.survivorsPerFile) ||
      args.survivorsPerFile < 0)
  ) {
    return triageError('survivorsPerFile must be an integer >= 0.');
  }
  if (
    args.fileConcurrency !== undefined &&
    (typeof args.fileConcurrency !== 'number' ||
      !Number.isInteger(args.fileConcurrency) ||
      args.fileConcurrency < 1 ||
      args.fileConcurrency > 64)
  ) {
    return triageError('fileConcurrency must be an integer between 1 and 64.');
  }
  const paths = hasPaths ? (args.paths as string[]) : undefined;
```

Note: the existing code declares `const paths = args.paths as string[];` — replace usages so `paths` is `string[] | undefined`. The workspace-boundary loop that iterates `paths` must run only when `paths` is defined (guard with `if (paths) { ... }`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run src/__tests__/triage-handler.test.ts`
Expected: PASS (existing paths-based tests still pass; new validation tests pass).

- [ ] **Step 5: Commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/triage-handler.ts src/__tests__/triage-handler.test.ts
git commit -m "feat: validate triage diffBase/survivorsPerFile/fileConcurrency + paths-or-diffBase"
```

---

### Task 8: Handler — diffBase file selection + per-file line scope (serial)

**Files:**
- Modify: `src/triage-handler.ts`
- Test: `src/__tests__/triage-handler.test.ts`

**Interfaces:**
- Consumes: `listChangedFiles` (Task 1), `discoverChangedFiles` (Task 2), `computeChangedRanges` (existing, `./utils/git-diff.js`), `ENGINE_REGISTRY[projectType].supportsLineScope`.
- Sets the `scopeNote` (Task 4) on the payload when in diffBase mode, and per-row `scopeNote` for diff-scoped/whole-file rows.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/triage-handler.test.ts` (follow the existing mocking of `listChangedFiles`/`computeChangedRanges`/audit core; assert selection + scoping behavior):

```ts
it('selects changed files via diffBase and reports not-a-repo', async () => {
  // mock listChangedFiles → { kind: 'not-a-repo' }
  const res = await handleTriageCall({
    params: { name: 'triage_test_coverage', arguments: { diffBase: 'main' } },
  } as any);
  expect(res.isError).toBe(true);
  expect((res.content[0] as { text: string }).text).toMatch(/git work tree|not a git/i);
});

it('diffBase with no changed supported files returns an empty leaderboard', async () => {
  // mock listChangedFiles → { kind: 'files', files: ['README.md'] }
  const res = await handleTriageCall({
    params: { name: 'triage_test_coverage', arguments: { diffBase: 'main' } },
  } as any);
  const parsed = JSON.parse((res.content[0] as { text: string }).text);
  expect(parsed.ranking).toEqual([]);
  expect(parsed.scopeNote).toBeDefined();
});
```

(Use the test file's established mock seams. If `listChangedFiles`/`computeChangedRanges` are imported from `../utils/git-diff.js`, mock that module.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/triage-handler.test.ts -t diffBase`
Expected: FAIL — diffBase not yet handled.

- [ ] **Step 3: Implement**

In `src/triage-handler.ts`:
- Import `listChangedFiles`, `computeChangedRanges` from `./utils/git-diff.js`, `discoverChangedFiles` from `./triage.js`, and `ENGINE_REGISTRY` from `./engines/registry.js` (some already imported).
- After validation, branch file discovery:

```ts
  let files: string[];
  let discovered: number;
  let skipped: number;
  let scopeNote: string | undefined;

  if (hasDiffBase) {
    const listed = await listChangedFiles(rootCwd, args.diffBase as string);
    if (listed.kind === 'not-a-repo') {
      return triageError(
        `diffBase requires a git work tree, but "${rootCwd}" is not one. Remove diffBase or run inside a git repository.`,
      );
    }
    if (listed.kind === 'bad-ref') {
      return triageError(`diffBase "${listed.ref}" could not be resolved as a git ref.`);
    }
    const sel = discoverChangedFiles(listed.files, paths, maxFiles);
    files = sel.files;
    discovered = sel.discovered;
    skipped = sel.skipped;
    scopeNote = `Scoped to files changed vs ${args.diffBase}. TypeScript files mutated on changed lines; other languages whole-file.`;
  } else {
    const disc = discoverFiles(paths as string[], rootCwd, maxFiles);
    files = disc.files;
    discovered = disc.discovered;
    skipped = disc.skipped;
  }
```

- In the per-file loop body, when `hasDiffBase` and the engine supports line scope, compute ranges and pass them into `auditFile`; set per-row `scopeNote`:

```ts
      let lineRanges: { start: number; end: number }[] | undefined;
      let rowScopeNote: string | undefined;
      if (hasDiffBase) {
        if (ENGINE_REGISTRY[projectType].supportsLineScope) {
          const ranges = await computeChangedRanges(targetFile, env.workspaceRoot, args.diffBase as string);
          if (ranges.kind === 'ranges') {
            lineRanges = ranges.ranges;
            rowScopeNote = 'scored on changed lines';
          } else if (ranges.kind === 'untracked') {
            rowScopeNote = 'untracked; whole file';
          }
          // no-changes/bad-ref/not-a-repo: leave whole-file (the file was selected, so this is rare)
        } else {
          rowScopeNote = 'diff scoping unsupported for this language; whole file';
        }
      }
```

Pass `lineRanges` to `auditFile({ ..., lineRanges })`, and after building the row attach `row.scopeNote = rowScopeNote` when set. Pass `scopeNote` into the `buildTriagePayload`/formatters at BOTH the empty-result return and the final return (replace the `const scopeNote = undefined` placeholder from Task 4).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run src/__tests__/triage-handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/triage-handler.ts src/__tests__/triage-handler.test.ts
git commit -m "feat: diffBase file selection and per-file line scoping in triage"
```

---

### Task 9: Handler — bounded-parallel execution + inline survivors

**Files:**
- Modify: `src/triage-handler.ts`
- Test: `src/__tests__/triage-handler.test.ts`

**Interfaces:**
- Consumes: `mapPool` (Task 3), `buildResultPayload` from `./format.js` (Phase 1), `cpus` from `os`, `cfg.defaultFileConcurrency` (Task 6), the `survivorsPerFile`/`fileConcurrency` args.
- Produces: exported pure helper `export function resolveStrykerConcurrency(poolSize: number, cpus: number): number | undefined` (for testing the oversubscription math).

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/triage-handler.test.ts`:

```ts
import { resolveStrykerConcurrency } from '../triage-handler.js';

describe('resolveStrykerConcurrency', () => {
  it('returns undefined for a single-file pool', () => {
    expect(resolveStrykerConcurrency(1, 8)).toBeUndefined();
  });
  it('divides (cpus-1) across the pool, min 1', () => {
    expect(resolveStrykerConcurrency(4, 8)).toBe(1); // floor(7/4)=1
    expect(resolveStrykerConcurrency(2, 8)).toBe(3); // floor(7/2)=3
    expect(resolveStrykerConcurrency(8, 2)).toBe(1); // floor(1/8)=0 → clamped to 1
  });
});
```

Add an inline-survivors behavior test using the file's audit-core mock to return a result with a high-severity survivor, then assert a row carries `survivors` and `worstSeverity` when `survivorsPerFile > 0`, and does NOT when `0`:

```ts
it('inlines top survivors per file when survivorsPerFile > 0', async () => {
  // mock the audit core to yield a MutationResult with a ConditionalExpression survivor on a .ts file
  const res = await handleTriageCall({
    params: { name: 'triage_test_coverage', arguments: { paths: ['src/foo.ts'], survivorsPerFile: 3 } },
  } as any);
  const parsed = JSON.parse((res.content[0] as { text: string }).text);
  const row = parsed.ranking[0];
  expect(row.survivors.length).toBeGreaterThan(0);
  expect(row.worstSeverity).toBe('high');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/triage-handler.test.ts -t "resolveStrykerConcurrency\|inlines top survivors"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/triage-handler.ts`:
- Add imports: `import { cpus } from 'os';`, `import { mapPool } from './utils/pool.js';`, `import { buildResultPayload } from './format.js';`, `import { readFileSync } from 'fs';`
- Add the pure helper:

```ts
/** Per-file StrykerJS worker cap so parallel triage doesn't oversubscribe CPU. */
export function resolveStrykerConcurrency(poolSize: number, cpuCount: number): number | undefined {
  if (poolSize <= 1) return undefined;
  return Math.max(1, Math.floor((cpuCount - 1) / poolSize));
}
```

- Resolve the pool size and survivor count near the top (after validation):

```ts
  const cpuCount = cpus().length;
  const poolSize =
    typeof args.fileConcurrency === 'number' && Number.isInteger(args.fileConcurrency)
      ? args.fileConcurrency
      : (cfg.defaultFileConcurrency ?? Math.max(1, Math.min(4, cpuCount - 1)));
  const strykerConcurrency = resolveStrykerConcurrency(poolSize, cpuCount);
  const survivorsPerFile =
    typeof args.survivorsPerFile === 'number' && Number.isInteger(args.survivorsPerFile)
      ? args.survivorsPerFile
      : 0;
```

- Replace the serial `for (const file of files) { ... }` loop with a `mapPool` call. Move the existing per-file body into an async function `auditOne(file)` that returns `{ row } | { error }`, then:

```ts
  const outcomes = await mapPool(files, poolSize, (file) => auditOne(file));
  const audited: { file: string; result: MutationResult }[] = [];
  for (const o of outcomes) {
    if (o instanceof Error) { errors.push({ file: '(unknown)', error: o.message }); continue; }
    if ('error' in o) errors.push(o.error);
    else audited.push(o.row);
  }
```

  In `auditOne`, for TypeScript files include `concurrency: strykerConcurrency` in `perFileArgs` (only when defined); after `auditFile` returns `result`, when `survivorsPerFile > 0` enrich and attach:

```ts
      const base = { file, result };
      if (survivorsPerFile > 0) {
        let sourceLines: string[] | undefined;
        try { sourceLines = readFileSync(resolve(rootCwd, file), 'utf8').split(/\r?\n/); }
        catch { sourceLines = undefined; }
        const payload = buildResultPayload(result, {
          enrich: { projectType, sourceLines },
          maxSurvivors: survivorsPerFile,
        });
        base.detail = {
          survivors: payload.survivors,
          noCoverageGroups: payload.noCoverage,
          worstSeverity: payload.summary.worstSeverity,
        };
      }
      return { row: base };
```

  Then when building `TriageRow`s for ranking, carry `survivors`/`noCoverageGroups`/`worstSeverity`/`scopeNote` from each audited entry. Note: `rankResults` currently maps `{file,result}` → row; extend the audited entry to carry the optional `detail` + `scopeNote`, and after `rankResults` produces the base rows, merge the detail/scopeNote onto the matching row by file (or extend `rankResults` to accept and pass through the extra fields). Keep `rankResults`'s sort keys unchanged.

  (Implementer choice: simplest is to have `auditOne` return the full enriched `TriageRow` directly and add a `rankRows(rows)` that sorts pre-built rows with the same comparator, rather than threading detail through `rankResults`. Either is fine as long as sort order is unchanged and tests pass.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run src/__tests__/triage-handler.test.ts src/__tests__/triage.test.ts`
Expected: PASS. Update any existing triage-handler test that assumed strictly-serial ordering of side effects (ranking output is order-independent, so assertions on the ranking array should be unaffected).

- [ ] **Step 5: Commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/triage-handler.ts src/__tests__/triage-handler.test.ts
git commit -m "feat: bounded-parallel triage with Stryker worker cap and inline survivors"
```

---

### Task 10: Full gate + self-mutation smoke + docs

**Files:**
- Modify: `README.md`, `CHANGELOG.md`
- No new test file.

- [ ] **Step 1: Run the full gate**

Run: `npm run check`
Expected: build, lint, format:check, and all tests PASS.

- [ ] **Step 2: Self-mutation smoke (best-effort)**

Run: `node scripts/audit-self.js src/triage.ts` then `node scripts/meta-test.js`
Expected: completes without crashing; genuine survivors are fine (do not chase equivalent mutants). If the environment can't run them, document why — `npm run check` is the hard gate.

- [ ] **Step 3: Update docs**

In `README.md`, document on `triage_test_coverage`: `diffBase` (paths now optional; PR-scan; TS line-scoped, others whole-file), `survivorsPerFile` (default 0), `fileConcurrency` (default min(4,cpus-1) + the Stryker worker-cap behavior), that triage now returns `structuredContent` + an `outputSchema`, and the new `defaultFileConcurrency` config field. Keep the existing README structure/voice; verify each claim against the code, do not invent behavior. Add a `CHANGELOG.md` entry under a new unreleased heading summarizing Phase 2.

- [ ] **Step 4: Commit**

```bash
npm run build && npm run lint && npm run format:check
git add README.md CHANGELOG.md
git commit -m "docs: document Phase 2 triage scanner changes"
```

---

## Self-Review

**Spec coverage:**
- #1 diffBase (discovery, paths-optional/intersect, per-file TS line-scope) → Tasks 1, 2, 5 (schema), 7 (validation/paths-or-diffBase), 8 (wiring). ✓
- #3 inline survivors (`survivorsPerFile`, enriched top-N) → Tasks 4 (row fields), 5 (schema), 7 (validation), 9 (wiring). ✓
- #11 bounded-parallel (`mapPool`, fileConcurrency, Stryker worker division) → Tasks 3, 5 (schema), 6 (config), 7 (validation), 9 (wiring + `resolveStrykerConcurrency`). ✓
- Triage structuredContent + outputSchema → Tasks 4, 5. ✓
- Config `defaultFileConcurrency` → Task 6. ✓
- Error handling (not-a-repo/bad-ref/empty/ per-file isolation) → Tasks 1, 8, 9. ✓
- Testing + gate + docs → embedded per task + Task 10. ✓

**Placeholder scan:** Every code step contains full code. The only deferred spot is Task 9's explicit implementer choice between "return full row from auditOne" vs "thread detail through rankResults" — both are spelled out with the invariant (sort order unchanged); not a placeholder. Task 4's `scopeNote` is a defined `undefined` placeholder that Task 8 fills, called out in both tasks.

**Type consistency:** `ChangedFilesResult`/`listChangedFiles` (Task 1) consumed unchanged in Task 8. `discoverChangedFiles` signature (Task 2) matches its Task 8 call. `mapPool` signature (Task 3) matches Task 9 usage. `TriageRow` optional fields (Task 4) are the ones populated in Tasks 8 (`scopeNote`) and 9 (`survivors`/`noCoverageGroups`/`worstSeverity`). `buildTriagePayload`/`TriagePayload` (Task 4) match the `outputSchema` (Task 5). `resolveStrykerConcurrency` (Task 9) signature matches its test. `LineGroup` is exported from `format.ts` in Task 4 before triage imports it. `defaultFileConcurrency` (Task 6) read in Task 9.

**Ordering:** Utils (1–3) and refactor (4) → schema/config/validation (5–7) → handler wiring (8 selection, 9 parallel+survivors) → gate/docs (10). Task 8 depends on 1,2,4,7; Task 9 depends on 3,4,6,7 and Phase-1 `buildResultPayload`.
