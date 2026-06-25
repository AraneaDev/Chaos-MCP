/**
 * Output formatting for audit results.
 *
 * Extracted from index.ts. The raw engine output repeats an identical
 * boilerplate description for every mutant (often dozens per file), which is
 * token-inefficient for an LLM consumer. These helpers bundle mutants by line,
 * collapse duplicate mutators to counts, and state the explanation once.
 */

export interface MutationResultShape {
  target: string;
  totalMutants: number;
  killed: number;
  survived: number;
  mutationScore: string;
  vulnerabilities: { line: number; replacement: string; description: string }[];
}

/** Matches the NoCoverage marker engines embed in a vulnerability description. */
const NO_COVERAGE_RE = /no test reached|nocoverage/i;

interface LineGroup {
  line: number;
  mutators: Record<string, number>;
}

/** Group a set of vulnerabilities by line into sorted {line, mutators} entries. */
function groupByLine(byLine: Map<number, Record<string, number>>): LineGroup[] {
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, mutators]) => ({ line, mutators }));
}

function compactSurvivors(result: MutationResultShape): {
  survivors: LineGroup[];
  noCoverage: LineGroup[];
} {
  const survivorsByLine = new Map<number, Record<string, number>>();
  const noCoverageByLine = new Map<number, Record<string, number>>();

  for (const v of result.vulnerabilities) {
    // NoCoverage mutants are grouped separately AND at the same (line, mutator)
    // granularity as survivors — a NoCoverage mutant on a line can coexist with
    // covered survivors on that same line (e.g. an unreachable `|| []` fallback
    // next to a live `.filter`), so reporting a bare line number would wrongly
    // imply the whole line is uncovered.
    const target = NO_COVERAGE_RE.test(v.description) ? noCoverageByLine : survivorsByLine;
    const ops = target.get(v.line) ?? {};
    ops[v.replacement] = (ops[v.replacement] ?? 0) + 1;
    target.set(v.line, ops);
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
export function formatResultAsText(result: MutationResultShape): string {
  const { survivors, noCoverage } = compactSurvivors(result);
  const lines: string[] = [
    `Chaos-MCP Audit Report: ${result.target}`,
    `Mutation score: ${result.mutationScore} (${result.killed}/${result.totalMutants} killed, ${result.survived} survived)`,
  ];

  if (survivors.length === 0 && noCoverage.length === 0) {
    lines.push('✅ No surviving mutants — your tests caught all mutations.');
    return lines.join('\n');
  }

  if (survivors.length > 0) {
    lines.push(`Survivors (line: mutators):`);
    for (const s of survivors) {
      lines.push(`  ${s.line}: ${formatMutators(s.mutators)}`);
    }
  }
  if (noCoverage.length > 0) {
    lines.push(`No-coverage mutants (line: mutators):`);
    for (const n of noCoverage) {
      lines.push(`  ${n.line}: ${formatMutators(n.mutators)}`);
    }
  }
  lines.push('Add or strengthen tests targeting these lines to kill the survivors.');

  return lines.join('\n');
}

/**
 * Format a MutationResult as a compact JSON payload (single-line, deduplicated).
 * Used for the default `outputFormat: 'json'`.
 */
export function formatResultAsJson(result: MutationResultShape): string {
  const { survivors, noCoverage } = compactSurvivors(result);
  const clean = survivors.length === 0 && noCoverage.length === 0;
  return JSON.stringify({
    target: result.target,
    mutationScore: result.mutationScore,
    summary: { total: result.totalMutants, killed: result.killed, survived: result.survived },
    survivors,
    noCoverage,
    note: clean
      ? 'No surviving mutants — the test suite caught every mutation.'
      : 'survivors: mutants your tests ran but did not kill. noCoverage: mutants no test reached (per line+mutator, so a line may appear here and in survivors). mutators = type→count. Add or strengthen tests targeting these.',
  });
}
