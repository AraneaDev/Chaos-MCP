import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadSuppressions,
  addSuppressions,
  removeSuppressions,
  verifySuppressions,
  restampSuppressions,
  normalizeSourceLine,
  fingerprintOfLine,
  fingerprintSourceLine,
  toPortableKey,
  SuppressionFileError,
  _resetWriteQueue,
  _writeQueueSize,
} from '../utils/suppression.js';
import { applySuppressions } from '../audit/apply-suppressions.js';
import { loadVerifiedSuppressions } from '../audit/suppression-io.js';
import { warn } from '../utils/logger.js';
import type { MutationResult } from '../engines/base.js';
import { verdictOf, appliedKeys } from './support/suppression-verdict.js';

// `loadSuppressions` degrades an unreadable file to "no suppressions" but must
// SAY so; the warning is the only signal that separates "corrupt" from
// "nothing suppressed", so it is asserted rather than left to stderr.
vi.mock('../utils/logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger.js')>()),
  warn: vi.fn(),
}));

/**
 * The `"<line> <mutator>"` keys stored for one file, in file order.
 *
 * `loadSuppressions` returns the stored ENTRIES now (v2 keeps a fingerprint on
 * each), so the tests that only care about identity project them back down to
 * the key they used to assert on.
 */
function storedKeys(root: string, file: string, configPath?: string): string[] {
  return (loadSuppressions(root, configPath).get(file) ?? []).map((e) => `${e.line} ${e.mutator}`);
}

/** Write a source file under the workspace so a suppression can fingerprint it. */
function writeSource(root: string, rel: string, lines: string[]): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), `${lines.join('\n')}\n`, 'utf8');
}

/** Absolute path of the default suppressions file under a test workspace. */
function supFile(r: string): string {
  return join(r, '.chaos-mcp', 'suppressions.json');
}

/** Write a raw suppressions file (valid or not) at the default location. */
function writeRawSuppressions(r: string, contents: string): string {
  mkdirSync(join(r, '.chaos-mcp'), { recursive: true });
  writeFileSync(supFile(r), contents, 'utf8');
  return supFile(r);
}

let root: string;
beforeEach(() => {
  vi.mocked(warn).mockClear();
  root = mkdtempSync(join(tmpdir(), 'sup-test-'));
  // Defensive: clear the in-process write-queue so a previous test that leaked
  // (e.g. crashed mid-write) cannot poison this one. The queue is per
  // workspaceRoot+configPath; fresh mkdtempSync root ⇒ fresh key.
  _resetWriteQueue();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  _resetWriteQueue();
});

function makeResult(): MutationResult {
  return {
    target: 'src/a.ts',
    totalMutants: 10,
    killed: 6,
    survived: 4,
    mutationScore: '60.00%',
    vulnerabilities: [
      { line: 1, mutator: 'A', description: 'x' },
      { line: 1, mutator: 'B', description: 'x' },
      { line: 2, mutator: 'A', description: 'no test reached this line' },
    ],
  };
}

