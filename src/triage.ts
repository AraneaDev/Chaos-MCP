import { readdirSync } from 'fs';
import { join, relative, resolve } from 'path';
import type { MutationResult } from './engines/base.js';
import type { Severity } from './enrich.js';
import { displayMutationScore, hasNoMutableLogic, type LineGroup } from './format.js';
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
  /** Whether this file met the minScore gate threshold (only present when minScore is set). */
  passed?: boolean;
  /** True when the file has no mutable logic (zero mutants, no scope note); score is "n/a" (audit M3). */
  noMutableLogic?: boolean;
}

export interface TriageError {
  file: string;
  error: string;
}

const SUPPORTED_EXT = ['.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.php'];
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

/** True if a path is a mutation-testable source file (supported ext, not a test). */
export function isSupportedSourceFile(path: string): boolean {
  if (!SUPPORTED_EXT.some((ext) => path.endsWith(ext))) return false;
  if (TEST_FILE_RE.test(path)) return false;
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
  };
  ranking: TriageRow[];
  errors: TriageError[];
  scopeNote?: string;
  note: string;
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
  if (scopeNote) payload.scopeNote = scopeNote;
  if (minScore !== undefined) {
    const graded = rows.map((r) => ({
      ...r,
      passed: evaluateGate(r.mutationScore, minScore).passed,
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
): string {
  const lines: string[] = [
    `Chaos-MCP Triage: ${rows.length} of ${discovered} files audited` +
      (skipped > 0 ? ` (${skipped} skipped)` : ''),
  ];
  if (scopeNote) lines.push(scopeNote);
  if (rows.length > 0) {
    lines.push('Weakest first (score  survived/total  file):');
    for (const r of rows) {
      lines.push(`  ${r.mutationScore}  ${r.survived}/${r.total}  ${r.file}`);
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
  return lines.join('\n');
}
