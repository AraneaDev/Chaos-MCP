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
import { basename, join } from 'node:path';

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
  // Oldest first, with the id breaking a same-millisecond tie. Without the
  // tiebreak equal timestamps kept their readdir order, which is
  // filesystem-defined over random run ids — so the same cache state evicted
  // a different entry between otherwise identical runs.
  const live = entries
    .filter((e) => now - e.createdAt <= ttlMs)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
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
  try {
    writeFileSync(tmp, JSON.stringify(full), 'utf8');
    renameSync(tmp, dest);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort */
    }
    throw e;
  }
  return runId;
}

/**
 * The parts of a built result payload a cached run is keyed by.
 *
 * Declared structurally rather than imported as `format.js#ResultPayload` on
 * purpose: `utils/` is the leaf layer, and a value import of `format.js` (a
 * domain module that itself pulls in `enrich`, `gate` and `engines/base`) was
 * the last edge pointing back up from it — exactly the shape that would let a
 * `format.ts ↔ utils/*` cycle form. `ResultPayload` satisfies this interface,
 * so callers pass `buildResultPayload(result, {})` straight in.
 */
export interface RunCachePayload {
  survivors: { line: number; mutators: Record<string, number> }[];
  noCoverage: { line: number; mutators: Record<string, number> }[];
}

/**
 * Mint a runId for a finished mutation run so the caller can verify it later by
 * id, without re-auditing.
 *
 * `audit_code_resilience` and `triage_test_coverage` minted this identically —
 * same compact payload, same `{ line, mutators }` projection over both group
 * arrays, same non-fatal `catch` — from two copies that could drift into
 * writing different cache entries for the same file. One copy lives here, next
 * to {@link saveRun}, so both tools cache the same shape.
 *
 * `file` MUST be the workspace-relative path (`relFromRoot`): it is the key the
 * verify-by-runId check and triage both look the run up by.
 *
 * `payload` is the already-compacted result (`buildResultPayload(result, {})`),
 * built by the caller — see {@link RunCachePayload} for why it is not built
 * here. Callers must pass an UNCAPPED, UNFILTERED payload (`{}` opts): a
 * `maxSurvivors`-truncated one would cache fewer survivors than the run found
 * and a later verify would read the missing ones as fixed.
 *
 * A cache failure is non-fatal by design — the runId is a convenience for a
 * follow-up verify, and losing it must not cost the caller the audit they asked
 * for — so this returns `undefined` rather than throwing.
 */
export function mintRunId(
  payload: RunCachePayload,
  file: string,
  projectType: string,
  opts?: RunCacheOptions,
): string | undefined {
  try {
    return saveRun(
      {
        file,
        projectType,
        survivors: payload.survivors.map((g) => ({ line: g.line, mutators: g.mutators })),
        noCoverage: payload.noCoverage.map((g) => ({ line: g.line, mutators: g.mutators })),
      },
      opts,
    );
  } catch {
    return undefined; // cache failure is non-fatal; omit runId
  }
}

export function loadRun(runId: string, opts?: RunCacheOptions): RunCacheEntry | undefined {
  const dir = cacheDir(opts);
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts?.now ?? Date.now();
  // Defense in depth against path traversal: `runId` reaches this function from
  // a tool argument and is interpolated into a filename, so an id containing
  // path separators or `..` would read a JSON file anywhere on disk. The tool
  // validator already pins the minted 8-hex shape; this second check means the
  // cache cannot be turned into a file-read primitive even by a caller that
  // bypasses it (a direct API consumer, or a future handler that forgets).
  if (basename(runId) !== runId || runId.length === 0) return undefined;
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
