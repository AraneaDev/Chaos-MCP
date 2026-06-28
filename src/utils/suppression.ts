import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { MutationResult } from '../engines/base.js';

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

export function addSuppressions(
  workspaceRoot: string,
  relFile: string,
  entries: SuppressionInput[],
  configPath?: string,
): void {
  if (entries.length === 0) return;
  const data = readFile(workspaceRoot, configPath);
  const list = data.entries[relFile] ?? [];
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
}

export function removeSuppressions(
  workspaceRoot: string,
  relFile: string,
  keys: { line: number; mutator: string }[],
  configPath?: string,
): void {
  if (keys.length === 0) return;
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
    );
  }
  writeFile(workspaceRoot, data, configPath);
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
  const totalMutants = Math.max(0, result.totalMutants - suppressedCount);
  const survived = Math.max(0, result.survived - suppressedCount);
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
