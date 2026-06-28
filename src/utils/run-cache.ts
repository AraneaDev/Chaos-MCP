import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RunCacheEntry {
  runId: string;
  file: string;
  projectType: string;
  createdAt: number;
  survivors: { line: number; mutators: Record<string, number> }[];
  noCoverage: { line: number; mutators: Record<string, number> }[];
}

export interface RunCacheOptions {
  dir?: string;
  ttlMs?: number;
  max?: number;
  now?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX = 200;

function cacheDir(opts?: RunCacheOptions): string {
  return opts?.dir ?? join(tmpdir(), 'chaos-mcp-runs');
}

/** Read every cache file with its createdAt; unreadable/corrupt files are skipped. */
function listEntries(dir: string): { id: string; createdAt: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: { id: string; createdAt: number }[] = [];
  for (const n of names) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, n), 'utf8')) as RunCacheEntry;
      out.push({ id: n.slice(0, -'.json'.length), createdAt: parsed.createdAt ?? 0 });
    } catch {
      // Corrupt file: drop it so it cannot accumulate.
      try {
        rmSync(join(dir, n), { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
  return out;
}

/** Best-effort eviction: drop TTL-expired entries, then trim oldest beyond `max`. */
function evict(dir: string, ttlMs: number, max: number, now: number): void {
  const entries = listEntries(dir);
  for (const e of entries) {
    if (now - e.createdAt > ttlMs) {
      try {
        rmSync(join(dir, `${e.id}.json`), { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
  const live = entries
    .filter((e) => now - e.createdAt <= ttlMs)
    .sort((a, b) => a.createdAt - b.createdAt);
  for (let i = 0; i < live.length - max + 1; i++) {
    try {
      rmSync(join(dir, `${live[i].id}.json`), { force: true });
    } catch {
      /* best-effort */
    }
  }
}

export function saveRun(
  entry: Omit<RunCacheEntry, 'runId' | 'createdAt'>,
  opts?: RunCacheOptions,
): string {
  const dir = cacheDir(opts);
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const max = opts?.max ?? DEFAULT_MAX;
  const now = opts?.now ?? Date.now();
  mkdirSync(dir, { recursive: true });
  evict(dir, ttlMs, max, now);

  const runId = randomUUID().slice(0, 8);
  const full: RunCacheEntry = { ...entry, runId, createdAt: now };
  const dest = join(dir, `${runId}.json`);
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(full), 'utf8');
  renameSync(tmp, dest);
  return runId;
}

export function loadRun(runId: string, opts?: RunCacheOptions): RunCacheEntry | undefined {
  const dir = cacheDir(opts);
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts?.now ?? Date.now();
  const file = join(dir, `${runId}.json`);
  try {
    statSync(file);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as RunCacheEntry;
    if (typeof parsed.createdAt !== 'number' || now - parsed.createdAt > ttlMs) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
