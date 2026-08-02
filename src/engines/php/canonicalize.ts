/**
 * Decoding Infection's mutator names into canonical mutator categories.
 *
 * Pure and self-contained: it knows only Infection's wire vocabulary and the
 * canonical category NAMES (the Stryker-derived vocabulary that enrich.ts owns).
 * It deliberately does not import that table — `engines/` sits below the domain
 * layer (`engines-below-domain` in knossos.json), and the caller re-checks every
 * returned name against it anyway.
 */

/**
 * Map an Infection (PHP) mutator NAME onto a canonical category.
 *
 * WHY this table exists: Infection reports its real operator name for every
 * mutant (`mutator.mutatorName` in the JSON log — see `../php.ts`, which stores
 * it verbatim), but the consumer's `canonicalizeMutator` had no PHP branch at
 * all. Every PHP mutant therefore fell through to `'unknown'`: no severity, no
 * why, no hint, `worstSeverity` unset, and a `severityFloor` of `medium`/`high`
 * silently filtered out 100% of groups because rank 0 is below every floor. The
 * payload meanwhile claimed enrichment had run (audit: PHP severities all
 * `unknown`). That gap is the reason this table now lives WITH the engine that
 * parses these names, instead of two layers above it.
 *
 * WHY an EXACT-name map rather than the ordered regex list Python uses:
 * cosmic-ray's names are long and compound (`ReplaceComparisonOperator_Lt_LtE`),
 * so substring rules discriminate well. Infection's are short words that nest —
 * `/Equal/` also matches `GreaterThanOrEqualTo` and `NotEqualNotIdentical`,
 * `/Not/` matches `NotIdentical` and `LogicalNot`, `/Array/` matches 50 unrelated
 * `Unwrap*` names. Exact lookup cannot mis-fire that way, and the names are a
 * documented, stable part of Infection's public config surface (users list them
 * in `infection.json5`'s `mutators` key), so pinning them is safe.
 *
 * Source: the mutator reference at https://infection.github.io/guide/mutators.html
 * (Infection 0.27–0.34, the range `../php.ts`'s parser declares support for).
 *
 * Names deliberately LEFT OUT map to nothing meaningful here and stay `'unknown'`
 * rather than being forced into a category whose why/hint would misdescribe them
 * — chiefly `PublicVisibility`/`ProtectedVisibility` (a method-visibility change
 * has no operator analogue in the Stryker-derived vocabulary).
 */
