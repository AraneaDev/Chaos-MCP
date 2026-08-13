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
 * Copy for a mutant sitting in an unreachable exhaustiveness guard.
 *
 * A `default:` arm whose subject is narrowed to `never` cannot be entered by any
 * runtime input, so every mutant in it is equivalent: emptying the block or
 * forcing the branch changes nothing observable. The category table would rate
 * those `high` and tell the caller to "take BOTH the true and the false branch",
 * which is advice for a test that cannot be written — the only way in is to cast
 * an invalid value past the type system, defeating the guard the block exists to
 * provide. Found by auditing this server with itself: `core/baseline-timing.ts`
 * scored 98.11% on two such mutants, its only survivors.
 *
 * `low` rather than a fourth severity: `Regex` already uses `low` to mean "often
 * equivalent", and it sorts these below real gaps instead of leading with them.
 */
export const EQUIVALENT_GUARD_SEMANTIC = {
  severity: 'low' as const,
  why: 'this line is inside an exhaustiveness guard whose subject is narrowed to `never`, so no runtime input reaches it; the mutant is equivalent rather than a test gap.',
  hint: 'do not write a test for this — reaching it requires casting an invalid value past the type system. Suppress it as equivalent (`suppress: [{ line, mutator, reason }]`) so it stops counting against the score.',
};

/**
 * Markers that identify an exhaustiveness guard, kept deliberately narrow.
 *
 * Both forms in use here are covered: the helper call
 * (`assertNeverProjectType(x)` in core/) and the never-typed assignment
 * (`const unhandled: never = diff` in audit/scope.ts and triage/audit-one.ts).
 * Generic idioms like `throw new Error('unreachable')` are NOT matched on
 * purpose: a throwing guard can sit on a reachable error path that genuinely
 * should be tested, and advising suppression there would hide a real gap. A
 * missed guard keeps the ordinary (merely unhelpful) advice; a false match
 * actively misleads, so this errs toward missing.
 */
