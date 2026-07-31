/**
 * Deterministic survivor-enrichment knowledge.
 *
 * The MCP server is NOT an LLM: all "intelligence" here is a static mapping from
 * a mutator's canonical category to (severity, why-it-matters, kill-hint). The
 * calling agent does the creative test-writing; this module hands it structured
 * context. Keyed by canonical category so the strings are stable and testable.
 */
import type { SupportedProjectType } from './utils/project-detector.js';

export type Severity = 'high' | 'medium' | 'low' | 'unknown';

export interface MutatorSemantic {
  severity: 'high' | 'medium' | 'low';
  why: string;
  hint: string;
}

export const SEVERITY_RANK: Record<Severity, number> = {
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

/**
 * Copy used when a mutant's category can't be classified.
 *
 * Deliberately says only that the operator could not be MAPPED, not that the
 * tool failed to report one. The old wording ("this language's mutation tool
 * doesn't expose the operator type") is true for cargo-mutants alone — Stryker,
 * cosmic-ray and Infection all report an operator name, and an `unknown` from
 * those three means the name is simply not in this module's tables. Telling a
 * caller their tool is coarse when it is not sends them looking for a different
 * tool instead of reading the line (audit: PHP severities all `unknown` under a
 * factually false note).
 */
export const UNKNOWN_SEMANTIC = {
  why: "a mutant survived here but its operator could not be matched to a known category, so this server can't rank its risk.",
  hint: 'inspect the line and add an assertion pinning down its exact behavior — the value it computes, the branch it takes, or the side effect it performs.',
};

/**
 * Canonical category → semantics. Category names follow StrykerJS's mutator
 * names (the richest engine); other engines normalize onto these keys.
 */
export const MUTATOR_SEMANTICS: Record<string, MutatorSemantic> = {
  ConditionalExpression: {
    severity: 'high',
    why: 'a branch condition was forced to a constant (always-true / always-false); a test passed without exercising both arms.',
    hint: 'add tests that take BOTH the true and the false branch (and the boundary value if the condition is a comparison).',
  },
  EqualityOperator: {
    severity: 'high',
    why: 'a comparison/boundary operator was swapped (e.g. `>` -> `>=`); an off-by-one your tests do not pin down.',
    hint: 'assert behavior at exactly the boundary value, not just clearly-inside or clearly-outside it.',
  },
  ArithmeticOperator: {
    severity: 'high',
    why: 'an arithmetic operator was swapped (e.g. `+` -> `-`); the computed result is wrong but a test did not check the value.',
    hint: 'assert the exact numeric result, not merely that the call ran or returned something truthy.',
  },
  LogicalOperator: {
    severity: 'high',
    why: '`&&` / `||` were swapped; combined-condition logic is untested.',
    hint: 'add a case where the two operands disagree (one true, one false) so the operator choice is observable.',
  },
  UnaryOperator: {
    severity: 'high',
    why: 'a unary operator was changed/removed (e.g. negation flipped); a guard or sign is untested.',
    hint: 'add a case whose outcome depends on the operator being the correct polarity/sign.',
  },
  UpdateOperator: {
    severity: 'high',
    why: '`++` / `--` (or pre/post form) was altered; an increment/decrement step is untested.',
    hint: 'assert the counter/index value after the update, including across the loop boundary.',
  },
  BooleanLiteral: {
    severity: 'high',
    why: 'a boolean literal was flipped; a default or guard polarity is untested.',
    hint: 'add a case that fails if the literal is the wrong polarity.',
  },
  BlockStatement: {
    severity: 'high',
    why: 'a statement block (often a function body or side-effecting block) was emptied and tests still passed — that code may be effectively untested.',
    hint: 'assert an observable effect of the block: its return value, a mutation it makes, or a call it performs.',
  },
  AssignmentOperator: {
    severity: 'medium',
    why: 'a compound assignment (e.g. `+=` -> `-=`) was swapped; the accumulated value is untested.',
    hint: "assert the variable's value after the assignment, not just that it was set.",
  },
  OptionalChaining: {
    severity: 'medium',
    why: 'optional chaining was added/removed; null-safety behavior is untested.',
    hint: 'add a case where the chained value is null/undefined and assert the safe outcome.',
  },
  MethodExpression: {
    severity: 'medium',
    why: 'a method call was replaced/removed (e.g. `.filter` -> identity); a transformation is untested.',
    hint: 'assert the post-call value, choosing input where the method actually changes the result.',
  },
  ArrayDeclaration: {
    severity: 'medium',
    why: 'an array literal was emptied/altered; downstream length or contents are untested.',
    hint: "assert the array's length and elements where they matter.",
  },
  ObjectLiteral: {
    severity: 'medium',
    why: 'an object literal was emptied/altered; a property consumers rely on is untested.',
    hint: 'assert the specific properties consumers read.',
  },
  ArrowFunction: {
    severity: 'medium',
    why: "an arrow function body was replaced (e.g. with a constant); a callback's logic is untested.",
    hint: "assert the callback's effect through the API that invokes it.",
  },
  StringLiteral: {
    severity: 'low',
    why: 'a string literal was changed; often cosmetic, but may be a real key/path/message. Frequently an equivalent (unkillable) mutant.',
    hint: 'only worth a test if the string is semantically significant — a key, enum value, path, or matched message.',
  },
  Regex: {
    severity: 'low',
    why: 'a regex pattern was altered; matching behavior changed but may be cosmetic. Often equivalent.',
    hint: 'if the pattern is significant, add inputs that distinguish the original from the mutated match.',
  },
};

/**
 * Keyword rules for inferring a canonical category from a Rust (cargo-mutants)
 * change description like "replace > with >=". Order matters: logical before
 * equality before arithmetic, so `&&`/`||` aren't shadowed by a stray operator
 * char in the surrounding text.
 */
const RUST_DESCRIPTION_RULES: { test: RegExp; category: string }[] = [
  { test: /&&|\|\|/, category: 'LogicalOperator' },
  { test: /[<>]=?|==|!=/, category: 'EqualityOperator' },
  { test: /\b(true|false)\b/, category: 'BooleanLiteral' },
  { test: /[+\-*/%]/, category: 'ArithmeticOperator' },
];

/**
 * Map a Python (cosmic-ray) operator NAME to a canonical category. cosmic-ray
 * emits authoritative operator names (e.g. `core/ReplaceComparisonOperator_Lt_LtE`,
 * `core/ReplaceBinaryOperator_Add_Sub`), so this is a deterministic name match —
 * far more reliable than inferring from a diff. Order matters: the more specific
 * `BooleanOperator` (and/or) is matched before the generic True/False rule, and
 * `Comparison` before `BinaryOperator`.
 */
const PYTHON_OPERATOR_RULES: { test: RegExp; category: string }[] = [
  { test: /Comparison/i, category: 'EqualityOperator' },
  { test: /BinaryOperator/i, category: 'ArithmeticOperator' },
  { test: /BooleanOperator|AndWith|OrWith/i, category: 'LogicalOperator' },
  { test: /Unary|AddNot|RemoveNot/i, category: 'UnaryOperator' },
  { test: /True|False|Boolean/i, category: 'BooleanLiteral' },
  { test: /Number/i, category: 'ArithmeticOperator' },
  { test: /String/i, category: 'StringLiteral' },
];

/**
 * Map an Infection (PHP) mutator NAME onto a canonical category.
 *
 * WHY this table exists: Infection reports its real operator name for every
 * mutant (`mutator.mutatorName` in the JSON log — see `php.ts`, which stores it
 * verbatim), but `canonicalizeMutator` had no PHP branch at all. Every PHP
 * mutant therefore fell through to `'unknown'`: no severity, no why, no hint,
 * `worstSeverity` unset, and a `severityFloor` of `medium`/`high` silently
 * filtered out 100% of groups because rank 0 is below every floor. The payload
 * meanwhile claimed enrichment had run (audit: PHP severities all `unknown`).
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
 * (Infection 0.27–0.34, the range `php.ts`'s parser declares support for).
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
 * Ordered, like the other rule lists in this module.
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
 * Normalize an engine-specific mutator into a canonical category present in
 * {@link MUTATOR_SEMANTICS}, or `'unknown'`.
 *
 * - TypeScript: StrykerJS names ARE canonical — direct table lookup.
 * - Rust: infer from `changeText` (cargo-mutants packs the operator there).
 * - Python: map the cosmic-ray operator NAME via {@link PYTHON_OPERATOR_RULES}
 *   (authoritative); unmapped operators → `'unknown'`.
 * - PHP: map the Infection mutator NAME via {@link PHP_MUTATOR_CATEGORIES}, then
 *   the {@link PHP_OPERATOR_RULES} prefix families; unmapped → `'unknown'`.
 *
 * Each language's rules are gated on its own `projectType` and never fall
 * through to another's: the name spaces collide (`TrueValue` is a real Infection
 * mutator that also matches Python's `/True|False|Boolean/i` rule), and a
 * cross-engine match invents a confident severity out of a coincidence.
 */
export function canonicalizeMutator(
  rawMutator: string,
  projectType: SupportedProjectType,
  changeText?: string,
): string {
  if (projectType === 'typescript') {
    // `Object.hasOwn`, not `in`: `'constructor' in MUTATOR_SEMANTICS` is TRUE
    // through the prototype chain, and the lookup then yields `Object` — an
    // object with no `.severity`, which propagates `undefined` into
    // SEVERITY_RANK and makes the sort comparator return NaN. Only reachable
    // via a custom Stryker mutator plugin so named, but the same guard is
    // already applied at engines/typescript.ts and utils/config/rules.ts
    // (audit: prototype-chain lookup).
    return Object.hasOwn(MUTATOR_SEMANTICS, rawMutator) ? rawMutator : 'unknown';
  }
  if (projectType === 'php') {
    if (Object.hasOwn(PHP_MUTATOR_CATEGORIES, rawMutator)) {
      return PHP_MUTATOR_CATEGORIES[rawMutator];
    }
    for (const rule of PHP_OPERATOR_RULES) {
      if (rule.test.test(rawMutator)) return rule.category;
    }
  }
  if (projectType === 'rust' && changeText) {
    // Strip the cargo-mutants `->` arrow (e.g. "replace get_name -> String with …")
    // before operator matching so the `-` and `>` in the arrow cannot spuriously
    // trigger the ArithmeticOperator or EqualityOperator rules.
    const normalizedText = changeText.replace(/->/g, ' ');
    for (const rule of RUST_DESCRIPTION_RULES) {
      if (rule.test.test(normalizedText)) return rule.category;
    }
  }
  if (projectType === 'python') {
    for (const rule of PYTHON_OPERATOR_RULES) {
      if (rule.test.test(rawMutator)) return rule.category;
    }
  }
  return 'unknown';
}

// Referenced by later tasks (kept here to centralize the type import).
export type { SupportedProjectType };

export interface Enrichment {
  severity: Severity;
  why: string;
  hint: string;
  context?: string[];
}

export interface EnrichGroupInput {
  line: number;
  mutators: Record<string, number>;
  /**
   * Change strings for this line. Must be the COMPLETE set, not the display-
   * capped one: for Rust this text IS the operator evidence (cargo-mutants
   * exposes no operator field), so a mutant whose `&&` appears only in the
   * fourth change string cannot be classified if the caller passes a list
   * truncated to three plus a "…N more" sentinel (audit: severity derived from
   * a capped change string). `format.ts` caps for display only, after enriching.
   */
  changes?: string[];
  projectType: SupportedProjectType;
  sourceLines?: string[];
}

const CONTEXT_RADIUS = 2;

/** Source window [line-RADIUS, line+RADIUS] clamped to the file, line-numbered. */
function buildContext(line: number, sourceLines?: string[]): string[] | undefined {
  if (!sourceLines || line < 1 || line > sourceLines.length) return undefined;
  const start = Math.max(1, line - CONTEXT_RADIUS);
  const end = Math.min(sourceLines.length, line + CONTEXT_RADIUS);
  const out: string[] = [];
  for (let n = start; n <= end; n++) out.push(`${n}: ${sourceLines[n - 1]}`);
  return out;
}

/** Compute severity + why/hint + context for a single survivor line group. */
export function enrichGroup(input: EnrichGroupInput): Enrichment {
  const changeText = input.changes?.join(' ');
  let best: { category: string; semantic: MutatorSemantic } | undefined;
  for (const rawMutator of Object.keys(input.mutators)) {
    const category = canonicalizeMutator(rawMutator, input.projectType, changeText);
    // `Object.hasOwn` before the read: a category of `'constructor'` (or
    // `'toString'`) resolves through the prototype chain to a truthy value that
    // has no `.severity`, so `!semantic` would not reject it and the group would
    // ship with `severity: undefined` — dropped by JSON.stringify while the
    // outputSchema declares it present (audit: prototype-chain lookup).
    if (!Object.hasOwn(MUTATOR_SEMANTICS, category)) continue;
    const semantic = MUTATOR_SEMANTICS[category];
    if (!best || SEVERITY_RANK[semantic.severity] > SEVERITY_RANK[best.semantic.severity]) {
      best = { category, semantic };
    }
  }

  const context = buildContext(input.line, input.sourceLines);
  if (!best) {
    return { severity: 'unknown', why: UNKNOWN_SEMANTIC.why, hint: UNKNOWN_SEMANTIC.hint, context };
  }
  return {
    severity: best.semantic.severity,
    why: best.semantic.why,
    hint: best.semantic.hint,
    context,
  };
}
