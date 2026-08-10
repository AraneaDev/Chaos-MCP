/**
 * Placing stored suppressions against a finished MutationResult, by content.
 *
 * Moved out of `utils/suppression.ts` (Finding 18). That module owns the
 * suppression FILE — load/save, the per-workspace write mutex — and this
 * function touches none of it: every field it reads and writes belongs to
 * `MutationResult`, so it is audit-pipeline domain logic, not a utility. It
 * sits beside `audit-output.ts` (its main caller) and `suppression-io.ts` (the
 * read/write half), which is where the audit layer already owns the rest of
 * the suppression story.
 *
 * Keeping it out of `utils/` also keeps the import graph pointing one way:
 * `utils/suppression.ts` no longer reaches up into the domain layer, so if
 * `format.ts` ever needs something from the suppression store there is no cycle
 * waiting to form.
 */
import { formatMutationScore, type MutationResult, type Vulnerability } from '../engines/base.js';
import { isNoCoverage } from '../utils/no-coverage.js';
import { changeOf } from '../utils/mutant-identity.js';
import type { ResolvedSuppression, SuppressionVerdict } from '../utils/suppression.js';

/** A stored suppression that was placed against this run's mutants. */
export interface AppliedSuppression {
  /** Where the mutant was found — the stored line unless it relocated. */
  line: number;
  /** The line the entry is stored against. Differs from `line` after a move. */
  storedLine: number;
  mutator: string;
  change?: string;
  reason?: string;
  /** 1 = stored line, 2 = relocated by fingerprint, 3 = relocated by change. */
  tier: 1 | 2 | 3;
}

/**
 * Whether a mutant IS the one an entry names.
 *
 * Identity is the mutator plus the change (`utils/mutant-identity.ts`), never
 * the line: several mutants of one mutator can share a line, and suppressing by
 * mutator name alone took a KILLED sibling's coverage signal down with the
 * equivalent one.
 *
 * A changeless entry falls back to mutator-only identity, matching every mutant
 * of that mutator on the line. That is correct for cargo-mutants, whose mutator
 * name IS the free-text change description, and it is the pre-v3 behaviour for
 * anything else that reaches here without a change.
 */
function matches(v: Vulnerability, s: { mutator: string; change?: string }): boolean {
  if (v.mutator !== s.mutator) return false;
  if (s.change === undefined) return true;
  return changeOf(v) === s.change;
}

/**
 * TIER 3: place a pending entry using the SURVIVOR list.
 *
 * The entry's line was edited, so its fingerprint is gone and
 * `verifySuppressions` could not place it. The mutant may still exist — a
 * reflow, a rename or an added comment changes a line's hash without changing
 * what mutates on it. Match `(mutator, change)` across every mutant in the file;
 * a single line's worth of hits re-points the entry.
 *
 * This is the only tier that can be WRONG. Uniqueness is not proof: if the
 * original site was DELETED in the same edit and an unrelated site elsewhere
 * happens to produce the same `original → mutated`, the suppression moves onto
 * code its `reason` was never written about. That is why tier-3 placements are
 * reported entry by entry rather than folded into a count — see
 * `suppressionDriftNotes` in core/score-semantics.ts.
 */
function resolvePending(
  pending: ResolvedSuppression[],
  vulnerabilities: Vulnerability[],
): { applied: AppliedSuppression[]; drifted: number } {
  const applied: AppliedSuppression[] = [];
  let drifted = 0;
  for (const p of pending) {
    const hits = vulnerabilities.filter((v) => matches(v, p));
    const lines = new Set(hits.map((v) => v.line));
    // Zero hits: the mutant is gone. Several LINES: ambiguous, and guessing is
    // exactly what this system refuses to do. Several hits on ONE line are
    // fine — they are the same mutant identity and move together.
    if (lines.size !== 1) {
      drifted += 1;
      continue;
    }
    applied.push({
      line: hits[0].line,
      storedLine: p.storedLine,
      mutator: p.mutator,
      tier: 3,
      ...(p.change === undefined ? {} : { change: p.change }),
      ...(p.reason === undefined ? {} : { reason: p.reason }),
    });
  }
  return { applied, drifted };
}

