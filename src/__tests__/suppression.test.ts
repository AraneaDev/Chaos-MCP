import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  loadSuppressions,
  addSuppressions,
  removeSuppressions,
  verifySuppressions,
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
    const { result, suppressedCount } = applySuppressions(makeResult(), new Set(['1 A', '2 A']));
    expect(suppressedCount).toBe(2);
    expect(result.vulnerabilities).toEqual([{ line: 1, mutator: 'B', description: 'x' }]);
    expect(result.totalMutants).toBe(8); // 10 - 2
    expect(result.survived).toBe(3); // 4 - 1 (only '1 A' is a true survivor; '2 A' is NoCoverage)
    expect(result.mutationScore).toBe('75.00%'); // 6 / 8
  });

  it('applySuppressions suppressing only a NoCoverage mutant leaves survived unchanged', () => {
    // '2 A' has description 'no test reached this line' → NoCoverage, not a true survivor
    const { result, suppressedCount } = applySuppressions(makeResult(), new Set(['2 A']));
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
  it('preserves an existing file version through add', async () => {
    mkdirSync(join(root, '.chaos-mcp'), { recursive: true });
    const dest = join(root, '.chaos-mcp', 'suppressions.json');
    writeFileSync(
      dest,
      JSON.stringify({
        version: 2,
        entries: { 'src/a.ts': [{ line: 1, mutator: 'A', addedAt: 1 }] },
      }),
    );
    await addSuppressions(root, 'src/a.ts', [{ line: 2, mutator: 'B' }]);
    const raw = JSON.parse(readFileSync(dest, 'utf8')) as { version: number };
    expect(raw.version).toBe(2);
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
    const { result, suppressedCount } = applySuppressions(r, new Set(['999 Z']));
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

    const { result, suppressedCount } = applySuppressions(empty, new Set(['1 A']));

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
    const { result } = applySuppressions(makeResult(), new Set(['1 A']));
    expect(Object.keys(result)).not.toContain('scopeNote');
  });

  it('applySuppressions with an empty set leaves the result untouched', () => {
    const r = makeResult();

    const { result, suppressedCount } = applySuppressions(r, new Set());

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
    const { result } = applySuppressions(r, new Set(['1 A', '1 B']));
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
    await expect(added).resolves.toEqual({ stamped: 0, unstamped: 0 });
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
      expect(res).toEqual({ stamped: 1, unstamped: 0 });
      const stored = loadSuppressions(root).get(FILE);
      expect(stored?.[0].fingerprint).toBe(fingerprintOfLine(SRC[1]));
    });

    it('bumps the stored schema version to 2', async () => {
      await addSuppressions(root, FILE, [{ line: 2, mutator: 'X' }]);
      const raw = JSON.parse(
        readFileSync(join(root, '.chaos-mcp', 'suppressions.json'), 'utf8'),
      ) as { version: number };
      expect(raw.version).toBe(2);
    });

    it('records NO fingerprint when the source file is missing', async () => {
      const res = await addSuppressions(root, 'src/gone.ts', [{ line: 2, mutator: 'X' }]);
      // Observable at the call site, and stored honestly rather than invented.
      expect(res).toEqual({ stamped: 0, unstamped: 1 });
      expect(loadSuppressions(root).get('src/gone.ts')?.[0].fingerprint).toBeUndefined();
    });

    it('records NO fingerprint when the line is past the end of the file', async () => {
      const res = await addSuppressions(root, FILE, [{ line: 9999, mutator: 'X' }]);
      expect(res).toEqual({ stamped: 0, unstamped: 1 });
      expect(loadSuppressions(root).get(FILE)?.[0].fingerprint).toBeUndefined();
    });
  });

  describe('apply path (three-way)', () => {
    it('APPLIES an entry whose fingerprint matches the current line', async () => {
      await addSuppressions(root, FILE, [{ line: 2, mutator: 'ConditionalExpression' }]);
      const verdict = verifySuppressions(root, FILE, loadSuppressions(root).get(FILE));
      expect([...verdict.applied]).toEqual(['2 ConditionalExpression']);
      expect(verdict.drifted).toBe(0);
      expect(verdict.unverified).toBe(0);
    });

    it('survives a whitespace-only reformat of the targeted line', async () => {
      await addSuppressions(root, FILE, [{ line: 2, mutator: 'ConditionalExpression' }]);
      const reformatted = [...SRC];
      reformatted[1] = '\t if   (a > b)   {';
      writeSource(root, FILE, reformatted);
      const verdict = verifySuppressions(root, FILE, loadSuppressions(root).get(FILE));
      expect([...verdict.applied]).toEqual(['2 ConditionalExpression']);
      expect(verdict.drifted).toBe(0);
    });

    it('does NOT apply — and counts as drifted — when the line becomes different code', async () => {
      await addSuppressions(root, FILE, [{ line: 2, mutator: 'ConditionalExpression' }]);
      const edited = [...SRC];
      edited[1] = '  if (a >= b) {';
      writeSource(root, FILE, edited);
      const verdict = verifySuppressions(root, FILE, loadSuppressions(root).get(FILE));
      expect(verdict.applied.size).toBe(0);
      expect(verdict.drifted).toBe(1);
      expect(verdict.unverified).toBe(0);
    });

    it('does NOT apply when an inserted line shifts the target down', async () => {
      // The exact regression: line 2 now hosts different code, so the stored key
      // must stop matching instead of silently suppressing whatever moved in.
      await addSuppressions(root, FILE, [{ line: 2, mutator: 'ConditionalExpression' }]);
      writeSource(root, FILE, ['// a new banner comment', ...SRC]);
      const verdict = verifySuppressions(root, FILE, loadSuppressions(root).get(FILE));
      expect(verdict.applied.size).toBe(0);
      expect(verdict.drifted).toBe(1);
    });

    it('does NOT apply when the file can no longer be read', async () => {
      await addSuppressions(root, FILE, [{ line: 2, mutator: 'ConditionalExpression' }]);
      rmSync(join(root, FILE));
      const verdict = verifySuppressions(root, FILE, loadSuppressions(root).get(FILE));
      // Cannot be shown to still match ⇒ not applied. Fail toward the VISIBLE
      // failure (a lower score) over the invisible one (a hidden coverage gap).
      expect(verdict.applied.size).toBe(0);
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
      expect([...verdict.applied]).toEqual(['2 ConditionalExpression']);
      expect(verdict.drifted).toBe(1);
    });

    it('treats no stored entries as an empty verdict', () => {
      const verdict = verifySuppressions(root, FILE, undefined);
      expect(verdict.applied.size).toBe(0);
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
      expect(verdict.applied.size).toBe(0);
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
      expect(res).toEqual({ stamped: 1, unstamped: 0 });
      const stored = loadSuppressions(root).get(FILE);
      expect(stored).toHaveLength(1);
      expect(stored?.[0].reason).toBe('a > b is dominated by the caller guard');
      expect(stored?.[0].fingerprint).toBe(fingerprintSourceLine(root, FILE, 2));
      const verdict = verifySuppressions(root, FILE, stored);
      expect([...verdict.applied]).toEqual(['2 ConditionalExpression']);
      expect(verdict.unverified).toBe(0);
    });

    it('drops a stale fingerprint rather than keeping it when the line cannot be re-read', async () => {
      await addSuppressions(root, FILE, [{ line: 2, mutator: 'ConditionalExpression' }]);
      rmSync(join(root, FILE));
      const res = await addSuppressions(root, FILE, [
        { line: 2, mutator: 'ConditionalExpression' },
      ]);
      expect(res).toEqual({ stamped: 0, unstamped: 1 });
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
      expect(verdict.applied.size).toBe(0);
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
    expect([...verdict.applied]).toEqual(['2 ConditionalExpression']);
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
