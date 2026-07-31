import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadSuppressions,
  addSuppressions,
  removeSuppressions,
  _resetWriteQueue,
  _writeQueueSize,
} from '../utils/suppression.js';
import { applySuppressions } from '../audit/apply-suppressions.js';
import type { MutationResult } from '../engines/base.js';

let root: string;
beforeEach(() => {
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
  });

  it('corrupt file → empty map, no throw', () => {
    mkdirSync(join(root, '.chaos-mcp'), { recursive: true });
    writeFileSync(join(root, '.chaos-mcp', 'suppressions.json'), '{bad');
    expect(loadSuppressions(root).size).toBe(0);
  });

  it('add then load round-trips, deduped', async () => {
    await addSuppressions(root, 'src/a.ts', [
      { line: 1, mutator: 'A', reason: 'equivalent' },
      { line: 1, mutator: 'A' }, // dup
    ]);
    const map = loadSuppressions(root);
    expect([...(map.get('src/a.ts') ?? [])]).toEqual(['1 A']);
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
    expect([...(loadSuppressions(root).get('src/a.ts') ?? [])]).toEqual(['2 B']);
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
    expect([...(loadSuppressions(root, 'custom/sup.json').get('src/a.ts') ?? [])]).toEqual(['7 C']);
    // ...and the DEFAULT location was never written.
    expect(loadSuppressions(root).size).toBe(0);
  });

  it('honors an absolute configPath verbatim', async () => {
    const abs = join(root, 'abs-suppressions.json');
    await addSuppressions(root, 'src/a.ts', [{ line: 9, mutator: 'D' }], abs);
    expect([...(loadSuppressions(root, abs).get('src/a.ts') ?? [])]).toEqual(['9 D']);
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
    expect([...(map.get('good.ts') ?? [])]).toEqual(['5 A']);
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
    // `seen` from the entries already on disk. If that rebuild loses the keys,
    // every re-suppression appends another copy and the file grows without
    // bound — invisible through loadSuppressions(), which collapses the list
    // into a Set on the way out.
    return (async () => {
      await addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A', reason: 'first' }]);
      await addSuppressions(root, 'src/a.ts', [{ line: 1, mutator: 'A', reason: 'second' }]);

      const raw = JSON.parse(
        readFileSync(join(root, '.chaos-mcp', 'suppressions.json'), 'utf8'),
      ) as { entries: Record<string, { reason?: string }[]> };
      expect(raw.entries['src/a.ts']).toHaveLength(1);
      // First write wins — a re-suppression is skipped, not merged.
      expect(raw.entries['src/a.ts'][0].reason).toBe('first');
    })();
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
    expect([...(loadSuppressions(root).get('src/a.ts') ?? [])]).toEqual(['1 A']);
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
    expect([...(loadSuppressions(root).get('src/a.ts') ?? [])].sort()).toEqual(['1 A', '2 B']);
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
    await expect(added).resolves.toBeUndefined();
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
    const persisted = loadSuppressions(root);
    expect([...(persisted.get('src/a.ts') ?? [])].sort()).toEqual([
      '1 A',
      '2 B',
      '4 D',
      '5 E',
      '6 F',
    ]);

    // Invariant 2: map is empty after all writes settled (no leak).
    expect(_writeQueueSize()).toBe(0);
  });
});
