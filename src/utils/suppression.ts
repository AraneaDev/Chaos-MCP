/**
 * Suppression-file storage: load, add, remove, verify, and the per-workspace
 * write lock.
 *
 * This module owns the FILE and nothing else. Applying a suppression set to a
 * `MutationResult` is domain logic over the audit result, not storage, and now
 * lives in `audit/apply-suppressions.ts` — which is what keeps this leaf module
 * from importing up into `format.ts`. It imports `node:crypto` (for the content
 * fingerprint) alongside `node:fs`/`node:path`, plus `utils/logger.js` — itself
 * a zero-dependency leaf that only writes to stderr. Nothing else: it must stay
 * a leaf, so it may not import any `src/*.ts` DOMAIN module.
 *
 * ## Schema v2: content fingerprints
 *
 * A suppression used to be identified by `(line, mutator)` and nothing else.
 * That identity does not survive editing: insert a line at the top of a file and
 * every suppression below it silently re-points at different code, hiding
 * whatever mutant now lands there. v2 records a `fingerprint` — a digest of the
 * normalized source line the suppression was argued about — so a moved or
 * rewritten line can be DETECTED instead of silently re-targeted.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { warn } from './logger.js';

/**
 * The suppressions file exists but cannot be read as a suppressions document.
 *
 * Deliberately NOT raised for a missing file: "no suppressions yet" is the
 * normal state of a fresh workspace and must stay a silent empty default. This
 * is the other case — a JSON syntax error, `EACCES`, `EISDIR` — where the user
 * HAS data and we simply cannot see it.
 *
 * The distinction is load-bearing because {@link addSuppressions} and
 * {@link removeSuppressions} are read-modify-WRITE cycles over the whole
 * document and {@link writeFile} renames over the original with no backup.
 * Collapsing "unreadable" into "empty" therefore turns the next write into a
 * silent deletion of every OTHER file's suppressions and every hand-written
 * `reason` on them. Throwing here is the same fail-safe posture
 * {@link verifySuppressions} documents for itself: fail toward the VISIBLE
 * failure, never toward invisible data loss.
 */
