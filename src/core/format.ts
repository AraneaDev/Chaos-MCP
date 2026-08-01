/**
 * Output formatting for audit results.
 *
 * Extracted from index.ts. The raw engine output repeats an identical
 * boilerplate description for every mutant (often dozens per file), which is
 * token-inefficient for an LLM consumer. These helpers bundle mutants by line,
 * collapse duplicate mutators to counts, and state the explanation once.
 */

import type { MutationResult } from '../engines/base.js';
import type { SupportedProjectType } from '../utils/project-detector.js';
import { ENGINE_REGISTRY } from '../engines/registry.js';
import { enrichGroup, SEVERITY_RANK, type Severity, type Enrichment } from './enrich.js';
import type { GateResult } from './gate.js';
import { warn } from '../utils/logger.js';
import { isNoCoverage } from '../utils/no-coverage.js';
// Score/suppression vocabulary lives in its own leaf module: `triage.ts` renders
// an independent leaderboard and needs the same meanings without importing this
// renderer. Import direction is one-way — score-semantics.ts never imports here.
import {
  displayMutationScore,
  hasNoMutableLogic,
  suppressionDriftNotes,
  type LineGroup,
} from './score-semantics.js';

export interface EnrichContext {
  projectType: SupportedProjectType;
  sourceLines?: string[];
}

/** Max distinct change-strings shown per line group before truncation. */
const CHANGES_CAP = 3;

interface LineAcc {
  mutators: Record<string, number>;
  changes: Set<string>;
}

/** Build a single-line "original → mutated" change string, degrading gracefully. */
function buildChange(original?: string, mutated?: string): string | undefined {
  const norm = (s?: string) => (s === undefined ? '' : s.replace(/\s+/g, ' ').trim());
  const o = norm(original);
  const m = norm(mutated);
  if (o && m) return `${o} → ${m}`;
  if (m) return m; // mutated-only (e.g. Rust description) or empty original
  if (o) return o; // mutated empty — surface the original at least
  return undefined;
}

/** Cap a change set to CHANGES_CAP distinct entries, appending a "…N more" sentinel. */
function capChanges(set: Set<string>): string[] | undefined {
  if (set.size === 0) return undefined;
  const all = [...set];
  if (all.length <= CHANGES_CAP) return all;
  const shown = all.slice(0, CHANGES_CAP);
  shown.push(`…${all.length - CHANGES_CAP} more`);
  return shown;
}

/**
 * Line groups for rendering, plus the UNCAPPED change strings behind them.
 *
 * The two are separated because they serve different consumers (audit: severity
 * derived from a capped change string). `LineGroup.changes` is a DISPLAY field:
 * capped at CHANGES_CAP with a "…N more" sentinel so a hot line doesn't flood
 * the report. Enrichment, however, treats change text as EVIDENCE — for Rust it
 * is the only evidence there is, since cargo-mutants exposes no operator name
 * and `canonicalizeMutator` matches the description alone. Feeding it the capped
 * list means a mutant whose `&&` lands in change #4 cannot influence its own
 * severity, and `RUST_DESCRIPTION_RULES` is ordered logical-first precisely so
 * that `&&`/`||` outranks a stray operator character. So: enrich from
 * `uncapped`, render from `groups`.
 */
interface CompactedGroups {
  groups: LineGroup[];
  /** line → every distinct change string seen on it, before the display cap. */
  uncapped: Map<number, string[]>;
}

/** Group accumulated line entries into sorted {line, mutators, changes?} groups. */
function groupByLine(byLine: Map<number, LineAcc>): CompactedGroups {
  const uncapped = new Map<number, string[]>();
  const groups = [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, acc]) => {
      const group: LineGroup = { line, mutators: acc.mutators };
      if (acc.changes.size > 0) uncapped.set(line, [...acc.changes]);
      const changes = capChanges(acc.changes);
      if (changes) group.changes = changes;
      return group;
    });
  return { groups, uncapped };
}

