/**
 * Decoding cargo-mutants' change descriptions into canonical mutator categories.
 *
 * Pure and self-contained: it knows only cargo-mutants' wire vocabulary and the
 * canonical category NAMES (the Stryker-derived vocabulary that enrich.ts owns).
 * It deliberately does not import that table — `engines/` sits below the domain
 * layer (`engines-below-domain` in knossos.json), and the caller re-checks every
 * returned name against it anyway.
 */

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
 * Infer a canonical category from a cargo-mutants mutant.
 *
 * cargo-mutants exposes NO operator field, so `changeText` — the change
 * description — is the only operator evidence there is; a mutant with no
 * description degrades to `'unknown'` rather than crashing. The caller must pass
 * the COMPLETE set of change strings joined together, not a display-capped one,
 * or an operator that appears only in a dropped entry cannot be classified.
 */
export function canonicalizeRustMutator(_rawMutator: string, changeText?: string): string {
  if (!changeText) return 'unknown';
  // Strip the cargo-mutants `->` arrow (e.g. "replace get_name -> String with …")
  // before operator matching so the `-` and `>` in the arrow cannot spuriously
  // trigger the ArithmeticOperator or EqualityOperator rules. The replacement is
  // a SPACE, not nothing: fusing the return type onto the preceding identifier
  // (`get_flag->true` → `get_flagtrue`) breaks the `\btrue\b` word boundary and
  // silently downgrades a boolean-literal mutant to `'unknown'`.
  const normalizedText = changeText.replace(/->/g, ' ');
  for (const rule of RUST_DESCRIPTION_RULES) {
    if (rule.test.test(normalizedText)) return rule.category;
  }
  return 'unknown';
}