export class SuppressionFileError extends Error {
  /** Absolute path of the file that could not be read. */
  readonly path: string;
  constructor(path: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Suppression file "${path}" could not be read: ${detail}`);
    this.name = 'SuppressionFileError';
    this.path = path;
    this.cause = cause;
  }
}

/**
 * Normalize a stored suppression key to POSIX separators.
 *
 * Backslashes are translated on EVERY platform, not just where `sep` is `\`:
 * the whole point is that a key WRITTEN on Windows (`src\utils\foo.ts`) must
 * still resolve when the committed file is READ on Linux CI, where `sep` is
 * `/` and a platform-gated version would be a no-op. This mirrors the
 * unconditional normalisation in `triage.ts#toPosix` and `engines/php.ts`, and
 * carries the same accepted trade: a POSIX filename may legally contain a
 * backslash, so `weird\a.ts` is misread as a directory boundary. That is worth
 * it — the alternative is a silent, CI-invisible suppression miss.
 */
export function toPortableKey(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * The key under which `portable`'s entries are ACTUALLY stored in `entries`.
 *
 * Prefers the portable (POSIX) key, but falls back to any legacy key that
 * differs from it only by separator, so a suppressions file written by an older
 * Windows client is found — and, on the write paths, migrated — rather than
 * silently duplicated under a second key.
 */
/**
 * `entries` with `key` removed.
 *
 * A rebuild rather than `delete entries[key]`: the lint rule bans a
 * dynamically computed `delete`, and this is the same idiom the write paths
 * already use to drop a file left with no suppressions.
 */
function withoutKey(
  entries: Record<string, StoredEntry[]>,
  key: string,
): Record<string, StoredEntry[]> {
  return Object.fromEntries(Object.entries(entries).filter(([file]) => file !== key)) as Record<
    string,
    StoredEntry[]
  >;
}

function storedKeyFor(entries: Record<string, StoredEntry[]>, portable: string): string {
  if (Object.hasOwn(entries, portable)) return portable;
  for (const key of Object.keys(entries)) {
    if (key !== portable && toPortableKey(key) === portable) return key;
  }
  return portable;
}

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
  //
  // Live-audit finding #2: even with the identity fix, returning `next` and
  // letting the caller `await` it resumes BEFORE the cleanup `.finally` runs.
  // The awaiter resumes on a separate microtask path that bypasses the
  // cleanup callback, so any code that immediately reads WRITE_QUEUE.size
  // after `await addSuppressions` / `await removeSuppressions` sees a stale
  // entry. Fix: return `cleaned` (the post-cleanup Promise) so the caller's
  // await resolves AFTER the cleanup `.finally` callback has run.
  //
  // CodeRabbit finding: `cleaned` MUST preserve the underlying rejection so a
  // failed read/write surfaces to the caller (the handler's try/catch reports
  // it as "Failed to update suppression list"). Build `cleaned` from `next`
  // (which rejects on failure — `.finally` is pass-through), and separately
  // store a rejection-swallowed copy in the queue so the NEXT chained writer's
  // `prev.then(fn, fn)` still runs and there is no unhandled rejection.
  const cleaned = next.finally(() => {
    // `tracked` is assigned below and only read here, after `cleaned` settles.
    if (WRITE_QUEUE.get(key) === tracked) WRITE_QUEUE.delete(key);
  });
  const tracked = cleaned.catch(() => undefined) as Promise<unknown>;
  WRITE_QUEUE.set(key, tracked);
  return cleaned;
}

export interface SuppressionInput {
  line: number;
  mutator: string;
  reason?: string;
  /**
   * The change this mutant makes, `"<original> → <mutated>"` (see
   * {@link ../utils/mutant-identity.changeOf}). Part of the entry's IDENTITY:
   * two mutants of the same mutator on one line are told apart by this and
   * nothing else.
   *
   * Optional because cargo-mutants reports no replacement — its mutator name IS
   * the change description — and because a caller may omit it and let the audit
   * path resolve it from the survivor list (`audit/suppression-io.ts`).
   */
  change?: string;
}

/** One suppression as it is persisted. `fingerprint` is absent on v1 data. */
export interface StoredEntry {
  line: number;
  mutator: string;
  /** See {@link SuppressionInput.change}. Absent = mutator-only identity. */
  change?: string;
  reason?: string;
  addedAt: number;
  /**
   * Digest of the normalized source line this suppression was recorded against
   * ({@link fingerprintOfLine}). Absent means "never fingerprinted" — either a
   * v1 entry or a write whose source line could not be read — and an entry
   * without one is never applied.
   */
  fingerprint?: string;
}
interface SuppressionFile {
  version: number;
  entries: Record<string, StoredEntry[]>;
}

/**
 * Schema version this module writes. v1 = `(line, mutator)` only; v2 added the
 * per-entry content `fingerprint`; v3 makes IDENTITY the mutator plus the change
 * (`original → mutated`) and demotes `line` to a relocatable hint.
 *
 * Older files still LOAD — their entries keep every field verbatim, including
 * the hand-written `reason` — and are simply not applied as their authors
 * intended until re-confirmed. A v1 entry has no fingerprint, so it cannot be
 * proven to still point at the code it was argued about; back-filling one from
 * today's source would bless exactly the mismatches this feature exists to
 * catch. A v2 entry has no `change`, so it reads as mutator-only identity —
 * correct for cargo-mutants, and broader than intended for every other engine.
 *
 * v2 corpora are migrated once by `scripts/migrate-suppressions-v3.mjs`, which
 * is driven by audit reports because the change names WHICH mutant and only an
 * audit knows which mutants exist. That is a deliberate one-time step: the
 * alternative is a dual-format branch living in this module forever.
 */
const SCHEMA_VERSION = 3;

/**
 * Identity of one suppression: the mutator plus the change it makes.
 *
 * The line number is deliberately NOT in this key. It was, through v2, and that
 * is the defect v3 fixes. A positional key is invalidated by any edit above it —
 * the suppressions on `core/format.ts` were broken three separate times that way
 * — and it collapses several same-mutator mutants on one line onto a single
 * entry, so suppressing an equivalent mutant deleted a KILLED sibling's coverage
 * signal along with it.
 *
 * The line survives on the entry as a lookup HINT that relocation rewrites; the
 * identity is content.
 *
 * `change` is absent only for engines that report no replacement (cargo-mutants,
 * whose description IS the mutator name), where mutator alone is all the
 * identity available. Those entries keep the pre-v3 behaviour: one entry per
 * (file, mutator), matching every mutant of that mutator.
 */
const identityKeyOf = (mutator: string, change?: string): string =>
  change === undefined ? mutator : `${mutator} ${change}`;

/**
 * The key one file's STORED entries are deduplicated under: identity plus the
 * line the entry currently points at.
 *
 * Identity alone is not enough, because one file can hold two DIFFERENT mutants
 * that make the same change. Both shapes occur in this repository:
 *
 *  - `audit/scope.ts` builds an object literal whose `nowKilled: []` and
 *    `notReChecked: []` are separate mutants on separate lines, both mutating to
 *    the same replacement.
 *  - `core/tool-args-validation.ts` has the byte-identical guard
 *    `typeof entry !== 'object'` in two different validators, so those two
 *    mutants share a change AND a content fingerprint.
 *
 * On identity alone the second silently overwrote the first and its mutant
 * reappeared in the score. The fingerprint separates the first pair but NOT the
 * second; the line separates both.
 *
 * The line is not identity — matching never uses this key, and
 * `applySuppressions` still resolves an entry by content and relocates it. It is
 * the entry's current ADDRESS, which is exactly what a store needs to keep two
 * otherwise-indistinguishable records apart, and `restampSuppressions` keeps it
 * current when the code moves.
 *
 * Re-confirming a drifted or v1 entry also lands here: the caller names the line
 * it is looking at, which is the line the entry is stored against, so the entry
 * updates in place rather than leaving a duplicate.
 */
const storageKeyOf = (mutator: string, change: string | undefined, line: number): string =>
  `${identityKeyOf(mutator, change)}\u0000L${line}`;

/**
 * Normalize a source line before hashing it.
 *
 * Trim, then collapse internal whitespace runs to a single space. That is the
 * whole rule, and the restraint is deliberate:
 *
 * - It absorbs the churn that is NOT a change in meaning — re-indentation and a
 *   formatter re-wrapping the same tokens — so running Prettier does not
 *   invalidate a fingerprint.
 * - It keeps every token, operator, identifier, string and comment IN the
 *   digest. Over-normalizing (stripping punctuation, casing, comments) would
 *   let genuinely different code collide on one fingerprint, which is the exact
 *   failure mode being fixed: a suppression must stop applying the moment the
 *   code it was argued about changes.
 *
 * The line NUMBER is deliberately not part of the digest. The number is the
 * lookup key; the digest is the evidence that the key still points at the same
 * code. Hashing both would make every downward line shift look like a content
 * change and turn ordinary edits into a wall of false drift.
 */
export function normalizeSourceLine(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** Short content digest of one source line. 12 hex chars ≈ 48 bits. */
export function fingerprintOfLine(text: string): string {
  return createHash('sha256').update(normalizeSourceLine(text)).digest('hex').slice(0, 12);
}

/**
 * The source lines of a workspace-relative file, or `undefined` when it cannot
 * be read. Unreadable is a first-class outcome here, never an exception: a
 * suppressed file may have been deleted or renamed since, and that must degrade
 * to "cannot verify", not to a failed audit.
 */
function readSourceLines(workspaceRoot: string, relFile: string): string[] | undefined {
  try {
    return readFileSync(join(workspaceRoot, relFile), 'utf8').split(/\r?\n/);
  } catch {
    return undefined;
  }
}

/**
 * Fingerprint of `line` (1-based) within already-read source lines, or
 * `undefined` when the file was unreadable or the line is out of range.
 */
function fingerprintAt(lines: string[] | undefined, line: number): string | undefined {
  if (lines === undefined) return undefined;
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return undefined;
  return fingerprintOfLine(lines[line - 1]);
}

/**
 * Whether `text` is a line no mutation engine can ever report a mutant on:
 * blank, or nothing but comment.
 *
 * Every engine reports a mutant at the position of the token it replaced, and a
 * token is never inside a comment — so a suppression aimed at such a line
 * suppresses NOTHING. It is not merely useless: it is stored, fingerprinted
 * against the comment text, and therefore verifies clean forever, which makes
 * the mismatch invisible to {@link verifySuppressions}. Auditing this server
 * against itself found 40 entries in that state, several carrying a correct
 * equivalence argument for a mutant that had moved lines — the argument was
 * preserved while the suppression silently stopped applying.
 *
 * Deliberately conservative: a line is only rejected when NOTHING executable
 * remains on it. A line that CLOSES a block comment and then declares a
 * variable is mutable and is accepted, as is one that opens and closes a short
 * comment before a call. Better to accept an inert entry than to refuse a real
 * one, because refusing a real one loses the reason its author wrote.
 */
export function isNonMutableLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return true;
  if (trimmed.startsWith('//')) return true;
  // A block-comment opener or interior/closing line. Code AFTER the terminator
  // on the same line makes it mutable again, so look for what follows `*/`.
  if (trimmed.startsWith('/*') || trimmed.startsWith('*')) {
    const end = trimmed.indexOf('*/');
    return end === -1 || trimmed.slice(end + 2).trim() === '';
  }
  return false;
}

/**
 * Fingerprint the current content of one workspace-relative source line, or
 * `undefined` if it cannot be read. Exported for callers that want to compute
 * the same digest this module stores.
 */
export function fingerprintSourceLine(
  workspaceRoot: string,
  relFile: string,
  line: number,
): string | undefined {
  return fingerprintAt(readSourceLines(workspaceRoot, relFile), line);
}

/** One stored suppression, resolved to where its mutant is expected now. */
export interface ResolvedSuppression {
  /** Effective line after relocation — where the mutant is expected NOW. */
  line: number;
  /** The line the entry is stored against, before any relocation. */
  storedLine: number;
  mutator: string;
  change?: string;
  reason?: string;
  fingerprint: string;
  /** 1 = line and fingerprint agree; 2 = the fingerprint was found elsewhere. */
  tier: 1 | 2;
}

/** What one file's stored suppressions are worth against the current source. */
export interface SuppressionVerdict {
  /** Entries placed by source content alone (tiers 1 and 2). */
  resolved: ResolvedSuppression[];
  /** Fingerprint found nowhere; tier-3 candidates, resolved against survivors. */
  pending: ResolvedSuppression[];
  /**
   * Entries source alone refused and tier 3 cannot rescue: an ambiguous
   * fingerprint (found on two lines), or a vanished one on a changeless entry.
   *
   * Counted HERE rather than inferred by a caller from
   * `stored − resolved − pending − unverified`. A refused entry appears in no
   * list, so an inferred count would silently read zero the moment a fourth
   * outcome is added — and a suppression that stops applying while reporting
   * nothing is the exact failure this whole subsystem exists to prevent.
   */
  drifted: number;
  /** Entries carrying no fingerprint at all (v1 data, or an unstamped write). */
  unverified: number;
}

/** An empty verdict — nothing stored, nothing resolved, nothing to report. */
function emptyVerdict(): SuppressionVerdict {
  return { resolved: [], pending: [], drifted: 0, unverified: 0 };
}

/** Every 1-based line whose content hashes to `fingerprint`. */
function linesMatching(lines: string[], fingerprint: string): number[] {
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (fingerprintOfLine(lines[i]) === fingerprint) hits.push(i + 1);
  }
  return hits;
}

/**
 * Resolve each stored suppression against the current source, as far as source
 * alone can take it.
 *
 * TIER 1 — the stored line still hashes to the stored fingerprint. Use it. No
 * search, no report; this is the ordinary case.
 *
 * TIER 2 — the fingerprint is gone from the stored line but appears exactly
 * once elsewhere. The line's CONTENT is unchanged and an edit above merely
 * shifted it, so the entry is re-pointed. This is the failure that broke the
 * suppressions on `core/format.ts` three separate times, each time costing a
 * hand re-point — and hand re-pointing is what corrupted this repository's
 * corpus in the first place. It now costs nothing.
 *
 * PENDING — the fingerprint appears nowhere, so the line itself was edited: a
 * reflow, a rename, a trailing comment. The mutant may well still exist, but
 * proving it needs the SURVIVOR LIST, which this module must not see — it is a
 * leaf over the suppression FILE, and importing `MutationResult` would point it
 * at the domain layer. `audit/apply-suppressions.ts` finishes the job (tier 3).
 * An entry with no `change` is never pending: mutator-only identity gives tier 3
 * nothing to match on, so it goes straight to drift.
 *
 * AMBIGUITY IS REFUSAL. A fingerprint found twice resolves to neither line: the
 * entry appears in no list and is counted as drift downstream. This is the same
 * fail-SAFE asymmetry v2 established — a suppression that is not applied lowers
 * the reported score VISIBLY, the mutant reappears and the counts say why,
 * whereas a suppression applied to the wrong code hides a real coverage gap
 * INVISIBLY. Always fail toward the visible failure.
 */
export function verifySuppressions(
  workspaceRoot: string,
  relFile: string,
  entries: StoredEntry[] | undefined,
): SuppressionVerdict {
  const verdict = emptyVerdict();
  if (entries === undefined || entries.length === 0) return verdict;
  // One read per file, reused for every entry in it.
  const lines = readSourceLines(workspaceRoot, relFile);
  for (const e of entries) {
    if (e.fingerprint === undefined) {
      verdict.unverified += 1;
      continue;
    }
    const base = {
      storedLine: e.line,
      mutator: e.mutator,
      fingerprint: e.fingerprint,
      ...(e.change === undefined ? {} : { change: e.change }),
      ...(e.reason === undefined ? {} : { reason: e.reason }),
    };
    if (fingerprintAt(lines, e.line) === e.fingerprint) {
      verdict.resolved.push({ ...base, line: e.line, tier: 1 });
      continue;
    }
    // An unreadable file (deleted, renamed) yields no lines, hence no
    // relocation: the entry drifts rather than being credited on an older check.
    const hits = lines === undefined ? [] : linesMatching(lines, e.fingerprint);
    if (hits.length === 1) {
      verdict.resolved.push({ ...base, line: hits[0], tier: 2 });
      continue;
    }
    if (hits.length === 0 && e.change !== undefined) {
      // `tier` is a placeholder here; `applySuppressions` stamps 3 if it places
      // the entry, and counts it as drift if it cannot.
      verdict.pending.push({ ...base, line: e.line, tier: 1 });
      continue;
    }
    // Either the fingerprint is ambiguous (two lines carry it, and guessing is
    // what this system refuses to do) or it is gone from a changeless entry,
    // which leaves tier 3 nothing to match on.
    verdict.drifted += 1;
  }
  return verdict;
}

function filePath(workspaceRoot: string, configPath?: string): string {
  if (configPath) return isAbsolute(configPath) ? configPath : join(workspaceRoot, configPath);
  return join(workspaceRoot, '.chaos-mcp', 'suppressions.json');
}

/**
 * Read the suppressions document.
 *
 * Exactly one error is benign: `ENOENT`. A workspace that has never suppressed
 * anything has no file, and that must read as an empty document. EVERY other
 * failure — a `JSON.parse` SyntaxError, `EACCES`, `EISDIR` — means the user has
 * data we cannot see, and is raised as {@link SuppressionFileError} so the
 * read-modify-write callers abort instead of "helpfully" rewriting the file
 * from an empty starting point and destroying every entry in it.
 */
function readFile(workspaceRoot: string, configPath?: string): SuppressionFile {
  const dest = filePath(workspaceRoot, configPath);
  let raw: SuppressionFile;
  try {
    raw = JSON.parse(readFileSync(dest, 'utf8')) as SuppressionFile;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, entries: {} };
    }
    throw new SuppressionFileError(dest, error);
  }
  // A well-formed JSON document whose shape is not ours (`null`, an array, a
  // scalar, or an object without an `entries` object) is treated as EMPTY, not
  // as unreadable. It parsed — there is nothing to salvage and no entry to
  // lose — so overwriting it with a correct document is a repair, not data
  // loss. Only a file we could not parse at all is protected above.
  if (!raw || typeof raw !== 'object' || typeof raw.entries !== 'object' || raw.entries === null) {
    return { version: 1, entries: {} };
  }
  return { version: raw.version ?? 1, entries: raw.entries };
}

