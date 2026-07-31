/** Outcome of grading a mutation score against a threshold. */
export interface GateResult {
  minScore: number;
  passed: boolean;
  /** Why the gate failed without the score itself being below the threshold. */
  reason?: 'partial_audit';
}

/**
 * Grade a formatted mutation score (e.g. "87.50%") against `minScore`.
 *
 * An unparseable or empty score is treated as PASSING — a file with no
 * gradable mutants must never spuriously fail the gate.
 *
 * `complete` mirrors `MutationResult.complete`: false when a time-budgeted run
 * returned only the batches it managed to finish. Such a score describes a
 * FRACTION of the file, so grading it as if it covered the whole one lets a
 * gate report green over code that was never mutated. The gate exists to be
 * trusted in CI, so an incomplete audit fails closed and says why. Defaults to
 * true so callers with no batching concept are unaffected.
 */
export function evaluateGate(scoreText: string, minScore: number, complete = true): GateResult {
  if (!complete) return { minScore, passed: false, reason: 'partial_audit' };
  // The regex only matches a well-formed decimal, so a match always parses to a
  // real number (no NaN guard needed), and a non-match — empty or unparseable
  // input — is treated as passing so a file with no gradable mutants never
  // spuriously fails the gate.
  const match = /-?\d+(?:\.\d+)?/.exec(scoreText);
  if (match === null) return { minScore, passed: true };
  return { minScore, passed: parseFloat(match[0]) >= minScore };
}

/**
 * Validate a `minScore` tool argument. Returns null when absent (optional) or
 * a number in [0, 100]; otherwise an error message.
 */
export function validateMinScore(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > 100) {
    return 'minScore must be a number between 0 and 100. Example: 80.';
  }
  return null;
}
