import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { MutationResult } from '../engines/base.js';
import { NO_COVERAGE_RE } from '../format.js';

/**
 * Per-file mutex for suppression writes (audit H3).
 *
 * Two `addSuppressions` / `removeSuppressions` calls for the same
 * `workspaceRoot` arriving on the same event-loop turn both `readFile` and
 * `writeFile` the suppression JSON, racing a read-modify-write cycle: the
 * later writer wins and silently overwrites the earlier entry. We serialise
 * writes through a Promise chain keyed by `workspaceRoot + configPath` so
 * concurrent callers in a single Node process cannot lose entries.
 *
 * Cross-process: if two chaos-mcp processes edit the same workspace, the
 * chain in either process is unaware of the other. fs.flock would close that
 * gap but is not portable to Windows; the in-process queue is the safe
 * minimum that works on every platform.
 */
const WRITE_QUEUE = new Map<string, Promise<unknown>>();
export function _resetWriteQueue(): void {
  WRITE_QUEUE.clear();
}
/** Test-only introspection hook so the cleanup invariant can be asserted. */
export function _writeQueueSize(): number {
  return WRITE_QUEUE.size;
}
function withWorkspaceLock<T>(
  workspaceRoot: string,
  configPath: string | undefined,
  fn: () => T,
): Promise<T> {
  const key = `${workspaceRoot}\u0000${configPath ?? ''}`;
  const prev = WRITE_QUEUE.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn) as Promise<T>;
  // Live-audit finding: previously the queue stored `next.catch(() => undefined)`
  // (a fresh Promise with a different identity) and the cleanup compared
  // against the un-caught `next`, so the identity match ALWAYS failed and the
  // map entry was never deleted. Fix: store and clean the SAME chained Promise,
  // so the identity check actually compares equal. (BEFORE this fix the queue
  // grew by one dead Promise per workspace per write.)
  const tracked = next.catch(() => undefined) as Promise<unknown>;
  WRITE_QUEUE.set(key, tracked);
  // Live-audit finding #2: even with the identity fix, returning `next` and
  // letting the caller `await` it resumes BEFORE the cleanup `.finally` runs.
  // The awaiter resumes on a separate microtask path that bypasses the
  // cleanup callback, so any code that immediately reads WRITE_QUEUE.size
  // after `await addSuppressions` / `await removeSuppressions` sees a stale
  // entry. Fix: return `cleaned` (the post-cleanup Promise) so the caller's
  // await resolves AFTER the cleanup `.finally` callback has run.
  const cleaned = tracked.finally(() => {
    if (WRITE_QUEUE.get(key) === tracked) WRITE_QUEUE.delete(key);
  });
  return cleaned as Promise<T>;
}

export interface SuppressionInput {
  line: number;
  mutator: string;
  reason?: string;
}

interface StoredEntry {
  line: number;
  mutator: string;
  reason?: string;
  addedAt: number;
}
interface SuppressionFile {
  version: number;
  entries: Record<string, StoredEntry[]>;
}

const keyOf = (line: number, mutator: string): string => `${line} ${mutator}`;

function filePath(workspaceRoot: string, configPath?: string): string {
  if (configPath) return isAbsolute(configPath) ? configPath : join(workspaceRoot, configPath);
  return join(workspaceRoot, '.chaos-mcp', 'suppressions.json');
}