function writeFile(workspaceRoot: string, data: SuppressionFile, configPath?: string): void {
  const dest = filePath(workspaceRoot, configPath);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  // Anything this module writes is v2 data (new entries carry a fingerprint), so
  // stamp the version up — but never DOWN: a file written by a future, higher
  // version keeps its own number rather than being silently downgraded.
  const out: SuppressionFile = { ...data, version: Math.max(data.version, SCHEMA_VERSION) };
  writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  renameSync(tmp, dest);
}

/**
 * Every stored suppression, keyed by workspace-relative file path.
 *
 * Returns the stored ENTRIES, not a key set: the fingerprint on each entry is
 * what {@link verifySuppressions} needs, and verification is deliberately a
 * separate step so a caller pays for reading source files only for the files it
 * actually audits.
 *
 * Malformed entries are dropped (they cannot be keyed), a non-array per-file
 * value is skipped, and a file left with no valid entry is omitted entirely.
 *
 * Keys are normalised to POSIX separators ({@link toPortableKey}) so a file
 * written on Windows resolves against the `/`-separated key every other reader
 * computes. Two stored keys that collapse onto the same portable key are
 * MERGED (later entry wins per `(line, mutator)`) rather than one silently
 * shadowing the other.
 *
 * This is the READ path used to filter an audit the user explicitly asked for,
 * so an unreadable file degrades to "no suppressions" instead of failing the
 * audit — but never silently: {@link SuppressionFileError} is warned to stderr,
 * because a corrupt file that looks exactly like "nothing suppressed" is how a
 * whole equivalence argument disappears without a trace.
 */
