import type { MutationResult } from '../engines/base.js';
import type { GateResult } from './gate.js';

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
  nowKilled: MutantKey[]; // in baseline, absent from a COMPLETE re-run
  stillSurviving: MutantKey[]; // in both
  newSurvivors: MutantKey[]; // in re-run, not in baseline, on a baseline line
  /**
   * In the baseline, absent from a re-run that did not enumerate everything.
   *
   * Always empty for a complete re-run — those keys go to `nowKilled`, which is
   * the only case where absence proves a kill. See {@link computeVerifyDelta}.
   */
  notReChecked: MutantKey[];
  /**
   * Partial-run provenance, mirrored from the re-run's `MutationResult` so the
   * three renderers below stay pure functions of the delta and cannot each
   * decide for themselves whether the run was whole.
   *
   * `complete` follows the MutationResult convention: absent for engines with no
   * batching concept, `false` only when a batch loop returned early.
   */
  complete?: boolean;
  batchesCompleted?: number;
  batchesPlanned?: number;
  stoppedReason?: 'time_budget_exhausted';
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
 *
 * ── ABSENCE ONLY PROVES A KILL WHEN THE RE-RUN ENUMERATED EVERYTHING ──
 *
 * `nowKilled` is inferred from absence, and that inference is sound only if the
 * re-run covered at least as much as the baseline did. It often does not.
 * Verify is deliberately WHOLE-FILE on every engine (see `audit/scope.ts`), so a
 * TypeScript re-run on Vitest >= 3 goes through `runBatched` and plans the
 * MAXIMUM number of batches — and either the time budget drains and the loop
 * breaks, or a batch throws `StrykerTimeoutError` and is swallowed
 * (`engines/typescript.ts`). Both merge only the batches that finished and set
 * `complete: false`. A baseline mutant sitting in a batch that never ran is
 * simply ABSENT, and reporting it as "now killed" is a false "you fixed it" on
 * the single question verify exists to answer.
 *
 * So when the re-run is incomplete, those keys go to `notReChecked` instead and
 * `nowKilled` is empty: the run has no evidence about ANY of them, and the
 * honest answer is "unknown", not "killed". `stillSurviving` and `newSurvivors`
 * are unaffected — both are inferred from PRESENCE, and a mutant the re-run
 * actually saw survive is a fact whether or not the rest of the file ran.
 *
 * The classification lives here rather than in the formatter on purpose: this is
 * where "absent ⇒ killed" is decided, `result` (the only carrier of `complete`)
 * is in hand here and nowhere downstream, and the three renderers all take a
 * bare `VerifyDelta` — putting the guard in one of them would leave the other
 * two, and every future consumer of this function, reading a wrong `nowKilled`.
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

  // `=== false`, not `!== true`: engines with no batching concept leave
  // `complete` undefined and must keep the old (correct, whole-file) behaviour.
  const partial = result.complete === false;
  const absent = sortKeys(baseline.filter((k) => !rerunKeySet.has(keyOf(k.line, k.mutator))));
  const stillSurviving = baseline.filter((k) => rerunKeySet.has(keyOf(k.line, k.mutator)));
  const newSurvivors = rerun.filter((k) => !baselineKeySet.has(keyOf(k.line, k.mutator)));

  const delta: VerifyDelta = {
    baselineTotal: baseline.length,
    nowKilled: partial ? [] : absent,
    stillSurviving: sortKeys(stillSurviving),
    newSurvivors: sortKeys(newSurvivors),
    notReChecked: partial ? absent : [],
  };
  // Forwarded, not recomputed: the renderers and the structured payload all read
  // the run's partial state off the delta, so there is exactly one copy of it.
  if (result.complete !== undefined) delta.complete = result.complete;
  if (result.batchesCompleted !== undefined) delta.batchesCompleted = result.batchesCompleted;
  if (result.batchesPlanned !== undefined) delta.batchesPlanned = result.batchesPlanned;
  if (result.stoppedReason !== undefined) delta.stoppedReason = result.stoppedReason;
  return delta;
}

