/**
 * The no-coverage predicate.
 *
 * This is a classification over a single mutant record (`{ kind, description }`),
 * not a formatting or a storage concern, so it lives in the leaf layer where
 * every consumer can reach it without importing a domain module. It deliberately
 * depends on nothing: `format.ts` (rendering) and the audit layer's
 * `applySuppressions` (score arithmetic) both need it, and routing either of
 * them through the other is what would create an import cycle.
 */

/**
 * Matches the NoCoverage marker engines embed in a vulnerability description.
 *
 * FALLBACK ONLY. Engines now classify each mutant structurally via
 * `Vulnerability.kind`; this regex covers a `Vulnerability` built without it
 * (an older cached result, a direct API consumer). Prefer {@link isNoCoverage}
 * over calling this directly — reading the prose was how a reworded sentence
 * could silently reclassify every no-coverage mutant as a survivor.
 */
export const NO_COVERAGE_RE = /no test reached|nocoverage/i;

/**
 * Whether a mutant represents an unreached line rather than a survivor.
 * Structured `kind` wins; the description heuristic is consulted only when the
 * engine did not supply one.
 */
export function isNoCoverage(v: { kind?: string; description: string }): boolean {
  if (v.kind !== undefined) return v.kind === 'noCoverage';
  return NO_COVERAGE_RE.test(v.description);
}
