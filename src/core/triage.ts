import type { Severity } from './enrich.js';
import { suppressionDriftNotes, type LineGroup } from './score-semantics.js';
import { evaluateGate } from './gate.js';

export interface TriageRow {
  file: string;
  mutationScore: string;
  total: number;
  killed: number;
  survived: number;
  noCoverage: number;
  scopeNote?: string;
  worstSeverity?: Severity;
  survivors?: LineGroup[];
  noCoverageGroups?: LineGroup[];
  /** Cached run id — pass to audit_code_resilience as `runId` to verify survivors. */
  runId?: string;
  /** Number of equivalent mutants suppressed for this file (from the suppressions list). */
  suppressedCount?: number;
  /**
   * Stored suppressions NOT applied because their content fingerprint no longer
   * matches the source line they target (the code moved or changed).
   */
  driftedSuppressions?: number;
  /**
   * Stored suppressions NOT applied because they carry no fingerprint at all
   * (v1 entries), awaiting re-confirmation.
   */
  unverifiedSuppressions?: number;
  /**
   * Applied suppressions whose (line, mutator) matched no SURVIVING mutant this
   * run — inert (the mutant may now be killed, or its identity may be gone),
   * and only counted for a whole-file, complete audit (see `isWholeFileRun` in
   * `audit/suppression-io.ts`).
   */
  orphanedSuppressions?: number;
  /** Whether this file met the minScore gate threshold (only present when minScore is set). */
  passed?: boolean;
  /** True when the file has no mutable logic (zero mutants, no scope note); score is "n/a" (audit M3). */
  noMutableLogic?: boolean;
  /**
   * False when the file's audit ran out of time budget and scored only some of
   * its mutation batches. Absent means complete. Without this the leaderboard
   * presented a fraction of a file's score as the whole file's, and the gate
   * graded it — so a partially-audited file could rank "safe" and pass.
   */
  complete?: boolean;
  /** Batches that produced usable reports (only present on a partial run). */
  batchesCompleted?: number;
  /** Batches planned for the requested scope (only present on a partial run). */
  batchesPlanned?: number;
}

export interface TriageError {
  file: string;
  error: string;
}

/** Parse a "87.50%" score string into a number (NaN-safe → 100). */
function scoreNum(s: string): number {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 100;
}

/** Comparator: weakest-first — score asc, survived desc, file asc. */
export function compareTriageRows(a: TriageRow, b: TriageRow): number {
  return (
    scoreNum(a.mutationScore) - scoreNum(b.mutationScore) ||
    b.survived - a.survived ||
    a.file.localeCompare(b.file)
  );
}

function note(rows: TriageRow[], discovered: number, skipped: number, diffMode?: boolean): string {
  if (discovered === 0) {
    return diffMode
      ? 'No changed supported source files found vs the diff base.'
      : 'No supported source files found under the given paths.';
  }
  const trunc = skipped > 0 ? ` Audited ${rows.length}; ${skipped} skipped by maxFiles.` : '';
  return (
    'Ranked weakest-first by mutation score. ' +
    'Drill into a file with audit_code_resilience for survivor detail.' +
    trunc
  );
}

export interface TriagePayload {
  mode: 'triage';
  summary: {
    filesDiscovered: number;
    filesAudited: number;
    filesSkipped: number;
    filesErrored: number;
    /** Selected files never started because the sweep's time budget ran out. */
    filesUnaudited?: number;
  };
  ranking: TriageRow[];
  errors: TriageError[];
  scopeNote?: string;
  note: string;
  /**
   * Files the sweep selected but never audited, because `totalTimeoutMs` was
   * exhausted first. Distinct from `errors` (something went wrong) and from
   * `filesSkipped` (never selected, capped by maxFiles): nothing was measured
   * for these, so the ranking does not describe them.
   */
  unaudited?: string[];
  /** Machine-readable reason the sweep stopped early. */
  stoppedReason?: 'time_budget_exhausted';
  /** Gate result — only present when minScore is supplied. A failing gate is never an error. */
  gate?: {
    minScore: number;
    passed: boolean;
    failingFiles: string[];
    /**
     * Why the gate failed. `below_threshold` means at least one graded file
     * scored under `minScore`; `files_not_graded` means every graded file
     * passed but part of the sweep produced no score at all. Absent when the
     * gate passed. `below_threshold` wins when both are true — a real failing
     * score is the more actionable of the two.
     */
    reason?: 'below_threshold' | 'files_not_graded';
    /**
     * Files no score exists for, so the caller can tell "below threshold" from
     * "not measured". Both make the gate fail.
     */
    notGraded: { errored: number; unaudited: number };
  };
}

