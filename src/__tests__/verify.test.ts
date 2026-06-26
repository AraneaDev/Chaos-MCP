import { describe, it, expect } from 'vitest';
import {
  parseBaseline,
  baselineLines,
  computeVerifyDelta,
  formatVerifyResultAsJson,
  formatVerifyResultAsText,
} from '../verify.js';
import type { MutationResult } from '../engines/base.js';

const result = (vulns: { line: number; mutator: string }[]): MutationResult => ({
  target: 'src/x.ts',
  totalMutants: 10,
  killed: 8,
  survived: vulns.length,
  mutationScore: '80.00%',
  vulnerabilities: vulns.map((v) => ({ ...v, description: 'survived' })),
});

describe('parseBaseline', () => {
  it('flattens survivors + noCoverage into deduped (line, mutator) keys', () => {
    expect(
      parseBaseline({
        survivors: [{ line: 42, mutators: { ConditionalExpression: 1, BooleanLiteral: 2 } }],
        noCoverage: [{ line: 88, mutators: { ArithmeticOperator: 1 } }],
      }),
    ).toEqual([
      { line: 42, mutator: 'BooleanLiteral' },
      { line: 42, mutator: 'ConditionalExpression' },
      { line: 88, mutator: 'ArithmeticOperator' },
    ]);
  });

  it('dedupes the same (line, mutator) appearing in both arrays', () => {
    expect(
      parseBaseline({
        survivors: [{ line: 5, mutators: { M: 1 } }],
        noCoverage: [{ line: 5, mutators: { M: 1 } }],
      }),
    ).toEqual([{ line: 5, mutator: 'M' }]);
  });

  it('returns empty for an empty baseline', () => {
    expect(parseBaseline({})).toEqual([]);
  });
});

describe('baselineLines', () => {
  it('returns unique sorted line numbers', () => {
    expect(
      baselineLines([
        { line: 88, mutator: 'A' },
        { line: 42, mutator: 'B' },
        { line: 42, mutator: 'C' },
      ]),
    ).toEqual([42, 88]);
  });
});

describe('computeVerifyDelta', () => {
  const baseline = parseBaseline({
    survivors: [{ line: 42, mutators: { ConditionalExpression: 1 } }],
    noCoverage: [{ line: 88, mutators: { ArithmeticOperator: 1 } }],
  });

  it('classifies nowKilled, stillSurviving, and newSurvivors', () => {
    const delta = computeVerifyDelta(
      baseline,
      result([
        { line: 88, mutator: 'ArithmeticOperator' },
        { line: 42, mutator: 'BooleanLiteral' },
      ]),
    );
    expect(delta.baselineTotal).toBe(2);
    expect(delta.nowKilled).toEqual([{ line: 42, mutator: 'ConditionalExpression' }]);
    expect(delta.stillSurviving).toEqual([{ line: 88, mutator: 'ArithmeticOperator' }]);
    expect(delta.newSurvivors).toEqual([{ line: 42, mutator: 'BooleanLiteral' }]);
  });

  it('excludes re-run survivors on non-baseline lines from newSurvivors', () => {
    const delta = computeVerifyDelta(baseline, result([{ line: 999, mutator: 'X' }]));
    expect(delta.newSurvivors).toEqual([]);
    expect(delta.nowKilled).toEqual([
      { line: 42, mutator: 'ConditionalExpression' },
      { line: 88, mutator: 'ArithmeticOperator' },
    ]);
  });

  it('reports all killed when the re-run has no baseline survivors', () => {
    const delta = computeVerifyDelta(baseline, result([]));
    expect(delta.nowKilled).toHaveLength(2);
    expect(delta.stillSurviving).toEqual([]);
  });

  it('deduplicates non-baseline entries on a baseline line in newSurvivors', () => {
    // If the dedup guard is removed, the duplicate Z would appear twice in newSurvivors.
    const delta = computeVerifyDelta(
      parseBaseline({ survivors: [{ line: 5, mutators: { M: 1 } }] }),
      result([
        { line: 5, mutator: 'Z' },
        { line: 5, mutator: 'Z' }, // duplicate – must be deduped
      ]),
    );
    expect(delta.newSurvivors).toHaveLength(1);
    expect(delta.newSurvivors[0]).toEqual({ line: 5, mutator: 'Z' });
  });
});

