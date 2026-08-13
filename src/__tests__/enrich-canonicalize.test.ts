import { describe, it, expect } from 'vitest';
import { canonicalizeMutator, MUTATOR_SEMANTICS } from '../core/enrich.js';
import { canonicalizePhpMutator } from '../engines/php/canonicalize.js';
import { ENGINE_REGISTRY } from '../engines/registry.js';

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

  /**
   * Both links of `ENGINE_REGISTRY[projectType]?.canonicalizeMutator?.(…)`.
   *
   * The documented contract is that a language the registry cannot place
   * degrades to `'unknown'` — no severity, and UNKNOWN_SEMANTIC's why/hint
   * saying so. Every engine registered today defines the translation, so both
   * guards protect a case no existing test could reach: without them enrichment
   * throws a TypeError, and enrichment runs on the reporting path of every audit.
   */
  it('degrades to unknown for a project type the registry does not carry', () => {
    expect(canonicalizeMutator('ConditionalExpression', 'cobol' as never)).toBe('unknown');
  });

  it('degrades to unknown for an engine that has no mutator translation', () => {
    // `canonicalizeMutator` is an OPTIONAL descriptor field; this is the shape a
    // newly-added engine has before its translation table is written.
    const entry = ENGINE_REGISTRY.typescript;
    const original = entry.canonicalizeMutator;
    delete entry.canonicalizeMutator;
    try {
      expect(canonicalizeMutator('ConditionalExpression', 'typescript')).toBe('unknown');
    } finally {
      entry.canonicalizeMutator = original;
    }
  });

  // ── cargo-mutants vocabulary ───────────────────────────────────────────────
  //
  // Every description below is a REAL one, taken from `cargo mutants --list`
  // over a Rust crate (1088 mutants, cargo-mutants 27.1.0). The block this
  // replaced was written against invented strings — `replace a + b with a - b`,
  // `replace get_flag->true with Default::default()` — which cargo-mutants does
  // not emit in any version, so it pinned the behaviour of rules that never met
  // the input they were written for. The real grammar has exactly five shapes,
  // and the classifier reads the mutator NAME, which for cargo-mutants IS the
  // description.

  it('classifies an operator swap by the operator that was in the source', () => {
    const rust = (desc: string) => canonicalizeMutator(desc, 'rust');
    expect(rust('replace == with != in Policy::evaluate_command')).toBe('EqualityOperator');
    expect(rust('replace > with >= in Policy::evaluate_command')).toBe('EqualityOperator');
    expect(rust('replace && with || in Policy::evaluate_command')).toBe('LogicalOperator');
    expect(rust('replace || with && in clean_ident')).toBe('LogicalOperator');
    expect(rust('replace + with * in wildcard_match')).toBe('ArithmeticOperator');
    expect(rust('replace - with / in count_log')).toBe('ArithmeticOperator');
    expect(rust('replace += with -= in tally')).toBe('AssignmentOperator');
    expect(rust('replace ^= with |= in mask')).toBe('AssignmentOperator');
    // Bitwise operators compute a value rather than choose a branch, so they
    // take the arithmetic advice ("assert the exact result") rather than the
    // boundary advice. `^` and `&` must NOT be read as their logical lookalikes.
    expect(rust('replace ^ with | in mask')).toBe('ArithmeticOperator');
    expect(rust('replace & with ^ in mask')).toBe('ArithmeticOperator');
    expect(rust('replace >> with << in shift')).toBe('ArithmeticOperator');
  });

  it('classifies the deletion shapes', () => {
    expect(canonicalizeMutator('delete ! in maybe_send', 'rust')).toBe('UnaryOperator');
    expect(canonicalizeMutator('delete - in offset', 'rust')).toBe('UnaryOperator');
    expect(canonicalizeMutator('delete match arm "rm" | "unlink" in is_flag', 'rust')).toBe(
      'MatchArm',
    );
    expect(
      canonicalizeMutator('delete match arm (Some(true), Some(code)) in dispatch', 'rust'),
    ).toBe('MatchArm');
  });

  it('classifies a match guard forced to a constant as a conditional', () => {
    expect(
      canonicalizeMutator('replace match guard !scan.capped with true in preview_for', 'rust'),
    ).toBe('ConditionalExpression');
    expect(
      canonicalizeMutator('replace match guard !in_double with false in tokenize', 'rust'),
    ).toBe('ConditionalExpression');
  });

  it('classifies a whole-body replacement as ReturnValue, generics and all', () => {
    // THE regression this file exists to pin. Every one of these used to come
    // back `EqualityOperator` — severity high, and a why-sentence about a
    // comparison operator being swapped — because the old rule tested for
    // `[<>]=?` ANYWHERE in the description and a Rust generic is full of angle
    // brackets. Stripping the `->` arrow did not help: the brackets are in the
    // TYPE, not the arrow.
    const rust = (desc: string) => canonicalizeMutator(desc, 'rust');
    expect(rust('replace default_notify_on -> Vec<String> with vec![String::new()]')).toBe(
      'ReturnValue',
    );
    expect(
      rust(
        'replace <impl fmt::Display for Action>::fmt -> fmt::Result with Ok(Default::default())',
      ),
    ).toBe('ReturnValue');
    expect(rust('replace parse_tf_plan -> Option<(u32, u32, u32, Vec<String>)> with None')).toBe(
      'ReturnValue',
    );
    expect(rust('replace test -> anyhow::Result<i32> with Ok(-1)')).toBe('ReturnValue');
    expect(rust('replace is_tty -> bool with true')).toBe('ReturnValue');
    // The `()` return: no arrow in the description at all.
    expect(rust('replace maybe_send with ()')).toBe('ReturnValue');
  });

  it('returns unknown for a description in no known shape', () => {
    // Not a guess: an invented category ships a confident severity and a
    // why-sentence describing a mutation that did not happen.
    expect(canonicalizeMutator('reticulate splines in foo', 'rust')).toBe('unknown');
    expect(canonicalizeMutator('replace with', 'rust')).toBe('unknown');
  });

  it('falls back to changeText when the mutator name is not a description', () => {
    // The mutator name is the primary evidence because it is per-mutant;
    // `changeText` is joined across every mutant on the line. It remains a
    // fallback for a caller that carries the description there instead.
    expect(canonicalizeMutator('replace > with', 'rust', 'replace > with >= in f')).toBe(
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

  it('reads the return type as part of the function path, not as operators', () => {
    // Replaces the old "separates the tokens either side of a stripped arrow"
    // case. There is no arrow strip any more: the shapes are anchored, so the
    // whole `<fn path> -> <type>` half is matched as one span and never scanned
    // for operator characters. The property that matters is unchanged — a
    // return type must not decide the category.
    expect(canonicalizeMutator('replace get_flag -> bool with false', 'rust')).toBe('ReturnValue');
  });

  it('returns unknown for Rust when neither evidence source is a description', () => {
    // A name in no known shape and no changeText must degrade to unknown rather
    // than throw.
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
