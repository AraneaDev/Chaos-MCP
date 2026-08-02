import { describe, it, expect } from 'vitest';
import { canonicalizeMutator, MUTATOR_SEMANTICS } from '../core/enrich.js';
import { canonicalizePhpMutator } from '../engines/php/canonicalize.js';

describe('canonicalizeMutator', () => {
  it('maps StrykerJS canonical names directly for typescript', () => {
    expect(canonicalizeMutator('ConditionalExpression', 'typescript')).toBe(
      'ConditionalExpression',
    );
    expect(canonicalizeMutator('EqualityOperator', 'typescript')).toBe('EqualityOperator');
    expect(canonicalizeMutator('StringLiteral', 'typescript')).toBe('StringLiteral');
  });

  it('returns unknown for a Stryker name not in the table', () => {
    expect(canonicalizeMutator('SomeFutureMutator', 'typescript')).toBe('unknown');
  });

  it('infers Rust categories from the change description', () => {
    expect(canonicalizeMutator('replace > with', 'rust', 'replace > with >=')).toBe(
      'EqualityOperator',
    );
    expect(canonicalizeMutator('replace add ->', 'rust', 'replace a + b with a - b')).toBe(
      'ArithmeticOperator',
    );
    expect(canonicalizeMutator('replace && with', 'rust', 'replace x && y with x || y')).toBe(
      'LogicalOperator',
    );
    expect(canonicalizeMutator('replace true', 'rust', 'replace true with false')).toBe(
      'BooleanLiteral',
    );
  });

  it('returns unknown for Rust when the description has no recognizable operator', () => {
    expect(canonicalizeMutator('replace foo', 'rust', 'replace foo with Default::default()')).toBe(
      'unknown',
    );
  });

  it('does not misclassify cargo-mutants -> arrow as ArithmeticOperator', () => {
    // The `-` in `->` must not trigger the arithmetic rule.
    expect(
      canonicalizeMutator(
        'replace get_name ->',
        'rust',
        'replace get_name -> String with String::new()',
      ),
    ).toBe('unknown');
  });

  it('classifies a bare < / > (no =) as EqualityOperator', () => {
    // The EqualityOperator rule is /[<>]=?|==|!=/ — the `=` is OPTIONAL, so a
    // relational flip with no `=` must still match. Guards the `=?` quantifier.
    expect(canonicalizeMutator('replace < with >', 'rust', 'replace a < b with a > b')).toBe(
      'EqualityOperator',
    );
  });

  it('does not apply the Rust rules to non-Rust engines even with change text', () => {
    // Python descriptions can contain operator chars, but only Rust packs a
    // reliable per-mutant operator into changeText. The `projectType === 'rust'`
    // guard must hold even when changeText would match a rule.
    expect(canonicalizeMutator('Some Python Mutation', 'python', 'replace && with ||')).toBe(
      'unknown',
    );
  });

  it('does not apply the Python rules to a non-Python engine', () => {
    // The cosmic-ray rules are name-based and only authoritative for cosmic-ray;
    // letting them run for another engine invents a confident category — and its
    // severity — out of a name collision. A cosmic-ray operator name handed to
    // the PHP branch is not an Infection mutator and must stay `unknown` rather
    // than be matched by the Python `/Comparison/i` rule.
    //
    // UPDATED: this case used to assert `canonicalizeMutator('TrueValue', 'php')
    // === 'unknown'` as its cross-engine guard. `TrueValue` is a REAL Infection
    // mutator, and PHP now has its own table that classifies it correctly, so
    // that assertion pinned the very gap this table closed. The guard it was
    // really making — Python's rules must not leak into PHP — is preserved by
    // the cosmic-ray-only name below.
    expect(canonicalizeMutator('ReplaceComparisonOperator_Lt_LtE', 'php')).toBe('unknown');
    expect(canonicalizeMutator('core/ReplaceTrueWithFalse', 'php')).toBe('unknown');
    // Rust with no change text must not fall through to the name rules either.
    expect(canonicalizeMutator('ReplaceBinaryOperator_Add_Sub', 'rust')).toBe('unknown');
  });

  it('does not apply the PHP rules to a non-PHP engine', () => {
    // The mirror of the rule above. `Plus`, `Identical` and `TrueValue` are
    // Infection names; a Python or Rust run that happened to report one must not
    // borrow PHP's table, or a name collision again decides a severity.
    expect(canonicalizeMutator('Plus', 'python')).toBe('unknown');
    expect(canonicalizeMutator('Identical', 'rust')).toBe('unknown');
    expect(canonicalizeMutator('TrueValue', 'typescript')).toBe('unknown');
  });

  it('separates the tokens either side of a stripped Rust arrow', () => {
    // The arrow strip exists so `-` and `>` cannot trigger the arithmetic or
    // equality rules — but it must leave a SEPARATOR behind. Replacing `->`
    // with nothing fuses the return type onto the preceding identifier, so
    // `get_flag->true` becomes `get_flagtrue` and the `\btrue\b` rule stops
    // matching: a boolean-literal mutant is then reported as `unknown`, with no
    // severity and no hint.
    expect(
      canonicalizeMutator(
        'replace get_flag',
        'rust',
        'replace get_flag->true with Default::default()',
      ),
    ).toBe('BooleanLiteral');
  });

  it('returns unknown for Rust when changeText is absent (no throw)', () => {
    // The `&& changeText` guard short-circuits before the .replace() call; a
    // Rust target with no description must degrade to unknown, not crash.
    expect(canonicalizeMutator('replace foo', 'rust', undefined)).toBe('unknown');
  });

  it('returns unknown for Python (coarse engines)', () => {
    expect(canonicalizeMutator('Arithmetic/Logical Mutation', 'python')).toBe('unknown');
  });

  it('only ever returns a table key or unknown', () => {
    const keys = new Set([...Object.keys(MUTATOR_SEMANTICS), 'unknown']);
    expect(keys.has(canonicalizeMutator('ConditionalExpression', 'typescript'))).toBe(true);
  });
});