function readFile(workspaceRoot: string, configPath?: string): SuppressionFile {
  try {
    const raw = JSON.parse(
      readFileSync(filePath(workspaceRoot, configPath), 'utf8'),
    ) as SuppressionFile;
    if (
      !raw ||
      typeof raw !== 'object' ||
      typeof raw.entries !== 'object' ||
      raw.entries === null
    ) {
      return { version: 1, entries: {} };
    }
    return { version: raw.version ?? 1, entries: raw.entries };
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeFile(workspaceRoot: string, data: SuppressionFile, configPath?: string): void {
  const dest = filePath(workspaceRoot, configPath);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, dest);
}

export function loadSuppressions(
  workspaceRoot: string,
  configPath?: string,
): Map<string, Set<string>> {
  const data = readFile(workspaceRoot, configPath);
  const map = new Map<string, Set<string>>();
  for (const [file, list] of Object.entries(data.entries)) {
    if (!Array.isArray(list)) continue;
    const set = new Set<string>();
    for (const e of list) {
      if (e && Number.isInteger(e.line) && typeof e.mutator === 'string')
        set.add(keyOf(e.line, e.mutator));
    }
    if (set.size > 0) map.set(file, set);
  }
  return map;
}

/** Quiesces callers that prefer a Promise return even on the no-op path. */
function noopPromise(): Promise<void> {
  return Promise.resolve();
}

export function addSuppressions(
  workspaceRoot: string,
  relFile: string,
  entries: SuppressionInput[],
  configPath?: string,
): Promise<void> {
  if (entries.length === 0) return noopPromise();
  return withWorkspaceLock(workspaceRoot, configPath, () => {
    const data = readFile(workspaceRoot, configPath);
    const list = Array.isArray(data.entries[relFile])
      ? data.entries[relFile]
      : ([] as StoredEntry[]);
    const seen = new Set(list.map((e) => keyOf(e.line, e.mutator)));
    const now = Date.now();
    for (const e of entries) {
      const k = keyOf(e.line, e.mutator);
      if (seen.has(k)) continue;
      seen.add(k);
      list.push({ line: e.line, mutator: e.mutator, reason: e.reason, addedAt: now });
    }
    data.entries[relFile] = list;
    writeFile(workspaceRoot, data, configPath);
  });
}

export function removeSuppressions(
  workspaceRoot: string,
  relFile: string,
  keys: { line: number; mutator: string }[],
  configPath?: string,
): Promise<void> {
  if (keys.length === 0) return noopPromise();
  return withWorkspaceLock(workspaceRoot, configPath, () => {
    const data = readFile(workspaceRoot, configPath);
    const list = data.entries[relFile];
    if (!Array.isArray(list)) return;
    const drop = new Set(keys.map((k) => keyOf(k.line, k.mutator)));
    const kept = list.filter((e) => !drop.has(keyOf(e.line, e.mutator)));
    if (kept.length > 0) {
      data.entries[relFile] = kept;
    } else {
      data.entries = Object.fromEntries(
        Object.entries(data.entries).filter(([file]) => file !== relFile),
      ) as Record<string, StoredEntry[]>;
    }
    writeFile(workspaceRoot, data, configPath);
  });
}

/**
 * Drop suppressed (equivalent) mutants from a result. Equivalent mutants are
 * unkillable, so they leave the denominator: total shrinks, score is recomputed,
 * survived is clamped down. Returns a new result; the input is not mutated.
 */
export function applySuppressions(
  result: MutationResult,
  suppressed: Set<string> | undefined,
): { result: MutationResult; suppressedCount: number } {
  if (!suppressed || suppressed.size === 0) return { result, suppressedCount: 0 };
  const kept = result.vulnerabilities.filter((v) => !suppressed.has(keyOf(v.line, v.mutator)));
  const suppressedCount = result.vulnerabilities.length - kept.length;
  if (suppressedCount === 0) return { result, suppressedCount: 0 };
  // Only true survivors (not NoCoverage) count against result.survived.
  const suppressedSurvivors = result.vulnerabilities.filter(
    (v) => suppressed.has(keyOf(v.line, v.mutator)) && !NO_COVERAGE_RE.test(v.description),
  ).length;
  const totalMutants = Math.max(0, result.totalMutants - suppressedCount);
  const survived = Math.max(0, result.survived - suppressedSurvivors);
  const score = totalMutants === 0 ? 100 : (result.killed / totalMutants) * 100;
  return {
    result: {
      ...result,
      vulnerabilities: kept,
      totalMutants,
      survived,
      mutationScore: `${score.toFixed(2)}%`,
    },
    suppressedCount,
  };
}