const PHP_MUTATOR_CATEGORIES: Record<string, string> = {
  // --- Conditional boundaries: `>` → `>=` and friends. Exactly Stryker's
  // EqualityOperator, which covers both relational and equality swaps.
  GreaterThan: 'EqualityOperator',
  GreaterThanOrEqualTo: 'EqualityOperator',
  LessThan: 'EqualityOperator',
  LessThanOrEqualTo: 'EqualityOperator',
  // --- Negated conditionals: `==` → `!=`, `===` → `!==`, `>` → `<=` …
  Equal: 'EqualityOperator',
  NotEqual: 'EqualityOperator',
  Identical: 'EqualityOperator',
  NotIdentical: 'EqualityOperator',
  GreaterThanNegotiation: 'EqualityOperator',
  GreaterThanOrEqualToNegotiation: 'EqualityOperator',
  LessThanNegotiation: 'EqualityOperator',
  LessThanOrEqualToNegotiation: 'EqualityOperator',
  // --- Loose/strict comparison swaps (`==` ↔ `===`): same boundary risk.
  EqualIdentical: 'EqualityOperator',
  IdenticalEqual: 'EqualityOperator',
  NotEqualNotIdentical: 'EqualityOperator',
  NotIdenticalNotEqual: 'EqualityOperator',
  // `<=>` with its operands swapped — an ordering comparison, so the boundary
  // advice ("assert at exactly the boundary") is the right hint.
  Spaceship: 'EqualityOperator',

  // --- Combined-condition logic. The *Negation variants rewrite the operands
  // of an `&&`/`||`, so the observable failure is the same: a combined
  // condition whose parts are never made to disagree.
  LogicalAnd: 'LogicalOperator',
  LogicalOr: 'LogicalOperator',
  LogicalLowerAnd: 'LogicalOperator',
  LogicalLowerOr: 'LogicalOperator',
  LogicalAndNegation: 'LogicalOperator',
  LogicalAndAllSubExprNegation: 'LogicalOperator',
  LogicalAndSingleSubExprNegation: 'LogicalOperator',
  LogicalOrNegation: 'LogicalOperator',
  LogicalOrAllSubExprNegation: 'LogicalOperator',
  LogicalOrSingleSubExprNegation: 'LogicalOperator',
  // `!` removed — a polarity change, which is what UnaryOperator describes.
  LogicalNot: 'UnaryOperator',

  // --- Branch conditions forced/inverted wholesale.
  IfNegation: 'ConditionalExpression',
  ElseIfNegation: 'ConditionalExpression',
  Ternary: 'ConditionalExpression',
  InstanceOf_: 'ConditionalExpression',
  // Removing a `match` arm or a shared `case` deletes a branch outright.
  MatchArmRemoval: 'ConditionalExpression',
  SharedCaseRemoval: 'ConditionalExpression',

  // --- Boolean literals (both as expressions and as replaced return values).
  TrueValue: 'BooleanLiteral',
  FalseValue: 'BooleanLiteral',

  // --- Arithmetic / bitwise operator swaps.
  Plus: 'ArithmeticOperator',
  Minus: 'ArithmeticOperator',
  Multiplication: 'ArithmeticOperator',
  Division: 'ArithmeticOperator',
  Modulus: 'ArithmeticOperator',
  Exponentiation: 'ArithmeticOperator',
  BitwiseAnd: 'ArithmeticOperator',
  BitwiseOr: 'ArithmeticOperator',
  BitwiseXor: 'ArithmeticOperator',
  BitwiseNot: 'ArithmeticOperator',
  ShiftLeft: 'ArithmeticOperator',
  ShiftRight: 'ArithmeticOperator',
  // round/floor/ceil interchanged — a numeric-result change, same advice.
  RoundingFamily: 'ArithmeticOperator',
  // Literal-number tweaks: the computed value is wrong and no test pinned it.
  // Matches the Python table, where `NumberReplacer` maps here for the same reason.
  DecrementInteger: 'ArithmeticOperator',
  IncrementInteger: 'ArithmeticOperator',
  OneZeroInteger: 'ArithmeticOperator',
  OneZeroFloat: 'ArithmeticOperator',
  // Sign flips on a returned number — a polarity change, not an operator swap.
  IntegerNegation: 'UnaryOperator',
  FloatNegation: 'UnaryOperator',

  // --- `++` / `--`.
  Increment: 'UpdateOperator',
  Decrement: 'UpdateOperator',

  // --- Compound assignment.
  Assignment: 'AssignmentOperator',
  AssignmentEqual: 'AssignmentOperator',
  PlusEqual: 'AssignmentOperator',
  MinusEqual: 'AssignmentOperator',
  MulEqual: 'AssignmentOperator',
  DivEqual: 'AssignmentOperator',
  ModEqual: 'AssignmentOperator',
  PowEqual: 'AssignmentOperator',
  AssignCoalesce: 'AssignmentOperator',
  AssignmentCoalesce: 'AssignmentOperator',

  // --- Null-safety: `??` operands swapped, `?->` rewritten to `->`.
  Coalesce: 'OptionalChaining',
  NullSafeMethodCall: 'OptionalChaining',
  NullSafePropertyCall: 'OptionalChaining',

  // --- Whole statements / bodies whose observable effect went unasserted.
  // BlockStatement's hint ("assert an observable effect: its return value, a
  // mutation it makes, or a call it performs") is exactly the advice for a
  // dropped return, an emptied loop body, or a deleted catch/finally.
  ReturnRemoval: 'BlockStatement',
  FunctionCall: 'BlockStatement',
  NewObject: 'BlockStatement',
  This: 'BlockStatement',
  YieldValue: 'BlockStatement',
  Yield_: 'BlockStatement',
  Throw_: 'BlockStatement',
  Catch_: 'BlockStatement',
  CatchBlockRemoval: 'BlockStatement',
  Finally_: 'BlockStatement',
  UnwrapFinally: 'BlockStatement',
  Foreach_: 'BlockStatement',
  For_: 'BlockStatement',
  While_: 'BlockStatement',
  DoWhile: 'BlockStatement',
  Break_: 'BlockStatement',
  Continue_: 'BlockStatement',

  // --- Calls whose transformation was replaced/removed.
  FunctionCallRemoval: 'MethodExpression',
  MethodCallRemoval: 'MethodExpression',
  CloneRemoval: 'MethodExpression',
  ArrayFind: 'MethodExpression',
  ArrayFindKey: 'MethodExpression',
  ArrayFirst: 'MethodExpression',
  ArrayLast: 'MethodExpression',
  ArrayAll: 'MethodExpression',
  ArrayAny: 'MethodExpression',
  BCMath: 'MethodExpression',
  MBString: 'MethodExpression',

  // --- Array construction/contents.
  ArrayItem: 'ArrayDeclaration',
  ArrayItemRemoval: 'ArrayDeclaration',
  ArrayOneItem: 'ArrayDeclaration',
  SpreadAssignment: 'ArrayDeclaration',
  SpreadOneItem: 'ArrayDeclaration',
  SpreadRemoval: 'ArrayDeclaration',

  // --- String building. Low severity, matching StringLiteral: a concat change
  // is frequently cosmetic, and the hint ("only worth a test if the string is
  // semantically significant") is the correct triage advice for both.
  Concat: 'StringLiteral',
  ConcatOperandRemoval: 'StringLiteral',
};