function compactSurvivors(result: MutationResult): {
  survivors: CompactedGroups;
  noCoverage: CompactedGroups;
} {
  const survivorsByLine = new Map<number, LineAcc>();
  const noCoverageByLine = new Map<number, LineAcc>();

  let sentinelSeen = false;
  for (const v of result.vulnerabilities) {
    // A line < 1 is the parsers' "location unknown" sentinel (python.ts/rust.ts
    // fall back to 0 when location parsing fails). enrich.ts guards it, but the
    // compact/verify/suppression paths key on the raw line. Surface the anomaly
    // once so a "0: …" group isn't silently mistaken for a real line (audit L7).
    if (v.line < 1) sentinelSeen = true;
    // NoCoverage mutants are grouped separately AND at the same (line, mutator)
    // granularity as survivors — a NoCoverage mutant on a line can coexist with
    // covered survivors on that same line (e.g. an unreachable `|| []` fallback
    // next to a live `.filter`), so reporting a bare line number would wrongly
    // imply the whole line is uncovered.
    const target = isNoCoverage(v) ? noCoverageByLine : survivorsByLine;
    const acc = target.get(v.line) ?? { mutators: {}, changes: new Set<string>() };
    acc.mutators[v.mutator] = (acc.mutators[v.mutator] ?? 0) + 1;
    const change = buildChange(v.original, v.mutated);
    if (change) acc.changes.add(change);
    target.set(v.line, acc);
  }

  if (sentinelSeen) {
    warn(
      `${result.target}: one or more mutants have an unknown source line (sentinel < 1); ` +
        'the mutation tool did not report a parseable location for them.',
    );
  }

  return { survivors: groupByLine(survivorsByLine), noCoverage: groupByLine(noCoverageByLine) };
}

/** A LineGroup augmented with its enrichment fields (severity, why, hint, context). */
export type EnrichedGroup = LineGroup & Enrichment;

/**
 * Enrich + re-rank line groups: attach severity/why/hint/context to each group,
 * then sort severity-descending, line-ascending. Returns the enriched groups
 * plus the worst severity seen and whether any group was unclassified.
 */
function enrichGroups(
  groups: LineGroup[],
  enrich: EnrichContext,
  uncapped: Map<number, string[]>,
): { groups: EnrichedGroup[]; worst: Severity; hasUnknown: boolean } {
  const enriched: EnrichedGroup[] = groups.map((g) => ({
    ...g,
    ...enrichGroup({
      line: g.line,
      // The UNCAPPED change set, not `g.changes`: severity must be decided on
      // all the evidence, not on the first CHANGES_CAP entries plus a "…N more"
      // sentinel that no rule can match. Falls back to the display list only if
      // a caller ever builds groups without going through `compactSurvivors`.
      changes: uncapped.get(g.line) ?? g.changes,
      mutators: g.mutators,
      projectType: enrich.projectType,
      sourceLines: enrich.sourceLines,
    }),
  }));
  enriched.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.line - b.line);
  let worst: Severity = 'unknown';
  let hasUnknown = false;
  for (const g of enriched) {
    if (SEVERITY_RANK[g.severity] > SEVERITY_RANK[worst]) worst = g.severity;
    if (g.severity === 'unknown') hasUnknown = true;
  }
  return { groups: enriched, worst, hasUnknown };
}

/** Render a `{ ConditionalExpression: 2, LogicalOperator: 1 }` map as "ConditionalExpression×2, LogicalOperator". */
function formatMutators(mutators: Record<string, number>): string {
  return Object.entries(mutators)
    .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
    .join(', ');
}

/**
 * Cap a list of line groups to at most `max` entries.
 * Returns the (possibly sliced) groups and the truncation count.
 */
function capGroups(
  groups: LineGroup[],
  max: number | undefined,
): { groups: LineGroup[]; truncated: number } {
  if (typeof max !== 'number' || groups.length <= max) return { groups, truncated: 0 };
  return { groups: groups.slice(0, max), truncated: groups.length - max };
}

/**
 * Filter out line groups whose severity is below `floor`.
 * Only has an effect when `enriched` is true (severity data is present).
 * Returns the kept groups and the count of dropped groups.
 */
function floorGroups(
  groups: LineGroup[],
  floor: Severity | undefined,
  enriched: boolean,
): { groups: LineGroup[]; filtered: number } {
  if (!enriched || !floor) return { groups, filtered: 0 };
  const min = SEVERITY_RANK[floor];
  const kept = groups.filter(
    (g) => SEVERITY_RANK[(g as EnrichedGroup).severity ?? 'unknown'] >= min,
  );
  return { groups: kept, filtered: groups.length - kept.length };
}

