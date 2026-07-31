/**
 * Applying a suppression key set to a finished MutationResult.
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
import { formatMutationScore, type MutationResult } from '../engines/base.js';
import { isNoCoverage } from '../utils/no-coverage.js';

/** Same `${line} ${mutator}` key shape the suppression file is stored under. */
const keyOf = (line: number, mutator: string): string => `${line} ${mutator}`;

/**
 * Drop suppressed (equivalent) mutants from a result. Equivalent mutants are
 * unkillable, so they leave the denominator: total shrinks, score is recomputed,
 * survived is clamped down. Returns a new result; the input is not mutated.
 */
export function applySuppressions(
  result: MutationResult,
  suppressed: Set<string> | undefined,
): { result: MutationResult; suppressedCount: number } {
  if (!suppressed || suppressed.size === 0) return { result, suppressedCount: 0 };
  const kept = result.vulnerabilities.filter((v) => !suppressed.has(keyOf(v.line, v.mutator)));
  const suppressedCount = result.vulnerabilities.length - kept.length;
  if (suppressedCount === 0) return { result, suppressedCount: 0 };
  // Only true survivors (not NoCoverage) count against result.survived.
  const suppressedSurvivors = result.vulnerabilities.filter(
    (v) => suppressed.has(keyOf(v.line, v.mutator)) && !isNoCoverage(v),
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
  };
}
