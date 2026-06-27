import { describe, it, expect } from 'vitest';
import { enrichGroup, MUTATOR_SEMANTICS } from '../enrich.js';

const SRC = [
  'function clamp(a, b) {', // 1
  '  // upper bound', // 2
  '  if (a > b) return b;', // 3
  '  return a;', // 4
  '}', // 5
];

describe('enrichGroup', () => {
  it('selects the highest-severity mutator on the line', () => {
    const e = enrichGroup({
      line: 3,
      mutators: { StringLiteral: 1, EqualityOperator: 1 }, // low + high → high wins
      projectType: 'typescript',
      sourceLines: SRC,
    });
    expect(e.severity).toBe('high');
    expect(e.why).toBe(MUTATOR_SEMANTICS.EqualityOperator.why);
    expect(e.hint).toBe(MUTATOR_SEMANTICS.EqualityOperator.hint);
  });

  it('keeps the highest severity even when the high mutator is listed first', () => {
    // Order-independence: with the high mutator FIRST, a lower one must not
    // overwrite it. Guards the `rank > best.rank` comparison against being
    // forced always-true (which would let the last-iterated mutator win).
    const e = enrichGroup({
      line: 3,
      mutators: { EqualityOperator: 1, StringLiteral: 1 }, // high listed before low
      projectType: 'typescript',
      sourceLines: SRC,
    });
    expect(e.severity).toBe('high');
    expect(e.why).toBe(MUTATOR_SEMANTICS.EqualityOperator.why);
  });

  it('keeps the first-seen mutator when two share the top severity (strict >)', () => {
    // ConditionalExpression and EqualityOperator are both high. The selector
    // uses strict `>`, so the FIRST-listed wins the tie; a `>=` mutant would
    // switch to the second and change the why/hint.
    const e = enrichGroup({
      line: 3,
      mutators: { ConditionalExpression: 1, EqualityOperator: 1 },
      projectType: 'typescript',
      sourceLines: SRC,
    });
    expect(e.severity).toBe('high');
    expect(e.why).toBe(MUTATOR_SEMANTICS.ConditionalExpression.why);
    expect(e.hint).toBe(MUTATOR_SEMANTICS.ConditionalExpression.hint);
  });

  it('builds a line-numbered context window clamped to the file', () => {
    const e = enrichGroup({
      line: 3,
      mutators: { EqualityOperator: 1 },
      projectType: 'typescript',
      sourceLines: SRC,
    });
    expect(e.context).toEqual([
      '1: function clamp(a, b) {',
      '2:   // upper bound',
      '3:   if (a > b) return b;',
      '4:   return a;',
      '5: }',
    ]);
  });

  it('clamps the window at the first line', () => {
    const e = enrichGroup({
      line: 1,
      mutators: { EqualityOperator: 1 },
      projectType: 'typescript',
      sourceLines: SRC,
    });
    expect(e.context).toEqual([
      '1: function clamp(a, b) {',
      '2:   // upper bound',
      '3:   if (a > b) return b;',
    ]);
  });

  it('falls back to unknown severity + generic copy for coarse engines', () => {
    const e = enrichGroup({
      line: 3,
      mutators: { 'Go Mutation Operator': 1 },
      projectType: 'go',
      sourceLines: SRC,
    });
    expect(e.severity).toBe('unknown');
    expect(e.why).toContain("doesn't expose the operator type");
  });

  it('omits context when sourceLines is absent', () => {
    const e = enrichGroup({
      line: 3,
      mutators: { EqualityOperator: 1 },
      projectType: 'typescript',
    });
    expect(e.context).toBeUndefined();
    expect(e.severity).toBe('high');
  });

  it('omits context when line is out of range', () => {
    const e = enrichGroup({
      line: 99,
      mutators: { EqualityOperator: 1 },
      projectType: 'typescript',
      sourceLines: SRC,
    });
    expect(e.context).toBeUndefined();
  });

  it('omits context when line is below 1', () => {
    // Guards the `line < 1` lower-bound check; line 0 must yield no window,
    // not a window anchored off the top of the file.
    const e = enrichGroup({
      line: 0,
      mutators: { EqualityOperator: 1 },
      projectType: 'typescript',
      sourceLines: SRC,
    });
    expect(e.context).toBeUndefined();
  });

  it('includes context for the last line (upper-bound boundary)', () => {
    // line === sourceLines.length is in range. Guards the `>` upper-bound
    // check against a `>=` mutant that would drop the final line.
    const e = enrichGroup({
      line: 5, // SRC has exactly 5 lines
      mutators: { EqualityOperator: 1 },
      projectType: 'typescript',
      sourceLines: SRC,
    });
    expect(e.context).toEqual(['3:   if (a > b) return b;', '4:   return a;', '5: }']);
  });

  it('uses Rust change text to classify', () => {
    const e = enrichGroup({
      line: 3,
      mutators: { 'replace > with': 1 },
      changes: ['replace > with >='],
      projectType: 'rust',
      sourceLines: SRC,
    });
    expect(e.severity).toBe('high');
    expect(e.why).toBe(MUTATOR_SEMANTICS.EqualityOperator.why);
  });
});
