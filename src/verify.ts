import type { MutationResult } from './engines/base.js';

/** A prior run's reported survivor/noCoverage arrays, passed back to verify. */
export interface BaselineInput {
  survivors?: { line: number; mutators: Record<string, number> }[];
  noCoverage?: { line: number; mutators: Record<string, number> }[];
}

/** A single uncaught-mutant identity. */
export interface MutantKey {
  line: number;
  mutator: string;
}

/** The result of comparing a baseline against a fresh run. */
export interface VerifyDelta {
  baselineTotal: number;
  nowKilled: MutantKey[]; // in baseline, absent from re-run
  stillSurviving: MutantKey[]; // in both
  newSurvivors: MutantKey[]; // in re-run, not in baseline, on a baseline line
}

/** Stable string key for a (line, mutator) pair. */
function keyOf(line: number, mutator: string): string {
  return `${line} ${mutator}`;
}

function sortKeys(keys: MutantKey[]): MutantKey[] {
  return [...keys].sort((a, b) => a.line - b.line || a.mutator.localeCompare(b.mutator));
}

/** Flatten survivors ∪ noCoverage into a deduped, sorted list of (line, mutator) keys. */
export function parseBaseline(b: BaselineInput): MutantKey[] {
  const seen = new Set<string>();
  const out: MutantKey[] = [];
  // Stryker disable next-line ArrayDeclaration: the `?? []` fallbacks only guard a
  // spread of `undefined`; their contents are never observed (a non-object element
  // has no `.mutators` and is skipped), so any array literal here is equivalent.
  for (const group of [...(b.survivors ?? []), ...(b.noCoverage ?? [])]) {
    for (const mutator of Object.keys(group.mutators ?? {})) {
      const k = keyOf(group.line, mutator);
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ line: group.line, mutator });
      }
    }
  }
  return sortKeys(out);
}

/** Unique sorted baseline line numbers (for scope derivation). */
export function baselineLines(keys: MutantKey[]): number[] {
  return [...new Set(keys.map((k) => k.line))].sort((a, b) => a - b);
}

/**
 * Compare baseline keys against a fresh run's vulnerabilities (Survived ∪ NoCoverage).
 *
 * `engineSupportsLineScope` mirrors `ENGINE_REGISTRY[type].supportsLineScope`.
 * When true (StrykerJS/TS) the rerun is scoped to exactly the baseline lines, so
 * every fresh survivor is guaranteed to land on a baseline line and we restrict
 * `newSurvivors` accordingly. When false (cosmic-ray/cargo-mutants/Infection) the
 * rerun is whole-file: a regression the fix introduces on a *different* line is a
 * real new survivor and MUST be counted, so we drop the baseline-line restriction.
 * Defaults to false so an omitted flag never silently hides regressions.
 */
export function computeVerifyDelta(
  baseline: MutantKey[],
  result: MutationResult,
  engineSupportsLineScope = false,
): VerifyDelta {
  const baselineKeySet = new Set(baseline.map((k) => keyOf(k.line, k.mutator)));
  const baselineLineSet = new Set(baseline.map((k) => k.line));

  const rerun: MutantKey[] = [];
  const rerunKeySet = new Set<string>();
  for (const v of result.vulnerabilities) {
    const k = keyOf(v.line, v.mutator);
    if (!rerunKeySet.has(k)) {
      rerunKeySet.add(k);
      rerun.push({ line: v.line, mutator: v.mutator });
    }
  }

  const nowKilled = baseline.filter((k) => !rerunKeySet.has(keyOf(k.line, k.mutator)));
  const stillSurviving = baseline.filter((k) => rerunKeySet.has(keyOf(k.line, k.mutator)));
  const newSurvivors = rerun.filter(
    (k) =>
      !baselineKeySet.has(keyOf(k.line, k.mutator)) &&
      (!engineSupportsLineScope || baselineLineSet.has(k.line)),
  );

  return {
    baselineTotal: baseline.length,
    nowKilled: sortKeys(nowKilled),
    stillSurviving: sortKeys(stillSurviving),
    newSurvivors: sortKeys(newSurvivors),
  };
}

/** Build the verify delta note string used in both JSON and structured responses. */
export function buildVerifyNote(delta: VerifyDelta): string {
  return (
    `${delta.nowKilled.length} of ${delta.baselineTotal} previously-uncaught mutants are now killed; ` +
    `${delta.stillSurviving.length} still surviving; ${delta.newSurvivors.length} new. ` +
    'stillSurviving: add or strengthen tests for these. ' +
    'newSurvivors: your change introduced these uncaught mutants on the same lines.'
  );
}

/** Render the verify delta as compact JSON. */
export function formatVerifyResultAsJson(target: string, delta: VerifyDelta): string {
  return JSON.stringify({
    target,
    mode: 'verify',
    baselineTotal: delta.baselineTotal,
    killedCount: delta.nowKilled.length,
    nowKilled: delta.nowKilled,
    stillSurviving: delta.stillSurviving,
    newSurvivors: delta.newSurvivors,
    note: buildVerifyNote(delta),
  });
}

/** Render the verify delta as a compact human-readable summary. */
export function formatVerifyResultAsText(target: string, delta: VerifyDelta): string {
  const lines: string[] = [`Chaos-MCP Verify Report: ${target}`];
  if (delta.stillSurviving.length === 0 && delta.newSurvivors.length === 0) {
    lines.push(`All ${delta.baselineTotal} previously-uncaught mutants are now killed.`);
    return lines.join('\n');
  }
  lines.push(
    `${delta.nowKilled.length} of ${delta.baselineTotal} previously-uncaught mutants now killed; ` +
      `${delta.stillSurviving.length} still surviving; ${delta.newSurvivors.length} new.`,
  );
  if (delta.nowKilled.length > 0) {
    lines.push('Now killed:');
    for (const k of delta.nowKilled) lines.push(`  ${k.line}: ${k.mutator}`);
  }
  if (delta.stillSurviving.length > 0) {
    lines.push('Still surviving:');
    for (const k of delta.stillSurviving) lines.push(`  ${k.line}: ${k.mutator}`);
  }
  if (delta.newSurvivors.length > 0) {
    lines.push('New survivors (regressions on baseline lines):');
    for (const k of delta.newSurvivors) lines.push(`  ${k.line}: ${k.mutator}`);
  }
  return lines.join('\n');
}
