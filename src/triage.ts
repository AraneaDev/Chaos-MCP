import { readdirSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import type { MutationResult } from './engines/base.js';
import type { Severity } from './enrich.js';
import { displayMutationScore, hasNoMutableLogic, type LineGroup } from './format.js';
import { evaluateGate } from './gate.js';
import { supportedSourceExtensions } from './utils/project-detector.js';

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

/**
 * Auditable source extensions, derived from the per-language detection registry
 * rather than restated here. Restating them meant a newly added language was
 * invisible to triage discovery with no compile error to say so — the tool just
 * returned an empty leaderboard (audit F15).
 */
const SUPPORTED_EXT = supportedSourceExtensions();
const IGNORE_DIRS = new Set([
  'node_modules',
  'build',
  'dist',
  '.git',
  'coverage',
  '.stryker-tmp',
  'reports',
  '__tests__',
  'tests',
]);
const TEST_FILE_RE = /(\.test\.|\.spec\.|_test\.(py|rs)$|(^|\/)test_[^/]*\.py$|Test\.php$)/;

/**
 * Normalise a path to forward slashes.
 *
 * {@link TEST_FILE_RE} anchors the `test_*.py` alternative on `(^|/)`, and
 * `walk` builds candidates with `relative()`, which yields BACKslashes on
 * Windows — so `pkg\test_math.py` failed the guard and a pytest test module was
 * audited as if it were source.
 *
 * Backslashes are translated on EVERY platform, not just where `sep` is `\`.
 * A POSIX filename may legally contain a backslash, so this technically
 * misreads `weird\test_x.py` as a directory boundary — an acceptable trade for
 * behaviour that Linux CI can actually verify. A platform-gated version is
 * invisible to this project's CI, which is precisely how the bug survived.
 * Matches the unconditional normalisation already used in engines/php.ts.
 */
function toPosix(path: string): string {
  return sep === '\\' ? path.split(sep).join('/') : path.replace(/\\/g, '/');
}

/** True if a path is a mutation-testable source file (supported ext, not a test). */
export function isSupportedSourceFile(path: string): boolean {
  const normalised = toPosix(path);
  // Extensions are compared case-insensitively: on the case-insensitive
  // filesystems where `Foo.PHP` is an ordinary filename, it is still PHP.
  const lower = normalised.toLowerCase();
  if (!SUPPORTED_EXT.some((ext) => lower.endsWith(ext))) return false;
  if (TEST_FILE_RE.test(normalised)) return false;
  return true;
}

/** Recursively collect supported source files under an absolute directory. */
function walk(absDir: string, workspaceRoot: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      walk(join(absDir, entry.name), workspaceRoot, out);
    } else if (entry.isFile()) {
      const rel = relative(workspaceRoot, join(absDir, entry.name));
      if (isSupportedSourceFile(rel)) out.push(rel);
    }
  }
}

/** Probe whether an absolute path is a directory via readdirSync (throws for files). */
function readdirSyncIsDir(abs: string): boolean {
  try {
    readdirSync(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Expand `paths` (files and/or directories) into workspace-relative supported
 * source files: dedupe, sort, then cap at `maxFiles`.
 */
export function discoverFiles(
  paths: string[],
  workspaceRoot: string,
  maxFiles: number,
): { files: string[]; discovered: number; skipped: number } {
  const collected: string[] = [];
  for (const p of paths) {
    const abs = resolve(workspaceRoot, p);
    if (readdirSyncIsDir(abs)) {
      walk(abs, workspaceRoot, collected);
    } else {
      const rel = relative(workspaceRoot, abs);
      if (isSupportedSourceFile(rel)) collected.push(rel);
    }
  }
  const unique = [...new Set(collected)].sort();
  const discovered = unique.length;
  const files = unique.slice(0, maxFiles);
  return { files, discovered, skipped: discovered - files.length };
}

/**
 * Filter a raw changed-file list (from listChangedFiles) to supported source
 * files, optionally intersecting with `paths` (treated as directory/file
 * prefixes), then sort, dedupe, and cap at `maxFiles`.
 */
export function discoverChangedFiles(
  changedFiles: string[],
  paths: string[] | undefined,
  maxFiles: number,
): { files: string[]; discovered: number; skipped: number } {
  const underPaths = (rel: string): boolean => {
    if (!paths || paths.length === 0) return true;
    return paths.some((p) => {
      const norm = p.replace(/\/+$/, '');
      return rel === norm || rel.startsWith(`${norm}/`);
    });
  };
  const collected = changedFiles.filter((rel) => isSupportedSourceFile(rel) && underPaths(rel));
  const unique = [...new Set(collected)].sort();
  const discovered = unique.length;
  const files = unique.slice(0, maxFiles);
  return { files, discovered, skipped: discovered - files.length };
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

/** Rank audited results weakest-first: score asc, survived desc, file asc. */
export function rankResults(results: { file: string; result: MutationResult }[]): TriageRow[] {
  const rows: TriageRow[] = results.map(({ file, result }) => {
    const row: TriageRow = {
      file,
      mutationScore: displayMutationScore(result),
      total: result.totalMutants,
      killed: result.killed,
      survived: result.survived,
      noCoverage: Math.max(0, result.vulnerabilities.length - result.survived),
    };
    if (hasNoMutableLogic(result)) row.noMutableLogic = true;
    if (result.complete === false) {
      row.complete = false;
      if (result.batchesCompleted !== undefined) row.batchesCompleted = result.batchesCompleted;
      if (result.batchesPlanned !== undefined) row.batchesPlanned = result.batchesPlanned;
    }
    return row;
  });
  return rows.sort(compareTriageRows);
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
  gate?: { minScore: number; passed: boolean; failingFiles: string[] };
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
    payload.gate = { minScore, passed: failingFiles.length === 0, failingFiles };
    if (errors.length > 0) {
      payload.note += ` Note: ${errors.length} file(s) errored and are not graded.`;
    }
    const partial = graded.filter((r) => r.complete === false).length;
    if (partial > 0) {
      payload.note += ` Note: ${partial} file(s) were audited only partially (time budget) and fail the gate on that basis.`;
    }
  }
  return payload;
}

/** Render the triage result as compact JSON. */
export function formatTriageAsJson(
  rows: TriageRow[],
  errors: TriageError[],
  discovered: number,
  skipped: number,
  scopeNote?: string,
): string {
  return JSON.stringify(buildTriagePayload(rows, errors, discovered, skipped, scopeNote));
}

/** Render the triage result as a human-readable table. */
export function formatTriageAsText(
  rows: TriageRow[],
  errors: TriageError[],
  discovered: number,
  skipped: number,
  scopeNote?: string,
  unaudited: string[] = [],
): string {
  const lines: string[] = [
    `Chaos-MCP Triage: ${rows.length} of ${discovered} files audited` +
      (skipped > 0 ? ` (${skipped} skipped)` : ''),
  ];
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