describe('suppression', () => {
  it('missing file → empty map', () => {
    expect(loadSuppressions(root).size).toBe(0);
    // ENOENT is the ORDINARY state of a fresh workspace, not a fault: it must
    // not warn, or every first audit would emit a scary line about a file that
    // is simply not supposed to exist yet.
    expect(warn).not.toHaveBeenCalled();
  });

  // UPDATED (was 'corrupt file → empty map, no throw'): the empty-map result on
  // the READ path is unchanged and still pinned, but silence is not. A corrupt
  // file that reads exactly like "nothing suppressed" is the failure mode being
  // fixed, so the warning is now part of the contract.
  it('corrupt file → empty map, no throw, but WARNS', () => {
    writeRawSuppressions(root, '{bad');
    expect(loadSuppressions(root).size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(warn).mock.calls[0][0])).toContain('could not be read');
  });

  it('add then load round-trips, deduped', async () => {
    await addSuppressions(root, 'src/a.ts', [
      { line: 1, mutator: 'A', reason: 'equivalent' },
      { line: 1, mutator: 'A' }, // dup
    ]);
    expect(storedKeys(root, 'src/a.ts')).toEqual(['1 A']);
    // Assert the dedup happened at WRITE time (one stored entry), not just that
    // loadSuppressions' Set collapses it — pins the `seen.has(k)` guard.
    const raw = JSON.parse(readFileSync(join(root, '.chaos-mcp', 'suppressions.json'), 'utf8')) as {
      entries: Record<string, unknown[]>;
    };
    expect(raw.entries['src/a.ts']).toHaveLength(1);
  });

  it('addSuppressions with no entries writes nothing (early return)', async () => {
    await addSuppressions(root, 'src/a.ts', []);
    // The early return means no file is created at all.
    expect(existsSync(join(root, '.chaos-mcp', 'suppressions.json'))).toBe(false);
  });

  it('removeSuppressions with no keys writes nothing (early return)', async () => {
    await removeSuppressions(root, 'src/a.ts', []);
    expect(existsSync(join(root, '.chaos-mcp', 'suppressions.json'))).toBe(false);
  });

  it('remove deletes a specific key', async () => {
    await addSuppressions(root, 'src/a.ts', [
      { line: 1, mutator: 'A' },
      { line: 2, mutator: 'B' },
    ]);
    await removeSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]);
    expect(storedKeys(root, 'src/a.ts')).toEqual(['2 B']);
  });

  it('applySuppressions filters vulnerabilities and recomputes score', () => {
    const { result, suppressedCount } = applySuppressions(makeResult(), verdictOf(['1 A', '2 A']));
    expect(suppressedCount).toBe(2);
    expect(result.vulnerabilities).toEqual([{ line: 1, mutator: 'B', description: 'x' }]);
    expect(result.totalMutants).toBe(8); // 10 - 2
    expect(result.survived).toBe(3); // 4 - 1 (only '1 A' is a true survivor; '2 A' is NoCoverage)
    expect(result.mutationScore).toBe('75.00%'); // 6 / 8
  });

  it('applySuppressions suppressing only a NoCoverage mutant leaves survived unchanged', () => {
    // '2 A' has description 'no test reached this line' → NoCoverage, not a true survivor
    const { result, suppressedCount } = applySuppressions(makeResult(), verdictOf(['2 A']));
    expect(suppressedCount).toBe(1);
    expect(result.totalMutants).toBe(9); // 10 - 1
    expect(result.survived).toBe(4); // unchanged — NoCoverage doesn't count against survived
    expect(result.mutationScore).toBe('66.67%'); // 6 / 9
  });

  it('applySuppressions with undefined set is a no-op', () => {
    const r = makeResult();
    const { result, suppressedCount } = applySuppressions(r, undefined);
    expect(suppressedCount).toBe(0);
    expect(result.totalMutants).toBe(10);
  });

  // ── configPath branch (line 26): a custom path is honored, relative paths
  //    resolve against the workspace root, absolute paths are used verbatim. ──
  it('honors a relative configPath (not the default location)', async () => {
    await addSuppressions(root, 'src/a.ts', [{ line: 7, mutator: 'C' }], 'custom/sup.json');
    // The custom file round-trips...
    expect(storedKeys(root, 'src/a.ts', 'custom/sup.json')).toEqual(['7 C']);
    // ...and the DEFAULT location was never written.
    expect(loadSuppressions(root).size).toBe(0);
  });

  it('honors an absolute configPath verbatim', async () => {
    const abs = join(root, 'abs-suppressions.json');
    await addSuppressions(root, 'src/a.ts', [{ line: 9, mutator: 'D' }], abs);
    expect(storedKeys(root, 'src/a.ts', abs)).toEqual(['9 D']);
    // Reading it as a relative path (joined to root) would point elsewhere → empty.
    expect(loadSuppressions(root).size).toBe(0);
  });

  // ── version preservation (line 43): `raw.version ?? 1` must keep an existing
  //    version across a read-modify-write (kills `??` → `&&`). ──
  it('never downgrades a document written by a future version', async () => {
    mkdirSync(join(root, '.chaos-mcp'), { recursive: true });
    const dest = join(root, '.chaos-mcp', 'suppressions.json');
    writeFileSync(
      dest,
      JSON.stringify({
        version: 99,
        entries: { 'src/a.ts': [{ line: 1, mutator: 'A', addedAt: 1 }] },
      }),
    );
    await addSuppressions(root, 'src/a.ts', [{ line: 2, mutator: 'B' }]);
    const raw = JSON.parse(readFileSync(dest, 'utf8')) as { version: number };
    // `Math.max(data.version, SCHEMA_VERSION)`: a file written by a newer
    // release keeps its own number rather than being silently graded down to
    // one this build understands.
    expect(raw.version).toBe(99);
  });

  // ── readFile shape validation (lines 36–39): valid JSON of the wrong shape
  //    must yield an empty map, never crash on Object.entries. ──
  it.each([
    ['top-level null', 'null'],
    ['a non-object scalar', '42'],
    ['an object missing entries', '{"version":1}'],
    ['entries set to null', '{"version":1,"entries":null}'],
  ])('treats %s as an empty suppression set', (_label, content) => {
    mkdirSync(join(root, '.chaos-mcp'), { recursive: true });
    writeFileSync(join(root, '.chaos-mcp', 'suppressions.json'), content);
    expect(loadSuppressions(root).size).toBe(0);
  });

  // ── loadSuppressions entry validation (lines 64/67/70): non-array values are
  //    skipped, malformed entries are filtered, files with no valid entries are
  //    omitted from the map entirely. ──
  it('skips non-array entry values, filters malformed entries, and drops empty files', () => {
    mkdirSync(join(root, '.chaos-mcp'), { recursive: true });
    writeFileSync(
      join(root, '.chaos-mcp', 'suppressions.json'),
      JSON.stringify({
        version: 1,
        entries: {
          'good.ts': [
            { line: 5, mutator: 'A', addedAt: 1 }, // valid → kept
            { line: 5.5, mutator: 'B', addedAt: 1 }, // non-integer line → dropped
            { line: 6 }, // missing mutator → dropped
            { mutator: 'C' }, // missing line → dropped
            null, // falsy entry → dropped
          ],
          'notArray.ts': 42, // not an array (and not iterable) → file skipped
          'allBad.ts': [{ line: 'x', mutator: 'Z' }], // every entry invalid → file omitted
        },
      }),
    );
    const map = loadSuppressions(root);
    expect([...map.keys()].sort()).toEqual(['good.ts']);
    expect(storedKeys(root, 'good.ts')).toEqual(['5 A']);
  });

  // ── removeSuppressions else-branch (lines 110–112): removing the last entry
  //    for a file deletes that file's key entirely, leaving other files intact. ──
  // Also exercises the H3 in-process Promise-chain mutex: two addSuppressions +
  // one removeSuppressions chained consecutively must each see the previous
  // write commit before the next read-modify-write begins. The sync test fails
  // because the writes are in microtask order; await forces the assertions to
  // observe committed state. The raw-file assertion pins the ordering proof.
  it('deletes a file key when its last entry is removed, keeping other files', async () => {
    await addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]);
    await addSuppressions(root, 'src/b.ts', [{ line: 2, mutator: 'B' }]);
    await removeSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]);
    const map = loadSuppressions(root);
    // a.ts is gone, b.ts remains — distinguishes "keep all" and "drop all" mutants.
    expect([...map.keys()]).toEqual(['src/b.ts']);
    // The raw file must no longer carry the src/a.ts key at all.
    const raw = JSON.parse(readFileSync(join(root, '.chaos-mcp', 'suppressions.json'), 'utf8')) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(raw.entries)).toEqual(['src/b.ts']);
  });

  // ── applySuppressions early return (line 130): a non-empty set that matches
  //    no vulnerability leaves the result untouched with suppressedCount 0. ──
  it('applySuppressions with a non-matching set is a no-op', () => {
    const r = makeResult();
    const { result, suppressedCount } = applySuppressions(r, verdictOf(['999 Z']));
    expect(suppressedCount).toBe(0);
    expect(result.totalMutants).toBe(10);
    expect(result.vulnerabilities).toHaveLength(3);
    expect(result.mutationScore).toBe('60.00%');
  });

  /**
   * A non-matching set must leave the score alone, not recompute it. On a run
   * that produced no mutants at all, recomputing divides by zero and the guard
   * clamps to 100% — turning "nothing was measured" into a perfect score, the
   * single most misleading result this tool can report.
   */
  it('applySuppressions does not recompute the score of a zero-mutant result', () => {
    const empty: MutationResult = {
      target: 'src/a.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '0.00%',
      vulnerabilities: [],
    };

    const { result, suppressedCount } = applySuppressions(empty, verdictOf(['1 A']));

    expect(suppressedCount).toBe(0);
    expect(result.mutationScore).toBe('0.00%');
  });

  /** An empty set is the same no-op as an undefined one. */
  it('does not append a duplicate when the same mutant is suppressed twice', () => {
    // Dedupe ACROSS calls, not just within one batch: the second call rebuilds
    // its index from the entries already on disk. If that rebuild loses the
    // keys, every re-suppression appends another copy and the file grows without
    // bound.
    return (async () => {
      await addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A', reason: 'first' }]);
      await addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A', reason: 'second' }]);

      const raw = JSON.parse(
        readFileSync(join(root, '.chaos-mcp', 'suppressions.json'), 'utf8'),
      ) as { entries: Record<string, { reason?: string }[]> };
      expect(raw.entries['src/a.ts']).toHaveLength(1);
      // A re-suppression is a RE-CONFIRMATION (it re-stamps the fingerprint), so
      // an explicitly supplied new reason replaces the old one.
      expect(raw.entries['src/a.ts'][0].reason).toBe('second');
    })();
  });

  it('a re-suppression with no reason keeps the reason already on record', async () => {
    // The stored reasons are hand-written equivalence arguments. Re-confirming
    // an entry (to re-stamp its fingerprint) must not wipe one.
    await addSuppressions(root, 'src/a.ts', [
      { line: 1, mutator: 'A', reason: 'unreachable by construction' },
    ]);
    await addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]);
    const stored = loadSuppressions(root).get('src/a.ts');
    expect(stored?.[0].reason).toBe('unreachable by construction');
  });

  it('a re-suppression preserves the original addedAt', async () => {
    mkdirSync(join(root, '.chaos-mcp'), { recursive: true });
    writeFileSync(
      join(root, '.chaos-mcp', 'suppressions.json'),
      JSON.stringify({
        version: 2,
        entries: { 'src/a.ts': [{ line: 1, mutator: 'A', addedAt: 111, fingerprint: 'stale' }] },
      }),
    );
    await addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]);
    // When the equivalence was first argued is provenance, not a write timestamp.
    expect(loadSuppressions(root).get('src/a.ts')?.[0].addedAt).toBe(111);
  });

  it('does not invent a scopeNote key on a result that had none', () => {
    // The note is added ONLY when suppressing everything would otherwise leave
    // a zero-mutant result that reads as "no mutable logic". Spreading it
    // unconditionally puts `scopeNote: undefined` on every result — which
    // `toEqual` cannot see, but which changes the object's shape for anything
    // that inspects its keys.
    const { result } = applySuppressions(makeResult(), verdictOf(['1 A']));
    expect(Object.keys(result)).not.toContain('scopeNote');
  });

  it('applySuppressions with an empty set leaves the result untouched', () => {
    const r = makeResult();

    const { result, suppressedCount } = applySuppressions(r, verdictOf([]));

    expect(suppressedCount).toBe(0);
    expect(result.mutationScore).toBe('60.00%');
    expect(result.vulnerabilities).toHaveLength(3);
  });

  /**
   * Removing keys from a file that has no suppressions at all must be a quiet
   * no-op. Without the Array.isArray guard the filter runs on `undefined` and
   * the returned promise rejects — an unsuppress of an already-clean file
   * would surface as a tool error.
   */
  it('removeSuppressions on a file with no entries resolves without touching the file', async () => {
    await addSuppressions(root, 'src/other.ts', [{ line: 9, mutator: 'Z' }]);
    const file = join(root, '.chaos-mcp', 'suppressions.json');
    const before = readFileSync(file, 'utf8');

    await expect(
      removeSuppressions(root, 'src/absent.ts', [{ line: 1, mutator: 'A' }]),
    ).resolves.not.toThrow();

    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  /**
   * An empty key list short-circuits before the lock, so the file is not even
   * rewritten. Reserialising it would be harmless today but silently rewrites
   * a file the caller asked nothing of.
   */
  it('removeSuppressions with no keys leaves an existing file byte-identical', async () => {
    mkdirSync(join(root, '.chaos-mcp'), { recursive: true });
    const file = join(root, '.chaos-mcp', 'suppressions.json');
    // Deliberately compact: a rewrite would re-indent it.
    const before = JSON.stringify({
      version: 1,
      entries: { 'src/a.ts': [{ line: 1, mutator: 'A' }] },
    });
    writeFileSync(file, before);

    await removeSuppressions(root, 'src/a.ts', []);

    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  // ── addSuppressions Array.isArray guard (L1): a corrupted per-file entry
  //    (non-array) must be treated as empty rather than crashing `.map`. ──
  it('addSuppressions tolerates a corrupted non-array per-file entry', async () => {
    mkdirSync(join(root, '.chaos-mcp'), { recursive: true });
    writeFileSync(
      join(root, '.chaos-mcp', 'suppressions.json'),
      JSON.stringify({ version: 1, entries: { 'src/a.ts': 42 } }),
    );
    await expect(
      addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]),
    ).resolves.not.toThrow();
    // The corrupted value is replaced by a fresh list containing just the new entry.
    expect(storedKeys(root, 'src/a.ts')).toEqual(['1 A']);
  });

  it('all mutants suppressed → 100.00% (no measurable mutants)', () => {
    const r: MutationResult = {
      ...makeResult(),
      totalMutants: 2,
      killed: 0,
      survived: 2,
      vulnerabilities: [
        { line: 1, mutator: 'A', description: 'x' },
        { line: 1, mutator: 'B', description: 'x' },
      ],
    };
    const { result } = applySuppressions(r, verdictOf(['1 A', '1 B']));
    expect(result.totalMutants).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
  });

  // ── WRITE_QUEUE cleanup invariant (live-audit H3 leak): the per-workspace
  //    mutex must drop its map entry once the chained Promise settles.
  //    Before this fix the cleanup compared WRONG identity and the map grew
  //    by one dead Promise per write, so we now also export _writeQueueSize()
  //    to make the invariant testable. ──
  it('WRITE_QUEUE map drops its entry after a completed add', async () => {
    await addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]);
    // Settled → the `tracked.finally(...)` cleanup ran → map empty for this key.
    expect(_writeQueueSize()).toBe(0);
  });

  it('WRITE_QUEUE map drops its entry after a completed remove', async () => {
    await addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]);
    await removeSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]);
    expect(_writeQueueSize()).toBe(0);
  });

  it('WRITE_QUEUE map drops its entry even after a write rejection', async () => {
    // Force the chained fn to throw so we can assert the map is cleaned even
    // on the rejection path (not just the .then success path). Pointing the
    // config path at `root` (a directory) makes the atomic rename target a
    // directory, so writeFile's `renameSync(tmp, dir)` throws EISDIR and the
    // returned promise rejects — exactly the failure path under test.
    await expect(
      addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }], root),
    ).rejects.toThrow();
    expect(_writeQueueSize()).toBe(0);
  });

  it('WRITE_QUEUE remains consistent across many sequential writes', async () => {
    // Hammer the queue with many writes; before the leak fix this loop
    // would have left an entry for every call. After the fix the map is
    // empty at every observation between awaits.
    for (let i = 0; i < 25; i += 1) {
      await addSuppressions(root, 'src/a.ts', [{ line: i, mutator: `M${i}` }]);
      expect(_writeQueueSize()).toBe(0);
    }
  });

  // ── H3 mutex under TRUE concurrency (reviewer follow-up): the previous
  //    coverage only exercised the SEQUENTIAL path through the chain. This
  //    test fires N add/remove calls on the SAME key in a single microtask
  //    drained together, which is the actual scenario the H3 mutex exists
  //    to resolve. The H3 invariants must hold:
  //     1. Every operation sees the previous write committed before it runs
  //        (no read-modify-write overlaps).
  //     2. The map is empty after the final await (no leak even under load).
  //     3. The persisted file matches the EXPECTED MERGED STATE, not just
  //        "the last operation's view" (catches aliasing where the chain
  //        skipped an intermediate write). ──
  it('keys the write queue per workspace AND per config path', async () => {
    // The lock exists to serialise writes to the SAME file. Collapsing the key
    // — an empty template, or `configPath && ''` instead of `?? ''` — makes
    // unrelated workspaces (or two different suppression files in one
    // workspace) queue behind each other, turning independent audits into a
    // single serial chain.
    const other = mkdtempSync(join(tmpdir(), 'sup-other-'));
    try {
      const ops = [
        addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]),
        addSuppressions(other, 'src/a.ts', [{ line: 1, mutator: 'A' }]),
        addSuppressions(root, 'src/a.ts', [{ line: 2, mutator: 'B' }], 'alt1/supp.json'),
        addSuppressions(root, 'src/a.ts', [{ line: 3, mutator: 'C' }], 'alt2/supp.json'),
      ];
      // Four distinct (workspace, configPath) pairs ⇒ four independent chains.
      expect(_writeQueueSize()).toBe(4);
      await Promise.all(ops);
      expect(_writeQueueSize()).toBe(0);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('does not let a finished write evict a newer writer from the queue', async () => {
    // Two writes on the SAME key chain together. When the first settles, the
    // map already holds the second's promise — the identity check is what stops
    // the first's cleanup from deleting it. Without it the second write is
    // unqueued while still in flight, and a third caller would start a parallel
    // chain on the same file: exactly the lost-update race the lock prevents.
    const first = addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]);
    const second = addSuppressions(root, 'src/a.ts', [{ line: 2, mutator: 'B' }]);

    await first;
    expect(_writeQueueSize()).toBe(1);

    await second;
    expect(_writeQueueSize()).toBe(0);
    expect(storedKeys(root, 'src/a.ts').sort()).toEqual(['1 A', '2 B']);
  });

  it('_resetWriteQueue drops in-flight bookkeeping', async () => {
    // The suite's own isolation hook: every test leans on it in beforeEach, so
    // a version that quietly does nothing would let one test's leaked chain
    // serialise the next one's writes.
    const pending = addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]);
    expect(_writeQueueSize()).toBe(1);

    _resetWriteQueue();

    expect(_writeQueueSize()).toBe(0);
    await pending;
  });

  it('returns a real Promise on the empty no-op path', async () => {
    // Both entry points short-circuit an empty list. The signature promises a
    // Promise, and callers `await` it or chain `.catch()` onto it; returning
    // undefined works under `await` by accident but breaks the moment anyone
    // calls a method on the result.
    const added = addSuppressions(root, 'src/a.ts', []);
    const removed = removeSuppressions(root, 'src/a.ts', []);
    expect(added).toBeInstanceOf(Promise);
    expect(removed).toBeInstanceOf(Promise);
    // The add path resolves with its stamped/unstamped tally on every path,
    // including this one — callers may read it without a null check.
    await expect(added).resolves.toEqual({ stamped: 0, unstamped: 0, rejected: [] });
    await expect(removed).resolves.toBeUndefined();
  });

  it('H3 mutex serialises concurrent add/remove on the same key without losing entries', async () => {
    // 6 concurrent ops on `src/a.ts`: 3 adds + 1 partial-remove + 2 more adds.
    // After all settle the file must contain entries 1..6 minus the one the
    // remove dropped — i.e. 1..6 with 3 removed = [1, 2, 4, 5, 6].
    const ops: Promise<unknown>[] = [
      addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]),
      addSuppressions(root, 'src/a.ts', [{ line: 2, mutator: 'B' }]),
      addSuppressions(root, 'src/a.ts', [{ line: 3, mutator: 'C' }]),
      removeSuppressions(root, 'src/a.ts', [{ line: 3, mutator: 'C' }]),
      addSuppressions(root, 'src/a.ts', [{ line: 4, mutator: 'D' }]),
      addSuppressions(root, 'src/a.ts', [{ line: 5, mutator: 'E' }]),
      addSuppressions(root, 'src/a.ts', [{ line: 6, mutator: 'F' }]),
    ];
    await Promise.all(ops);

    // Invariant 1+3: file must contain exactly the merged state of all 7 ops.
    // If the chain skipped a write (H3 breakage), one of these entries would
    // be missing and the assertion would fail.
    expect(storedKeys(root, 'src/a.ts').sort()).toEqual(['1 A', '2 B', '4 D', '5 E', '6 F']);

    // Invariant 2: map is empty after all writes settled (no leak).
    expect(_writeQueueSize()).toBe(0);
  });
});