describe('canonicalizeMutator (python — cosmic-ray operator names)', () => {
  // cosmic-ray emits authoritative operator names; the Python branch maps the
  // NAME directly (no diff inference). Comparison is matched before BinaryOperator,
  // and BooleanOperator (and/or) before the generic True/False rule.
  it('maps a comparison-operator replacement to EqualityOperator', () => {
    expect(canonicalizeMutator('core/ReplaceComparisonOperator_Lt_LtE', 'python')).toBe(
      'EqualityOperator',
    );
  });
  it('maps a binary-operator replacement to ArithmeticOperator', () => {
    expect(canonicalizeMutator('core/ReplaceBinaryOperator_Add_Sub', 'python')).toBe(
      'ArithmeticOperator',
    );
    // bitwise variants live under the same operator family
    expect(canonicalizeMutator('core/ReplaceBinaryOperator_Add_BitOr', 'python')).toBe(
      'ArithmeticOperator',
    );
  });
  it('maps a boolean-operator (and/or) replacement to LogicalOperator', () => {
    expect(canonicalizeMutator('core/ReplaceBooleanOperator_And_Or', 'python')).toBe(
      'LogicalOperator',
    );
  });
  it('maps a unary-operator replacement to UnaryOperator', () => {
    expect(canonicalizeMutator('core/ReplaceUnaryOperator_Not_Nothing', 'python')).toBe(
      'UnaryOperator',
    );
  });
  it('maps True/False replacement to BooleanLiteral (not LogicalOperator)', () => {
    expect(canonicalizeMutator('core/ReplaceTrueWithFalse', 'python')).toBe('BooleanLiteral');
  });
  it('maps NumberReplacer to ArithmeticOperator (a wrong constant is a value bug)', () => {
    expect(canonicalizeMutator('core/NumberReplacer', 'python')).toBe('ArithmeticOperator');
  });
  it('maps a string replacement to StringLiteral', () => {
    expect(canonicalizeMutator('core/StringReplacer', 'python')).toBe('StringLiteral');
  });
  it('returns unknown for an unrecognized cosmic-ray operator', () => {
    expect(canonicalizeMutator('core/ZeroIterationForLoop', 'python')).toBe('unknown');
  });
});