export function loadSuppressions(
  workspaceRoot: string,
  configPath?: string,
): Map<string, StoredEntry[]> {
  let data: SuppressionFile;
  try {
    data = readFile(workspaceRoot, configPath);
  } catch (error: unknown) {
    if (!(error instanceof SuppressionFileError)) throw error;
    warn(`${error.message} — continuing as if it recorded no suppressions; none will be applied.`);
    return new Map<string, StoredEntry[]>();
  }
  const map = new Map<string, StoredEntry[]>();
  for (const [file, list] of Object.entries(data.entries)) {
    if (!Array.isArray(list)) continue;
    const kept: StoredEntry[] = [];
    for (const e of list) {
      if (!e || !Number.isInteger(e.line) || typeof e.mutator !== 'string') continue;
      const entry: StoredEntry = { line: e.line, mutator: e.mutator, addedAt: e.addedAt };
      // A non-string `change` is treated as absent → mutator-only identity,
      // rather than a value that could never match a computed change string.
      if (typeof e.change === 'string') entry.change = e.change;
      if (typeof e.reason === 'string') entry.reason = e.reason;
      // A non-string fingerprint is treated as absent → the entry is unverified
      // rather than compared against a value that can never match.
      if (typeof e.fingerprint === 'string') entry.fingerprint = e.fingerprint;
      kept.push(entry);
    }
    if (kept.length === 0) continue;
    const key = toPortableKey(file);
    const existing = map.get(key);
    if (existing === undefined) {
      map.set(key, kept);
      continue;
    }
    // Same file reached under two spellings (e.g. a Windows-written
    // `src\a.ts` alongside a Linux-written `src/a.ts`). Union them by STORAGE
    // key, not identity: identity alone is not unique inside one file (see
    // `storageKeyOf`), so two mutants sharing a mutator and a change on
    // different lines would collapse into one and a suppression would be lost.
    const byKey = new Map(
      existing.map((e) => [storageKeyOf(e.mutator, e.change, e.line), e] as const),
    );
    for (const e of kept) byKey.set(storageKeyOf(e.mutator, e.change, e.line), e);
    map.set(key, [...byKey.values()]);
  }
  return map;
}

