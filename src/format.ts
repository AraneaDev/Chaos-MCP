/**
 * Output formatting for audit results.
 *
 * Extracted from index.ts. The raw engine output repeats an identical
 * boilerplate description for every mutant (often dozens per file), which is
 * token-inefficient for an LLM consumer. These helpers bundle mutants by line,
 * collapse duplicate mutators to counts, and state the explanation once.
 */

import type { MutationResult } from './engines/base.js';

/** Matches the NoCoverage marker engines embed in a vulnerability description. */
const NO_COVERAGE_RE = /no test reached|nocoverage/i;

/** Max distinct change-strings shown per line group before truncation. */
const CHANGES_CAP = 3;

interface LineGroup {
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

/** Render a `{ ConditionalExpression: 2, LogicalOperator: 1 }` map as "ConditionalExpression×2, LogicalOperator". */
function formatMutators(mutators: Record<string, number>): string {
  return Object.entries(mutators)
    .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
    .join(', ');
}

/**
 * Format a MutationResult as a compact, human-readable text summary.
 * Used when the caller requests `outputFormat: 'text'`.
 */
export function formatResultAsText(result: MutationResult): string {
  const { survivors, noCoverage } = compactSurvivors(result);
  const lines: string[] = [
    `Chaos-MCP Audit Report: ${result.target}`,
    `Mutation score: ${result.mutationScore} (${result.killed}/${result.totalMutants} killed, ${result.survived} survived)`,
  ];

  if (result.scopeNote) {
    lines.push(`Scope: ${result.scopeNote}`);
  }

  if (survivors.length === 0 && noCoverage.length === 0) {
    lines.push('✅ No surviving mutants — your tests caught all mutations.');
    return lines.join('\n');
  }

  if (survivors.length > 0) {
    lines.push(`Survivors (line: mutators):`);
    for (const s of survivors) {
      const suffix = s.changes ? `  (${s.changes.join('; ')})` : '';
      lines.push(`  ${s.line}: ${formatMutators(s.mutators)}${suffix}`);
    }
  }
  if (noCoverage.length > 0) {
    lines.push(`No-coverage mutants (line: mutators):`);
    for (const n of noCoverage) {
      const suffix = n.changes ? `  (${n.changes.join('; ')})` : '';
      lines.push(`  ${n.line}: ${formatMutators(n.mutators)}${suffix}`);
    }
  }
  lines.push('Add or strengthen tests targeting these lines to kill the survivors.');

  return lines.join('\n');
}

/**
 * Format a MutationResult as a compact JSON payload (single-line, deduplicated).
 * Used for the default `outputFormat: 'json'`.
 */
export function formatResultAsJson(result: MutationResult): string {
  const { survivors, noCoverage } = compactSurvivors(result);
  const clean = survivors.length === 0 && noCoverage.length === 0;
  const hasChanges = [...survivors, ...noCoverage].some((g) => g.changes);
  const baseNote =
    'survivors: mutants your tests ran but did not kill. noCoverage: mutants no test reached (per line+mutator, so a line may appear here and in survivors). mutators = type→count. Add or strengthen tests targeting these.';
  const payload: Record<string, unknown> = {
    target: result.target,
    mutationScore: result.mutationScore,
    summary: { total: result.totalMutants, killed: result.killed, survived: result.survived },
    survivors,
    noCoverage,
    note: clean
      ? 'No surviving mutants — the test suite caught every mutation.'
      : hasChanges
        ? `${baseNote} changes = sampled original→mutated edits for that line (capped).`
        : baseNote,
  };
  if (result.scopeNote) payload.scopeNote = result.scopeNote;
  return JSON.stringify(payload);
}
