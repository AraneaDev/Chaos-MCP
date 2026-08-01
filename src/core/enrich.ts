/**
 * Deterministic survivor-enrichment knowledge.
 *
 * The MCP server is NOT an LLM: all "intelligence" here is a static mapping from
 * a mutator's canonical category to (severity, why-it-matters, kill-hint). The
 * calling agent does the creative test-writing; this module hands it structured
 * context. Keyed by canonical category so the strings are stable and testable.
 *
 * What this module deliberately does NOT hold: the per-engine vocabularies that
 * decode a tool's raw mutator names. Each of those is versioned against ONE
 * tool's output (the PHP table against Infection 0.27–0.34, the Rust rules
 * against cargo-mutants' change descriptions) and now lives beside that engine,
 * reached through `EngineDescriptor.canonicalizeMutator`.
 */
import type { SupportedProjectType } from '../utils/project-detector.js';
import { ENGINE_REGISTRY } from '../engines/registry.js';

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
 * those three means the name is simply not in that engine's table. Telling a
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
 * Normalize an engine-specific mutator into a canonical category present in
 * {@link MUTATOR_SEMANTICS}, or `'unknown'`.
 *
 * The decoding itself belongs to the engine — each vocabulary is versioned
 * against one tool's output — so this delegates to
 * `EngineDescriptor.canonicalizeMutator` (engines/registry.ts):
 *
 * - TypeScript: StrykerJS names ARE canonical — the identity, then the guard below.
 * - Rust: infer from `changeText` (cargo-mutants packs the operator there).
 * - Python: map the cosmic-ray operator NAME (authoritative).
 * - PHP: map the Infection mutator NAME, then its prefix families.
 *
 * Each language's rules are gated on its own `projectType` and never fall
 * through to another's: the name spaces collide (`TrueValue` is a real Infection
 * mutator that also matches Python's `/True|False|Boolean/i` rule), and a
 * cross-engine match invents a confident severity out of a coincidence. Routing
 * through the registry makes that gating structural rather than a chain of `if`s
 * one language can be left out of — which is precisely how PHP once had no
 * branch at all and reported `unknown` for every mutant.
 *
 * A language with no `canonicalizeMutator` (and any name the engine cannot
 * place) degrades to `'unknown'`: no severity, and {@link UNKNOWN_SEMANTIC}'s
 * why/hint saying so.
 */
export function canonicalizeMutator(
  rawMutator: string,
  projectType: SupportedProjectType,
  changeText?: string,
): string {
  const category =
    ENGINE_REGISTRY[projectType]?.canonicalizeMutator?.(rawMutator, changeText) ?? 'unknown';
  // `Object.hasOwn`, not `in`: `'constructor' in MUTATOR_SEMANTICS` is TRUE
  // through the prototype chain, and the lookup then yields `Object` — an
  // object with no `.severity`, which propagates `undefined` into
  // SEVERITY_RANK and makes the sort comparator return NaN. Only reachable
  // via a custom Stryker mutator plugin so named (TypeScript's translation is
  // the identity), but the same guard is already applied at
  // engines/typescript.ts and utils/config/rules.ts (audit: prototype-chain
  // lookup). It doubles as the contract check on every engine's table: a
  // category that is not in this module's vocabulary is `'unknown'`, which is
  // what lets `engines/` translate without importing this table upward.
  return Object.hasOwn(MUTATOR_SEMANTICS, category) ? category : 'unknown';
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