/**
 * Schema v2: a suppression is identified by `(line, mutator)` PLUS a fingerprint
 * of the source line it was recorded against. Without the fingerprint any edit
 * that shifts a line silently re-points every suppression below it at different
 * code — the failure this whole suite exists to make impossible.
 */
describe('suppression fingerprints (schema v2)', () => {
  const FILE = 'src/calc.ts';
  const SRC = [
    'export function pick(a: number, b: number): number {', // 1
    '  if (a > b) {', //                                       2
    '    return a;', //                                        3
    '  }', //                                                  4
    '  return b;', //                                          5
    '}', //                                                    6
  ];

  beforeEach(() => writeSource(root, FILE, SRC));

  describe('normalization', () => {
    it('is stable against formatting-only churn', () => {
      // Re-indentation and re-wrapped whitespace are not a change in meaning.
      expect(normalizeSourceLine('   if (a > b) {   ')).toBe('if (a > b) {');
      expect(normalizeSourceLine('\tif (a  >   b) {')).toBe('if (a > b) {');
      expect(fingerprintOfLine('  if (a > b) {')).toBe(fingerprintOfLine('if (a  >  b) {'));
    });

    it('does NOT collapse genuinely different code onto one digest', () => {
      // Every token stays in the digest: operators, identifiers, punctuation.
      expect(fingerprintOfLine('if (a > b) {')).not.toBe(fingerprintOfLine('if (a >= b) {'));
      expect(fingerprintOfLine('if (a > b) {')).not.toBe(fingerprintOfLine('if (a > c) {'));
      expect(fingerprintOfLine('return a;')).not.toBe(fingerprintOfLine('return -a;'));
    });

    it('excludes the line number, so a pure line shift is not content drift', () => {
      // The number is the lookup key; the digest is the evidence behind it.
      expect(fingerprintOfLine('  return b;')).toBe(fingerprintOfLine('return b;'));
    });
  });

  describe('write path', () => {
    it('stamps the fingerprint of the targeted source line', async () => {
      const res = await addSuppressions(root, FILE, [
        { line: 2, mutator: 'ConditionalExpression' },
      ]);
      expect(res).toEqual({ stamped: 1, unstamped: 0, rejected: [] });
      const stored = loadSuppressions(root).get(FILE);
      expect(stored?.[0].fingerprint).toBe(fingerprintOfLine(SRC[1]));
    });

    /**
     * A suppression aimed at a line no mutant can occupy.
     *
     * Auditing this server against its own source turned up 40 stored entries in
     * exactly that state. They are worse than useless: stored, they fingerprint
     * the COMMENT, so `verifySuppressions` reports them clean forever and the
     * mismatch never surfaces — while the mutant they were written for goes on
     * counting against the score somewhere else in the file.
     */
    describe('refuses a target no mutant can occupy', () => {
      const COMMENTED = [
        'export function pick(a: number, b: number): number {', // 1
        '  // decide which one wins', //                           2
        '  /* a block comment */', //                              3
        '', //                                                     4
        '  /* opened here', //                                     5
        '   * continued', //                                       6
        '   */', //                                                7
        '  return a > b ? a : b; /* and code after a comment */', // 8
        '}', //                                                    9
      ];

      beforeEach(() => {
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, FILE), COMMENTED.join('\n'));
      });

      it.each([
        ['a line comment', 2],
        ['a whole-line block comment', 3],
        ['a blank line', 4],
        ['a block-comment opener', 5],
        ['a block-comment interior', 6],
        ['a block-comment terminator', 7],
      ])('does not store a suppression aimed at %s', async (_label, line) => {
        const res = await addSuppressions(root, FILE, [
          { line, mutator: 'ConditionalExpression', reason: 'looked equivalent' },
        ]);

        expect(res.rejected).toEqual([
          { line, mutator: 'ConditionalExpression', cause: 'non-mutable' },
        ]);
        expect(res.stamped).toBe(0);
        expect(loadSuppressions(root).get(FILE)).toBeUndefined();
      });

      it('says which entry it refused and why', async () => {
        await addSuppressions(root, FILE, [{ line: 2, mutator: 'ConditionalExpression' }]);

        expect(vi.mocked(warn)).toHaveBeenCalledWith(
          expect.stringContaining('blank or comment-only'),
        );
        expect(vi.mocked(warn)).toHaveBeenCalledWith(expect.stringContaining(`${FILE}:2`));
      });

      it('still accepts code that merely FOLLOWS a comment on the same line', async () => {
        // Conservative on purpose: refusing a real target loses the reason its
        // author wrote, which is worse than storing an inert one.
        const res = await addSuppressions(root, FILE, [
          { line: 8, mutator: 'ConditionalExpression' },
        ]);

        expect(res.rejected).toEqual([]);
        expect(res.stamped).toBe(1);
        expect(loadSuppressions(root).get(FILE)).toHaveLength(1);
      });

      it('accepts a line that OPENS with a comment and then runs code', async () => {
        // The case above starts with code, so it never reaches the block-comment
        // branch at all. This one does: the line begins `/*`, and what decides
        // it is whether anything survives the terminator. Treating every line
        // that starts with a comment as unmutable would refuse a real target.
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(
          join(root, FILE),
          ['export const f = () => {', '  /* fast path */ return a > b;', '};'].join('\n'),
        );

        const res = await addSuppressions(root, FILE, [
          { line: 2, mutator: 'ConditionalExpression' },
        ]);

        expect(res.rejected).toEqual([]);
        expect(res.stamped).toBe(1);
      });

      it('writes the good entries in a batch that also carries a bad one', async () => {
        // A rejected entry must not cost the caller the rest of their batch.
        const res = await addSuppressions(root, FILE, [
          { line: 2, mutator: 'ConditionalExpression' },
          { line: 8, mutator: 'EqualityOperator' },
        ]);

        expect(res.rejected).toEqual([
          { line: 2, mutator: 'ConditionalExpression', cause: 'non-mutable' },
        ]);
        expect(res.stamped).toBe(1);
        expect(loadSuppressions(root).get(FILE)).toHaveLength(1);
      });
    });

    it('bumps the stored schema version to 3', async () => {
      await addSuppressions(root, FILE, [{ line: 2, mutator: 'X' }]);
      const raw = JSON.parse(
        readFileSync(join(root, '.chaos-mcp', 'suppressions.json'), 'utf8'),
      ) as { version: number };
      expect(raw.version).toBe(3);
    });

    it('records NO fingerprint when the source file is missing', async () => {
      const res = await addSuppressions(root, 'src/gone.ts', [{ line: 2, mutator: 'X' }]);
      // Observable at the call site, and stored honestly rather than invented.
      expect(res).toEqual({ stamped: 0, unstamped: 1, rejected: [] });
      expect(loadSuppressions(root).get('src/gone.ts')?.[0].fingerprint).toBeUndefined();
    });

    it('records NO fingerprint when the line is past the end of the file', async () => {
      const res = await addSuppressions(root, FILE, [{ line: 9999, mutator: 'X' }]);
      expect(res).toEqual({ stamped: 0, unstamped: 1, rejected: [] });
      expect(loadSuppressions(root).get(FILE)?.[0].fingerprint).toBeUndefined();
    });
  });

  describe('apply path (three-way)', () => {
    it('APPLIES an entry whose fingerprint matches the current line', async () => {
      await addSuppressions(root, FILE, [{ line: 2, mutator: 'ConditionalExpression' }]);
      const verdict = verifySuppressions(root, FILE, loadSuppressions(root).get(FILE));
      expect(appliedKeys(verdict)).toEqual(['2 ConditionalExpression']);
      expect(verdict.drifted).toBe(0);
      expect(verdict.unverified).toBe(0);
    });

    it('survives a whitespace-only reformat of the targeted line', async () => {
      await addSuppressions(root, FILE, [{ line: 2, mutator: 'ConditionalExpression' }]);
      const reformatted = [...SRC];
      reformatted[1] = '\t if   (a > b)   {';
      writeSource(root, FILE, reformatted);
      const verdict = verifySuppressions(root, FILE, loadSuppressions(root).get(FILE));
      expect(appliedKeys(verdict)).toEqual(['2 ConditionalExpression']);
      expect(verdict.drifted).toBe(0);
    });

    it('does NOT apply — and counts as drifted — when the line becomes different code', async () => {
      await addSuppressions(root, FILE, [{ line: 2, mutator: 'ConditionalExpression' }]);
      const edited = [...SRC];
      edited[1] = '  if (a >= b) {';
      writeSource(root, FILE, edited);
      const verdict = verifySuppressions(root, FILE, loadSuppressions(root).get(FILE));
      expect(appliedKeys(verdict).length).toBe(0);
      expect(verdict.drifted).toBe(1);
      expect(verdict.unverified).toBe(0);
    });

    it('RELOCATES when an inserted line shifts the target down (tier 2)', async () => {
      // Through v2 this was drift: line 2 now held different code, so the entry
      // stopped matching and a human had to re-point it by hand. Hand
      // re-pointing is what corrupted this repository's corpus, and the
      // suppressions on `core/format.ts` needed it three separate times.
      //
      // The line's CONTENT did not change — it only moved — so the fingerprint
      // still identifies it uniquely and the entry follows it. Nothing is
      // guessed: a fingerprint found twice would be refused as ambiguous.
      await addSuppressions(root, FILE, [{ line: 2, mutator: 'ConditionalExpression' }]);
      writeSource(root, FILE, ['// a new banner comment', ...SRC]);
      const verdict = verifySuppressions(root, FILE, loadSuppressions(root).get(FILE));
      expect(appliedKeys(verdict)).toEqual(['3 ConditionalExpression']);
      expect(verdict.drifted).toBe(0);
      expect(verdict.resolved[0]).toMatchObject({ line: 3, storedLine: 2, tier: 2 });
    });

    it('refuses to relocate when the fingerprint occurs twice', async () => {
      // Ambiguity is refusal. Two candidate lines carry the same content, so
      // nothing distinguishes them and picking one would be a guess.
      await addSuppressions(root, FILE, [{ line: 2, mutator: 'ConditionalExpression' }]);
      writeSource(root, FILE, ['// banner', ...SRC, SRC[1]]);
      const verdict = verifySuppressions(root, FILE, loadSuppressions(root).get(FILE));
      expect(appliedKeys(verdict).length).toBe(0);
      expect(verdict.drifted).toBe(1);
    });

    it('does NOT apply when the file can no longer be read', async () => {
      await addSuppressions(root, FILE, [{ line: 2, mutator: 'ConditionalExpression' }]);
      rmSync(join(root, FILE));
      const verdict = verifySuppressions(root, FILE, loadSuppressions(root).get(FILE));
      // Cannot be shown to still match ⇒ not applied. Fail toward the VISIBLE
      // failure (a lower score) over the invisible one (a hidden coverage gap).
      expect(appliedKeys(verdict).length).toBe(0);
      expect(verdict.drifted).toBe(1);
    });

    it('verifies each entry independently within one file', async () => {
      await addSuppressions(root, FILE, [
        { line: 2, mutator: 'ConditionalExpression' },
        { line: 5, mutator: 'ArithmeticOperator' },
      ]);
      const edited = [...SRC];
      edited[4] = '  return a;';
      writeSource(root, FILE, edited);
      const verdict = verifySuppressions(root, FILE, loadSuppressions(root).get(FILE));
      expect(appliedKeys(verdict)).toEqual(['2 ConditionalExpression']);
      expect(verdict.drifted).toBe(1);
    });

    it('treats no stored entries as an empty verdict', () => {
      const verdict = verifySuppressions(root, FILE, undefined);
      expect(appliedKeys(verdict).length).toBe(0);
      expect(verdict.drifted).toBe(0);
      expect(verdict.unverified).toBe(0);
    });
  });

  describe('v1 migration', () => {
    /** The exact v1 shape: no `version: 2`, no fingerprint on any entry. */
    function writeV1(): void {
      mkdirSync(join(root, '.chaos-mcp'), { recursive: true });
      writeFileSync(
        join(root, '.chaos-mcp', 'suppressions.json'),
        JSON.stringify({
          version: 1,
          entries: {
            [FILE]: [
              {
                line: 2,
                mutator: 'ConditionalExpression',
                reason: 'a > b is dominated by the caller guard',
                addedAt: 1700000000000,
              },
            ],
          },
        }),
      );
    }

    it('loads without error and keeps every v1 field verbatim', () => {
      writeV1();
      const stored = loadSuppressions(root).get(FILE);
      expect(stored).toHaveLength(1);
      expect(stored?.[0]).toEqual({
        line: 2,
        mutator: 'ConditionalExpression',
        reason: 'a > b is dominated by the caller guard',
        addedAt: 1700000000000,
      });
    });

    it('counts a v1 entry as unverified and does NOT apply it', () => {
      writeV1();
      const verdict = verifySuppressions(root, FILE, loadSuppressions(root).get(FILE));
      expect(appliedKeys(verdict).length).toBe(0);
      expect(verdict.unverified).toBe(1);
      // Not "drifted": nothing was ever recorded to compare against. The two
      // counts prescribe the same action but describe different histories.
      expect(verdict.drifted).toBe(0);
    });

    it('is NOT back-filled from current source just because the line still parses', () => {
      writeV1();
      // Reading is not blessing: the entry stays fingerprint-less on disk until
      // a human re-confirms it. Back-filling here would bless a suppression that
      // may now sit on entirely unrelated code.
      const verdict = verifySuppressions(root, FILE, loadSuppressions(root).get(FILE));
      expect(verdict.unverified).toBe(1);
      expect(loadSuppressions(root).get(FILE)?.[0].fingerprint).toBeUndefined();
    });

    it('re-adding promotes a v1 entry to applied, keeping its reason', async () => {
      writeV1();
      const res = await addSuppressions(root, FILE, [
        { line: 2, mutator: 'ConditionalExpression' },
      ]);
      expect(res).toEqual({ stamped: 1, unstamped: 0, rejected: [] });
      const stored = loadSuppressions(root).get(FILE);
      expect(stored).toHaveLength(1);
      expect(stored?.[0].reason).toBe('a > b is dominated by the caller guard');
      expect(stored?.[0].fingerprint).toBe(fingerprintSourceLine(root, FILE, 2));
      const verdict = verifySuppressions(root, FILE, stored);
      expect(appliedKeys(verdict)).toEqual(['2 ConditionalExpression']);
      expect(verdict.unverified).toBe(0);
    });

    it('drops a stale fingerprint rather than keeping it when the line cannot be re-read', async () => {
      await addSuppressions(root, FILE, [{ line: 2, mutator: 'ConditionalExpression' }]);
      rmSync(join(root, FILE));
      const res = await addSuppressions(root, FILE, [
        { line: 2, mutator: 'ConditionalExpression' },
      ]);
      expect(res).toEqual({ stamped: 0, unstamped: 1, rejected: [] });
      // An entry we could not re-verify must not keep applying on an older check.
      expect(loadSuppressions(root).get(FILE)?.[0].fingerprint).toBeUndefined();
    });

    it('ignores a non-string fingerprint instead of comparing against it', () => {
      mkdirSync(join(root, '.chaos-mcp'), { recursive: true });
      writeFileSync(
        join(root, '.chaos-mcp', 'suppressions.json'),
        JSON.stringify({
          version: 2,
          entries: { [FILE]: [{ line: 2, mutator: 'X', addedAt: 1, fingerprint: 42 }] },
        }),
      );
      const verdict = verifySuppressions(root, FILE, loadSuppressions(root).get(FILE));
      expect(verdict.unverified).toBe(1);
      expect(appliedKeys(verdict).length).toBe(0);
    });
  });
});

