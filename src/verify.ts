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
  // The `?? []` fallbacks only guard a spread of `undefined`: a non-object element
  // has no `.mutators` and is skipped, so any array literal here is an equivalent
  // mutant. The Stryker directive must sit on its OWN line immediately above the
  // loop — `next-line` targets the very next line, so an intervening comment line
  // would misdirect it off the loop.
  // Stryker disable next-line ArrayDeclaration: equivalent mutant (see above)
  for (const group of [...(b.survivors ?? []), ...(b.noCoverage ?? [])]) {
    // Not every baseline is a value this process produced: one arrives as a raw
    // `baseline` tool argument (validated for type, not for element shape) and
    // another is read back from the on-disk run cache, so an element can be
    // `null` — a truncated or hand-edited cache entry, or a caller passing
    // `survivors: [null]`. Dereferencing it threw a raw TypeError out of
    // `computeScope`, which the handler reported as "Chaos Engine Halted:
    // Cannot read properties of null" — an internal crash where the intended
    // answer was the "not found or expired" / bad-argument tool error (audit
    // M10). The declared type says this cannot happen, hence the widening cast:
    // the guard exists precisely for the inputs the type system never saw.
    // A group with no usable line number is skipped for the same reason — it
    // would key mutants as `"undefined <mutator>"` and corrupt the delta.
    const g = group as { line?: unknown; mutators?: unknown } | null | undefined;
    if (g === null || g === undefined || typeof g.line !== 'number') continue;
    // `mutators` needs no guard of its own: `?? {}` already covers null/absent,
    // and a non-object value yields no keys.
    for (const mutator of Object.keys((g.mutators ?? {}) as Record<string, unknown>)) {
      const k = keyOf(g.line, mutator);
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ line: g.line, mutator });
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
 * Every verify re-run is WHOLE-FILE, on every engine, so a fresh survivor may
 * legitimately land on a line the baseline never mentioned and all of them are
 * counted as `newSurvivors`.
 *
 * This used to take an `engineSupportsLineScope` flag that restricted
 * `newSurvivors` to baseline lines for StrykerJS, on the stated grounds that
 * "the rerun is scoped to exactly the baseline lines, so every fresh survivor is
 * guaranteed to land on a baseline line". That premise was false in a way that
 * mattered: the re-run was scoped to one single-line range per baseline line,
 * and Stryker only generates a mutant whose ENTIRE span fits inside the range —
 * so multi-line mutants were never re-tested at all, and this function, which
 * infers "killed" from ABSENCE, reported them as `nowKilled`. `scope.ts` no
 * longer line-scopes verify (see the long comment there), which removes both the
 * false-killed bug and the flag's justification. Dropping the restriction also
 * restores the property the flag's own `= false` default was chosen for: a
 * regression the fix introduces on a DIFFERENT line is a real new survivor and
 * must never be silently hidden.
 */
export function computeVerifyDelta(baseline: MutantKey[], result: MutationResult): VerifyDelta {
  const baselineKeySet = new Set(baseline.map((k) => keyOf(k.line, k.mutator)));

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
  const newSurvivors = rerun.filter((k) => !baselineKeySet.has(keyOf(k.line, k.mutator)));

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
