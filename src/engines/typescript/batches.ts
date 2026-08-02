/**
 * Bounded command-runner batching for the StrykerJS engine.
 *
 * The command runner re-runs the whole suite per mutant, so a large file is
 * split into line-bounded batches that each get a slice of the time budget.
 * Both functions are pure — the planning and folding rules are assertable
 * without a filesystem or a Stryker process.
 */
import { type MutationResult, formatMutationScore } from '../base.js';

export const COMMAND_BATCH_LINES = 80;
export const COMMAND_BATCH_THRESHOLD_LINES = 120;
export const MIN_BATCH_BUDGET_MS = 3_000;

/** Split requested physical line ranges into bounded command-runner batches. */
export function planLineBatches(
  totalLines: number,
  ranges?: { start: number; end: number }[],
): { start: number; end: number }[] {
  // Stryker disable ArrayDeclaration: sentinel array elements are outside the typed input domain.
  const requestedLineCount = (ranges ?? []).reduce(
    (sum, range) => sum + Math.max(0, range.end - range.start + 1),
    0,
  );
  const requested =
    ranges && ranges.length > 0
      ? requestedLineCount > COMMAND_BATCH_LINES
        ? ranges
        : []
      : totalLines > COMMAND_BATCH_THRESHOLD_LINES
        ? [{ start: 1, end: totalLines }]
        : [];
  // Stryker restore ArrayDeclaration
  const batches: { start: number; end: number }[] = [];
  for (const range of requested) {
    for (let start = range.start; start <= range.end; start += COMMAND_BATCH_LINES) {
      batches.push({ start, end: Math.min(range.end, start + COMMAND_BATCH_LINES - 1) });
    }
  }
  return batches;
}

/**
 * Fold the per-batch results of a bounded command-runner run into one result.
 *
 * @param scopeKind — the REQUESTED scope of the whole batched run, not of an
 *   individual batch: every batch is line-scoped by construction, but a run that
 *   plans batches across the entire file is still `'whole-file'`. See the
 *   {@link MutationResult.scopeKind} doc in `engines/base.ts`.
 */
export function mergeBatchResults(
  filePath: string,
  results: MutationResult[],
  planned: number,
  complete: boolean,
  scopeKind: 'whole-file' | 'scoped' = 'whole-file',
): MutationResult {
  const totalMutants = results.reduce((sum, result) => sum + result.totalMutants, 0);
  const killed = results.reduce((sum, result) => sum + result.killed, 0);
  const survived = results.reduce((sum, result) => sum + result.survived, 0);
  const incompetent = results.reduce((sum, result) => sum + (result.incompetent ?? 0), 0);
  const score = formatMutationScore(killed, totalMutants);
  return {
    target: filePath,
    totalMutants,
    killed,
    survived,
    mutationScore: score,
    vulnerabilities: results.flatMap((result) => result.vulnerabilities),
    incompetent: incompetent > 0 ? incompetent : undefined,
    complete,
    batchesCompleted: results.length,
    batchesPlanned: planned,
    stoppedReason: complete ? undefined : 'time_budget_exhausted',
    scopeKind,
    scopeNote: complete
      ? `Completed ${planned} bounded mutation batches.`
      : `Partial audit: completed ${results.length} of ${planned} bounded mutation batches before the time budget was exhausted.`,
  };
}