/**
 * An unreadable suppressions file must never be laundered into an empty one.
 *
 * `addSuppressions` / `removeSuppressions` are read-modify-WRITE cycles and
 * `writeFile` renames over the original with no backup, so treating a
 * SyntaxError/EACCES read as `{ entries: {} }` turns the very next write into a
 * silent deletion of every other file's suppressions and every hand-written
 * `reason` on them. The write paths therefore THROW; only the read path used
 * for filtering degrades, and it warns when it does.
 */
describe('suppression file read failures (fail-safe)', () => {
  it('a missing file is NOT an error on the write path — it is just an empty start', async () => {
    expect(existsSync(supFile(root))).toBe(false);
    await expect(
      addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]),
    ).resolves.toBeDefined();
    expect(storedKeys(root, 'src/a.ts')).toEqual(['1 A']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('malformed JSON makes addSuppressions THROW instead of rewriting the file', async () => {
    const file = writeRawSuppressions(root, '{"version": 2, "entries": {"src/a.ts": [');
    const before = readFileSync(file, 'utf8');
    await expect(addSuppressions(root, 'src/b.ts', [{ line: 1, mutator: 'A' }])).rejects.toThrow(
      SuppressionFileError,
    );
    // The whole point: the user's data is still on disk, untouched, under its
    // own name — recoverable by hand rather than replaced by a one-entry file.
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('malformed JSON makes removeSuppressions THROW instead of rewriting the file', async () => {
    const file = writeRawSuppressions(root, 'not json at all');
    const before = readFileSync(file, 'utf8');
    await expect(removeSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }])).rejects.toThrow(
      SuppressionFileError,
    );
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('the thrown error names the file and carries the underlying cause message', async () => {
    const file = writeRawSuppressions(root, '{bad');
    const error = await addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SuppressionFileError);
    const err = error as SuppressionFileError;
    expect(err.name).toBe('SuppressionFileError');
    expect(err.path).toBe(file);
    // handler.ts renders this verbatim as "Failed to update suppression list: …",
    // so it has to be actionable on its own.
    expect(err.message).toContain(file);
    expect(err.message).toMatch(/JSON|Unexpected|token/i);
    expect(err.cause).toBeInstanceOf(Error);
  });

  it('a non-ENOENT fs error (EISDIR) throws too, not just a parse failure', async () => {
    // The suppressions "file" is a directory: readFileSync fails with EISDIR
    // (EPERM on some platforms) — the user has no readable data, so the write
    // must abort exactly as it does for a syntax error.
    mkdirSync(supFile(root), { recursive: true });
    await expect(addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }])).rejects.toThrow(
      SuppressionFileError,
    );
    expect(() => loadSuppressions(root)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a well-formed document of the WRONG SHAPE is empty, not unreadable', async () => {
    // It parsed, so there is no entry to lose and nothing to salvage: this is
    // the one case that stays a silent empty default and is repaired by the
    // next write. Pinned separately so the ENOENT/parse split cannot regress
    // into swallowing this too — or into throwing on it.
    writeRawSuppressions(root, JSON.stringify({ version: 2, entries: 42 }));
    expect(loadSuppressions(root).size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    await expect(
      addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]),
    ).resolves.toBeDefined();
    expect(storedKeys(root, 'src/a.ts')).toEqual(['1 A']);
  });

  it('a valid file still round-trips untouched through a read-modify-write', async () => {
    await addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A', reason: 'argued' }]);
    await addSuppressions(root, 'src/b.ts', [{ line: 9, mutator: 'B', reason: 'also argued' }]);
    // The regression this whole fix exists to prevent: writing to ONE file must
    // leave every OTHER file's entries — and their reasons — intact.
    await addSuppressions(root, 'src/c.ts', [{ line: 3, mutator: 'C' }]);
    const map = loadSuppressions(root);
    expect([...map.keys()].sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(map.get('src/a.ts')?.[0].reason).toBe('argued');
    expect(map.get('src/b.ts')?.[0].reason).toBe('also argued');
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * `readFile` validates only that `entries` is an object — per-entry shape is
   * never checked on the write path. `addSuppressions` guards each element
   * before dereferencing it; `removeSuppressions` did not, so a hand-edited or
   * truncated file turned an `unsuppress` into a TypeError reported as the
   * unhelpful "Failed to update suppression list: Cannot read properties of
   * null". Unsuppressing is the repair action — it must not be the one call
   * that a corrupt file can block.
   */
  it('removeSuppressions survives a junk entry instead of dereferencing it', async () => {
    writeRawSuppressions(
      root,
      JSON.stringify({
        version: 2,
        entries: { 'src/a.ts': [null, { line: 1, mutator: 'A', addedAt: 1 }, 'nonsense'] },
      }),
    );

    await expect(
      removeSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]),
    ).resolves.toBeUndefined();

    // The requested key is gone, and the unusable entries went with it rather
    // than being rewritten as `null` for the next reader to trip over.
    expect(storedKeys(root, 'src/a.ts')).toEqual([]);
  });

  it('removeSuppressions keeps the valid entries alongside a junk one', async () => {
    writeRawSuppressions(
      root,
      JSON.stringify({
        version: 2,
        entries: {
          'src/a.ts': [
            null,
            { line: 1, mutator: 'A', addedAt: 1 },
            { line: 2, mutator: 'B', addedAt: 1 },
          ],
        },
      }),
    );

    await removeSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }]);

    // Only the key that was asked for is dropped; the other survives untouched.
    expect(storedKeys(root, 'src/a.ts')).toEqual(['2 B']);
  });

  it('the write queue does not leak an entry when the read throws', async () => {
    writeRawSuppressions(root, '{bad');
    await expect(addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A' }])).rejects.toThrow();
    expect(_writeQueueSize()).toBe(0);
  });
});

