import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
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
    // Assert the dedup happened at WRITE time (one stored entry), not just that
    // loadSuppressions' Set collapses it — pins the `seen.has(k)` guard.
    const raw = JSON.parse(readFileSync(join(root, '.chaos-mcp', 'suppressions.json'), 'utf8')) as {
      entries: Record<string, unknown[]>;
    };
    expect(raw.entries['src/a.ts']).toHaveLength(1);
  });

  it('addSuppressions with no entries writes nothing (early return)', () => {
    addSuppressions(root, 'src/a.ts', []);
    // The early return means no file is created at all.
    expect(existsSync(join(root, '.chaos-mcp', 'suppressions.json'))).toBe(false);
  });

  it('removeSuppressions with no keys writes nothing (early return)', () => {
    removeSuppressions(root, 'src/a.ts', []);
    expect(existsSync(join(root, '.chaos-mcp', 'suppressions.json'))).toBe(false);
  });

  it('remove deletes a specific key', () => {
    addSuppressions(root, 'src/a.ts', [
      { line: 1, mutator: 'A' },
      { line: 2, mutator: 'B' },
    ]);
    removeSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]);
    expect([...(loadSuppressions(root).get('src/a.ts') ?? [])]).toEqual(['2 B']);
  });

  it('applySuppressions filters vulnerabilities and recomputes score', () => {
    const { result, suppressedCount } = applySuppressions(makeResult(), new Set(['1 A', '2 A']));
    expect(suppressedCount).toBe(2);
    expect(result.vulnerabilities).toEqual([{ line: 1, mutator: 'B', description: 'x' }]);
    expect(result.totalMutants).toBe(8); // 10 - 2
    expect(result.survived).toBe(3); // 4 - 1 (only '1 A' is a true survivor; '2 A' is NoCoverage)
    expect(result.mutationScore).toBe('75.00%'); // 6 / 8
  });

  it('applySuppressions suppressing only a NoCoverage mutant leaves survived unchanged', () => {
    // '2 A' has description 'no test reached this line' → NoCoverage, not a true survivor
    const { result, suppressedCount } = applySuppressions(makeResult(), new Set(['2 A']));
    expect(suppressedCount).toBe(1);
    expect(result.totalMutants).toBe(9); // 10 - 1
    expect(result.survived).toBe(4); // unchanged — NoCoverage doesn't count against survived
    expect(result.mutationScore).toBe('66.67%'); // 6 / 9
  });

  it('applySuppressions with undefined set is a no-op', () => {
    const r = makeResult();
    const { result, suppressedCount } = applySuppressions(r, undefined);
    expect(suppressedCount).toBe(0);
    expect(result.totalMutants).toBe(10);
  });

  // ── configPath branch (line 26): a custom path is honored, relative paths
  //    resolve against the workspace root, absolute paths are used verbatim. ──
  it('honors a relative configPath (not the default location)', () => {
    addSuppressions(root, 'src/a.ts', [{ line: 7, mutator: 'C' }], 'custom/sup.json');
    // The custom file round-trips...
    expect([...(loadSuppressions(root, 'custom/sup.json').get('src/a.ts') ?? [])]).toEqual(['7 C']);
    // ...and the DEFAULT location was never written.
    expect(loadSuppressions(root).size).toBe(0);
  });

  it('honors an absolute configPath verbatim', () => {
    const abs = join(root, 'abs-suppressions.json');
    addSuppressions(root, 'src/a.ts', [{ line: 9, mutator: 'D' }], abs);
    expect([...(loadSuppressions(root, abs).get('src/a.ts') ?? [])]).toEqual(['9 D']);
    // Reading it as a relative path (joined to root) would point elsewhere → empty.
    expect(loadSuppressions(root).size).toBe(0);
  });

  // ── version preservation (line 43): `raw.version ?? 1` must keep an existing
  //    version across a read-modify-write (kills `??` → `&&`). ──
  it('preserves an existing file version through add', () => {
    mkdirSync(join(root, '.chaos-mcp'), { recursive: true });
    const dest = join(root, '.chaos-mcp', 'suppressions.json');
    writeFileSync(
      dest,
      JSON.stringify({
        version: 2,
        entries: { 'src/a.ts': [{ line: 1, mutator: 'A', addedAt: 1 }] },
      }),
    );
    addSuppressions(root, 'src/a.ts', [{ line: 2, mutator: 'B' }]);
    const raw = JSON.parse(readFileSync(dest, 'utf8')) as { version: number };
    expect(raw.version).toBe(2);
  });

  // ── readFile shape validation (lines 36–39): valid JSON of the wrong shape
  //    must yield an empty map, never crash on Object.entries. ──
  it.each([
    ['top-level null', 'null'],
    ['a non-object scalar', '42'],
    ['an object missing entries', '{"version":1}'],
    ['entries set to null', '{"version":1,"entries":null}'],
  ])('treats %s as an empty suppression set', (_label, content) => {
    mkdirSync(join(root, '.chaos-mcp'), { recursive: true });
    writeFileSync(join(root, '.chaos-mcp', 'suppressions.json'), content);
    expect(loadSuppressions(root).size).toBe(0);
  });

  // ── loadSuppressions entry validation (lines 64/67/70): non-array values are
  //    skipped, malformed entries are filtered, files with no valid entries are
  //    omitted from the map entirely. ──
  it('skips non-array entry values, filters malformed entries, and drops empty files', () => {
    mkdirSync(join(root, '.chaos-mcp'), { recursive: true });
    writeFileSync(
      join(root, '.chaos-mcp', 'suppressions.json'),
      JSON.stringify({
        version: 1,
        entries: {
          'good.ts': [
            { line: 5, mutator: 'A', addedAt: 1 }, // valid → kept
            { line: 5.5, mutator: 'B', addedAt: 1 }, // non-integer line → dropped
            { line: 6 }, // missing mutator → dropped
            { mutator: 'C' }, // missing line → dropped
            null, // falsy entry → dropped
          ],
          'notArray.ts': 42, // not an array (and not iterable) → file skipped
          'allBad.ts': [{ line: 'x', mutator: 'Z' }], // every entry invalid → file omitted
        },
      }),
    );
    const map = loadSuppressions(root);
    expect([...map.keys()].sort()).toEqual(['good.ts']);
    expect([...(map.get('good.ts') ?? [])]).toEqual(['5 A']);
  });

  // ── removeSuppressions else-branch (lines 110–112): removing the last entry
  //    for a file deletes that file's key entirely, leaving other files intact. ──
  it('deletes a file key when its last entry is removed, keeping other files', () => {
    addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]);
    addSuppressions(root, 'src/b.ts', [{ line: 2, mutator: 'B' }]);
    removeSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]);
    const map = loadSuppressions(root);
    // a.ts is gone, b.ts remains — distinguishes "keep all" and "drop all" mutants.
    expect([...map.keys()]).toEqual(['src/b.ts']);
    // The raw file must no longer carry the src/a.ts key at all.
    const raw = JSON.parse(readFileSync(join(root, '.chaos-mcp', 'suppressions.json'), 'utf8')) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(raw.entries)).toEqual(['src/b.ts']);
  });

  // ── applySuppressions early return (line 130): a non-empty set that matches
  //    no vulnerability leaves the result untouched with suppressedCount 0. ──
  it('applySuppressions with a non-matching set is a no-op', () => {
    const r = makeResult();
    const { result, suppressedCount } = applySuppressions(r, new Set(['999 Z']));
    expect(suppressedCount).toBe(0);
    expect(result.totalMutants).toBe(10);
    expect(result.vulnerabilities).toHaveLength(3);
    expect(result.mutationScore).toBe('60.00%');
  });

  it('all mutants suppressed → 100.00% (no measurable mutants)', () => {
    const r: MutationResult = {
      ...makeResult(),
      totalMutants: 2,
      killed: 0,
      survived: 2,
      vulnerabilities: [
        { line: 1, mutator: 'A', description: 'x' },
        { line: 1, mutator: 'B', description: 'x' },
      ],
    };
    const { result } = applySuppressions(r, new Set(['1 A', '1 B']));
    expect(result.totalMutants).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
  });
});