describe('canonicalizeMutator (php — Infection mutator names)', () => {
  // Infection reports its real operator name for every mutant and php.ts stores
  // it verbatim, but canonicalizeMutator had no PHP branch: EVERY PHP mutant
  // came back `unknown`, so `worstSeverity` was never set and a severityFloor of
  // `high` filtered out 100% of groups (rank 0 < 3) while the payload claimed
  // enrichment had run. Names below are from Infection's published mutator
  // reference (https://infection.github.io/guide/mutators.html).
  it('maps the conditional-boundary family to EqualityOperator', () => {
    for (const name of ['GreaterThan', 'GreaterThanOrEqualTo', 'LessThan', 'LessThanOrEqualTo']) {
      expect(canonicalizeMutator(name, 'php')).toBe('EqualityOperator');
    }
  });

  it('maps the negated-conditional and identical/equal families to EqualityOperator', () => {
    for (const name of [
      'Equal',
      'NotEqual',
      'Identical',
      'NotIdentical',
      'EqualIdentical',
      'IdenticalEqual',
      'NotEqualNotIdentical',
      'NotIdenticalNotEqual',
      'GreaterThanNegotiation',
      'LessThanOrEqualToNegotiation',
    ]) {
      expect(canonicalizeMutator(name, 'php')).toBe('EqualityOperator');
    }
  });

  it('maps the logical family to LogicalOperator and `!` removal to UnaryOperator', () => {
    for (const name of [
      'LogicalAnd',
      'LogicalOr',
      'LogicalLowerAnd',
      'LogicalLowerOr',
      'LogicalAndNegation',
      'LogicalOrSingleSubExprNegation',
    ]) {
      expect(canonicalizeMutator(name, 'php')).toBe('LogicalOperator');
    }
    // LogicalNot flips a polarity rather than combining two operands, so it
    // belongs with the unary family — not with `&&`/`||`.
    expect(canonicalizeMutator('LogicalNot', 'php')).toBe('UnaryOperator');
  });

  it('maps the arithmetic family to ArithmeticOperator', () => {
    for (const name of [
      'Plus',
      'Minus',
      'Multiplication',
      'Division',
      'Modulus',
      'Exponentiation',
      'ShiftLeft',
      'BitwiseXor',
      'RoundingFamily',
      'DecrementInteger',
      'OneZeroInteger',
    ]) {
      expect(canonicalizeMutator(name, 'php')).toBe('ArithmeticOperator');
    }
  });

  it('maps boolean literals, `++`/`--` and compound assignment to their own categories', () => {
    expect(canonicalizeMutator('TrueValue', 'php')).toBe('BooleanLiteral');
    expect(canonicalizeMutator('FalseValue', 'php')).toBe('BooleanLiteral');
    expect(canonicalizeMutator('Increment', 'php')).toBe('UpdateOperator');
    expect(canonicalizeMutator('Decrement', 'php')).toBe('UpdateOperator');
    expect(canonicalizeMutator('PlusEqual', 'php')).toBe('AssignmentOperator');
    expect(canonicalizeMutator('AssignCoalesce', 'php')).toBe('AssignmentOperator');
  });

  it('maps branch and block mutators to ConditionalExpression / BlockStatement', () => {
    expect(canonicalizeMutator('IfNegation', 'php')).toBe('ConditionalExpression');
    expect(canonicalizeMutator('Ternary', 'php')).toBe('ConditionalExpression');
    expect(canonicalizeMutator('MatchArmRemoval', 'php')).toBe('ConditionalExpression');
    expect(canonicalizeMutator('ReturnRemoval', 'php')).toBe('BlockStatement');
    expect(canonicalizeMutator('Foreach_', 'php')).toBe('BlockStatement');
    expect(canonicalizeMutator('CatchBlockRemoval', 'php')).toBe('BlockStatement');
  });

  it('maps null-safety mutators to OptionalChaining', () => {
    expect(canonicalizeMutator('Coalesce', 'php')).toBe('OptionalChaining');
    expect(canonicalizeMutator('NullSafeMethodCall', 'php')).toBe('OptionalChaining');
  });

  it('maps the Unwrap/Cast/Preg prefix families without enumerating them', () => {
    // ~50 Unwrap* mutators exist; matching by prefix keeps the table finite.
    expect(canonicalizeMutator('UnwrapArrayFilter', 'php')).toBe('MethodExpression');
    expect(canonicalizeMutator('UnwrapStrToLower', 'php')).toBe('MethodExpression');
    expect(canonicalizeMutator('CastInt', 'php')).toBe('MethodExpression');
    expect(canonicalizeMutator('PregMatchRemoveCaret', 'php')).toBe('Regex');
  });

  it('lets an exact entry beat the prefix families', () => {
    // UnwrapFinally starts with "Unwrap" but is an exception mutator, not one of
    // the string/array unwrappers. Exact lookup must run FIRST, or removing a
    // `finally` block is reported as a removed string transformation.
    expect(canonicalizeMutator('UnwrapFinally', 'php')).toBe('BlockStatement');
  });

  it('returns unknown for a PHP mutator with no canonical equivalent', () => {
    // Visibility changes are deliberately unmapped: no category in
    // MUTATOR_SEMANTICS describes them, and forcing one would attach a why/hint
    // that misdescribes the mutant. `unknown` is the honest answer.
    expect(canonicalizeMutator('PublicVisibility', 'php')).toBe('unknown');
    // php.ts's fallback name when Infection reports no mutatorName at all.
    expect(canonicalizeMutator('PHP Mutation Operator', 'php')).toBe('unknown');
  });

  it('only ever returns a table key or unknown for php', () => {
    const keys = new Set([...Object.keys(MUTATOR_SEMANTICS), 'unknown']);
    for (const name of [
      'GreaterThan',
      'LogicalAnd',
      'TrueValue',
      'Plus',
      'UnwrapTrim',
      'PregQuote',
      'PublicVisibility',
    ]) {
      expect(keys.has(canonicalizeMutator(name, 'php'))).toBe(true);
    }
  });

  it('does not resolve a prototype-chain name to a bogus category', () => {
    // `'constructor' in {}` is true, so an `in`-based lookup would resolve
    // `constructor` to Object — truthy, but with no `.severity`. Object.hasOwn
    // is what keeps it `unknown` (matching engines/typescript.ts's guard).
    expect(canonicalizeMutator('constructor', 'typescript')).toBe('unknown');
    expect(canonicalizeMutator('toString', 'typescript')).toBe('unknown');
    expect(canonicalizeMutator('constructor', 'php')).toBe('unknown');
  });
});