/**
 * Portable keys (Med finding: OS-native separators in a committable file).
 *
 * `relative()` yields `src\utils\a.ts` on Windows and `src/utils/a.ts` on Linux.
 * The suppressions file is documented as portable/committable, so a key written
 * by one machine has to resolve on the other — and the failure when it does not
 * is SILENT: a missing map key produces an empty verdict, so `drifted` and
 * `unverified` both stay 0 and nothing reports that anything was skipped.
 */
describe('suppression key separators', () => {
  const SRC = 'src/utils/a.ts';
  const WIN = 'src\\utils\\a.ts';

  /** A suppressions file whose keys use Windows separators, as committed by a Windows client. */
  function writeWindowsKeyedFile(fingerprint: string): void {
    writeRawSuppressions(
      root,
      JSON.stringify({
        version: 2,
        entries: {
          [WIN]: [
            { line: 2, mutator: 'ConditionalExpression', addedAt: 1, reason: 'why', fingerprint },
          ],
        },
      }),
    );
  }

  it('toPortableKey rewrites backslashes on EVERY platform, not only on Windows', () => {
    // Unconditional by design: the key being repaired was written by the OTHER
    // machine's `sep`, so gating on the local `sep` would make this a no-op on
    // exactly the Linux CI that has to read it.
    expect(toPortableKey(WIN)).toBe(SRC);
    expect(toPortableKey(SRC)).toBe(SRC);
  });

  it('a backslash-keyed entry resolves under a POSIX lookup', () => {
    writeWindowsKeyedFile('deadbeefcafe');
    const map = loadSuppressions(root);
    expect([...map.keys()]).toEqual([SRC]);
    expect(map.get(SRC)).toHaveLength(1);
    expect(map.get(SRC)?.[0].reason).toBe('why');
  });

  it('a backslash-keyed entry is APPLIED end-to-end via loadVerifiedSuppressions', () => {
    writeSource(root, SRC, ['const a = 1;', 'if (a > 0) return a;', 'return 0;']);
    writeWindowsKeyedFile(fingerprintSourceLine(root, SRC, 2) as string);
    // Before the fix this returned an all-zero verdict: `.get('src/utils/a.ts')`
    // missed the `src\utils\a.ts` key and the suppression vanished silently.
    const verdict = loadVerifiedSuppressions(root, SRC, undefined);
    expect(appliedKeys(verdict)).toEqual(['2 ConditionalExpression']);
    expect(verdict.drifted).toBe(0);
    expect(verdict.unverified).toBe(0);
  });

  it('adding to a legacy backslash key MIGRATES it rather than duplicating it', async () => {
    writeSource(root, SRC, ['const a = 1;', 'if (a > 0) return a;', 'return 0;']);
    writeWindowsKeyedFile('stale00000000');
    await addSuppressions(root, SRC, [{ line: 3, mutator: 'BlockStatement' }]);
    const raw = JSON.parse(readFileSync(supFile(root), 'utf8')) as {
      entries: Record<string, unknown[]>;
    };
    expect(Object.keys(raw.entries)).toEqual([SRC]);
    // The pre-existing entry survives the migration — including its reason.
    expect(storedKeys(root, SRC)).toEqual(['2 ConditionalExpression', '3 BlockStatement']);
    expect(loadSuppressions(root).get(SRC)?.[0].reason).toBe('why');
  });

  it('removing from a legacy backslash key finds and drops the entry', async () => {
    writeWindowsKeyedFile('deadbeefcafe');
    await removeSuppressions(root, SRC, [{ line: 2, mutator: 'ConditionalExpression' }]);
    const raw = JSON.parse(readFileSync(supFile(root), 'utf8')) as {
      entries: Record<string, unknown[]>;
    };
    // Last entry gone → the file key goes with it, under EITHER spelling.
    expect(Object.keys(raw.entries)).toEqual([]);
  });

  it('merges two spellings of the same file instead of letting one shadow the other', () => {
    writeRawSuppressions(
      root,
      JSON.stringify({
        version: 2,
        entries: {
          [WIN]: [{ line: 2, mutator: 'A', addedAt: 1 }],
          [SRC]: [{ line: 7, mutator: 'B', addedAt: 1 }],
        },
      }),
    );
    const entries = loadSuppressions(root).get(SRC);
    expect(entries?.map((e) => `${e.line} ${e.mutator}`)).toEqual(['2 A', '7 B']);
  });
});

