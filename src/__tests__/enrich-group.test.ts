import { describe, it, expect } from 'vitest';
import { enrichGroup, MUTATOR_SEMANTICS, UNKNOWN_SEMANTIC } from '../core/enrich.js';

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

  it('joins multiple change strings with a separator, not end to end', () => {
    // The Rust categoriser reads the joined change text, and its rules use word
    // boundaries. Concatenating the entries with no separator fuses the tail of
    // one onto the head of the next — `…with bar` + `true` becomes `bartrue` —
    // and a boolean-literal mutant silently degrades to `unknown`: no severity,
    // no why, no hint for the caller to act on.
    const e = enrichGroup({
      line: 3,
      mutators: { replace_flag: 1 },
      changes: ['replace foo with bar', 'true'],
      projectType: 'rust',
    });
    expect(e.severity).toBe(MUTATOR_SEMANTICS.BooleanLiteral.severity);
    expect(e.why).toBe(MUTATOR_SEMANTICS.BooleanLiteral.why);
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

  it('falls back to unknown severity + generic copy when no operator rule matches', () => {
    const e = enrichGroup({
      line: 3,
      mutators: { 'Unrecognized Python Mutation': 1 },
      projectType: 'python',
      sourceLines: SRC,
    });
    expect(e.severity).toBe('unknown');
    // UPDATED: the copy used to say "this language's mutation tool doesn't
    // expose the operator type". cosmic-ray DOES expose it (this fixture's name
    // is simply not one the table maps), as do Stryker and Infection — only
    // cargo-mutants is genuinely operator-less. The assertion now pins the
    // truthful wording; the behaviour under test (unknown severity + generic
    // copy for an unmatched operator) is unchanged.
    expect(e.why).toContain('could not be matched to a known category');
  });

  it('classifies a PHP group from its Infection mutator name', () => {
    // Every PHP mutant used to fall through to `unknown` — no severity, no
    // why/hint, and a severityFloor that silently hid the whole file.
    const e = enrichGroup({
      line: 3,
      mutators: { GreaterThanOrEqualTo: 1 },
      projectType: 'php',
      sourceLines: SRC,
    });
    expect(e.severity).toBe(MUTATOR_SEMANTICS.EqualityOperator.severity);
    expect(e.why).toBe(MUTATOR_SEMANTICS.EqualityOperator.why);
  });

  it('keeps the highest severity across a mixed PHP group', () => {
    const e = enrichGroup({
      line: 3,
      mutators: { Concat: 1, LogicalAnd: 1 }, // low + high → high wins
      projectType: 'php',
    });
    expect(e.severity).toBe('high');
    expect(e.why).toBe(MUTATOR_SEMANTICS.LogicalOperator.why);
  });

  it('reports unknown for a mutator named after an Object.prototype member', () => {
    // `MUTATOR_SEMANTICS['constructor']` resolves through the prototype chain to
    // `Object` — truthy, so a `!semantic` guard accepts it, and the group then
    // ships `severity: undefined`: SEVERITY_RANK[undefined] is undefined, the
    // sort comparator returns NaN, and JSON.stringify drops severity/why/hint
    // while the outputSchema declares them present. Only reachable via a custom
    // Stryker mutator plugin so named, but the same Object.hasOwn guard is
    // already applied in engines/typescript.ts and utils/config/rules.ts.
    const e = enrichGroup({ line: 3, mutators: { constructor: 1 }, projectType: 'typescript' });
    expect(e.severity).toBe('unknown');
    expect(e.why).toBe(UNKNOWN_SEMANTIC.why);
    expect(JSON.parse(JSON.stringify(e))).toHaveProperty('severity');
  });

  it('still classifies real mutators sharing a group with a prototype-chain name', () => {
    // The guard must `continue`, not abort: a genuine EqualityOperator alongside
    // the bogus name still decides the group.
    const e = enrichGroup({
      line: 3,
      mutators: { toString: 1, EqualityOperator: 1 },
      projectType: 'typescript',
    });
    expect(e.severity).toBe('high');
    expect(e.why).toBe(MUTATOR_SEMANTICS.EqualityOperator.why);
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