/** Quiesces callers that prefer a Promise return even on the no-op path. */
function noopPromise(): Promise<AddSuppressionsResult> {
  return Promise.resolve({ stamped: 0, unstamped: 0, rejected: [] });
}

/** What a write actually managed to record — the unstamped tally is the signal. */
export interface AddSuppressionsResult {
  /** Entries written WITH a content fingerprint; these will be applied. */
  stamped: number;
  /**
   * Entries written WITHOUT one because the source line could not be read
   * (missing file, line past EOF). They are stored — the caller's reason is
   * never thrown away — but they count as `unverified` and are not applied.
   */
  unstamped: number;
  /**
   * Entries NOT written, and why.
   *
   * `'non-mutable'` — the target line is blank or comment-only, so no engine
   * could ever report a mutant there (see {@link isNonMutableLine}).
   *
   * `'unresolved'` — the run did not finish, and no mutant matching the
   * `(line, mutator)` was generated by the batches that DID run. Absence proves
   * nothing here: the mutant may live in a batch that never ran. Filing the
   * entry anyway would store mutator-only identity — broader than the caller
   * asked for — on the strength of a run that did not look.
   *
   * `'ambiguous'` — the caller named a `(line, mutator)` carrying SEVERAL
   * distinct mutants and did not say which. Filing it would suppress all of
   * them, which is how an equivalent mutant takes a KILLED sibling's coverage
   * signal down with it; the `candidates` are returned so the caller can name a
   * `change` instead.
   *
   * Either way the caller's reason is dropped, and in both cases that is right:
   * storing the entry is what would make the mistake permanent and invisible. A
   * non-mutable entry would fingerprint the comment and verify clean forever
   * while suppressing nothing.
   */
  rejected: {
    line: number;
    mutator: string;
    cause: 'non-mutable' | 'ambiguous' | 'unresolved';
    /** The distinct changes on that line, when `cause` is `'ambiguous'`. */
    candidates?: string[];
  }[];
}

