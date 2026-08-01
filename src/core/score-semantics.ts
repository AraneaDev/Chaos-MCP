/**
 * Score and suppression VOCABULARY — the small set of meanings that every
 * consumer of a MutationResult has to agree on, independent of how any of them
 * renders it.
 *
 * Separate from `format.ts` because that module is the audit tool's REPORT
 * RENDERER (`prepareGroups` → `formatResultAsText`/`buildResultPayload`), while
 * these four are pure semantics: when a score is a lie ({@link hasNoMutableLogic},
 * {@link displayMutationScore}), how an un-applied suppression is explained
 * ({@link suppressionDriftNotes}), and the per-line shape both the audit report
 * and the triage leaderboard carry ({@link LineGroup}). `triage.ts` renders its
 * own independent leaderboard and used to import the audit renderer purely to
 * borrow this vocabulary; that edge is what this module removes.
 *
 * This module is a LEAF on purpose: it imports only the `MutationResult` type
 * from `engines/base.js` and must never import `format.ts` or `triage.ts`. The
 * repo enforces `new_cycles: 0`, and a back-edge from vocabulary to renderer is
 * exactly how such a cycle appears.
 */

import type { MutationResult } from '../engines/base.js';

/**
 * Does a zero-mutant result prove the file has no mutable logic?
 *
 * Why it matters (audit M3): a 0/0 run scores "100.00%", which reads as proven
 * coverage. Both `audit_code_resilience` and `triage_test_coverage` substitute
 * "n/a" and flag the row so a file with no testable logic is not ranked as
 * "safest" indistinguishably from a genuinely perfect kill rate.
 *
 * Three conjuncts, each rejecting a different way a zero can lie:
 *
 * 1. `totalMutants === 0` — the obvious one. One enumerated mutant means real
 *    logic, and the file keeps its own score.
 *
 * 2. `scopeKind === 'whole-file'` — the run must have enumerated across the
 *    WHOLE file. This used to be spelled `!result.scopeNote`, i.e. inferred from
 *    the absence of free-text prose, and batching broke it: every batched TS run
 *    stamps a scopeNote, so whole-file audits of large files stopped qualifying
 *    (and, worse, the check was decided by wording rather than by scope).
 *    `scopeKind` is the engine's structural answer — `'scoped'` means only a
 *    lineScope/lineRange was enumerated, so a zero there means "nothing in that
 *    range", not "nothing in the file"; `undefined` means the engine never
 *    enumerated at all (a dry run), which proves nothing either.
 *
 * 3. `complete !== false` — the run must not have stopped early. `complete` is
 *    false when a time-budgeted batch loop returned only the batches it
 *    finished. Such a run enumerated the batches it got to and no more, so a
 *    zero across them says nothing about the batches that never ran: the file
 *    may be full of mutable logic sitting in an unexecuted batch. Conjunct 2
 *    describes what was REQUESTED, conjunct 3 what was DELIVERED, and only both
 *    together license the claim "this file has no mutable logic". `!== false`
 *    (not `=== true`) because `complete` is optional: engines with no batching
 *    concept leave it undefined and must keep behaving as before.
 *
 * TRANSITIONAL: conjunct 2 accepts `scopeKind === undefined` as long as the
 * result carries no `scopeNote`. Only the TypeScript engine emits `scopeKind`
 * today; the Python, Rust and PHP engines do not, and demanding it outright
 * would silently un-fix audit M3 for three of the four languages — a Rust
 * constants file would go straight back to reporting "100.00%". The `!scopeNote`
 * fallback is exactly the old predicate, and it still excludes the one
 * non-enumerating run that exists: StrykerJS `dryRun` is the only producer of a
 * `scopeKind`-less zero-with-no-enumeration, and `dryRunResult` always sets a
 * scopeNote. Delete the fallback once every engine sets `scopeKind`.
 */
export function hasNoMutableLogic(result: MutationResult): boolean {
  if (result.totalMutants !== 0) return false;
  if (result.complete === false) return false;
  if (result.scopeKind === 'whole-file') return true;
  if (result.scopeKind === 'scoped') return false;
  return !result.scopeNote;
}

/**
 * Display score for a result: "n/a" when the number would lie, else the raw score.
 *
 * Two ways it lies, both ending in an empty denominator that
 * {@link formatMutationScore} renders as "100.00%":
 *  - the file has no mutable logic at all (see {@link hasNoMutableLogic});
 *  - the run stopped early AND the batches that did run enumerated nothing.
 *    That is not "no mutable logic" — `hasNoMutableLogic` correctly refuses it,
 *    because the unrun batches were never looked at — but it is not a perfect
 *    kill rate either, and 0/0 has no percentage to report. Without this second
 *    clause the honesty fix in `hasNoMutableLogic` would hand such a run the
 *    bare "100.00%" it used to be protected from.
 */
export function displayMutationScore(result: MutationResult): string {
  if (hasNoMutableLogic(result)) return 'n/a';
  if (result.totalMutants === 0 && result.complete === false) return 'n/a';
  return result.mutationScore;
}

export interface LineGroup {
  line: number;
  mutators: Record<string, number>;
  changes?: string[];
}

/**
 * The sentences that explain suppressions which were NOT applied, one per
 * non-zero count and nothing at all when both are zero.
 *
 * Shared by the text report, the structured payload's `note`, and the
 * verify-mode note so the three cannot drift apart. Each sentence says what to
 * DO about it: an un-applied suppression is only useful feedback if the reader
 * knows re-confirming it (re-issuing `suppress`) restores it.
 */
export function suppressionDriftNotes(drifted?: number, unverified?: number): string[] {
  const notes: string[] = [];
  if (drifted !== undefined && drifted > 0) {
    notes.push(
      `${drifted} suppression(s) no longer match the code they were recorded against and were NOT applied — re-confirm them with \`suppress\` (or drop them with \`unsuppress\`).`,
    );
  }
  if (unverified !== undefined && unverified > 0) {
    notes.push(
      `${unverified} suppression(s) predate content fingerprinting and were NOT applied — re-confirm them with \`suppress\` to restore them.`,
    );
  }
  return notes;
}
