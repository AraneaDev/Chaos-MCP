import { describe, it, expect } from 'vitest';
import {
  enrichGroup,
  EQUIVALENT_GUARD_SEMANTIC,
  MUTATOR_SEMANTICS,
  UNKNOWN_SEMANTIC,
} from '../core/enrich.js';

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

  describe('exhaustiveness guards', () => {
    // A `default:` arm narrowed to `never` cannot be reached by any runtime
    // input, so its mutants are equivalent — unkillable without casting past
    // the type system. Telling the caller to "take BOTH arms" sends them after
    // a test that cannot exist; the actionable advice is to suppress.
    const GUARD_SRC = [
      'function baselineCommand(projectType) {', // 1
      '  switch (projectType) {', // 2
      "    case 'rust':", // 3
      "      return { command: 'cargo' };", // 4
      '    default: {', // 5
      '      // Exhaustiveness guard, not a runtime check.', // 6
      '      assertNeverProjectType(projectType);', // 7
      '      return undefined;', // 8
      '    }', // 9
      '  }', // 10
      '}', // 11
    ];

    it('advises suppression for a block opening an assertNever guard', () => {
      const e = enrichGroup({
        line: 5, // `default: {` — the line Stryker attributes both mutants to
        mutators: { ConditionalExpression: 1, BlockStatement: 1 },
        projectType: 'typescript',
        sourceLines: GUARD_SRC,
      });
      expect(e.severity).toBe('low');
      expect(e.why).toBe(EQUIVALENT_GUARD_SEMANTIC.why);
      expect(e.hint).toBe(EQUIVALENT_GUARD_SEMANTIC.hint);
    });

    it('advises suppression on the guard call line itself', () => {
      // The marker is ON this line and it opens no block, so the short-window
      // path has to find it too — not only the brace-walk path.
      const e = enrichGroup({
        line: 7,
        mutators: { MethodExpression: 1 },
        projectType: 'typescript',
        sourceLines: GUARD_SRC,
      });
      expect(e.severity).toBe('low');
      expect(e.why).toBe(EQUIVALENT_GUARD_SEMANTIC.why);
    });

    it('recognises the `: never =` assignment form of the guard', () => {
      const neverSrc = [
        'switch (diff.kind) {', // 1
        '  default: {', // 2
        '    const unhandled: never = diff;', // 3
        '    return unhandled;', // 4
        '  }', // 5
        '}', // 6
      ];
      const e = enrichGroup({
        line: 2,
        mutators: { BlockStatement: 1 },
        projectType: 'typescript',
        sourceLines: neverSrc,
      });
      expect(e.severity).toBe('low');
      expect(e.why).toBe(EQUIVALENT_GUARD_SEMANTIC.why);
    });

    it('leaves an ordinary block with a real test gap at its true severity', () => {
      // The override must not swallow reachable code: no guard marker here, so
      // the EqualityOperator verdict and its test-writing hint stand.
      const e = enrichGroup({
        line: 3,
        mutators: { EqualityOperator: 1 },
        projectType: 'typescript',
        sourceLines: SRC,
      });
      expect(e.severity).toBe('high');
      expect(e.hint).toBe(MUTATOR_SEMANTICS.EqualityOperator.hint);
    });

    it('does not reach past the end of the block for a marker', () => {
      // The guard sits in a LATER, sibling block. A scan that ran to the end of
      // the file (or a fixed line budget) would wrongly clear this real gap.
      const siblingSrc = [
        'switch (kind) {', // 1
        "  case 'a': {", // 2
        '    return compute(kind);', // 3
        '  }', // 4
        '  default: {', // 5
        '    assertNeverProjectType(kind);', // 6
        '  }', // 7
        '}', // 8
      ];
      const e = enrichGroup({
        line: 2, // opens the `case 'a'` block, which closes on line 4
        mutators: { BlockStatement: 1 },
        projectType: 'typescript',
        sourceLines: siblingSrc,
      });
      expect(e.severity).toBe('high');
      expect(e.why).toBe(MUTATOR_SEMANTICS.BlockStatement.why);
    });

    it('still classifies when no source is available to inspect', () => {
      // sourceLines is optional; without it there is nothing to detect and the
      // plain mutator verdict must survive rather than throw.
      const e = enrichGroup({
        line: 5,
        mutators: { BlockStatement: 1 },
        projectType: 'typescript',
      });
      expect(e.severity).toBe('high');
      expect(e.why).toBe(MUTATOR_SEMANTICS.BlockStatement.why);
    });
  });
});

describe('exhaustiveness guards without a brace block', () => {
  // A switch arm needs no `{}`. `default:` followed by statements is the same guard as
  // `default: {`, but the brace-walk never starts, so detection fell through to the
  // own-line-only path and found no marker on the word `default:`. Confirmed live at
  // core/estimate-heuristic.ts:48, which was reported high-severity with the misleading
  // "add tests that take BOTH arms" hint.
  const BARE_SRC = [
    'function noisePattern(family) {', // 1
    '  switch (family) {', // 2
    "    case 'hash':", // 3
    "      parts.push('#');", // 4
    '      break;', // 5
    '    default:', // 6
    '      // Exhaustiveness guard, not a runtime check.', // 7
    '      assertNeverProjectType(family);', // 8
    "      parts.push('//');", // 9
    '      break;', // 10
    '  }', // 11
    '}', // 12
  ];

  it('advises suppression for a brace-less default arm', () => {
    const e = enrichGroup({
      line: 6,
      mutators: { ConditionalExpression: 1 },
      projectType: 'typescript',
      sourceLines: BARE_SRC,
    });

    expect(e.severity).toBe('low');
    expect(e.why).toBe(EQUIVALENT_GUARD_SEMANTIC.why);
  });

  it('does not let a real case arm borrow a guard from a later arm', () => {
    // The scan must stop at the end of THIS arm. `case 'hash':` is reachable code with a
    // real test gap; a scan that ran on to the `default:` below would clear it wrongly.
    const e = enrichGroup({
      line: 3,
      mutators: { ConditionalExpression: 1 },
      projectType: 'typescript',
      sourceLines: BARE_SRC,
    });

    expect(e.severity).toBe('high');
    expect(e.why).toBe(MUTATOR_SEMANTICS.ConditionalExpression.why);
  });
});
