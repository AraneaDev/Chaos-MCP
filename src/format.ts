/**
 * Output formatting for audit results.
 *
 * Extracted from index.ts. The raw engine output repeats an identical
 * boilerplate description for every mutant (often dozens per file), which is
 * token-inefficient for an LLM consumer. These helpers bundle mutants by line,
 * collapse duplicate mutators to counts, and state the explanation once.
 */

import type { MutationResult } from './engines/base.js';
import type { SupportedProjectType } from './engines/registry.js';
import { enrichGroup, SEVERITY_RANK, type Severity, type Enrichment } from './enrich.js';
import type { GateResult } from './gate.js';
import { warn } from './utils/logger.js';

export interface EnrichContext {
  projectType: SupportedProjectType;
  sourceLines?: string[];
}

/** Matches the NoCoverage marker engines embed in a vulnerability description. */
export const NO_COVERAGE_RE = /no test reached|nocoverage/i;

/**
 * A result with zero enumerated mutants and no scope note has no mutable logic:
 * its "100%" score would misread as proven coverage. Both `audit_code_resilience`
 * and `triage_test_coverage` must substitute "n/a" and flag the row so a file with
 * no testable logic is not ranked as "safest" indistinguishably from a genuinely
 * perfect kill rate (audit M3). A scopeNote-carrying zero (e.g. a diff no-change)
 * is a real scoped run and is left as-is.
 */
export function hasNoMutableLogic(result: MutationResult): boolean {
  return result.totalMutants === 0 && !result.scopeNote;
}

/** Display score for a result: "n/a" when it has no mutable logic, else the raw score. */
export function displayMutationScore(result: MutationResult): string {
  return hasNoMutableLogic(result) ? 'n/a' : result.mutationScore;
}

/** Max distinct change-strings shown per line group before truncation. */
const CHANGES_CAP = 3;

export interface LineGroup {
  line: number;
  mutators: Record<string, number>;
  changes?: string[];
}

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

/** Group accumulated line entries into sorted {line, mutators, changes?} groups. */
function groupByLine(byLine: Map<number, LineAcc>): LineGroup[] {
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, acc]) => {
      const group: LineGroup = { line, mutators: acc.mutators };
      const changes = capChanges(acc.changes);
      if (changes) group.changes = changes;
      return group;
    });
}

