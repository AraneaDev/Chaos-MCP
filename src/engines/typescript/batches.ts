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

/**
 * What one StrykerJS command-runner invocation costs before it tests a mutant:
 * Stryker init, instrumentation and the dry run.
 *
 * Restated rather than imported from `TIMING.startupMs.commandRunner`
 * (core/baseline-timing.ts): `engines/` may not import `core/`
 * (`engines-below-domain` in knossos.json). Keep the two in step — same idiom
 * as MIN_ENGINE_BUDGET_MS in triage/audit-one.ts.
 */
export const COMMAND_RUNNER_STARTUP_MS = 10_000;

/**
 * The smallest slice worth spending on a batch: one startup plus enough time to
 * actually test something.
 *
 * This was a bare 3_000, which is under a THIRD of the fixed startup cost — so
 * `runBatched` happily started batches that could not survive their own
 * bootstrap. With 25 batches and the default 300s budget each got 12s, every
 * one timed out, and the audit ended in "Time budget exhausted before any
 * mutation batch could run" for a file that a single-batch run would have
 * scored.
 */
export const MIN_BATCH_BUDGET_MS = COMMAND_RUNNER_STARTUP_MS + 5_000;

/**
 * Split requested physical line ranges into bounded command-runner batches.
 *
 * `budgetMs` caps the batch COUNT at what the wall-clock can actually fund, and
 * widens each batch to compensate so the requested span is still covered end to
 * end. Fewer, larger batches strictly dominate here: the per-batch cost is fixed
 * (one Stryker startup) and the per-line cost is not. Omitting `budgetMs` keeps
 * the pure line-count plan, which is what the unit tests of the geometry use.
 */
export function planLineBatches(
  totalLines: number,
  ranges?: { start: number; end: number }[],
  budgetMs?: number,
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
  if (requested.length === 0) return [];

  const spanned = requested.reduce((sum, r) => sum + Math.max(0, r.end - r.start + 1), 0);
  const affordable = budgetMs === undefined ? Infinity : Math.floor(budgetMs / MIN_BATCH_BUDGET_MS);
  // One affordable batch is not a batched run — the caller runs unbatched.
  if (affordable < 2) return [];
  const byLines = Math.ceil(spanned / COMMAND_BATCH_LINES);
  const count = Math.min(byLines, affordable);
  const step = Math.max(COMMAND_BATCH_LINES, Math.ceil(spanned / count));

  const batches: { start: number; end: number }[] = [];
  for (const range of requested) {
    for (let start = range.start; start <= range.end; start += step) {
      batches.push({ start, end: Math.min(range.end, start + step - 1) });
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