/** The shared group pipeline's output, consumed by both entry points. */
export interface PreparedGroups {
  /** Survivor groups after enrich → floor → cap. */
  survivors: LineGroup[];
  /** No-coverage groups after enrich → floor → cap. */
  noCoverage: LineGroup[];
  /** Whether the result had no survivor and no no-coverage group at all (pre-filter). */
  clean: boolean;
  survivorsTruncated: number;
  noCoverageTruncated: number;
  survivorsFiltered: number;
  noCoverageFiltered: number;
  /** Highest severity across the non-empty enriched group lists; only set when enriching. */
  worstSeverity?: Severity;
  /** Advisory about unclassifiable mutants, or an ignored severityFloor. */
  enrichNote?: string;
}

/**
 * Explain, per language, why some mutants came back with severity "unknown".
 *
 * The single note this replaced claimed for EVERY language that "this language's
 * mutation tool doesn't expose per-mutant operator detail". That is true of
 * cargo-mutants alone, which reports a free-text description and no operator
 * field. StrykerJS, cosmic-ray and Infection all name the operator, and the
 * engines store it — so an "unknown" from those three means the name is not one
 * this server's tables map, which is a gap here and not a limitation of the
 * caller's tooling. The old wording sent a PHP user off to look for a better
 * mutation tool when every PHP mutant was unknown for want of a lookup table
 * (audit: PHP severities all `unknown` under a factually false note).
 *
 * Which languages get the tool-blaming version is therefore a per-ENGINE fact,
 * and it is declared as one: `unclassifiedMutatorNote` on the engine registry's
 * descriptor. Absent — the honest default — the generic wording below applies,
 * which is the correct explanation for every engine that names its operators.
 * This used to be an `=== 'rust'` branch here, in a formatting module with no
 * knowledge of any engine's output shape.
 */
function unclassifiedNote(projectType: SupportedProjectType): string {
  // `?.`: an unrecognised projectType must still get the generic sentence, as
  // it did when this was an `=== 'rust'` branch.
  const engineNote = ENGINE_REGISTRY[projectType]?.unclassifiedMutatorNote;
  if (engineNote !== undefined) return engineNote;
  return `some mutants could not be classified — their ${projectType} operator name is not one this server maps to a severity category (severity reported as "unknown"). The line still deserves a look; only its risk ranking is missing.`;
}

export interface PrepareGroupsOpts {
  enrich?: EnrichContext;
  maxSurvivors?: number;
  severityFloor?: Severity;
}

/**
 * Compact a MutationResult into line groups and run the five-stage pipeline
 * (compact → enrich → floor → cap, plus the worst-severity reduce) that both
 * `formatResultAsText` and `buildResultPayload` need.
 *
 * Previously each entry point reassembled these stages independently, which is
 * how the `hasNoMutableLogic` predicate came to be spelled two ways in one file.
 * The stages themselves are unchanged and run in the same order as before;
 * `clean` is captured before any filtering so the text path can still short-
 * circuit on "nothing to report" rather than on "nothing survived the floor".
 */
function prepareGroups(result: MutationResult, opts: PrepareGroupsOpts): PreparedGroups {
  const compact = compactSurvivors(result);
  let survivors: LineGroup[] = compact.survivors.groups;
  let noCoverage: LineGroup[] = compact.noCoverage.groups;
  const clean = survivors.length === 0 && noCoverage.length === 0;

  const { enrich } = opts;
  const enriched = Boolean(enrich);
  let worstSeverity: Severity | undefined;
  let enrichNote: string | undefined;
  if (enrich) {
    const s = enrichGroups(survivors, enrich, compact.survivors.uncapped);
    const n = enrichGroups(noCoverage, enrich, compact.noCoverage.uncapped);
    survivors = s.groups;
    noCoverage = n.groups;
    if (survivors.length > 0 || noCoverage.length > 0) {
      const candidates: Severity[] = [];
      if (survivors.length > 0) candidates.push(s.worst);
      if (noCoverage.length > 0) candidates.push(n.worst);
      worstSeverity = candidates.reduce((a, b) => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b));
    }
    if (s.hasUnknown || n.hasUnknown) {
      enrichNote = unclassifiedNote(enrich.projectType);
    }
  }

  const sFloor = floorGroups(survivors, opts.severityFloor, enriched);
  const nFloor = floorGroups(noCoverage, opts.severityFloor, enriched);
  survivors = sFloor.groups;
  noCoverage = nFloor.groups;
  if (!enriched && opts.severityFloor) {
    enrichNote =
      'severityFloor was ignored: it requires enrichment (severity classification), which is off for this run.';
  }

  const sCap = capGroups(survivors, opts.maxSurvivors);
  const nCap = capGroups(noCoverage, opts.maxSurvivors);

  const prepared: PreparedGroups = {
    survivors: sCap.groups,
    noCoverage: nCap.groups,
    clean,
    survivorsTruncated: sCap.truncated,
    noCoverageTruncated: nCap.truncated,
    survivorsFiltered: sFloor.filtered,
    noCoverageFiltered: nFloor.filtered,
  };
  if (worstSeverity) prepared.worstSeverity = worstSeverity;
  if (enrichNote) prepared.enrichNote = enrichNote;
  return prepared;
}