function compactSurvivors(result: MutationResult): {
  survivors: LineGroup[];
  noCoverage: LineGroup[];
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
    const target = NO_COVERAGE_RE.test(v.description) ? noCoverageByLine : survivorsByLine;
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
): { groups: EnrichedGroup[]; worst: Severity; hasUnknown: boolean } {
  const enriched: EnrichedGroup[] = groups.map((g) => ({
    ...g,
    ...enrichGroup({
      line: g.line,
      mutators: g.mutators,
      changes: g.changes,
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
    /** When the caller asked for severityFloor without enrichment (M6). */
    floorIgnoredNote?: string;
  } = {},
): string {
  const compact = compactSurvivors(result);
  let survivors = compact.survivors;
  let noCoverage = compact.noCoverage;
  // A file with zero enumerated mutants AND no scope note has no mutable logic
  // (only constants, type hints, or straight delegation). Reporting "100%" there
  // reads as proven coverage when nothing was actually tested — show "n/a".
  // A scopeNote (e.g. diff "no changed lines") is a different, already-explained
  // zero, so leave it untouched.
  const noMutants = result.totalMutants === 0 && !result.scopeNote;
  const lines: string[] = [
    `Chaos-MCP Audit Report: ${result.target}`,
    `Mutation score: ${noMutants ? 'n/a' : result.mutationScore} (${result.killed}/${result.totalMutants} killed, ${result.survived} survived)`,
  ];
  if (result.scopeNote) lines.push(`Scope: ${result.scopeNote}`);
  // Surface unscoreable mutants in text format too (audit L6) so a caller
  // asking for human-readable output can see why total < generated.
  if (result.incompetent && result.incompetent > 0) {
    lines.push(
      `Note: ${result.incompetent} mutant(s) excluded as incompetent (mutated code never produced a real pass/fail).`,
    );
  }
  // If the caller asked for severityFloor but enrichment data is missing,
  // surface the floor-ignored note here as well — the JSON path already
  // attaches it via enrichNote, but text users got nothing (audit M6).
  if (opts.floorIgnoredNote) {
    lines.push(opts.floorIgnoredNote);
  }

  if (survivors.length === 0 && noCoverage.length === 0) {
    lines.push(
      noMutants
        ? 'No mutants generated — this file has no mutable logic, so mutation testing is not meaningful here (this is not the same as proven coverage).'
        : 'No surviving mutants — your tests caught all mutations.',
    );
    return lines.join('\n');
  }

  const enriched = Boolean(enrich);
  if (enrich) {
    survivors = enrichGroups(survivors, enrich).groups;
    noCoverage = enrichGroups(noCoverage, enrich).groups;
  }

  const sFloorText = floorGroups(survivors, opts.severityFloor, enriched);
  const nFloorText = floorGroups(noCoverage, opts.severityFloor, enriched);
  survivors = sFloorText.groups;
  noCoverage = nFloorText.groups;

  const sCap = capGroups(survivors, opts.maxSurvivors);
  const nCap = capGroups(noCoverage, opts.maxSurvivors);
  survivors = sCap.groups;
  noCoverage = nCap.groups;

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
    if (sCap.truncated > 0)
      lines.push(`  …${sCap.truncated} more (raise maxSurvivors to see them)`);
    if (sFloorText.filtered > 0) lines.push(`  …${sFloorText.filtered} hidden below severityFloor`);
  }
  if (noCoverage.length > 0) {
    lines.push(`No-coverage mutants (line: mutators):`);
    noCoverage.forEach(renderGroup);
    if (nCap.truncated > 0)
      lines.push(`  …${nCap.truncated} more (raise maxSurvivors to see them)`);
    if (nFloorText.filtered > 0) lines.push(`  …${nFloorText.filtered} hidden below severityFloor`);
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
  enrichNote?: string;
  note: string;
  runId?: string;
  suppressedCount?: number;
  gate?: GateResult;
  /** Mutants excluded from the score because the mutated code never scored (audit I3). */
  incompetent?: number;
}

export interface ResultPayloadOpts {
  enrich?: EnrichContext;
  maxSurvivors?: number;
  severityFloor?: Severity;
  suggestedTestFile?: { path: string; exists: boolean };
  ignoredOptions?: string[];
  runId?: string;
  suppressedCount?: number;
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
  const { enrich } = opts;
  const compact = compactSurvivors(result);
  let survivors: LineGroup[] = compact.survivors;
  let noCoverage: LineGroup[] = compact.noCoverage;
  const clean = survivors.length === 0 && noCoverage.length === 0;

  const enriched = Boolean(enrich);
  let worstSeverity: Severity | undefined;
  let enrichNote: string | undefined;
  if (enrich) {
    const s = enrichGroups(survivors, enrich);
    const n = enrichGroups(noCoverage, enrich);
    survivors = s.groups;
    noCoverage = n.groups;
    if (survivors.length > 0 || noCoverage.length > 0) {
      const candidates: Severity[] = [];
      if (survivors.length > 0) candidates.push(s.worst);
      if (noCoverage.length > 0) candidates.push(n.worst);
      worstSeverity = candidates.reduce((a, b) => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b));
    }
    if (s.hasUnknown || n.hasUnknown) {
      enrichNote =
        'some mutants could not be classified — this language\'s mutation tool doesn\'t expose per-mutant operator detail (severity reported as "unknown").';
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
  survivors = sCap.groups;
  noCoverage = nCap.groups;

  const hasChanges = [...survivors, ...noCoverage].some((g) => g.changes);
  const baseNote =
    'survivors: mutants your tests ran but did not kill. noCoverage: mutants no test reached (per line+mutator, so a line may appear here and in survivors). mutators = type→count. Add or strengthen tests targeting these.';

  const summary: ResultPayload['summary'] = {
    total: result.totalMutants,
    killed: result.killed,
    survived: result.survived,
  };
  if (worstSeverity) summary.worstSeverity = worstSeverity;

  // Zero enumerated mutants and no scope note ⇒ no mutable logic; "100%" would
  // misread as proven coverage. Surface "n/a" + an honest note instead
  // (evaluateGate treats a non-numeric score as passing, so gates are
  // unaffected). A scopeNote-carrying zero (e.g. diff no-change) is left as-is.
  const noMutants = hasNoMutableLogic(result);
  const payload: ResultPayload = {
    target: result.target,
    mutationScore: noMutants ? 'n/a' : result.mutationScore,
    summary,
    survivors,
    noCoverage,
    note: clean
      ? noMutants
        ? 'No mutants generated — this file has no mutable logic, so mutation testing is not meaningful here (not the same as proven coverage).'
        : 'No surviving mutants — the test suite caught every mutation.'
      : hasChanges
        ? `${baseNote} changes = sampled original→mutated edits for that line (capped).`
        : baseNote,
  };
  if (sCap.truncated > 0) payload.survivorsTruncated = sCap.truncated;
  if (nCap.truncated > 0) payload.noCoverageTruncated = nCap.truncated;
  if (sFloor.filtered > 0) payload.survivorsFiltered = sFloor.filtered;
  if (nFloor.filtered > 0) payload.noCoverageFiltered = nFloor.filtered;
  if (enrichNote) payload.enrichNote = enrichNote;
  if (result.scopeNote) payload.scopeNote = result.scopeNote;
  if (opts.suggestedTestFile) payload.suggestedTestFile = opts.suggestedTestFile;
  if (opts.ignoredOptions && opts.ignoredOptions.length > 0)
    payload.ignoredOptions = opts.ignoredOptions;
  if (opts.runId) payload.runId = opts.runId;
  if (opts.suppressedCount && opts.suppressedCount > 0) {
    payload.suppressedCount = opts.suppressedCount;
    payload.note += ` ${opts.suppressedCount} equivalent mutant(s) suppressed and excluded from the score.`;
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
