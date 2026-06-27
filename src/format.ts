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

export interface EnrichContext {
  projectType: SupportedProjectType;
  sourceLines?: string[];
}

/** Matches the NoCoverage marker engines embed in a vulnerability description. */
const NO_COVERAGE_RE = /no test reached|nocoverage/i;

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

  for (const v of result.vulnerabilities) {
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
function capGroups(groups: LineGroup[], max: number | undefined): { groups: LineGroup[]; truncated: number } {
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
  const kept = groups.filter((g) => SEVERITY_RANK[(g as EnrichedGroup).severity ?? 'unknown'] >= min);
  return { groups: kept, filtered: groups.length - kept.length };
}

/**
 * Format a MutationResult as a compact, human-readable text summary.
 * Used when the caller requests `outputFormat: 'text'`.
 */
export function formatResultAsText(
  result: MutationResult,
  enrich?: EnrichContext,
  opts: { maxSurvivors?: number; severityFloor?: Severity } = {},
): string {
  const compact = compactSurvivors(result);
  let survivors = compact.survivors;
  let noCoverage = compact.noCoverage;
  const lines: string[] = [
    `Chaos-MCP Audit Report: ${result.target}`,
    `Mutation score: ${result.mutationScore} (${result.killed}/${result.totalMutants} killed, ${result.survived} survived)`,
  ];
  if (result.scopeNote) lines.push(`Scope: ${result.scopeNote}`);

  if (survivors.length === 0 && noCoverage.length === 0) {
    lines.push('No surviving mutants — your tests caught all mutations.');
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
    if (sCap.truncated > 0) lines.push(`  …${sCap.truncated} more (raise maxSurvivors to see them)`);
  }
  if (noCoverage.length > 0) {
    lines.push(`No-coverage mutants (line: mutators):`);
    noCoverage.forEach(renderGroup);
    if (nCap.truncated > 0) lines.push(`  …${nCap.truncated} more (raise maxSurvivors to see them)`);
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
}

export interface ResultPayloadOpts {
  enrich?: EnrichContext;
  maxSurvivors?: number;
  severityFloor?: Severity;
  suggestedTestFile?: { path: string; exists: boolean };
  ignoredOptions?: string[];
}

/**
 * Build the structured result payload object from a MutationResult.
 * Pure data construction — no serialization. Becomes the `structuredContent`
 * and drives the `outputSchema` contract in future tasks.
 */
export function buildResultPayload(result: MutationResult, opts: ResultPayloadOpts = {}): ResultPayload {
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
    if (survivors.length > 0) worstSeverity = s.worst;
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

  const payload: ResultPayload = {
    target: result.target,
    mutationScore: result.mutationScore,
    summary,
    survivors,
    noCoverage,
    note: clean
      ? 'No surviving mutants — the test suite caught every mutation.'
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
  return payload;
}

/**
 * Format a MutationResult as a compact JSON payload (single-line, deduplicated).
 * Used for the default `outputFormat: 'json'`.
 */
export function formatResultAsJson(result: MutationResult, enrich?: EnrichContext): string {
  return JSON.stringify(buildResultPayload(result, { enrich }));
}