/**
 * The "nothing survived" sentence for a run that stopped early.
 *
 * A partial run scores only the batches that finished. Saying "the test suite
 * caught every mutation" there claims full credit for a file that was merely
 * SAMPLED: the mutants in the batches that never ran are unknown, not killed,
 * and a reader who takes the sentence at face value stops testing a file that
 * was never fully measured. The producer half of this finding makes `runBatched`
 * throw when ZERO batches complete; this is the consumer half, for the runs that
 * completed some but not all of them. Wording states only what was measured.
 */
function partialCleanNote(result: MutationResult): string {
  const measured =
    result.batchesCompleted !== undefined && result.batchesPlanned !== undefined
      ? `the ${result.batchesCompleted} of ${result.batchesPlanned} batches that completed`
      : 'the part of this file that was measured';
  const why =
    result.stoppedReason === 'time_budget_exhausted'
      ? 'the time budget was exhausted before the rest could run'
      : 'the run stopped before the rest could run';
  return `No surviving mutants in ${measured} — ${why}, so the mutants that were never generated are unknown, not killed. Re-run with a larger time budget for a verdict on the whole file.`;
}

/**
 * The "nothing survived" sentence for a run that deliberately generated nothing.
 *
 * Distinct from both siblings above. `hasNoMutableLogic` covers "we mutated the
 * whole file and it has no mutable logic"; `partialCleanNote` covers "we started
 * and stopped early". This is the third shape: a short-circuit that ran ZERO
 * mutants on purpose — a `diffBase` with no changed lines, or a verify whose
 * baseline recorded no uncaught mutants. Both set a `scopeNote` saying why, so
 * this sentence only has to avoid claiming credit and point at it.
 *
 * Found by running this tool on itself: the verify short-circuit reported
 * `total: 0` alongside "the test suite caught every mutation", which is false
 * for a run in which nothing was ever generated. "Caught every mutation" is only
 * ever true when at least one mutant actually ran.
 */
function noMutantsRanNote(): string {
  return 'No mutants were run, so this result is not a measurement of the test suite — see the scope note for why.';
}

/**
 * Pick the clean-result sentence: no mutable logic, a partial run, a
 * deliberate no-op, or a genuine all-killed result. Shared so the text report
 * and the payload cannot disagree about which of the four a given result is —
 * only about their own wording for the two cases where the run really did
 * cover the file.
 */
function cleanNote(result: MutationResult, wording: { noMutants: string; allKilled: string }) {
  if (hasNoMutableLogic(result)) return wording.noMutants;
  if (result.complete === false) return partialCleanNote(result);
  // Ordered last of the three guards: a zero-mutant result that is neither
  // "no mutable logic" nor a partial run is a short-circuit that ran nothing.
  if (result.totalMutants === 0) return noMutantsRanNote();
  return wording.allKilled;
}

/**
 * Render a gate verdict as a single report line.
 *
 * Text output computed and then dropped the gate entirely: `buildResultPayload`
 * puts it in `structuredContent`, but a caller reading only the text block saw a
 * report identical to a passing one and no `isError` either — a failing CI gate
 * that looks clean. Driven by the SAME {@link GateResult} the payload carries so
 * the two renderings cannot diverge.
 */
function formatGateLine(gate: GateResult, displayedScore: string): string {
  if (gate.passed) return `Gate: passed (minScore ${gate.minScore})`;
  if (gate.reason === 'partial_audit') {
    return `Gate: FAILED (minScore ${gate.minScore}) — the audit did not complete, so ${displayedScore} describes only part of the file and cannot be graded.`;
  }
  return `Gate: FAILED (minScore ${gate.minScore}) — score ${displayedScore} is below the threshold.`;
}

