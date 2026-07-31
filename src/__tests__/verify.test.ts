import { describe, it, expect } from 'vitest';
import {
  parseBaseline,
  baselineLines,
  computeVerifyDelta,
  buildVerifyNote,
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

  /**
   * A baseline is not always a value this process produced: one form arrives as
   * a raw `baseline` tool argument, another is read back from the on-disk run
   * cache. A null element used to be dereferenced, throwing a TypeError out of
   * `computeScope` that the handler reported as "Chaos Engine Halted: Cannot
   * read properties of null" — an internal crash where the caller should have
   * seen the ordinary "not found or expired" / bad-argument error (audit M10).
   */
  it('skips a null group instead of throwing', () => {
    const b = {
      survivors: [null, { line: 4, mutators: { M: 1 } }],
      noCoverage: [undefined],
    } as unknown as Parameters<typeof parseBaseline>[0];
    expect(parseBaseline(b)).toEqual([{ line: 4, mutator: 'M' }]);
  });

  it('skips a group with no usable line number', () => {
    // Otherwise the mutant is keyed "undefined M" and silently corrupts the delta.
    const b = {
      survivors: [{ mutators: { M: 1 } }, { line: '9', mutators: { M: 1 } }],
    } as unknown as Parameters<typeof parseBaseline>[0];
    expect(parseBaseline(b)).toEqual([]);
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

  it('counts a re-run survivor on a NON-baseline line, with no engine exemption', () => {
    // This test previously asserted the opposite — that an out-of-baseline
    // survivor is dropped for StrykerJS — on the grounds that "the re-run is
    // scoped to baseline lines, so an out-of-baseline survivor cannot occur".
    // The scoping that premise rested on was one single-line range per baseline
    // line, and Stryker only generates a mutant whose ENTIRE span fits the
    // range, so multi-line mutants were never re-tested and came back reported
    // as `nowKilled`. Verify now re-runs whole-file on every engine, so an
    // out-of-baseline survivor CAN occur and is a real regression.
    const delta = computeVerifyDelta(baseline, result([{ line: 999, mutator: 'X' }]));
    expect(delta.newSurvivors).toEqual([{ line: 999, mutator: 'X' }]);
    expect(delta.nowKilled).toEqual([
      { line: 42, mutator: 'ConditionalExpression' },
      { line: 88, mutator: 'ArithmeticOperator' },
    ]);
  });

  it('includes a new survivor ON a baseline line', () => {
    // A fresh survivor whose (line, mutator) key is NEW but whose LINE is in the
    // baseline is a regression on a re-tested line and must be counted. Held
    // before and after the line-scope exemption was removed.
    const delta = computeVerifyDelta(baseline, result([{ line: 42, mutator: 'BooleanLiteral' }]));
    expect(delta.newSurvivors).toEqual([{ line: 42, mutator: 'BooleanLiteral' }]);
  });

  it('counts re-run survivors on non-baseline lines as newSurvivors for whole-file engines (H1)', () => {
    // engineSupportsLineScope=false (cosmic-ray/cargo-mutants/Infection, and the
    // default): the whole file is re-run, so a regression the fix introduces on a
    // line outside the baseline is a real new survivor and MUST be reported.
    const delta = computeVerifyDelta(baseline, result([{ line: 999, mutator: 'X' }]));
    expect(delta.newSurvivors).toEqual([{ line: 999, mutator: 'X' }]);
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
    // Pin each concatenated fragment of the note (kills StringLiteral→"" mutants).
    expect(json.note).toContain('previously-uncaught mutants are now killed');
    expect(json.note).toContain('stillSurviving: add or strengthen tests for these.');
    expect(json.note).toContain('newSurvivors: your change introduced these uncaught mutants');
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
    expect(text).toContain('All 1 previously-uncaught mutants are now killed.');
    // The report header and success line are joined by '\n' (kills join('\n')→join('')).
    expect(text).toBe(
      'Chaos-MCP Verify Report: src/x.ts\nAll 1 previously-uncaught mutants are now killed.',
    );
  });

  it('lists still-surviving and new mutants when present', () => {
    const delta = computeVerifyDelta(
      parseBaseline({ survivors: [{ line: 88, mutators: { A: 1 } }] }),
      result([{ line: 88, mutator: 'A' }]),
    );
    const text = formatVerifyResultAsText('src/x.ts', delta);
    expect(text).toContain('Still surviving:');
    expect(text).toContain('  88: A');
    // Pin the summary line fragments (kills StringLiteral→"" on lines 108-109).
    expect(text).toContain('0 of 1 previously-uncaught mutants now killed; ');
    expect(text).toContain('1 still surviving; 0 new.');
    // Sections are newline-joined (kills join('\n')→join('') on line 123).
    expect(text.split('\n')).toContain('Still surviving:');
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
    expect(text).not.toContain('All 1 previously-uncaught mutants are now killed.');
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

describe('buildVerifyNote', () => {
  /** Four deliberately distinct counts so a swapped field cannot read as correct. */
  const delta = {
    baselineTotal: 5,
    nowKilled: [
      { line: 1, mutator: 'A' },
      { line: 2, mutator: 'B' },
    ],
    stillSurviving: [
      { line: 3, mutator: 'C' },
      { line: 4, mutator: 'D' },
      { line: 5, mutator: 'E' },
    ],
    newSurvivors: [{ line: 6, mutator: 'F' }],
  };

  it('reports each count against the field it belongs to', () => {
    expect(buildVerifyNote(delta)).toBe(
      '2 of 5 previously-uncaught mutants are now killed; 3 still surviving; 1 new. ' +
        'stillSurviving: add or strengthen tests for these. ' +
        'newSurvivors: your change introduced these uncaught mutants on the same lines.',
    );
  });

  it('renders zeroes rather than omitting a section when the delta is empty', () => {
    expect(
      buildVerifyNote({
        baselineTotal: 0,
        nowKilled: [],
        stillSurviving: [],
        newSurvivors: [],
      }),
    ).toContain('0 of 0 previously-uncaught mutants are now killed; 0 still surviving; 0 new.');
  });

  it('is the same note the JSON and text renderers carry', () => {
    // The note is built once and reused; a renderer that reworded its own copy
    // would drift from this contract silently.
    const built = buildVerifyNote(delta);
    const json = JSON.parse(formatVerifyResultAsJson('src/x.ts', delta)) as { note: string };
    expect(json.note).toBe(built);
  });
});