/**
 * Drop suppressed (equivalent) mutants from a result, placing each entry by
 * content and reporting the ones that matched nothing.
 *
 * A suppression that resolves against SOURCE but names no surviving mutant
 * filters nothing and used to move no counter at all — `suppressedCount` counts
 * mutants REMOVED, not entries honoured — so the entry was silently inert: it
 * changed neither the score nor the report, and nothing told the reader it had
 * stopped doing anything. It is now counted as `orphaned`.
 *
 * That count is derived from `result.vulnerabilities` (survivors ∪ no-coverage)
 * because that is the only mutant IDENTITY a `MutationResult` carries — killed
 * mutants are a count, not a list. An orphan therefore means one of three
 * things, and this code cannot tell them apart: the mutant is now KILLED (a
 * wrong equivalence claim disproved by a new test), its identity no longer
 * exists, or it was never generated because a `mutatorDenylist` entry excluded
 * its mutator. The second is not always an edit — for Rust the mutant identity
 * IS cargo-mutants' free-text change description (engines/rust/report.ts), so a
 * tool upgrade that rewords descriptions invalidates every Rust suppression at
 * once. Every message rendered from this count must state ALL THREE causes
 * rather than asserting any one; see `suppressionDriftNotes` in
 * core/score-semantics.ts.
 *
 * Equivalent mutants are unkillable, so they leave the denominator: total
 * shrinks, score is recomputed, survived is clamped down. Returns a new
 * result; the input is not mutated.
 */
export function applySuppressions(
  result: MutationResult,
  verdict: SuppressionVerdict | undefined,
): {
  result: MutationResult;
  suppressedCount: number;
  applied: AppliedSuppression[];
  relocated: AppliedSuppression[];
  drifted: number;
  orphaned: number;
} {
  const nothing = {
    result,
    suppressedCount: 0,
    applied: [] as AppliedSuppression[],
    relocated: [] as AppliedSuppression[],
    // The verdict's own refusals carry through even when there is nothing to
    // place, so a file whose every entry drifted still reports it.
    drifted: verdict?.drifted ?? 0,
    orphaned: 0,
  };
  if (!verdict || (verdict.resolved.length === 0 && verdict.pending.length === 0)) return nothing;

  const tier12: AppliedSuppression[] = verdict.resolved.map((r) => ({
    line: r.line,
    storedLine: r.storedLine,
    mutator: r.mutator,
    tier: r.tier,
    ...(r.change === undefined ? {} : { change: r.change }),
    ...(r.reason === undefined ? {} : { reason: r.reason }),
  }));
  const tier3 = resolvePending(verdict.pending, result.vulnerabilities);
  const applied = [...tier12, ...tier3.applied];
  const relocated = applied.filter((s) => s.tier !== 1);

  // Only tier 1/2 entries can be orphans. A tier-3 entry that matched nothing is
  // already counted as drift by `resolvePending` — calling it an orphan too
  // would double-report the same entry under two contradictory explanations.
  const orphaned = tier12.filter(
    (s) => !result.vulnerabilities.some((v) => v.line === s.line && matches(v, s)),
  ).length;

  const isSuppressed = (v: Vulnerability): boolean =>
    applied.some((s) => s.line === v.line && matches(v, s));
  const kept = result.vulnerabilities.filter((v) => !isSuppressed(v));
  const suppressedCount = result.vulnerabilities.length - kept.length;
  if (suppressedCount === 0) {
    return { ...nothing, applied, relocated, drifted: verdict.drifted + tier3.drifted, orphaned };
  }
  // Only true survivors (not NoCoverage) count against result.survived.
  const suppressedSurvivors = result.vulnerabilities.filter(
    (v) => isSuppressed(v) && !isNoCoverage(v),
  ).length;
  const totalMutants = Math.max(0, result.totalMutants - suppressedCount);
  const survived = Math.max(0, result.survived - suppressedSurvivors);
  // Same "no mutants left → 100.00%" convention every engine uses.
  const mutationScore = formatMutationScore(result.killed, totalMutants);
  // Suppressing every mutant leaves `totalMutants: 0` with no scope note, which
  // is exactly the signature `hasNoMutableLogic` reads as "this file has no
  // mutable logic". The reported score would then be "n/a" under a note saying
  // mutation testing is not meaningful here — the opposite of the truth, which
  // is that it IS meaningful and an operator declared every mutant equivalent.
  // A scope note both states what happened and keeps the file out of the
  // no-mutable-logic branch (and so out of ranking as a genuine 100%).
  const scopeNote =
    totalMutants === 0 && !result.scopeNote
      ? `All ${suppressedCount} mutant(s) for this file are suppressed as equivalent; nothing was left to score.`
      : result.scopeNote;
  return {
    result: {
      ...result,
      vulnerabilities: kept,
      totalMutants,
      survived,
      mutationScore,
      ...(scopeNote === undefined ? {} : { scopeNote }),
    },
    suppressedCount,
    applied,
    relocated,
    // Total across both halves of the ladder: what source alone refused
    // (`verdict.drifted`) plus what tier 3 could not place.
    drifted: verdict.drifted + tier3.drifted,
    orphaned,
  };
}
