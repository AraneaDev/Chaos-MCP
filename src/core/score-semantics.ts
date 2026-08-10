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
 * The rule is simply: NO ENUMERATED MUTANT, NO PERCENTAGE. `formatMutationScore`
 * computes killed/total and renders the empty denominator 0/0 as "100.00%",
 * which reads as proven coverage no matter WHICH kind of zero produced it:
 *  - the file has no mutable logic at all (see {@link hasNoMutableLogic});
 *  - the run stopped early and the batches that did run enumerated nothing.
 *    That is not "no mutable logic" — `hasNoMutableLogic` correctly refuses it,
 *    because the unrun batches were never looked at — but it is not a perfect
 *    kill rate either;
 *  - the run deliberately mutated nothing: a `diffBase` whose file did not
 *    change, a verify whose baseline recorded no uncaught mutants, or a
 *    `lineScope` over lines with no mutable logic in them.
 *
 * That third group is why the predicate is now a bare `totalMutants === 0`
 * rather than the two narrower clauses it replaced. Both of those were gated on
 * something ELSE also being true (`hasNoMutableLogic`, or `complete === false`),
 * and three live paths produce a zero-mutant result that satisfies neither:
 * `nothingToMutateResult` (audit/scope.ts) hard-codes `mutationScore:
 * '100.00%'` alongside a scopeNote; `handler.ts` appends diffBase-derived notes
 * to results from the three engines that set no `scopeKind`; and a `'scoped'`
 * zero is refused by `hasNoMutableLogic` by design. All three left `complete`
 * undefined, so the old second clause could not rescue them and the raw
 * "100.00%" survived into the report.
 *
 * {@link hasNoMutableLogic} is deliberately NOT widened to match: it answers a
 * different question ("does this file have no mutable logic?" vs "measured
 * nothing"), and `format.ts`/`triage.ts` both branch on it to pick their
 * wording. Every zero-mutant branch of `cleanNote` already tells the reader the
 * number is not a measurement, so "n/a" is never left unexplained. Gates are
 * unaffected: `evaluateGate` reads `result.mutationScore`, not this display
 * value, and treats a non-numeric score as passing either way.
 *
 * One clause, not three: `hasNoMutableLogic(result)` and `totalMutants === 0 &&
 * complete === false` both IMPLY `totalMutants === 0`, so keeping them beside
 * the general test would leave two branches no input can reach — dead code, and
 * exactly the kind of equivalent mutant this server exists to find.
 */
export function displayMutationScore(result: MutationResult): string {
  if (result.totalMutants === 0) return 'n/a';
  return result.mutationScore;
}

export interface LineGroup {
  line: number;
  mutators: Record<string, number>;
  changes?: string[];
}

/** One tier-3 relocation, as the note renderer needs it. */
export interface RelocationNote {
  /** The line the entry was stored against before the move. */
  storedLine: number;
  /** The line its mutant was found on instead. */
  line: number;
  mutator: string;
  reason?: string;
}

/**
 * The sentences that explain suppressions which were NOT applied as recorded —
 * one per non-zero count, plus one per tier-3 relocation, and nothing at all
 * when every count is zero.
 *
 * Shared by the text report, the structured payload's `note`, and the
 * verify-mode note so the three cannot drift apart. Each sentence says what to
 * DO about it: an un-applied suppression is only useful feedback if the reader
 * knows re-confirming it (re-issuing `suppress`) restores it.
 */
export function suppressionDriftNotes(
  drifted?: number,
  unverified?: number,
  orphaned?: number,
  rejected?: number,
  relocated?: RelocationNote[],
): string[] {
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
  if (orphaned !== undefined && orphaned > 0) {
    notes.push(
      `${orphaned} suppression(s) matched no surviving mutant this run and had no effect — the mutant may now be killed, its line/mutator may no longer exist (a mutation-tool upgrade can rename operators), or a \`mutatorDenylist\` entry may have stopped it being generated. Chaos-MCP cannot tell which; the entry is inert either way, so drop it with \`unsuppress\` unless you know the mutant still exists.`,
    );
  }
  // Refused at WRITE time, so unlike the three above there is no stored entry
  // to re-confirm — and no later run will mention it again. Lives here, beside
  // its siblings, so the text and JSON projections cannot drift on it: both
  // render this one list.
  if (rejected !== undefined && rejected > 0) {
    notes.push(
      `${rejected} suppression(s) were NOT stored: either the target line is blank or comment-only ` +
        '(where no engine reports a mutant), or it carries several mutants of that mutator and the ' +
        'request did not say which — re-issue it with a `change` naming the one you mean. Check the ' +
        'line number against the survivor you meant to suppress.',
    );
  }
  // Reported ENTRY BY ENTRY, unlike the four counts above, because this is the
  // one suppression outcome that can be silently wrong. A tier-3 relocation
  // matched a mutant's change elsewhere in the file after the entry's own line
  // was edited away. Uniqueness is not proof: if the original site was DELETED
  // and an unrelated site produces the same `original → mutated`, the
  // suppression has just moved onto code its reason was never written about. A
  // bare count would hide that; naming the move and quoting the reason lets a
  // reader judge it.
  for (const r of relocated ?? []) {
    notes.push(
      `Suppression "${r.mutator}" moved from line ${r.storedLine} to line ${r.line}: its stored line was edited, and its mutant was found there instead. ` +
        (r.reason === undefined ? '' : `Recorded reason: "${r.reason}". `) +
        'Confirm this is still the mutant that reason was written about, and drop it with `unsuppress` if it is not.',
    );
  }

  return notes;
}
