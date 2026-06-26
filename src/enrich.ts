/**
 * Deterministic survivor-enrichment knowledge.
 *
 * The MCP server is NOT an LLM: all "intelligence" here is a static mapping from
 * a mutator's canonical category to (severity, why-it-matters, kill-hint). The
 * calling agent does the creative test-writing; this module hands it structured
 * context. Keyed by canonical category so the strings are stable and testable.
 */
import type { SupportedProjectType } from './engines/registry.js';

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

/** Copy used when a mutant's category can't be classified (coarse engines). */
export const UNKNOWN_SEMANTIC = {
  why: "a mutant survived here but this language's mutation tool doesn't expose the operator type, so its risk can't be classified.",
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
    why: 'an arrow function body was replaced (e.g. with a constant); a callback\'s logic is untested.',
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
 * Normalize an engine-specific mutator into a canonical category present in
 * {@link MUTATOR_SEMANTICS}, or `'unknown'`.
 *
 * - TypeScript: StrykerJS names ARE canonical — direct table lookup.
 * - Rust: infer from `changeText` (cargo-mutants packs the operator there).
 * - Go / Python: coarse labels with no per-mutant operator — always `'unknown'`.
 */
export function canonicalizeMutator(
  rawMutator: string,
  projectType: SupportedProjectType,
  changeText?: string,
): string {
  if (projectType === 'typescript') {
    return rawMutator in MUTATOR_SEMANTICS ? rawMutator : 'unknown';
  }
  if (projectType === 'rust' && changeText) {
    for (const rule of RUST_DESCRIPTION_RULES) {
      if (rule.test.test(changeText)) return rule.category;
    }
  }
  return 'unknown';
}

// Referenced by later tasks (kept here to centralize the type import).
export type { SupportedProjectType };