/**
 * The reason to persist when re-confirming an entry.
 *
 * Merge rule (deliberate): a new non-empty reason wins, otherwise the existing
 * one is kept. A re-suppression that supplies no reason must not wipe the
 * hand-written equivalence argument already on record — those strings are real
 * human work — and a re-suppression that DOES supply one is the caller
 * explicitly re-arguing the case, so it replaces rather than accumulates.
 */
function mergeReason(next: string | undefined, previous: string | undefined): string | undefined {
  return next !== undefined && next !== '' ? next : previous;
}

/**
 * Add (or re-confirm) suppressions for one file, stamping each with the
 * fingerprint of the source line it targets.
 *
 * Re-adding an existing `(line, mutator)` is a RE-CONFIRMATION, not a no-op: the
 * entry is re-stamped with the current fingerprint, which is how a drifted or
 * v1 entry is promoted back to applied. The original `addedAt` is preserved
 * (when the equivalence was first argued) and the reason is merged per
 * {@link mergeReason}. If the line cannot be read now, any previous fingerprint
 * is dropped rather than kept: an entry we cannot re-verify must not keep
 * applying on the strength of an older check.
 *
 * The entry is stored under the POSIX-normalised key so the file stays
 * portable; a pre-existing legacy key that differs only by separator is
 * migrated onto it rather than left behind as a duplicate.
 *
 * An unreadable suppressions file makes this THROW ({@link SuppressionFileError})
 * instead of starting from an empty document: `handler.ts` reports it as
 * "Failed to update suppression list", which is strictly better than a write
 * that silently drops every other file's entries.
 */
