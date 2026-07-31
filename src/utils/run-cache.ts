import { createHash, randomUUID } from 'node:crypto';
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
import { basename, join, resolve } from 'node:path';

export interface RunCacheEntry {
  runId: string;
  file: string;
  projectType: string;
  createdAt: number;
  /**
   * {@link workspaceFingerprint} of the workspace root this run audited, when
   * the minting call site identified it (audit M10).
   *
   * OPTIONAL only because the identity has to be SUPPLIED by the caller
   * (`RunCacheOptions.workspaceRoot`) — this module cannot infer it. Both
   * production mint sites now pass it (`handler.ts` for `audit_code_resilience`,
   * `triage/audit-one.ts` for `triage_test_coverage`), and the runId check in
   * `audit/scope.ts` REFUSES an entry that lacks it as well as one that
   * mismatches: an unknown workspace is not "any workspace". In practice the
   * only hash-less entries left are pre-M10 leftovers in the system temp
   * directory, which cost one re-run and then age out. {@link cacheDir} is the
   * complementary, coarser partition.
   */
  workspaceHash?: string;
  survivors: { line: number; mutators: Record<string, number> }[];
  noCoverage: { line: number; mutators: Record<string, number> }[];
}

export interface RunCacheOptions {
  dir?: string;
  ttlMs?: number;
  max?: number;
  now?: number;
  /**
   * The audited workspace root (`env.workspaceRoot`), stamped onto the entry as
   * {@link RunCacheEntry.workspaceHash} so a verify can refuse a run minted for
   * a DIFFERENT workspace that happens to contain the same relative path.
   *
   * Deliberately NOT used to pick the cache directory. A root-derived directory
   * would make the two halves look in different PLACES rather than compare two
   * values, so any disagreement between them (a monorepo package root on one
   * side and the repo root on the other) would degrade into a silent cache miss
   * — indistinguishable from an expired id — instead of the explicit
   * "recorded in a different workspace" refusal `audit/scope.ts` returns.
   */
  workspaceRoot?: string;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX = 200;

/**
 * Stable short identity for a workspace root (audit M10).
 *
 * `resolve` first so `/repo`, `/repo/` and a relative `.` all fold to one
 * value — an entry must not become unverifiable because the two call sites
 * spelled the same directory differently. Hashed rather than stored verbatim
 * because the entry is world-readable in the system temp directory and the
 * absolute path of a user's checkout is not ours to leave lying around; 16 hex
 * characters (64 bits) is far beyond what an accidental collision between two
 * checkouts on one machine needs.
 */
export function workspaceFingerprint(workspaceRoot: string): string {
  return createHash('sha256').update(resolve(workspaceRoot)).digest('hex').slice(0, 16);
}

/**
 * Where cache entries live.
 *
 * The default is partitioned by the SERVER'S WORKING DIRECTORY (audit M10).
 * Before that, every workspace on the host shared one flat
 * `$TMPDIR/chaos-mcp-runs` directory, and the only binding between an entry and
 * the tree it described was `entry.file` — a workspace-RELATIVE path. A runId
 * minted for workspace A's `src/index.ts` therefore passed the `cached.file ===
 * relFile` check in workspace B, and the verify reported B's file as "still
 * surviving / now killed" against A's mutants.
 *
 * `process.cwd()` is the one workspace identity available to BOTH halves with
 * no call-site cooperation at all, and it is stable for the lifetime of a
 * server — an MCP server is launched in the project it serves — so entries
 * still survive a restart and the documented TTL still governs expiry. It is a
 * partition, not a proof: one process serving several roots via
 * `CHAOS_ALLOWED_ROOTS` shares a cwd. {@link RunCacheEntry.workspaceHash} is
 * what closes that gap, and now that every mint site stamps it the two layers
 * are complementary — the directory keeps unrelated servers apart, the hash
 * keeps unrelated ROOTS under one server apart.
 *
 * Entries written by earlier versions sit in the un-partitioned parent
 * directory and are simply never read again — a cold miss costs one re-run,
 * and they age out of the system temp directory on their own.
 */
function cacheDir(opts?: RunCacheOptions): string {
  return opts?.dir ?? join(tmpdir(), 'chaos-mcp-runs', workspaceFingerprint(process.cwd()));
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
  entry: Omit<RunCacheEntry, 'runId' | 'createdAt' | 'workspaceHash'>,
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
  // Stamped only when the caller identified the workspace: an entry that
  // carries no hash is treated as "unknown workspace", never as "any
  // workspace" — see the runId check in `audit/scope.ts`.
  if (opts?.workspaceRoot !== undefined)
    full.workspaceHash = workspaceFingerprint(opts.workspaceRoot);
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
 *
 * CALL SITES SHOULD PASS `opts.workspaceRoot` (`env.workspaceRoot`): it stamps
 * {@link RunCacheEntry.workspaceHash} onto the entry, which is what lets the
 * verify path refuse a run minted for a different workspace that contains the
 * same relative path (audit M10). Omitting it is not an error — the entry is
 * still bound to the server's working directory by {@link cacheDir} — but a
 * single process serving several roots (`CHAOS_ALLOWED_ROOTS`) can only tell
 * them apart when the hash is present.
 *
 * UPDATE (this change): every production mint site now passes it, and
 * `audit/scope.ts` refuses an entry without it. Omitting it here is therefore
 * no longer merely weaker — it hands the caller a runId that no verify will
 * ever accept. New mint sites MUST pass it.
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

/** True for a `{ line, mutators }` group array — the only shape verify can read. */
function isGroupArray(
  value: unknown,
): value is { line: number; mutators: Record<string, number> }[] {
  if (!Array.isArray(value)) return false;
  return value.every((g) => {
    if (typeof g !== 'object' || g === null || Array.isArray(g)) return false;
    const group = g as { line?: unknown; mutators?: unknown };
    if (typeof group.line !== 'number') return false;
    // `mutators` is only ever `Object.keys`-ed, so any plain object will do;
    // an array or a null would take `parseBaseline` somewhere it cannot handle.
    return (
      typeof group.mutators === 'object' &&
      group.mutators !== null &&
      !Array.isArray(group.mutators)
    );
  });
}

/**
 * Runtime shape check for a parsed cache entry (audit M10).
 *
 * `loadRun` used to `JSON.parse(...) as RunCacheEntry` and validate nothing but
 * `createdAt`, so ANY well-formed JSON file that happened to sit in the cache
 * directory was handed to the verify path as a baseline. A truncated write, a
 * hand-edited file, or an entry from a future/older schema then surfaced as a
 * raw `TypeError` out of `computeScope` ("Chaos Engine Halted: Cannot read
 * properties of null") instead of the intended, actionable "not found or
 * expired" tool error. Everything the consumers read is checked here, so a
 * malformed entry is simply a MISS.
 */
function isRunCacheEntry(value: unknown): value is RunCacheEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const e = value as Partial<Record<keyof RunCacheEntry, unknown>>;
  if (typeof e.runId !== 'string') return false;
  if (typeof e.file !== 'string') return false;
  if (typeof e.projectType !== 'string') return false;
  if (typeof e.createdAt !== 'number') return false;
  if (e.workspaceHash !== undefined && typeof e.workspaceHash !== 'string') return false;
  return isGroupArray(e.survivors) && isGroupArray(e.noCoverage);
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
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    // Shape first, then freshness: a file that is not an entry at all has no
    // meaningful `createdAt` to grade (audit M10).
    if (!isRunCacheEntry(parsed)) return undefined;
    if (now - parsed.createdAt > ttlMs) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