describe('formatVerifyResultAsJson', () => {
  it('emits the verify shape with mode and killedCount', () => {
    const delta = computeVerifyDelta(
      parseBaseline({ survivors: [{ line: 42, mutators: { C: 1 } }] }),
      result([]),
    );
    const json = JSON.parse(formatVerifyResultAsJson('src/x.ts', delta));
    expect(json.mode).toBe('verify');
    expect(json.target).toBe('src/x.ts');
    expect(json.baselineTotal).toBe(1);
    expect(json.killedCount).toBe(1);
    expect(json.nowKilled).toEqual([{ line: 42, mutator: 'C' }]);
    expect(json.stillSurviving).toEqual([]);
    expect(json.newSurvivors).toEqual([]);
  });

  it('includes an explanatory note string', () => {
    const delta = computeVerifyDelta(
      parseBaseline({ survivors: [{ line: 1, mutators: { A: 1 } }] }),
      result([{ line: 1, mutator: 'A' }]),
    );
    const json = JSON.parse(formatVerifyResultAsJson('src/x.ts', delta));
    expect(typeof json.note).toBe('string');
    expect(json.note).toContain('still surviving');
  });
});

describe('formatVerifyResultAsText', () => {
  it('leads with a success line when nothing still survives and no regressions', () => {
    const delta = computeVerifyDelta(
      parseBaseline({ survivors: [{ line: 42, mutators: { C: 1 } }] }),
      result([]),
    );
    const text = formatVerifyResultAsText('src/x.ts', delta);
    expect(text).toContain('Chaos-MCP Verify Report: src/x.ts');
    expect(text).toContain('✅ All 1 previously-uncaught mutants are now killed.');
  });

  it('lists still-surviving and new mutants when present', () => {
    const delta = computeVerifyDelta(
      parseBaseline({ survivors: [{ line: 88, mutators: { A: 1 } }] }),
      result([{ line: 88, mutator: 'A' }]),
    );
    const text = formatVerifyResultAsText('src/x.ts', delta);
    expect(text).toContain('Still surviving:');
    expect(text).toContain('  88: A');
  });

  it('lists Now killed and New survivors sections when both are present', () => {
    // baseline: {10:A, 10:B}; re-run: {10:B (still), 10:C (new on baseline line 10)} → A killed.
    const delta = computeVerifyDelta(
      parseBaseline({ survivors: [{ line: 10, mutators: { A: 1, B: 1 } }] }),
      result([
        { line: 10, mutator: 'B' },
        { line: 10, mutator: 'C' },
      ]),
    );
    const text = formatVerifyResultAsText('src/x.ts', delta);
    expect(text).toContain('Now killed:');
    expect(text).toContain('  10: A');
    expect(text).toContain('New survivors (regressions on baseline lines):');
    expect(text).toContain('  10: C');
  });

  it('does NOT show success when newSurvivors is non-empty even if stillSurviving is empty', () => {
    // Kills the `&&`→`||` (or `newSurvivors.length===0`→`true`) mutation on the early-return guard.
    // baseline=[A], rerun=[B on line 1] → nowKilled=[A], stillSurviving=[], newSurvivors=[B]
    const delta = computeVerifyDelta(
      parseBaseline({ survivors: [{ line: 1, mutators: { A: 1 } }] }),
      result([{ line: 1, mutator: 'B' }]),
    );
    const text = formatVerifyResultAsText('src/x.ts', delta);
    expect(text).not.toContain('✅ All');
    expect(text).toContain('New survivors (regressions on baseline lines):');
  });

  it('omits "Now killed:" and "New survivors" sections when those counts are zero', () => {
    // baseline=[A], rerun=[A] → nowKilled=[], stillSurviving=[A], newSurvivors=[]
    const delta = computeVerifyDelta(
      parseBaseline({ survivors: [{ line: 5, mutators: { A: 1 } }] }),
      result([{ line: 5, mutator: 'A' }]),
    );
    const text = formatVerifyResultAsText('src/x.ts', delta);
    expect(text).not.toContain('Now killed:');
    expect(text).not.toContain('New survivors');
    expect(text).toContain('Still surviving:');
  });

  it('omits "Still surviving:" section when stillSurviving is empty', () => {
    // baseline=[A], rerun=[B on line 1] → nowKilled=[A], stillSurviving=[], newSurvivors=[B]
    const delta = computeVerifyDelta(
      parseBaseline({ survivors: [{ line: 1, mutators: { A: 1 } }] }),
      result([{ line: 1, mutator: 'B' }]),
    );
    const text = formatVerifyResultAsText('src/x.ts', delta);
    expect(text).not.toContain('Still surviving:');
    expect(text).toContain('Now killed:');
    expect(text).toContain('New survivors (regressions on baseline lines):');
  });
});