export function addSuppressions(
  workspaceRoot: string,
  relFile: string,
  entries: SuppressionInput[],
  configPath?: string,
): Promise<AddSuppressionsResult> {
  if (entries.length === 0) return noopPromise();
  return withWorkspaceLock(workspaceRoot, configPath, () => {
    const data = readFile(workspaceRoot, configPath);
    const portableKey = toPortableKey(relFile);
    const legacyKey = storedKeyFor(data.entries, portableKey);
    const list = Array.isArray(data.entries[legacyKey])
      ? data.entries[legacyKey]
      : ([] as StoredEntry[]);
    // `list` is captured above, so dropping the legacy key here migrates the
    // entries onto the portable key instead of leaving a duplicate behind.
    if (legacyKey !== portableKey) data.entries = withoutKey(data.entries, legacyKey);
    const indexOfKey = new Map<string, number>();
    list.forEach((e, i) => {
      if (e && typeof e === 'object') indexOfKey.set(storageKeyOf(e.mutator, e.change, e.line), i);
    });
    // One read for the whole batch; every entry in it targets this same file.
    const lines = readSourceLines(workspaceRoot, relFile);
    const now = Date.now();
    const summary: AddSuppressionsResult = { stamped: 0, unstamped: 0, rejected: [] };
    for (const e of entries) {
      // Refuse a target no mutant can occupy, BEFORE it is stored and stamped.
      // Storing it is what makes the mistake permanent and invisible.
      const targetLine = lines?.[e.line - 1];
      if (targetLine !== undefined && isNonMutableLine(targetLine)) {
        summary.rejected.push({ line: e.line, mutator: e.mutator, cause: 'non-mutable' });
        warn(
          `${relFile}:${e.line} is blank or comment-only, so no mutant is ever reported there — ` +
            `the "${e.mutator}" suppression for it was NOT stored. Check the line number against ` +
            'the survivor you meant to suppress; a stored entry would fingerprint the comment and ' +
            'verify clean forever while suppressing nothing.',
        );
        continue;
      }
      const fingerprint = fingerprintAt(lines, e.line);
      if (fingerprint === undefined) summary.unstamped += 1;
      else summary.stamped += 1;
      const k = storageKeyOf(e.mutator, e.change, e.line);
      const at = indexOfKey.get(k);
      const previous = at === undefined ? undefined : list[at];
      const merged: StoredEntry = {
        line: e.line,
        mutator: e.mutator,
        addedAt: previous?.addedAt ?? now,
      };
      if (e.change !== undefined) merged.change = e.change;
      const reason = mergeReason(e.reason, previous?.reason);
      if (reason !== undefined) merged.reason = reason;
      if (fingerprint !== undefined) merged.fingerprint = fingerprint;
      if (at === undefined) {
        indexOfKey.set(k, list.length);
        list.push(merged);
      } else {
        list[at] = merged;
      }
    }
    data.entries[portableKey] = list;
    writeFile(workspaceRoot, data, configPath);
    return summary;
  });
}

/**
 * Move stored entries onto the lines they were resolved to.
 *
 * Relocation without this is not a fix but a repeated rescue: every run would
 * re-search, and the corpus would keep the wrong line forever, so the next
 * person to read `suppressions.json` sees a number that has been wrong for
 * months. Writing it back is what turns detected drift into HEALED drift.
 *
 * Each update names the entry by its STORED line as well as its identity, and is
 * matched against the entry's current line. Identity alone is not enough: one
 * file can hold two mutants with the same mutator and the same change on
 * different lines (see {@link storageKeyOf}), and this repository's own corpus
 * holds three such pairs. Keyed on identity alone, two of them relocating in one
 * run would both be rewritten to whichever line the map happened to keep, with
 * the same re-derived fingerprint — leaving one mutant unsuppressed and the two
 * entries indistinguishable.
 *
 * The fingerprint is re-derived from the NEW line, so the next run resolves at
 * tier 1 and does no searching at all.
 *
 * An update naming no stored entry is a silent no-op rather than an error: the
 * caller resolved against an audit result, and an entry may have been dropped by
 * an `unsuppress` in the same call.
 */
