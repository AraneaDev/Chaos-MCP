/**
 * Decoding cosmic-ray's operator names into canonical mutator categories.
 *
 * Pure and self-contained: it knows only cosmic-ray's wire vocabulary and the
 * canonical category NAMES (the Stryker-derived vocabulary that enrich.ts owns).
 * It deliberately does not import that table — `engines/` sits below the domain
 * layer (`engines-below-domain` in knossos.json), and the caller re-checks every
 * returned name against it anyway.
 */

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
 * Map a cosmic-ray operator name onto a canonical category; unmapped operators
 * (e.g. `core/ZeroIterationForLoop`) stay `'unknown'` rather than being forced
 * into a category whose why/hint would misdescribe them.
 *
 * These rules are authoritative for cosmic-ray ONLY and must never be applied to
 * another engine's names: `TrueValue` is a real Infection mutator that also
 * matches the `/True|False|Boolean/i` rule here, and a cross-engine match invents
 * a confident severity out of a coincidence. The registry's per-language dispatch
 * is what keeps them apart.
 */
export function canonicalizePythonMutator(rawMutator: string, _changeText?: string): string {
  for (const rule of PYTHON_OPERATOR_RULES) {
    if (rule.test.test(rawMutator)) return rule.category;
  }
  return 'unknown';
}
