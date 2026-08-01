/**
 * Reading the StrykerJS JSON report into a {@link MutationResult}.
 *
 * The status classification is the substance here, and it is pure: given a
 * parsed report it decides the denominator, the numerator, and which mutants
 * become vulnerabilities, with no filesystem or process involved. The engine
 * keeps only the file read.
 */
import { type MutationResult, type Vulnerability, formatMutationScore } from '../base.js';
import { log, warn, isVerbose } from '../../utils/logger.js';

/**
 * Structured JSON produced by the Stryker JSON reporter.
 */
export interface StrykerJsonReport {
  files: Record<
    string,
    {
      source: string;
      mutants: StrykerMutantRecord[];
    }
  >;
}

export interface StrykerMutantRecord {
  id: string;
  mutatorName: string;
  replacement: string;
  location: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  /**
   * Deliberately `string`, not a closed union of the statuses we know about.
   * `parseReport` reaches this shape through an UNCHECKED `JSON.parse(...) as
   * StrykerJsonReport` cast of a file produced by a separately-versioned schema
   * package (mutation-testing-report-schema), so a union here would be a
   * compile-time fiction. `mutation-testing-report-schema@3.7.3` already
   * declares a `"Pending"` status this engine has never handled. The three sets
   * below are the real classifier, and anything they do not recognise is
   * reported rather than silently absorbed.
   */
  status: string;
  statusReason?: string;
}

/**
 * Mutant statuses that are SCORED: they form the denominator, and
 * `Killed`/`Timeout` also form the numerator (a timeout means the mutant was
 * detected — it made the suite hang).
 *
 * This is an ALLOW-list on purpose. It used to be a deny-list (`status !==
 * 'CompileError' && !== 'RuntimeError' && !== 'Ignored'`), which meant any status
 * Stryker's schema gains later — `Pending` exists in the schema package today —
 * would land in the denominator as "valid but neither killed nor survived",
 * inflating it and silently lowering every score with no warning at all.
 */
const SCORED_STATUSES: ReadonlySet<string> = new Set([
  'Killed',
  'Survived',
  'NoCoverage',
  'Timeout',
]);

/**
 * Statuses where the mutated code never produced a real pass/fail: it failed to
 * compile, or blew up before the suite could judge it. Excluded from the
 * denominator (they would penalise a score for a fault of the mutant, not the
 * tests) but counted into `MutationResult.incompetent`, which `engines/base.ts`
 * documents as covering exactly "Stryker compile errors". Without that count a
 * file where 40 of 100 mutants fail to compile reported a total of 60 with no
 * explanation of where the other 40 went (gap audit I3).
 */
const INCOMPETENT_STATUSES: ReadonlySet<string> = new Set(['CompileError', 'RuntimeError']);

/**
 * Statuses excluded on purpose by configuration (`mutator.excludedMutations`,
 * `// Stryker disable` comments). Kept SEPARATE from `incompetent`: nothing
 * failed, the operator asked for these not to run, so reporting them as
 * unscoreable failures would be misleading. They are silently dropped.
 */
const EXCLUDED_STATUSES: ReadonlySet<string> = new Set(['Ignored']);

/**
 * Slice the original source span a mutant replaced, from the report's embedded
 * file source. 1-based lines/columns, exclusive end column. Returns undefined
 * (never throws) when the location falls outside the source.
 */
function sliceSource(source: string, loc: StrykerMutantRecord['location']): string | undefined {
  const lines = source.split('\n');
  const { start, end } = loc;
  if (
    start.line < 1 ||
    end.line < 1 ||
    start.line > lines.length ||
    end.line > lines.length ||
    start.column < 1 ||
    end.column < 1
  ) {
    return undefined;
  }
  if (start.line === end.line) {
    return lines[start.line - 1].slice(start.column - 1, end.column - 1);
  }
  const parts: string[] = [lines[start.line - 1].slice(start.column - 1)];
  for (let ln = start.line + 1; ln < end.line; ln++) {
    parts.push(lines[ln - 1]);
  }
  parts.push(lines[end.line - 1].slice(0, end.column - 1));
  return parts.join('\n');
}

/**
 * Flatten a Stryker JSON report into a mutant list plus each mutant's file
 * source (needed to slice the original span it replaced).
 *
 * Defence-in-depth: this walk is external data, and it runs OUTSIDE the parse
 * `try` in the engine's `parseReport`. Stryker's own schema always carries
 * `mutants[].location.start`, but a null file entry or a location-less mutant
 * in a truncated/foreign report must not escape as a raw
 * `Cannot read properties of undefined` TypeError.
 */
function collectMutants(raw: StrykerJsonReport): {
  mutants: StrykerMutantRecord[];
  sourceById: Map<string, string>;
} {
  const mutants: StrykerMutantRecord[] = [];
  const sourceById = new Map<string, string>();
  if (raw?.files) {
    for (const fileData of Object.values(raw.files)) {
      if (!Array.isArray(fileData?.mutants)) continue;
      for (const m of fileData.mutants) {
        if (typeof m?.location?.start?.line !== 'number') continue;
        mutants.push(m);
        if (typeof fileData.source === 'string') sourceById.set(m.id, fileData.source);
      }
    }
  }
  return { mutants, sourceById };
}