export function restampSuppressions(
  workspaceRoot: string,
  relFile: string,
  updates: { mutator: string; change?: string; storedLine: number; line: number }[],
  configPath?: string,
): Promise<void> {
  if (updates.length === 0) return Promise.resolve();
  return withWorkspaceLock(workspaceRoot, configPath, () => {
    const data = readFile(workspaceRoot, configPath);
    const portableKey = toPortableKey(relFile);
    const legacyKey = storedKeyFor(data.entries, portableKey);
    const list = data.entries[legacyKey];
    if (!Array.isArray(list)) return;
    const byEntry = new Map(
      updates.map((u) => [storageKeyOf(u.mutator, u.change, u.storedLine), u.line] as const),
    );
    const lines = readSourceLines(workspaceRoot, relFile);
    let changed = false;
    const next = list.map((e) => {
      if (!e || typeof e !== 'object') return e;
      const line = byEntry.get(storageKeyOf(e.mutator, e.change, e.line));
      if (line === undefined || line === e.line) return e;
      changed = true;
      const moved: StoredEntry = { ...e, line };
      const fingerprint = fingerprintAt(lines, line);
      // A line we cannot read now must not keep an old fingerprint: that would
      // credit the entry at tier 1 on the strength of a check against different
      // code. Dropping it demotes the entry to `unverified`, which is visible.
      if (fingerprint === undefined) delete moved.fingerprint;
      else moved.fingerprint = fingerprint;
      return moved;
    });
    if (!changed) return;
    if (legacyKey !== portableKey) data.entries = withoutKey(data.entries, legacyKey);
    data.entries[portableKey] = next;
    writeFile(workspaceRoot, data, configPath);
  });
}

/**
 * Drop entries from one file's suppressions.
 *
 * Two drop modes, chosen per key. A key carrying a `change` removes EXACTLY the
 * entry with that identity. A key without one removes every entry for that
 * mutator — the pre-v3 behaviour, kept so a caller who cannot name the change
 * can still clear a line. The `line` on the key is ignored: identity is content,
 * and an entry that has relocated would otherwise become un-removable.
 *
 * Resolves the file under its portable key, falling back to a legacy key that
 * differs only by separator so an entry written on Windows can still be
 * unsuppressed on Linux; survivors are rewritten under the portable key. Like
 * {@link addSuppressions}, this propagates {@link SuppressionFileError} rather
 * than rewriting an unreadable document from scratch.
 */
export function removeSuppressions(
  workspaceRoot: string,
  relFile: string,
  keys: { line: number; mutator: string; change?: string }[],
  configPath?: string,
): Promise<void> {
  if (keys.length === 0) return Promise.resolve();
  return withWorkspaceLock(workspaceRoot, configPath, () => {
    const data = readFile(workspaceRoot, configPath);
    const portableKey = toPortableKey(relFile);
    const legacyKey = storedKeyFor(data.entries, portableKey);
    const list = data.entries[legacyKey];
    if (!Array.isArray(list)) return;
    const dropExact = new Set(
      keys.filter((k) => k.change !== undefined).map((k) => identityKeyOf(k.mutator, k.change)),
    );
    const dropByMutator = new Set(keys.filter((k) => k.change === undefined).map((k) => k.mutator));
    // `readFile` only proves `entries` is an object — per-entry shape is never
    // checked on the write path, so a hand-edited or truncated file holding
    // `{"entries":{"src/a.ts":[null]}}` made this dereference throw, surfacing
    // as an opaque "Failed to update suppression list". Same guard
    // `addSuppressions` already applies when it indexes the list; a junk entry
    // is silently dropped here, which is the repair the caller wanted anyway.
    const kept = list.filter(
      (e) =>
        e &&
        typeof e === 'object' &&
        !dropExact.has(identityKeyOf(e.mutator, e.change)) &&
        !dropByMutator.has(e.mutator),
    );
    if (legacyKey !== portableKey) data.entries = withoutKey(data.entries, legacyKey);
    if (kept.length > 0) {
      data.entries[portableKey] = kept;
    } else {
      // Last entry gone → the file key goes with it, under either spelling.
      data.entries = withoutKey(data.entries, portableKey);
    }
    writeFile(workspaceRoot, data, configPath);
  });
}