describe("the repository's own suppressions file", () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

  // The file declared "version": 2 while all but two of its entries were
  // v1-shaped, so every one of them was counted `unverified` and NONE was ever
  // applied — 125 hand-written equivalence arguments sat dormant and nothing in
  // the tool's output said so. `scripts/restamp-suppressions.mjs` re-pointed and
  // stamped what git could prove; this keeps the corpus from silently going
  // inert again.
  //
  // Deliberately NOT asserted here: `drifted`. An entry drifts the moment
  // someone edits the line it guards, which is ordinary work — that state is
  // reported by the audit itself and re-confirmed through the normal
  // suppression flow, and failing an unrelated PR's suite over it would only
  // teach people to delete the guard.
  /**
   * Skipped under a mutation run.
   *
   * `repoRoot` is derived from this file's own location, so under StrykerJS it
   * resolves to Stryker's sandbox — where the file being audited has been
   * INSTRUMENTED. Its source lines are no longer the ones the corpus recorded
   * (line 284 of a mutated `suppression.ts` reads `})());`), so this check
   * measures Stryker's rewrite rather than the repository, and the audit dies in
   * its dry run with "There were failed tests in the initial test run" — which
   * reads like a broken suite rather than a check that cannot apply here.
   *
   * That made `src/utils/suppression.ts` unauditable: every attempt to measure
   * the file failed before generating a single mutant.
   *
   * This is a corpus-hygiene guard for ordinary runs, not a behavioural test, so
   * skipping it under Stryker costs no coverage of the code under test.
   */
  // Detected by PATH, not by env: Stryker sets no `STRYKER*` variable during the
  // dry run (which is also why `tests/global-setup.ts` still rebuilds there), so
  // an env probe misses exactly the run that breaks this check. Every Stryker
  // sandbox lives under `.stryker-tmp/sandbox-*`, and `repoRoot` is derived from
  // this file's own location — so the marker is in the path whenever the corpus
  // being read is a sandbox copy rather than the repository.
  const inStrykerSandbox = repoRoot.includes('.stryker-tmp');

  it.skipIf(inStrykerSandbox)('carries no unverified entries', () => {
    let applied = 0;
    let unverified = 0;
    for (const [relFile, entries] of loadSuppressions(repoRoot)) {
      const verdict = verifySuppressions(repoRoot, relFile, entries);
      applied += appliedKeys(verdict).length;
      unverified += verdict.unverified;
    }
    // A root that resolved wrong loads NOTHING, and "no entries" would satisfy
    // the unverified assertion below vacuously — the same silence this guard
    // exists to break. Prove the corpus was actually read first.
    expect(applied).toBeGreaterThan(0);
    expect(unverified).toBe(0);
  });
});