describe('engine vocabulary contract', () => {
  // The Infection mutator names this server claims to support. This list is INPUT data
  // only: the expected category is deliberately not restated, so the test cannot decay
  // into comparing the table against itself (the trap that left enrich.ts:67-68 with
  // unkillable StringLiteral mutants). It asserts the weaker contract that actually
  // matters — every name we claim to handle resolves to a category enrich can rank.
  //
  // Blanking any table value makes canonicalizeMutator fall through to 'unknown', so
  // this one loop kills every StringLiteral mutant in the PHP vocabulary at once.
  const INFECTION_MUTATORS = [
    'GreaterThan',
    'GreaterThanOrEqualTo',
    'LessThan',
    'LessThanOrEqualTo',
    'Equal',
    'NotEqual',
    'Identical',
    'NotIdentical',
    'GreaterThanNegotiation',
    'GreaterThanOrEqualToNegotiation',
    'LessThanNegotiation',
    'LessThanOrEqualToNegotiation',
    'EqualIdentical',
    'IdenticalEqual',
    'NotEqualNotIdentical',
    'NotIdenticalNotEqual',
    'Spaceship',
    'LogicalAnd',
    'LogicalOr',
    'LogicalLowerAnd',
    'LogicalLowerOr',
    'LogicalAndNegation',
    'LogicalAndAllSubExprNegation',
    'LogicalAndSingleSubExprNegation',
    'LogicalOrNegation',
    'LogicalOrAllSubExprNegation',
    'LogicalOrSingleSubExprNegation',
    'LogicalNot',
    'IfNegation',
    'ElseIfNegation',
    'Ternary',
    'InstanceOf_',
    'MatchArmRemoval',
    'SharedCaseRemoval',
    'TrueValue',
    'FalseValue',
    'Plus',
    'Minus',
    'Multiplication',
    'Division',
    'Modulus',
    'Exponentiation',
    'BitwiseAnd',
    'BitwiseOr',
    'BitwiseXor',
    'BitwiseNot',
    'ShiftLeft',
    'ShiftRight',
    'RoundingFamily',
    'DecrementInteger',
    'IncrementInteger',
    'OneZeroInteger',
    'OneZeroFloat',
    'IntegerNegation',
    'FloatNegation',
    'Increment',
    'Decrement',
    'Assignment',
    'AssignmentEqual',
    'PlusEqual',
    'MinusEqual',
    'MulEqual',
    'DivEqual',
    'ModEqual',
    'PowEqual',
    'AssignCoalesce',
    'AssignmentCoalesce',
    'Coalesce',
    'NullSafeMethodCall',
    'NullSafePropertyCall',
    'ReturnRemoval',
    'FunctionCall',
    'NewObject',
    'This',
    'YieldValue',
    'Yield_',
    'Throw_',
    'Catch_',
    'CatchBlockRemoval',
    'Finally_',
    'UnwrapFinally',
    'Foreach_',
    'For_',
    'While_',
    'DoWhile',
    'Break_',
    'Continue_',
    'FunctionCallRemoval',
    'MethodCallRemoval',
    'CloneRemoval',
    'ArrayFind',
    'ArrayFindKey',
    'ArrayFirst',
    'ArrayLast',
    'ArrayAll',
    'ArrayAny',
    'BCMath',
    'MBString',
    'ArrayItem',
    'ArrayItemRemoval',
    'ArrayOneItem',
    'SpreadAssignment',
    'SpreadOneItem',
    'SpreadRemoval',
    'Concat',
    'ConcatOperandRemoval',
  ];

  it('resolves every supported Infection mutator to a rankable category', () => {
    // Collected rather than asserted per-name so a failure lists EVERY offending row at
    // once — and `unknown` is itself absent from MUTATOR_SEMANTICS, so this one check
    // catches both a blanked table value and a name that reaches no rule.
    const unresolved = INFECTION_MUTATORS.map((name) => ({
      name,
      category: canonicalizeMutator(name, 'php'),
    })).filter(({ category }) => !Object.hasOwn(MUTATOR_SEMANTICS, category));

    expect(unresolved).toEqual([]);
  });

  it('covers every row of the PHP vocabulary', () => {
    // Guards the list above against silently falling behind the table it describes.
    expect(INFECTION_MUTATORS.length).toBe(106);
    expect(new Set(INFECTION_MUTATORS).size).toBe(INFECTION_MUTATORS.length);
  });
});

