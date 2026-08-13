/**
 * Decoding cargo-mutants' mutant descriptions into canonical mutator categories.
 *
 * Pure and self-contained: it knows only cargo-mutants' wire vocabulary and the
 * canonical category NAMES (the Stryker-derived vocabulary that enrich.ts owns).
 * It deliberately does not import that table — `engines/` sits below the domain
 * layer (`engines-below-domain` in knossos.json), and the caller re-checks every
 * returned name against it anyway.
 */

/**
 * One operator token, as cargo-mutants prints it: `>`, `>=`, `&&`, `+=`, `<<`.
 *
 * The character class is the whole point of this module's second revision. The
 * rules used to test for `[<>]=?|==|!=` ANYWHERE in the description, which reads
 * every Rust generic as a comparison: `replace default_notify_on -> Vec<String>
 * with vec![]` was reported as "a comparison/boundary operator was swapped
 * (`>` -> `>=`); assert behavior at exactly the boundary value" — advice for a
 * boundary that does not exist in that mutant. `<impl fmt::Display for
 * Action>::fmt` did the same. Stripping the `->` arrow (the previous fix) does
 * not help, because the angle brackets are in the TYPE, not the arrow.
 *
 * Anchoring is what makes the class safe: an operator swap always prints the
 * bare operators as whole words either side of "with", and no Rust path is
 * spelled entirely in operator characters, so the two shapes cannot collide.
 */
const OPERATOR = String.raw`[-!<>=+*/%&|^]+`;

/**
 * The five shapes cargo-mutants emits, verified against 1088 mutants generated
 * by cargo-mutants 27.1.0 over a real crate (every one of them matched):
 *
 *   replace == with != in Policy::evaluate_command      → binary operator swap
 *   delete ! in maybe_send                              → unary operator removal
 *   delete match arm "rm" | "unlink" in is_flag         → match-arm removal
 *   replace match guard !scan.capped with true in ...   → guard forced constant
 *   replace parse -> Option<u32> with None              → whole-body replacement
 *
 * The first four are specific; the last is the catch-all and MUST be tried last,
 * because its `.+ with .+` also matches the other four.
 *
 * The trailing `in <fn>` is optional on the two `replace` shapes only so that a
 * caller holding a description without it (an older cargo-mutants, a hand-built
 * test string) still classifies. It is never optional in practice.
 */
const BINARY_SWAP = new RegExp(`^replace (${OPERATOR}) with ${OPERATOR}(?: in .+)?$`);
const UNARY_DELETE = new RegExp(`^delete ${OPERATOR} in .+$`);
const MATCH_ARM_DELETE = /^delete match arm .+ in .+$/;
const MATCH_GUARD_REPLACE = /^replace match guard .+ with (?:true|false)(?: in .+)?$/;
const BODY_REPLACE = /^replace .+ with .+$/;

/** `&&` / `||`. Bitwise `&` and `|` are NOT these — see {@link operatorCategory}. */
const LOGICAL_OPERATORS = new Set(['&&', '||']);

/** The six comparisons. Kept as an exact set so `<<` and `<=` cannot be confused. */
const COMPARISON_OPERATORS = new Set(['==', '!=', '<', '<=', '>', '>=']);

/**
 * Category for the operator on the LEFT of "with" — the one that was in the
 * source. The replacement is ignored: what the caller has to test is the
 * behaviour of the operator their code actually contains.
 *
 * Order matters. `==`/`!=`/`<=`/`>=` all end in `=` and would otherwise be read
 * as compound assignments, so comparisons are settled before the `=` suffix
 * test. Bitwise operators (`&`, `|`, `^`, `<<`, `>>`) fall through to
 * `ArithmeticOperator`: they compute a value rather than choose a branch, which
 * is what that category's why/hint tell the caller to assert.
 */
function operatorCategory(operator: string): string {
  if (LOGICAL_OPERATORS.has(operator)) return 'LogicalOperator';
  if (COMPARISON_OPERATORS.has(operator)) return 'EqualityOperator';
  if (operator.endsWith('=')) return 'AssignmentOperator';
  return 'ArithmeticOperator';
}

/**
 * Classify ONE cargo-mutants description, or `undefined` when it is not one.
 *
 * `undefined` rather than `'unknown'` so {@link canonicalizeRustMutator} can
 * tell "this string is not a description" from "this description has no
 * category", and only fall back to its second evidence source for the former.
 */
function classifyDescription(description: string): string | undefined {
  // A leading `→ ` is stripped because the secondary evidence source is a
  // RENDERED change string, and `changeOf` prefixes a one-sided change with the
  // arrow (`"→ replace foo with bar"`). Only at the start, and only that arrow:
  // an arrow inside the text belongs to a two-sided change, which is not a
  // cargo-mutants description at all.
  const text = description.trim().replace(/^→\s*/, '');

  const swap = BINARY_SWAP.exec(text);
  if (swap) return operatorCategory(swap[1]);
  // Before UNARY_DELETE only for readability — `match` is not an operator token,
  // so the two cannot match the same string in either order.
  if (MATCH_ARM_DELETE.test(text)) return 'MatchArm';
  if (UNARY_DELETE.test(text)) return 'UnaryOperator';
  // A guard forced to a constant is precisely Stryker's ConditionalExpression:
  // the arm is now taken always or never, and a test passed either way.
  if (MATCH_GUARD_REPLACE.test(text)) return 'ConditionalExpression';
  if (BODY_REPLACE.test(text)) return 'ReturnValue';
  return undefined;
}

/**
 * Infer a canonical category for one cargo-mutants mutant.
 *
 * `rawMutator` is the primary evidence and in production the only one:
 * cargo-mutants exposes no operator field, so `engines/rust/report.ts` stores
 * the description ITSELF as the mutator name. That makes the raw name a single,
 * complete, per-mutant description — which is what this needs, and what
 * `changeText` is not: enrich.ts joins every change on a line into one string
 * and hands the same blob to each mutator on it, so a line carrying both
 * `replace + with -` and `replace == with !=` classified both mutants from the
 * concatenation. Reading `rawMutator` makes classification per-mutant.
 *
 * `changeText` remains a fallback for a caller that carries the description
 * there instead (a stored pre-v3.1 report, a test). It is second, not first,
 * precisely because of the joining above.
 *
 * A description in neither place, or in a shape this does not know, degrades to
 * `'unknown'` rather than guessing: an invented category ships a confident
 * severity and a why-sentence describing a mutation that did not happen.
 */
export function canonicalizeRustMutator(rawMutator: string, changeText?: string): string {
  const fromMutator = classifyDescription(rawMutator);
  if (fromMutator !== undefined) return fromMutator;
  if (changeText === undefined) return 'unknown';
  return classifyDescription(changeText) ?? 'unknown';
}