export function buildTriagePayload(
  rows: TriageRow[],
  errors: TriageError[],
  discovered: number,
  skipped: number,
  scopeNote?: string,
  minScore?: number,
  unaudited: string[] = [],
): TriagePayload {
  const payload: TriagePayload = {
    mode: 'triage',
    summary: {
      filesDiscovered: discovered,
      filesAudited: rows.length,
      filesSkipped: skipped,
      filesErrored: errors.length,
    },
    ranking: rows,
    errors,
    note: note(rows, discovered, skipped, !!scopeNote),
  };
  if (unaudited.length > 0) {
    payload.summary.filesUnaudited = unaudited.length;
    payload.unaudited = unaudited;
    payload.stoppedReason = 'time_budget_exhausted';
    payload.note += ` ${unaudited.length} file(s) were not audited before the time budget ran out — raise totalTimeoutMs or narrow the paths.`;
  }
  if (scopeNote) payload.scopeNote = scopeNote;
  // Aggregate the per-row un-applied suppressions into one sweep-level sentence
  // each. A sweep is where a repo-wide staleness (e.g. every entry predating
  // fingerprints) shows up, and one line per kind is enough to send the reader
  // to the rows that carry the counts.
  const sumOf = (pick: (r: TriageRow) => number | undefined): number =>
    rows.reduce((sum, r) => sum + (pick(r) ?? 0), 0);
  for (const note of suppressionDriftNotes(
    sumOf((r) => r.driftedSuppressions),
    sumOf((r) => r.unverifiedSuppressions),
    sumOf((r) => r.orphanedSuppressions),
  )) {
    payload.note += ` ${note}`;
  }
  if (minScore !== undefined) {
    // `r.complete !== false` forwards partial-audit state: a row scored from
    // only some of its mutation batches describes a fraction of the file, so it
    // fails the gate rather than passing on a score that was never the whole
    // file's (see evaluateGate).
    const graded = rows.map((r) => ({
      ...r,
      passed: evaluateGate(r.mutationScore, minScore, r.complete !== false).passed,
    }));
    const failingFiles = graded
      .filter((r) => !r.passed)
      .map((r) => r.file)
      .sort();
    payload.ranking = graded;
    // The gate fails closed over an INCOMPLETE sweep. `rows` covers only the
    // files that produced a score; a file that errored or that the time budget
    // never reached was NOT measured, and grading the sweep on whichever subset
    // happened to finish lets a CI step keyed on `gate.passed` go green over
    // ungraded code. Same rationale as the partial-audit rule in evaluateGate:
    // the gate exists to be trusted in CI, so an incomplete audit fails closed.
    const notGraded = { errored: errors.length, unaudited: unaudited.length };
    const passed =
      failingFiles.length === 0 && notGraded.errored === 0 && notGraded.unaudited === 0;
    payload.gate = { minScore, passed, failingFiles, notGraded };
    if (!payload.gate.passed) {
      payload.gate.reason = failingFiles.length > 0 ? 'below_threshold' : 'files_not_graded';
    }
    if (errors.length > 0) {
      payload.note += ` Note: ${errors.length} file(s) errored and are not graded, so the gate fails closed.`;
    }
    if (unaudited.length > 0) {
      payload.note += ` Note: ${unaudited.length} file(s) were never audited, so the gate fails closed.`;
    }
    const partial = graded.filter((r) => r.complete === false).length;
    if (partial > 0) {
      payload.note += ` Note: ${partial} file(s) were audited only partially (time budget) and fail the gate on that basis.`;
    }
  }
  return payload;
}

/**
 * How many failing files the gate line names inline.
 *
 * A sweep defaults to 25 files, so an all-failing run would otherwise produce a
 * single unreadable 25-name line and push the rest of the report off screen.
 * The overflow is not lost: every failing file is in `gate.failingFiles` in
 * `structuredContent`, and each one is also a row in the table below.
 */
const GATE_FAILING_FILES_SHOWN = 10;

/**
 * Render the gate verdict as ONE line.
 *
 * Takes the already-computed `gate` object rather than the rows + minScore, so
 * the text and JSON representations cannot disagree about the verdict: both are
 * projections of the single {@link buildTriagePayload} result (audit M-gateText).
 *
 * The `reason` discriminator is rendered as the distinguishing clause ("below
 * threshold" vs "were not graded") rather than as the raw enum token — a human
 * reading the text block needs to tell "measured and too low" from "never
 * measured", and machines get the token itself from `structuredContent`.
 */