/**
 * Grade a verify delta against `minScore` (Finding 8).
 *
 * `minScore` is accepted alongside `runId`/`baseline` — nothing in
 * `validateMinScoreArg` makes them mutually exclusive — and the tool schema
 * promises unconditionally that "if the mutation score is below this (0–100),
 * the result reports gate.passed=false (never an error)". Verify mode emitted no
 * `gate` key at all, which is the SAME defect `audit/scope.ts` documents as
 * already fixed for the no-changes short-circuit: a consumer written
 * `if (!result.gate.passed)` throws a TypeError, and one written
 * `result.gate?.passed === true` reads the missing key as a failed gate.
 *
 * A verify has no percentage to grade — it re-runs a recorded set of mutants,
 * not the whole file — so `evaluateGate` (which parses a score string) is the
 * wrong instrument. The verify question is binary and is exactly the one the
 * delta answers: is anything from the baseline still alive, and did the fix
 * introduce anything new? Both empty ⇒ pass. `nowKilled` is deliberately NOT
 * consulted: a caller who suppressed a mutant instead of killing it removed it
 * from BOTH sides, and grading on the kill count would fail them for it.
 *
 * FAILS CLOSED on a partial re-run, for the same reason `evaluateGate` does
 * (see `core/gate.ts`): after Finding 2 an incomplete re-run reports its
 * unresolved baseline as `notReChecked` rather than `nowKilled`, and an empty
 * `stillSurviving` there means "we did not look", not "it is gone". The gate
 * exists to be trusted in CI, so it must not go green on a re-run that never
 * generated the mutants it is grading. `reason: 'partial_audit'` is the shared
 * vocabulary the text renderer already explains.
 */
export function evaluateVerifyGate(minScore: number, delta: VerifyDelta): GateResult {
  if (delta.complete === false) return { minScore, passed: false, reason: 'partial_audit' };
  return {
    minScore,
    passed: delta.stillSurviving.length === 0 && delta.newSurvivors.length === 0,
  };
}

/**
 * The leading sentence for a verify whose re-run stopped early.
 *
 * The producer-side analogue is `partialCleanNote` in `core/format.ts`, and the
 * framing is deliberately the same: name what was MEASURED, say why the rest was
 * not, and state plainly that the un-run part is unknown rather than clean.
 * Restated here rather than imported because that helper is private to the
 * report renderer and phrases the same idea about survivors instead of about a
 * baseline.
 *
 * It leads the note — before any count — because every number after it is
 * conditioned on it: a reader who takes `0 of 8 now killed` at face value
 * without knowing the re-run was a fraction of the file draws exactly the wrong
 * conclusion about their fix.
 */
function partialVerifyNote(delta: VerifyDelta): string {
  const measured =
    delta.batchesCompleted !== undefined && delta.batchesPlanned !== undefined
      ? `only ${delta.batchesCompleted} of ${delta.batchesPlanned} batches ran`
      : 'only part of the file was re-run';
  const why =
    delta.stoppedReason === 'time_budget_exhausted'
      ? 'the time budget was exhausted before the rest could run'
      : 'the run stopped before the rest could run';
  return (
    `PARTIAL RE-RUN — ${measured} because ${why}, so nothing here can be reported as fixed: ` +
    `a baseline mutant that did not reappear may simply never have been generated. ` +
    `${delta.notReChecked.length} baseline mutant(s) were NOT re-checked (notReChecked) and are ` +
    'counted as unknown, not killed. Re-run with a larger time budget for a verdict on the whole baseline.'
  );
}

/** Build the verify delta note string used in both JSON and structured responses. */
export function buildVerifyNote(delta: VerifyDelta): string {
  const counts =
    `${delta.nowKilled.length} of ${delta.baselineTotal} previously-uncaught mutants are now killed; ` +
    `${delta.stillSurviving.length} still surviving; ${delta.newSurvivors.length} new. ` +
    'stillSurviving: add or strengthen tests for these. ' +
    'newSurvivors: your change introduced these uncaught mutants on the same lines.';
  // `=== false` so an engine that never reports `complete` reads exactly as before.
  if (delta.complete === false) return `${partialVerifyNote(delta)} ${counts}`;
  return counts;
}