/**
 * Describe one uncaught mutant (Survived or NoCoverage) as a {@link Vulnerability}.
 *
 * @param source — the mutant's file source from {@link collectMutants}, used
 *   best-effort to recover the original span; absent when the report carried none.
 */
function toVulnerability(m: StrykerMutantRecord, source: string | undefined): Vulnerability {
  const vuln: Vulnerability = {
    line: m.location.start.line,
    mutator: m.mutatorName,
    // Carry Stryker's own status forward as structured data. The
    // description below says the same thing in prose for humans, but the
    // pipeline reads this field.
    kind: m.status === 'NoCoverage' ? 'noCoverage' : 'survived',
    description:
      m.status === 'NoCoverage'
        ? `No test reached this line (NoCoverage). Consider adding tests covering this branch.`
        : `Logical mutation via [${m.mutatorName}] survived. Your tests did not catch this change.`,
  };
  if (m.replacement) vuln.mutated = m.replacement;
  if (source !== undefined) {
    try {
      const original = sliceSource(source, m.location);
      if (original) vuln.original = original;
    } catch {
      // best-effort — leave original unset
    }
  }
  return vuln;
}

/**
 * Score an already-parsed Stryker report.
 *
 * Split from the engine's `parseReport` so the classification rules — which
 * statuses score, which are incompetent, which are dropped, and what happens to
 * one the engine has never heard of — are exercisable without a report file on
 * disk.
 *
 * @param scopeKind — whether the run this report came from enumerated the whole
 *   file or only the caller's line ranges.
 */
export function scoreStrykerReport(
  raw: StrykerJsonReport,
  filePath: string,
  scopeKind: 'whole-file' | 'scoped',
): MutationResult {
  // Collect all mutants across all files, keeping each mutant's file source
  // so we can slice the original span it replaced.
  const { mutants, sourceById } = collectMutants(raw);

  // ── Classify every mutant by an ALLOW-list of statuses ──
  // Scored mutants form the denominator; CompileError/RuntimeError become
  // `incompetent`; `Ignored` is dropped silently; anything else is schema
  // drift and is reported rather than quietly inflating the denominator.
  // See SCORED_STATUSES / INCOMPETENT_STATUSES / EXCLUDED_STATUSES above.
  const validMutants = mutants.filter((m) => SCORED_STATUSES.has(m.status));
  const incompetent = mutants.filter((m) => INCOMPETENT_STATUSES.has(m.status)).length;

  const unrecognised = new Map<string, number>();
  for (const m of mutants) {
    if (
      SCORED_STATUSES.has(m.status) ||
      INCOMPETENT_STATUSES.has(m.status) ||
      EXCLUDED_STATUSES.has(m.status)
    ) {
      continue;
    }
    unrecognised.set(m.status, (unrecognised.get(m.status) ?? 0) + 1);
  }
  if (unrecognised.size > 0) {
    // Warned unconditionally (not behind isVerbose): an unhandled status means
    // this engine's view of the report schema has drifted from the tool's, and
    // the resulting score silently omits those mutants. Once per run, naming
    // each status and its count.
    const summary = [...unrecognised].map(([status, count]) => `${status} (${count})`).join(', ');
    warn(
      `parseReport: ${unrecognised.size} unrecognised Stryker mutant status(es) in the report for ` +
        `${filePath}: ${summary}. They are excluded from the mutation score — this engine's status ` +
        'list may be out of date with the installed StrykerJS.',
    );
  }

  const totalMutants = validMutants.length;
  // Timeouts count as killed — the mutant was detected by causing the test suite to hang.
  const killed = validMutants.filter((m) => m.status === 'Killed' || m.status === 'Timeout').length;
  const survived = validMutants.filter((m) => m.status === 'Survived').length;
  const mutationScore = formatMutationScore(killed, totalMutants);

  // Vulnerabilities include Survived AND NoCoverage mutants — NoCoverage
  // means no test reached that code path and is therefore an actionable hole.
  const vulnerabilities: Vulnerability[] = validMutants
    .filter((m) => m.status === 'Survived' || m.status === 'NoCoverage')
    .map((m) => toVulnerability(m, sourceById.get(m.id)));

  // Log a heads-up when NoCoverage mutants are present (these lower the score
  // and now show up as explicit vulnerabilities — previously they were silent).
  const noCoverage = validMutants.filter((m) => m.status === 'NoCoverage').length;
  if (noCoverage > 0 && isVerbose()) {
    log(`parseReport: ${noCoverage} NoCoverage mutant(s) reported as vulnerabilities`);
  }

  return {
    target: filePath,
    totalMutants,
    killed,
    survived,
    mutationScore,
    vulnerabilities,
    incompetent: incompetent > 0 ? incompetent : undefined,
    scopeKind,
  };
}
