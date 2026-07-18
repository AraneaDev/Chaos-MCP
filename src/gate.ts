/** Outcome of grading a mutation score against a threshold. */
export interface GateResult {
  minScore: number;
  passed: boolean;
}

/**
 * Grade a formatted mutation score (e.g. "87.50%") against `minScore`.
 * An unparseable or empty score is treated as PASSING — a file with no
 * gradable mutants must never spuriously fail the gate.
 */
export function evaluateGate(scoreText: string, minScore: number): GateResult {
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