/**
 * Format a MutationResult as a compact, human-readable text summary.
 * Used when the caller requests `outputFormat: 'text'`.
 */
export function formatResultAsText(
  result: MutationResult,
  enrich?: EnrichContext,
  opts: {
    maxSurvivors?: number;
    severityFloor?: Severity;
    /** Suppressions rejected because their fingerprint no longer matches. */
    driftedSuppressions?: number;
    /** Suppressions rejected because they carry no fingerprint (v1 data). */
    unverifiedSuppressions?: number;
    /**
     * The gate verdict for this run, when the caller passed `minScore`. Must be
     * the same {@link GateResult} the payload carries — pass `evaluateGate`'s
     * result, do not re-derive one.
     */
    gate?: GateResult;
  } = {},
): string {
  // The text path ignores `prepared.worstSeverity` (a payload-only field) but
  // now emits `prepared.enrichNote`, the same wording the payload uses. It
  // previously took a `floorIgnoredNote` from the caller instead — a field NO
  // production caller ever set, so the note `prepareGroups` had already computed
  // was discarded here and never re-supplied, leaving text users with nothing
  // (audit M6, whose "fixed" comment was describing a path that did not run).
  // Everything else — the group pipeline and its truncation/filter counts — is
  // identical to the payload's.
  const prepared = prepareGroups(result, {
    enrich,
    maxSurvivors: opts.maxSurvivors,
    severityFloor: opts.severityFloor,
  });
  const { survivors, noCoverage } = prepared;
  // Rendered through the shared `displayMutationScore` rather than re-deciding
  // "n/a" here: a file with zero enumerated mutants has no percentage to report
  // and "100%" would read as proven coverage (audit M3).
  const displayedScore = displayMutationScore(result);
  const lines: string[] = [
    `Chaos-MCP Audit Report: ${result.target}`,
    `Mutation score: ${displayedScore} (${result.killed}/${result.totalMutants} killed, ${result.survived} survived)`,
  ];
  // Directly under the score, because a FAILED gate reframes every number above
  // and below it. Text output used to omit the verdict entirely.
  if (opts.gate) lines.push(formatGateLine(opts.gate, displayedScore));
  if (result.scopeNote) lines.push(`Scope: ${result.scopeNote}`);
  if (result.fidelityNote) lines.push(`Warning: ${result.fidelityNote}`);
  // Surface unscoreable mutants in text format too (audit L6) so a caller
  // asking for human-readable output can see why total < generated.
  if (result.incompetent && result.incompetent > 0) {
    lines.push(
      `Note: ${result.incompetent} mutant(s) excluded as incompetent (mutated code never produced a real pass/fail).`,
    );
  }
  // The enrichment advisory: either "some mutants could not be classified" or
  // "severityFloor was ignored". One computation in `prepareGroups` now feeds
  // both output formats, so text and JSON say the same thing (audit M6).
  if (prepared.enrichNote) {
    lines.push(prepared.enrichNote);
  }
  // Suppressions that were NOT applied. Emitted BEFORE the clean/early-return
  // branch: a file can come back clean and still be carrying stale suppressions,
  // and that is exactly when the reader most needs to know the score was not
  // helped by them.
  for (const n of suppressionDriftNotes(opts.driftedSuppressions, opts.unverifiedSuppressions)) {
    lines.push(`Note: ${n}`);
  }

  if (prepared.clean) {
    lines.push(
      cleanNote(result, {
        noMutants:
          'No mutants generated — this file has no mutable logic, so mutation testing is not meaningful here (this is not the same as proven coverage).',
        allKilled: 'No surviving mutants — your tests caught all mutations.',
      }),
    );
    return lines.join('\n');
  }

  const renderGroup = (g: LineGroup): void => {
    const suffix = g.changes ? `  (${g.changes.join('; ')})` : '';
    const e = g as Partial<Enrichment>;
    if (enrich && e.severity) {
      lines.push(`  ${g.line}: [${e.severity}] ${formatMutators(g.mutators)}${suffix}`);
      lines.push(`     why: ${e.why}`);
      lines.push(`     hint: ${e.hint}`);
      if (e.context) lines.push(`     context: ${e.context.join(' | ')}`);
    } else {
      lines.push(`  ${g.line}: ${formatMutators(g.mutators)}${suffix}`);
    }
  };

  if (survivors.length > 0) {
    lines.push(`Survivors (line: mutators):`);
    survivors.forEach(renderGroup);
    if (prepared.survivorsTruncated > 0)
      lines.push(`  …${prepared.survivorsTruncated} more (raise maxSurvivors to see them)`);
    if (prepared.survivorsFiltered > 0)
      lines.push(`  …${prepared.survivorsFiltered} hidden below severityFloor`);
  }
  if (noCoverage.length > 0) {
    lines.push(`No-coverage mutants (line: mutators):`);
    noCoverage.forEach(renderGroup);
    if (prepared.noCoverageTruncated > 0)
      lines.push(`  …${prepared.noCoverageTruncated} more (raise maxSurvivors to see them)`);
    if (prepared.noCoverageFiltered > 0)
      lines.push(`  …${prepared.noCoverageFiltered} hidden below severityFloor`);
  }
  // The severity floor removed EVERY group. `prepared.clean` is captured before
  // any filtering (see `prepareGroups`) and stays that way on purpose — flipping
  // it post-filter would print "No surviving mutants — your tests caught all
  // mutations." over a header that still reports a non-zero survivor count. But
  // pre-filter `clean` also means both render blocks above are skipped, and each
  // block owns its own "…N hidden below severityFloor" note, so neither fires:
  // the report used to end on "targeting these lines" with no lines above it.
  // Emit the hidden count here instead, and replace the trailing advice, which
  // would otherwise point the reader at a list that was never printed.
  const hiddenByFloor = prepared.survivorsFiltered + prepared.noCoverageFiltered;
  if (survivors.length === 0 && noCoverage.length === 0 && hiddenByFloor > 0) {
    lines.push(
      `…${hiddenByFloor} hidden below severityFloor — every surviving line group was filtered out, so none are listed above.`,
    );
    lines.push('Lower severityFloor to see them, or treat this file as clean at that severity.');
    return lines.join('\n');
  }
  lines.push('Add or strengthen tests targeting these lines to kill the survivors.');
  return lines.join('\n');
}

