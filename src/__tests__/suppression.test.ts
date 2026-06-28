import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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