const GUARD_MARKERS = [
  /\bassertNever[A-Za-z0-9_]*\s*\(/,
  /\bassertUnreachable\s*\(/,
  /:\s*never\s*=/,
];

/**
 * Ceiling on the guard scan, so an unbalanced brace (or a `{` inside a string,
 * which this deliberately does not parse) cannot walk the rest of the file.
 */
const GUARD_SCAN_MAX_LINES = 40;

/**
 * A `switch` arm written without braces: `default:` or `case 'x':` alone on the
 * line, with the arm's statements following it.
 */
const SWITCH_ARM_LABEL = /^\s*(?:case\b[^:]*|default)\s*:\s*$/;

/**
 * The end of a brace-less arm. `break`/`return`/`continue`/`throw` close it, and
 * so does the next label or a closing brace — whichever comes first.
 */
const SWITCH_ARM_END = /^\s*(?:break\s*;|return\b|continue\s*;|throw\b|\}|case\b|default\s*:)/;

/** Whether `line` opens, or is, an exhaustiveness guard.
 *
 * Three cases, because Stryker attributes a block mutant to the line that OPENS
 * the block (`default: {`) while other mutants land on the offending line
 * itself:
 *
 * - the line opens a braced block → scan to the matching close, capped.
 * - the line is a brace-less `case`/`default:` label → scan to the end of THAT
 *   arm only. A switch arm needs no braces, and `default:` followed by
 *   statements is the same guard as `default: {` — but the brace walk never
 *   starts, so this case was missed and reported at full severity with advice
 *   for a test that cannot be written (seen at core/estimate-heuristic.ts:48).
 *   The scan stops at the arm's end so a REACHABLE `case` cannot borrow the
 *   guard from a `default:` below it.
 * - neither → only the line itself counts.
 *
 * The last case is intentionally not widened to a window around the line: a
 * neighbouring `default:` arm is often a sibling of the very block being
 * judged, so a symmetric window would clear a real gap sitting next to a guard.
 * A mutant deeper inside a BRACED guard block (say on its `return undefined`)
 * is therefore still not detected — a miss, not a wrong answer.
 */
export function looksLikeExhaustivenessGuard(line: number, sourceLines?: string[]): boolean {
  if (!sourceLines || line < 1 || line > sourceLines.length) return false;
  const hasMarker = (text: string): boolean => GUARD_MARKERS.some((m) => m.test(text));

  const first = sourceLines[line - 1];
  const depthOf = (text: string): number =>
    (text.match(/\{/g)?.length ?? 0) - (text.match(/\}/g)?.length ?? 0);
  const last = Math.min(sourceLines.length, line - 1 + GUARD_SCAN_MAX_LINES);

  if (depthOf(first) <= 0) {
    if (hasMarker(first)) return true;
    if (!SWITCH_ARM_LABEL.test(first)) return false;
    for (let i = line; i < last; i++) {
      const text = sourceLines[i];
      // Marker before terminator: a guard arm ends in `break`/`return` too, and
      // checking the terminator first would stop one line short of the call.
      if (hasMarker(text)) return true;
      if (SWITCH_ARM_END.test(text)) return false;
    }
    return false;
  }

  let depth = 0;
  for (let i = line - 1; i < last; i++) {
    const text = sourceLines[i];
    if (hasMarker(text)) return true;
    depth += depthOf(text);
    if (depth <= 0) return false;
  }
  return false;
}

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
  // ReturnValue and MatchArm are the two categories with no StrykerJS
  // counterpart. Everything else in this table is named after a Stryker mutator
  // because Stryker has the richest vocabulary — but it has no mutator that
  // stubs a whole function, and none that deletes one arm of a match, which are
  // between them a third of everything cargo-mutants generates. Routing those
  // through the nearest Stryker key instead (BlockStatement, ConditionalExpression)
  // was the option not taken: the severity would have been right and the
  // sentence wrong, which is the failure mode this table exists to avoid.
  ReturnValue: {
    severity: 'high',
    why: "the function's whole body was replaced with a fixed value (e.g. `Ok(0)`, `()`, `None`, `Default::default()`) and tests still passed — nothing asserts what this function actually produces or does.",
    hint: 'call the function and assert its result, or the side effect it performs, for an input where the real answer differs from that fixed value.',
  },
  MatchArm: {
    severity: 'high',
    why: 'a `match` arm was deleted, so the values it handled fall through to another arm, and tests still passed — that arm has no case pinning it down.',
    hint: 'add a case whose input selects exactly this arm, and assert the value or branch it produces (not merely that the call succeeded).',
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
 * - Rust: parse the description (cargo-mutants stores it AS the mutator name).
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
   * capped one: an engine whose only operator evidence is the change text
   * cannot classify a mutant whose operator appears solely in the fourth change
   * string if the caller passes a list truncated to three plus a "…N more"
   * sentinel (audit: severity derived from a capped change string). `format.ts`
   * caps for display only, after enriching.
   *
   * SECONDARY evidence, and joined across every mutator on the line, so the
   * same blob reaches each of them. Rust used to be classified from it and the
   * bleed showed: two mutants on one line were categorised from the
   * concatenation of both descriptions. Rust now reads its own per-mutant
   * description out of the mutator name instead (engines/rust/canonicalize.ts);
   * prefer that shape for any engine that can.
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
  // Ahead of the category verdict, and ahead of the `unknown` fallback too: an
  // unreachable guard is equivalent whatever its operator was, so the actionable
  // answer is "suppress" even when the mutator could not be classified.
  if (looksLikeExhaustivenessGuard(input.line, input.sourceLines)) {
    return {
      severity: EQUIVALENT_GUARD_SEMANTIC.severity,
      why: EQUIVALENT_GUARD_SEMANTIC.why,
      hint: EQUIVALENT_GUARD_SEMANTIC.hint,
      context,
    };
  }
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