export interface ResultPayload {
  target: string;
  mutationScore: string;
  summary: { total: number; killed: number; survived: number; worstSeverity?: Severity };
  survivors: LineGroup[];
  noCoverage: LineGroup[];
  suggestedTestFile?: { path: string; exists: boolean };
  ignoredOptions?: string[];
  survivorsTruncated?: number;
  noCoverageTruncated?: number;
  survivorsFiltered?: number;
  noCoverageFiltered?: number;
  scopeNote?: string;
  /** Advisory that the run itself may misreport; see MutationResult.fidelityNote. */
  fidelityNote?: string;
  enrichNote?: string;
  note: string;
  runId?: string;
  suppressedCount?: number;
  /**
   * Stored suppressions that were NOT applied because their content fingerprint
   * no longer matches the source line they target (the code moved or changed).
   */
  driftedSuppressions?: number;
  /**
   * Stored suppressions that were NOT applied because they carry no fingerprint
   * at all — v1 entries, awaiting re-confirmation.
   */
  unverifiedSuppressions?: number;
  gate?: GateResult;
  /** Mutants excluded from the score because the mutated code never scored (audit I3). */
  incompetent?: number;
  complete?: boolean;
  batchesCompleted?: number;
  batchesPlanned?: number;
  stoppedReason?: 'time_budget_exhausted';
}

export interface ResultPayloadOpts {
  enrich?: EnrichContext;
  maxSurvivors?: number;
  severityFloor?: Severity;
  suggestedTestFile?: { path: string; exists: boolean };
  ignoredOptions?: string[];
  runId?: string;
  suppressedCount?: number;
  driftedSuppressions?: number;
  unverifiedSuppressions?: number;
  gate?: GateResult;
}

/**
 * Build the structured result payload object from a MutationResult.
 * Pure data construction — no serialization. Becomes the `structuredContent`
 * and drives the `outputSchema` contract in future tasks.
 */