function gateLine(gate: NonNullable<TriagePayload['gate']>): string {
  const { minScore, passed, failingFiles, notGraded, reason } = gate;
  if (passed) return `Gate: passed (minScore ${minScore})`;
  const ungraded = notGraded.errored + notGraded.unaudited;
  const ungradedDetail =
    `${ungraded} file(s) were not graded ` +
    `(${notGraded.errored} errored, ${notGraded.unaudited} unaudited)`;
  // Wave 1's fail-closed rule: an incomplete sweep fails even with zero failing
  // scores. Saying "0 below threshold" out loud is what stops that verdict from
  // reading as a bug in the gate.
  if (reason === 'files_not_graded') {
    return `Gate: FAILED (minScore ${minScore}) — 0 below threshold, but ${ungradedDetail}`;
  }
  const shown = failingFiles.slice(0, GATE_FAILING_FILES_SHOWN);
  const overflow = failingFiles.length - shown.length;
  const list = shown.join(', ') + (overflow > 0 ? `, +${overflow} more` : '');
  // Both causes can be true at once; `below_threshold` wins the headline (it is
  // the actionable one) but the ungraded count still has to be visible.
  const trailer = ungraded > 0 ? `; ${ungradedDetail}` : '';
  return (
    `Gate: FAILED (minScore ${minScore}) — ` +
    `${failingFiles.length} file(s) below threshold: ${list}${trailer}`
  );
}

/**
 * Render the triage result as a human-readable table.
 *
 * Takes the WHOLE {@link TriagePayload} rather than the six loose arguments it
 * used to: `outputFormat: 'text'` is a rendering choice, not a feature toggle,
 * and the previous signature had no way to express the gate verdict at all — so
 * a caller that asked for a gate and got text back saw an ordinary leaderboard
 * with no hint that a gate had been requested, let alone that it FAILED (audit
 * M-gateText). Feeding the renderer the same object the JSON path serialises
 * makes divergence structurally impossible instead of merely unlikely.
 */
export function formatTriageAsText(payload: TriagePayload): string {
  const rows = payload.ranking;
  const errors = payload.errors;
  const { filesDiscovered: discovered, filesSkipped: skipped } = payload.summary;
  const scopeNote = payload.scopeNote;
  const unaudited = payload.unaudited ?? [];
  const lines: string[] = [];
  // The verdict goes FIRST — above the banner, above the scope note, above the
  // table. A gate is the question the caller asked by supplying minScore, and a
  // sweep can rank 25 files: anywhere below the table is somewhere a reader (or
  // an agent reading a truncated content block) can miss it, which is the whole
  // defect being fixed. When no minScore was supplied nothing is emitted and the
  // output is byte-identical to before.
  if (payload.gate) lines.push(gateLine(payload.gate));
  lines.push(
    `Chaos-MCP Triage: ${rows.length} of ${discovered} files audited` +
      (skipped > 0 ? ` (${skipped} skipped)` : ''),
  );
  if (scopeNote) lines.push(scopeNote);
  if (rows.length > 0) {
    lines.push('Weakest first (score  survived/total  file):');
    for (const r of rows) {
      // A partial row's score covers only part of the file — say so inline, or
      // the number reads as the whole file's.
      const partial =
        r.complete === false
          ? `  (partial: ${r.batchesCompleted ?? '?'}/${r.batchesPlanned ?? '?'} batches)`
          : '';
      lines.push(`  ${r.mutationScore}  ${r.survived}/${r.total}  ${r.file}${partial}`);
    }
  } else if (discovered === 0) {
    lines.push(
      scopeNote
        ? 'No changed supported source files found vs the diff base.'
        : 'No supported source files found under the given paths.',
    );
  }
  for (const note of suppressionDriftNotes(
    rows.reduce((sum, r) => sum + (r.driftedSuppressions ?? 0), 0),
    rows.reduce((sum, r) => sum + (r.unverifiedSuppressions ?? 0), 0),
    rows.reduce((sum, r) => sum + (r.orphanedSuppressions ?? 0), 0),
  )) {
    lines.push(`Note: ${note}`);
  }
  if (errors.length > 0) {
    lines.push('Errors:');
    for (const e of errors) lines.push(`  ${e.file}: ${e.error}`);
  }
  if (unaudited.length > 0) {
    lines.push(
      `Not audited (time budget exhausted — raise totalTimeoutMs or narrow the paths): ${unaudited.length}`,
    );
    for (const f of unaudited) lines.push(`  ${f}`);
  }
  return lines.join('\n');
}