/**
 * Guards on the read and merge paths that nothing was exercising.
 *
 * These all decide what a STORED entry becomes when it is read back or
 * re-confirmed. A wrong answer here is invisible at the call site: the entry
 * still loads, it just carries a field it should not, or loses one it should
 * have kept.
 */
describe('suppression storage — entry hygiene', () => {
  const FILE = 'src/calc.ts';
  const SRC = ['export const a = 1;', 'if (a > 0) doThing();', 'export const b = 2;'];

  const writeSource = () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, FILE), SRC.join('\n'));
  };

  const rawEntries = (): Record<string, { line: number; mutator: string; reason?: string }[]> =>
    (
      JSON.parse(readFileSync(supFile(root), 'utf8')) as {
        entries: Record<string, { line: number; mutator: string; reason?: string }[]>;
      }
    ).entries;

  beforeEach(writeSource);

  it('prefers the portable key when a legacy-spelled one also exists', () => {
    // A file committed from Windows can leave `src\calc.ts` behind while the
    // POSIX key is also present. The fast path must win: without it the loop
    // finds the BACKSLASH key first and migrates that list onto the portable
    // key, silently discarding whatever the portable key already held.
    writeRawSuppressions(
      root,
      JSON.stringify({
        version: 2,
        entries: {
          'src/calc.ts': [{ line: 2, mutator: 'Portable', addedAt: 1 }],
          'src\\calc.ts': [{ line: 2, mutator: 'Legacy', addedAt: 1 }],
        },
      }),
    );

    return addSuppressions(root, FILE, [{ line: 2, mutator: 'Added' }]).then(() => {
      const entries = rawEntries();
      expect(entries['src/calc.ts'].map((e) => e.mutator).sort()).toEqual(['Added', 'Portable']);
      // The legacy key is left exactly as it was — it was never this call's list.
      expect(entries['src\\calc.ts']).toHaveLength(1);
    });
  });

  it.each([
    ['a line below the first', 0],
    ['a fractional line', 1.5],
  ])('stores %s without a fingerprint rather than stamping the wrong text', async (_l, line) => {
    // `fingerprintAt` rejects a non-integer and anything below 1 before
    // indexing. Dropping either guard indexes `lines[-1]` or `lines[0.5]`,
    // which is undefined — and hashing that would stamp every such entry with
    // one identical digest that matches no source line anywhere.
    const res = await addSuppressions(root, FILE, [{ line, mutator: 'Cond' }]);

    expect(res.unstamped).toBe(1);
    expect(res.stamped).toBe(0);
    expect(loadSuppressions(root).get(FILE)?.[0].fingerprint).toBeUndefined();
  });

  it('drops a non-string reason instead of loading it', async () => {
    writeRawSuppressions(
      root,
      JSON.stringify({
        version: 2,
        entries: { [FILE]: [{ line: 2, mutator: 'Cond', addedAt: 1, reason: 7 }] },
      }),
    );

    const entry = loadSuppressions(root).get(FILE)?.[0];

    expect(entry).toBeDefined();
    expect(Object.keys(entry as object)).not.toContain('reason');
  });

  it('keeps the previous reason when a re-confirmation supplies an empty one', async () => {
    // `mergeReason` treats '' as "no new argument". A hand-written equivalence
    // argument is real human work; an empty string must not erase it.
    await addSuppressions(root, FILE, [{ line: 2, mutator: 'Cond', reason: 'unreachable guard' }]);
    await addSuppressions(root, FILE, [{ line: 2, mutator: 'Cond', reason: '' }]);

    expect(loadSuppressions(root).get(FILE)?.[0].reason).toBe('unreachable guard');
  });

  it('omits reason and fingerprint entirely when it has neither', async () => {
    // Both are optional keys. Assigning them unconditionally writes
    // `reason: undefined` into the JSON document, where it serialises away —
    // but the in-memory entry a caller reads back would carry the key.
    await addSuppressions(root, 'src/missing.ts', [{ line: 2, mutator: 'Cond' }]);

    const entry = loadSuppressions(root).get('src/missing.ts')?.[0];

    expect(Object.keys(entry as object).sort()).toEqual(['addedAt', 'line', 'mutator']);
  });

  it('survives a junk element in a stored list on both write paths', async () => {
    // A truncated or hand-edited document can hold `[null]`. Indexing it must
    // skip the junk rather than dereference it — the failure mode was an
    // opaque "Failed to update suppression list".
    writeRawSuppressions(
      root,
      JSON.stringify({
        version: 2,
        entries: { [FILE]: [null, { line: 2, mutator: 'Keep', addedAt: 1 }] },
      }),
    );

    // The add path only has to SKIP the junk while indexing; it does not
    // rewrite the list, so the null is still there afterwards. What matters is
    // that it neither threw nor lost the real entry.
    await addSuppressions(root, FILE, [{ line: 2, mutator: 'Added' }]);
    expect(
      rawEntries()
        [FILE].filter(Boolean)
        .map((e) => e.mutator)
        .sort(),
    ).toEqual(['Added', 'Keep']);

    // The remove path rebuilds the list through a filter, which is where the
    // junk is actually repaired away.
    await removeSuppressions(root, FILE, [{ line: 2, mutator: 'Added' }]);
    expect(rawEntries()[FILE]).toEqual([expect.objectContaining({ line: 2, mutator: 'Keep' })]);
  });
});

describe('suppression storage — boundaries and schema', () => {
  const FILE = 'src/edge.ts';
  const SRC = ['export const a = 1;', 'if (a > 0) doThing();', 'export const last = 2;'];

  beforeEach(() => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, FILE), SRC.join('\n'));
  });

  it('stamps a suppression on the LAST line of the file', async () => {
    // `line > lines.length` is the range check. At `>=` the final line of every
    // file becomes unstampable — and an unstamped entry is never applied, so
    // the guard on the last line of a file would silently stop working.
    const res = await addSuppressions(root, FILE, [{ line: SRC.length, mutator: 'Cond' }]);

    expect(res.stamped).toBe(1);
    expect(res.unstamped).toBe(0);
    expect(loadSuppressions(root).get(FILE)?.[0].fingerprint).toBe(
      fingerprintOfLine(SRC[SRC.length - 1]),
    );
  });

  it('rejects a line one past the end', async () => {
    const res = await addSuppressions(root, FILE, [{ line: SRC.length + 1, mutator: 'Cond' }]);

    expect(res.stamped).toBe(0);
    expect(res.unstamped).toBe(1);
  });

  it('repairs a truthy non-object element on the remove path', async () => {
    // The filter is `e && typeof e === 'object'`. A null is caught by the first
    // half; a STRING is truthy and only the typeof half rejects it — without
    // which `keyOf(e.line, e.mutator)` keys it as "undefined undefined", never
    // matches the drop set, and the junk is written back forever.
    writeRawSuppressions(
      root,
      JSON.stringify({
        version: 2,
        entries: {
          [FILE]: [
            'junk',
            { line: 2, mutator: 'Drop', addedAt: 1 },
            { line: 3, mutator: 'Keep', addedAt: 1 },
          ],
        },
      }),
    );

    await removeSuppressions(root, FILE, [{ line: 2, mutator: 'Drop' }]);

    const raw = JSON.parse(readFileSync(supFile(root), 'utf8')) as {
      entries: Record<string, { mutator: string }[]>;
    };
    expect(raw.entries[FILE]).toEqual([expect.objectContaining({ mutator: 'Keep' })]);
  });

  it('promotes a document that carries no version at all to v3', async () => {
    // `raw.version ?? 1` supplies the floor that `Math.max(version, 3)` needs.
    // Without it the version is undefined, `Math.max(undefined, 3)` is NaN, and
    // the document is written with `"version": null` — a file no reader can
    // grade, produced by an ordinary write.
    writeRawSuppressions(root, JSON.stringify({ entries: {} }));

    await addSuppressions(root, FILE, [{ line: 2, mutator: 'Cond' }]);

    const raw = JSON.parse(readFileSync(supFile(root), 'utf8')) as { version: unknown };
    expect(raw.version).toBe(3);
  });
});