/**
 * Prefix families whose members are too numerous to enumerate. Consulted ONLY
 * after {@link PHP_MUTATOR_CATEGORIES} misses, so an exact entry always wins —
 * `UnwrapFinally` is an exception mutator, not one of the ~50 `Unwrap*` string/
 * array-function mutators, and its exact entry is what keeps it out of here.
 * Ordered, like the other rule lists in this family.
 */
const PHP_OPERATOR_RULES: { test: RegExp; category: string }[] = [
  // `str_replace($a, $b, $c)` → `$c`, `array_filter($a)` → `$a`: a transformation
  // was removed and the post-call value went unasserted.
  { test: /^Unwrap/, category: 'MethodExpression' },
  // `(int) $x` → `$x`: a coercion was dropped, same shape of finding.
  { test: /^Cast/, category: 'MethodExpression' },
  // preg_* pattern/flag edits — often equivalent, exactly like Stryker's Regex.
  { test: /^Preg/, category: 'Regex' },
];

/**
 * Map an Infection mutator name onto a canonical category: the exact table
 * first, then the prefix families; unmapped names → `'unknown'`.
 *
 * These rules are authoritative for Infection ONLY and must never be applied to
 * another engine's names — the name spaces collide, and a cross-engine match
 * invents a confident severity out of a coincidence. The registry's per-language
 * dispatch is what keeps them apart.
 *
 * `Object.hasOwn`, not `in`: `'constructor' in PHP_MUTATOR_CATEGORIES` is TRUE
 * through the prototype chain and the lookup then yields a function rather than
 * a category name (audit: prototype-chain lookup).
 */
export function canonicalizePhpMutator(rawMutator: string, _changeText?: string): string {
  if (Object.hasOwn(PHP_MUTATOR_CATEGORIES, rawMutator)) {
    return PHP_MUTATOR_CATEGORIES[rawMutator];
  }
  for (const rule of PHP_OPERATOR_RULES) {
    if (rule.test.test(rawMutator)) return rule.category;
  }
  return 'unknown';
}