/**
 * The prefix-family fallbacks that catch Infection names absent from the exact table.
 * These names must NOT be in PHP_MUTATOR_CATEGORIES, or they would resolve on the table
 * branch and never reach the rules — which is why the vocabulary loop above cannot cover
 * them, and why the `/^Unwrap/`, `/^Cast/` and `/^Preg/` patterns survived mutation.
 */
describe('PHP prefix-family fallbacks', () => {
  it.each([
    ['UnwrapArrayFilter', 'MethodExpression'],
    ['UnwrapStrReplace', 'MethodExpression'],
    ['CastInt', 'MethodExpression'],
    ['CastString', 'MethodExpression'],
    ['PregQuote', 'Regex'],
    ['PregMatchMatches', 'Regex'],
  ])('routes %s to %s via a prefix rule', (name, expected) => {
    expect(canonicalizeMutator(name, 'php')).toBe(expected);
  });

  it('falls through to unknown for a name matching no table row and no prefix', () => {
    // Asserted on the RAW engine function, not the enrich wrapper. The wrapper maps any
    // category outside MUTATOR_SEMANTICS back to 'unknown' (enrich.ts:179), so blanking
    // this sentinel to '' is invisible through canonicalizeMutator — it would return
    // 'unknown' either way and the mutant would survive the assertion.
    expect(canonicalizePhpMutator('SomeFutureInfectionMutator')).toBe('unknown');
    expect(canonicalizeMutator('SomeFutureInfectionMutator', 'php')).toBe('unknown');
  });
});

describe('PHP prefix rules are anchored to the start of the name', () => {
  // The `^` in /^Unwrap/, /^Cast/ and /^Preg/ is the contract: these are PREFIX
  // families, and without the anchor any name merely CONTAINING the word is swept into
  // the category. A mutation audit reported all three anchors as survivors, which is
  // what these names are for — each contains the word without starting with it, and is
  // absent from the exact table, so it reaches the rules and must fall through.
  it.each([['SpreadUnwrap'], ['ArrayCast'], ['NoPreg']])(
    'leaves %s unknown rather than matching mid-name',
    (name) => {
      expect(canonicalizePhpMutator(name)).toBe('unknown');
    },
  );
});
