/**
 * The identity of a mutant, independent of where it sits in a file.
 *
 * A suppression used to be identified by `(line, mutator)`. That is positional,
 * so any edit above an entry invalidates it, and it is not unique: one line can
 * carry several mutants of the same mutator. `audit/suppression-io.ts` has a
 * line emitting several `ConditionalExpression` mutants whose replacement is the
 * identical string `true`, differing only in the ORIGINAL span each replaced —
 * which is why identity needs both halves, not just the replacement.
 *
 * This module is a LEAF: it imports one TYPE and nothing else, so both the
 * storage layer (`utils/suppression.ts`, itself a leaf that may not import a
 * domain module) and the domain layer (`audit/apply-suppressions.ts`) can depend
 * on it without forming a cycle.
 */
import type { Vulnerability } from '../engines/base.js';

/**
 * Longest each side of a change string may be.
 *
 * Bounds corpus growth: cosmic-ray reports whole source lines as the original,
 * and Infection reports a unified diff. Two changes differing only past this
 * many characters collide — the resolver treats a collision as ambiguity and
 * refuses, so the cap costs precision, never correctness.
 */
export const CHANGE_SIDE_CAP = 120;

/**
 * Collapse whitespace runs to single spaces, trim, and cap.
 *
 * Same normalisation rule as `normalizeSourceLine` in `utils/suppression.ts`,
 * and deliberately as restrained: it absorbs re-indentation and a formatter
 * re-wrapping the same tokens, but keeps every token, operator, identifier and
 * literal, because a suppression must stop matching the moment the code it was
 * argued about changes meaning.
 */
export function normalizeChange(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length <= CHANGE_SIDE_CAP ? flat : `${flat.slice(0, CHANGE_SIDE_CAP - 1)}…`;
}

/**
 * The change a mutant makes, as `"<original> → <mutated>"`.
 *
 * `undefined` when the engine reported neither half — cargo-mutants, whose
 * free-text description IS the mutator name (`engines/rust/report.ts`). Such
 * mutants fall back to mutator-only identity, which is the pre-v3 behaviour,
 * now explicit rather than accidental.
 *
 * A one-sided change keeps its arrow (`"→ true"`, `"a > 0 →"`) so the two cases
 * cannot collide with each other or with a two-sided change: without it, a
 * mutated-only `"true"` and an original-only `"true"` would be one identity.
 */
export function changeOf(v: Pick<Vulnerability, 'original' | 'mutated'>): string | undefined {
  const o = v.original === undefined ? '' : normalizeChange(v.original);
  const m = v.mutated === undefined ? '' : normalizeChange(v.mutated);
  if (o && m) return `${o} → ${m}`;
  if (m) return `→ ${m}`;
  if (o) return `${o} →`;
  return undefined;
}