/**
 * The delta fields a verify response reports, in both projections.
 *
 * Text and JSON are two projections of ONE payload in this codebase, so the
 * partial-run fields (`notReChecked` and the `complete`/batch provenance behind
 * it) are emitted by both — and by `audit-output.ts`'s `structuredContent`,
 * which spreads the same object.
 *
 * The provenance keys are spread only when present so a complete re-run's
 * response is byte-identical to the one it produced before this existed.
 */
export function verifyPayloadFields(delta: VerifyDelta): Record<string, unknown> {
  const out: Record<string, unknown> = {
    baselineTotal: delta.baselineTotal,
    killedCount: delta.nowKilled.length,
    nowKilled: delta.nowKilled,
    stillSurviving: delta.stillSurviving,
    newSurvivors: delta.newSurvivors,
  };
  // Absent for a complete re-run: a caller that never sees a partial run must
  // not have to learn a field that is always `[]` for them.
  if (delta.notReChecked.length > 0) out.notReChecked = delta.notReChecked;
  if (delta.complete !== undefined) out.complete = delta.complete;
  if (delta.batchesCompleted !== undefined) out.batchesCompleted = delta.batchesCompleted;
  if (delta.batchesPlanned !== undefined) out.batchesPlanned = delta.batchesPlanned;
  if (delta.stoppedReason !== undefined) out.stoppedReason = delta.stoppedReason;
  return out;
}

/**
 * Render a verify gate verdict as a single report line.
 *
 * The counterpart of `formatGateLine` in `core/format.ts`, and it exists for
 * the same documented reason: text output that computed a gate and then dropped
 * it showed a caller reading only the text block a report identical to a
 * passing one, with no `isError` either — a failing CI gate that looks clean.
 * Its wording differs because a verify has no score to quote: the verdict is
 * about the baseline, not about a percentage.
 *
 * Exported so `audit/scope.ts` can render the same line on its clean-baseline
 * verify short-circuit rather than growing a second copy of the wording.
 */
export function formatVerifyGateLine(gate: GateResult): string {
  if (gate.passed) return `Gate: passed (minScore ${gate.minScore})`;
  if (gate.reason === 'partial_audit') {
    return `Gate: FAILED (minScore ${gate.minScore}) — the re-run did not complete, so the baseline was not fully re-checked and cannot be graded.`;
  }
  return `Gate: FAILED (minScore ${gate.minScore}) — the baseline is not clear: mutants are still surviving and/or new ones appeared.`;
}

/** Render the verify delta as compact JSON. */
export function formatVerifyResultAsJson(
  target: string,
  delta: VerifyDelta,
  gate?: GateResult,
): string {
  const payload: Record<string, unknown> = {
    target,
    mode: 'verify',
    ...verifyPayloadFields(delta),
    note: buildVerifyNote(delta),
  };
  // Last, and only when asked for, so a call without `minScore` serialises
  // exactly the object it always did.
  if (gate) payload.gate = gate;
  return JSON.stringify(payload);
}

/** Render the verify delta as a compact human-readable summary. */
export function formatVerifyResultAsText(
  target: string,
  delta: VerifyDelta,
  gate?: GateResult,
): string {
  const lines: string[] = [`Chaos-MCP Verify Report: ${target}`];
  // The partial banner goes above everything, including the success shortcut
  // below — see {@link partialVerifyNote}. A re-run that covered a fraction of
  // the file can legitimately come back with nothing still surviving and no
  // regressions, and "All N previously-uncaught mutants are now killed." is
  // then a flat falsehood: N of them were never generated.
  if (delta.complete === false) lines.push(partialVerifyNote(delta));
  // Above the counts, mirroring the standard report, where the gate sits
  // directly under the score: a FAILED verdict reframes every number below it.
  // Emitted before the success shortcut so a gated verify never returns a text
  // block with no verdict in it at all.
  if (gate) lines.push(formatVerifyGateLine(gate));
  if (
    delta.complete !== false &&
    delta.stillSurviving.length === 0 &&
    delta.newSurvivors.length === 0
  ) {
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
  // Listed, not just counted: these are the mutants the caller still has to
  // account for, and a bare number in the note leaves them guessing which.
  if (delta.notReChecked.length > 0) {
    lines.push('Not re-checked (never generated by this partial run — status unknown):');
    for (const k of delta.notReChecked) lines.push(`  ${k.line}: ${k.mutator}`);
  }
  return lines.join('\n');
}