export function buildResultPayload(
  result: MutationResult,
  opts: ResultPayloadOpts = {},
): ResultPayload {
  const prepared = prepareGroups(result, {
    enrich: opts.enrich,
    maxSurvivors: opts.maxSurvivors,
    severityFloor: opts.severityFloor,
  });
  const { survivors, noCoverage, clean } = prepared;

  const hasChanges = [...survivors, ...noCoverage].some((g) => g.changes);
  const baseNote =
    'survivors: mutants your tests ran but did not kill. noCoverage: mutants no test reached (per line+mutator, so a line may appear here and in survivors). mutators = type→count. Add or strengthen tests targeting these.';

  const summary: ResultPayload['summary'] = {
    total: result.totalMutants,
    killed: result.killed,
    survived: result.survived,
  };
  if (prepared.worstSeverity) summary.worstSeverity = prepared.worstSeverity;

  // A zero-mutant run has no percentage to report; "100%" would misread as
  // proven coverage, so `displayMutationScore` substitutes "n/a" and the note
  // below explains which kind of zero it was (`evaluateGate` treats a
  // non-numeric score as passing, so gates are unaffected).
  const payload: ResultPayload = {
    target: result.target,
    mutationScore: displayMutationScore(result),
    summary,
    survivors,
    noCoverage,
    note: clean
      ? cleanNote(result, {
          noMutants:
            'No mutants generated — this file has no mutable logic, so mutation testing is not meaningful here (not the same as proven coverage).',
          allKilled: 'No surviving mutants — the test suite caught every mutation.',
        })
      : hasChanges
        ? `${baseNote} changes = sampled original→mutated edits for that line (capped).`
        : baseNote,
  };
  if (prepared.survivorsTruncated > 0) payload.survivorsTruncated = prepared.survivorsTruncated;
  if (prepared.noCoverageTruncated > 0) payload.noCoverageTruncated = prepared.noCoverageTruncated;
  if (prepared.survivorsFiltered > 0) payload.survivorsFiltered = prepared.survivorsFiltered;
  if (prepared.noCoverageFiltered > 0) payload.noCoverageFiltered = prepared.noCoverageFiltered;
  if (prepared.enrichNote) payload.enrichNote = prepared.enrichNote;
  if (result.scopeNote) payload.scopeNote = result.scopeNote;
  if (result.fidelityNote) payload.fidelityNote = result.fidelityNote;
  if (result.complete !== undefined) payload.complete = result.complete;
  if (result.batchesCompleted !== undefined) payload.batchesCompleted = result.batchesCompleted;
  if (result.batchesPlanned !== undefined) payload.batchesPlanned = result.batchesPlanned;
  if (result.stoppedReason) payload.stoppedReason = result.stoppedReason;
  if (opts.suggestedTestFile) payload.suggestedTestFile = opts.suggestedTestFile;
  if (opts.ignoredOptions && opts.ignoredOptions.length > 0)
    payload.ignoredOptions = opts.ignoredOptions;
  if (opts.runId) payload.runId = opts.runId;
  if (opts.suppressedCount && opts.suppressedCount > 0) {
    payload.suppressedCount = opts.suppressedCount;
    payload.note += ` ${opts.suppressedCount} equivalent mutant(s) suppressed and excluded from the score.`;
  }
  // Suppressions that exist but were rejected. Reported separately from
  // `suppressedCount` because they did the opposite of suppressing: they left
  // the mutant in the score. Both fields stay absent (and `note` untouched)
  // when nothing drifted, so a healthy run reads exactly as it did before.
  if (opts.driftedSuppressions && opts.driftedSuppressions > 0) {
    payload.driftedSuppressions = opts.driftedSuppressions;
  }
  if (opts.unverifiedSuppressions && opts.unverifiedSuppressions > 0) {
    payload.unverifiedSuppressions = opts.unverifiedSuppressions;
  }
  for (const n of suppressionDriftNotes(opts.driftedSuppressions, opts.unverifiedSuppressions)) {
    payload.note += ` ${n}`;
  }
  if (opts.gate) payload.gate = opts.gate;
  // Surface mutants the tool could not score (e.g. cosmic-ray 'incompetent' or
  // compile failures). Previously produced but never exposed — a caller could
  // reasonably want to see why total < generated (audit I3).
  if (result.incompetent && result.incompetent > 0) {
    payload.incompetent = result.incompetent;
    payload.note += ` ${result.incompetent} mutant(s) were excluded as incompetent (the mutated code failed before a real pass/fail, so they don't count toward the score).`;
  }
  return payload;
}

/**
 * Format a MutationResult as a compact JSON payload (single-line, deduplicated).
 * Used for the default `outputFormat: 'json'`.
 */
export function formatResultAsJson(result: MutationResult, enrich?: EnrichContext): string {
  return JSON.stringify(buildResultPayload(result, { enrich }));
}