describe('schema v3: identity is the mutator plus the change', () => {
  const FILE = 'src/pick.ts';
  const SRC = [
    'export function pick(a: number, b: number): number {', // 1
    '  if (isNum(a) && a > b) {', //                           2
    '    return a;', //                                        3
    '  }', //                                                  4
    '  return b;', //                                          5
    '}', //                                                    6
  ];
  const COND = 'ConditionalExpression';
  const LEFT = 'isNum(a) → true';
  const RIGHT = 'a > b → true';

  beforeEach(() => writeSource(root, FILE, SRC));

  it('persists the change and stamps version 3', async () => {
    await addSuppressions(root, FILE, [
      { line: 2, mutator: COND, change: RIGHT, reason: 'b is always the floor' },
    ]);
    const doc = JSON.parse(readFileSync(join(root, '.chaos-mcp', 'suppressions.json'), 'utf8')) as {
      version: number;
      entries: Record<string, { change?: string }[]>;
    };
    expect(doc.version).toBe(3);
    expect(doc.entries[FILE][0].change).toBe(RIGHT);
  });

  it('keeps two same-line same-mutator entries apart', async () => {
    // Through v2 both collapsed onto the key "2 ConditionalExpression", so
    // suppressing the equivalent one deleted the killed sibling's coverage
    // signal too. Three survivors in this repository were left unsuppressed for
    // months rather than accept that trade.
    await addSuppressions(root, FILE, [
      { line: 2, mutator: COND, change: LEFT, reason: 'left' },
      { line: 2, mutator: COND, change: RIGHT, reason: 'right' },
    ]);
    const stored = loadSuppressions(root).get(FILE);
    expect(stored).toHaveLength(2);
    expect(stored?.map((e) => e.reason).sort()).toEqual(['left', 'right']);
  });

  it('re-confirms by change, preserving addedAt and the recorded reason', async () => {
    await addSuppressions(root, FILE, [{ line: 2, mutator: COND, change: RIGHT, reason: 'first' }]);
    const before = loadSuppressions(root).get(FILE)?.[0].addedAt;
    await addSuppressions(root, FILE, [{ line: 2, mutator: COND, change: RIGHT }]);
    const stored = loadSuppressions(root).get(FILE);
    expect(stored).toHaveLength(1);
    expect(stored?.[0].addedAt).toBe(before);
    expect(stored?.[0].reason).toBe('first');
  });

  it('drops a non-string change rather than storing one nothing can match', () => {
    mkdirSync(join(root, '.chaos-mcp'), { recursive: true });
    writeFileSync(
      join(root, '.chaos-mcp', 'suppressions.json'),
      JSON.stringify({
        version: 3,
        entries: { [FILE]: [{ line: 2, mutator: COND, change: 7, addedAt: 1 }] },
      }),
      'utf8',
    );
    expect(loadSuppressions(root).get(FILE)?.[0].change).toBeUndefined();
  });

  describe('removal', () => {
    beforeEach(async () => {
      await addSuppressions(root, FILE, [
        { line: 2, mutator: COND, change: LEFT, reason: 'left' },
        { line: 2, mutator: COND, change: RIGHT, reason: 'right' },
      ]);
    });

    it('removes only the entry whose change matches', async () => {
      await removeSuppressions(root, FILE, [{ line: 2, mutator: COND, change: LEFT }]);
      const stored = loadSuppressions(root).get(FILE);
      expect(stored).toHaveLength(1);
      expect(stored?.[0].reason).toBe('right');
    });

    it('removes every entry for the mutator when no change is named', async () => {
      // The pre-v3 behaviour, kept so a caller who cannot name the change can
      // still clear a line.
      await removeSuppressions(root, FILE, [{ line: 2, mutator: COND }]);
      expect(loadSuppressions(root).get(FILE)).toBeUndefined();
    });

    it('ignores the line on the key, so a relocated entry stays removable', async () => {
      await removeSuppressions(root, FILE, [{ line: 999, mutator: COND, change: LEFT }]);
      expect(loadSuppressions(root).get(FILE)).toHaveLength(1);
    });
  });

  describe('tier 3 candidates', () => {
    it('goes pending when the stored line is rewritten', async () => {
      await addSuppressions(root, FILE, [{ line: 2, mutator: COND, change: RIGHT }]);
      const edited = [...SRC];
      edited[1] = '  if (isNum(a) && a > b) { // widened guard';
      writeSource(root, FILE, edited);
      const verdict = verifySuppressions(root, FILE, loadSuppressions(root).get(FILE));
      expect(verdict.resolved).toHaveLength(0);
      expect(verdict.pending).toHaveLength(1);
      expect(verdict.pending[0].change).toBe(RIGHT);
      // Not drift YET — only `applySuppressions` can say, and it needs the
      // survivor list this module must never see.
      expect(verdict.drifted).toBe(0);
    });

    it('drifts instead when the entry carries no change to match on', async () => {
      await addSuppressions(root, FILE, [{ line: 2, mutator: COND }]);
      const edited = [...SRC];
      edited[1] = '  if (isNum(a) && a > b) { // widened guard';
      writeSource(root, FILE, edited);
      const verdict = verifySuppressions(root, FILE, loadSuppressions(root).get(FILE));
      expect(verdict.pending).toHaveLength(0);
      expect(verdict.drifted).toBe(1);
    });
  });

  describe('restampSuppressions', () => {
    it('rewrites the line and re-derives the fingerprint', async () => {
      await addSuppressions(root, FILE, [{ line: 2, mutator: COND, change: RIGHT }]);
      const before = loadSuppressions(root).get(FILE)?.[0].fingerprint;
      writeSource(root, FILE, ['// banner', ...SRC]);
      await restampSuppressions(root, FILE, [{ mutator: COND, change: RIGHT, line: 3 }]);
      const after = loadSuppressions(root).get(FILE)?.[0];
      expect(after?.line).toBe(3);
      expect(after?.fingerprint).toBe(before); // same CONTENT, so same digest
      // And the next verification is tier 1 — no searching at all.
      const verdict = verifySuppressions(root, FILE, loadSuppressions(root).get(FILE));
      expect(verdict.resolved[0]).toMatchObject({ line: 3, tier: 1 });
    });

    it('re-derives a DIFFERENT fingerprint when the new line differs', async () => {
      await addSuppressions(root, FILE, [{ line: 2, mutator: COND, change: RIGHT }]);
      const before = loadSuppressions(root).get(FILE)?.[0].fingerprint;
      await restampSuppressions(root, FILE, [{ mutator: COND, change: RIGHT, line: 5 }]);
      expect(loadSuppressions(root).get(FILE)?.[0].fingerprint).not.toBe(before);
    });

    it('drops the fingerprint when the new line cannot be read', async () => {
      // Keeping the old one would credit the entry at tier 1 on the strength of
      // a check against different code. Dropping it demotes the entry to
      // `unverified`, which is visible.
      await addSuppressions(root, FILE, [{ line: 2, mutator: COND, change: RIGHT }]);
      await restampSuppressions(root, FILE, [{ mutator: COND, change: RIGHT, line: 9999 }]);
      const after = loadSuppressions(root).get(FILE)?.[0];
      expect(after?.fingerprint).toBeUndefined();
      expect(verifySuppressions(root, FILE, loadSuppressions(root).get(FILE)).unverified).toBe(1);
    });

    it('leaves an entry no update names untouched', async () => {
      await addSuppressions(root, FILE, [
        { line: 2, mutator: COND, change: RIGHT, reason: 'keep' },
      ]);
      await restampSuppressions(root, FILE, [{ mutator: 'Other', change: 'x → y', line: 9 }]);
      const after = loadSuppressions(root).get(FILE)?.[0];
      expect(after?.line).toBe(2);
      expect(after?.reason).toBe('keep');
    });

    it('is a no-op for an unknown file rather than an error', async () => {
      await expect(
        restampSuppressions(root, 'src/never-suppressed.ts', [
          { mutator: COND, change: RIGHT, line: 3 },
        ]),
      ).resolves.toBeUndefined();
    });

    it('does not rewrite the file when no entry actually moves', async () => {
      await addSuppressions(root, FILE, [{ line: 2, mutator: COND, change: RIGHT }]);
      const dest = join(root, '.chaos-mcp', 'suppressions.json');
      const before = readFileSync(dest, 'utf8');
      await restampSuppressions(root, FILE, [{ mutator: COND, change: RIGHT, line: 2 }]);
      expect(readFileSync(dest, 'utf8')).toBe(before);
    });
  });
});
