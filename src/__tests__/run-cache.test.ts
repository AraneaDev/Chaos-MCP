import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Partial mock: everything passes through to the real implementation except
// `renameSync`, which is wrapped in a `vi.fn` so a single test can force it
// to throw (simulating ENOSPC/permission failures) without disturbing every
// other real filesystem interaction in this suite.
// `readdirSync` is wrapped the same way so one test can hand back a reversed
// listing: directory order is filesystem-defined, and on ext4 it happens to
// match the order the tie-break wants, which would let an eviction that relies
// on luck pass. Both wrappers delegate to the real implementation otherwise.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    readdirSync: vi.fn(actual.readdirSync),
  };
});

import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveRun, loadRun, mintRunId } from '../utils/run-cache.js';
import { buildResultPayload } from '../format.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-test-'));
});

describe('run-cache', () => {
  it('round-trips a saved run by id', () => {
    const id = saveRun(
      {
        file: 'src/a.ts',
        projectType: 'typescript',
        survivors: [{ line: 1, mutators: { Foo: 1 } }],
        noCoverage: [],
      },
      { dir },
    );
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    const got = loadRun(id, { dir });
    expect(got?.file).toBe('src/a.ts');
    expect(got?.survivors).toEqual([{ line: 1, mutators: { Foo: 1 } }]);
    expect(got?.createdAt).toBeTypeOf('number');
  });

  it('returns undefined for an unknown id', () => {
    expect(loadRun('deadbeef', { dir })).toBeUndefined();
  });

  it('treats an entry older than the TTL as a miss', () => {
    const id = saveRun(
      { file: 'a.ts', projectType: 'typescript', survivors: [], noCoverage: [] },
      { dir, now: 1000 },
    );
    expect(loadRun(id, { dir, now: 1000 + 10 })).toBeDefined();
    expect(loadRun(id, { dir, ttlMs: 5, now: 1000 + 10 })).toBeUndefined();
  });

  it('treats a corrupt file as a miss', () => {
    writeFileSync(join(dir, 'bad.json'), '{not json');
    expect(loadRun('bad', { dir })).toBeUndefined();
  });

  it('evicts oldest entries beyond max on write', () => {
    saveRun(
      { file: 'a', projectType: 't', survivors: [], noCoverage: [] },
      { dir, max: 2, now: 1 },
    );
    saveRun(
      { file: 'b', projectType: 't', survivors: [], noCoverage: [] },
      { dir, max: 2, now: 2 },
    );
    saveRun(
      { file: 'c', projectType: 't', survivors: [], noCoverage: [] },
      { dir, max: 2, now: 3 },
    );
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).length).toBeLessThanOrEqual(2);
  });

  it('removes a corrupt cache file encountered during eviction', () => {
    // A corrupt .json sitting in the cache dir must be cleaned up the next time
    // the cache is scanned (saveRun → evict → listEntries), so it cannot
    // accumulate. (loadRun never scans the dir, so this path is only hit here.)
    writeFileSync(join(dir, 'corrupt.json'), '{not json');
    saveRun({ file: 'a', projectType: 't', survivors: [], noCoverage: [] }, { dir, now: 1 });
    expect(existsSync(join(dir, 'corrupt.json'))).toBe(false);
  });

  it('leaves non-.json files untouched during eviction', () => {
    // The cache scan filters to *.json; an unrelated file must never be parsed
    // (and thus never deleted as "corrupt").
    writeFileSync(join(dir, 'note.txt'), 'not json and not ours');
    saveRun({ file: 'a', projectType: 't', survivors: [], noCoverage: [] }, { dir, now: 1 });
    expect(existsSync(join(dir, 'note.txt'))).toBe(true);
  });

  it('evicts entries older than the TTL on write', () => {
    saveRun(
      { file: 'old', projectType: 't', survivors: [], noCoverage: [] },
      { dir, ttlMs: 100, now: 1000 },
    );
    saveRun(
      { file: 'new', projectType: 't', survivors: [], noCoverage: [] },
      { dir, ttlMs: 100, now: 5000 },
    );
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).length).toBe(1);
  });

  const jsonCount = () => readdirSync(dir).filter((f) => f.endsWith('.json')).length;

  it('keeps an entry whose age is exactly the TTL (boundary is strict >)', () => {
    // Distinguishes `now - createdAt > ttlMs` from `>= ttlMs`: at exactly the TTL
    // the entry must survive.
    saveRun(
      { file: 'a', projectType: 't', survivors: [], noCoverage: [] },
      { dir, ttlMs: 100, now: 1000 },
    );
    saveRun(
      { file: 'b', projectType: 't', survivors: [], noCoverage: [] },
      { dir, ttlMs: 100, now: 1100 },
    );
    expect(jsonCount()).toBe(2); // age 100 == ttl → first entry retained
  });

  it('keeps a within-TTL entry on write (eviction age uses now - createdAt)', () => {
    // Distinguishes `now - createdAt` from `now + createdAt`: a fresh entry must
    // not be evicted, which a `+` mutant would do for any positive timestamps.
    saveRun(
      { file: 'a', projectType: 't', survivors: [], noCoverage: [] },
      { dir, ttlMs: 100, now: 1000 },
    );
    saveRun(
      { file: 'b', projectType: 't', survivors: [], noCoverage: [] },
      { dir, ttlMs: 100, now: 1050 },
    );
    expect(jsonCount()).toBe(2);
  });

  it('treats a cache file with no createdAt as ancient (createdAt ?? 0) and evicts it', () => {
    // `parsed.createdAt ?? 0` must default to 0 so the entry reads as maximally
    // old. A `&& 0` mutant yields undefined → NaN age → never evicted.
    writeFileSync(join(dir, 'aaaaaaaa.json'), JSON.stringify({ file: 'x', projectType: 't' }));
    saveRun(
      { file: 'b', projectType: 't', survivors: [], noCoverage: [] },
      { dir, ttlMs: 100, now: 100000 },
    );
    expect(existsSync(join(dir, 'aaaaaaaa.json'))).toBe(false);
  });

  it('trims to exactly max newest entries on overflow (off-by-one boundary)', () => {
    // Fill to max, then one past it. Exactly `max` entries must remain — pins
    // `i < live.length - max + 1` against the `<=` off-by-one (which over-trims).
    for (let t = 1; t <= 4; t++) {
      saveRun(
        { file: `f${t}`, projectType: 't', survivors: [], noCoverage: [] },
        { dir, max: 3, now: t },
      );
    }
    expect(jsonCount()).toBe(3);
  });

  it('evicts the oldest (not newest) when over max', () => {
    // The sort-by-createdAt picks the oldest live entry to drop; this asserts the
    // surviving ids are the two newest.
    const id1 = saveRun(
      { file: 'f1', projectType: 't', survivors: [], noCoverage: [] },
      { dir, max: 2, now: 1 },
    );
    const id2 = saveRun(
      { file: 'f2', projectType: 't', survivors: [], noCoverage: [] },
      { dir, max: 2, now: 2 },
    );
    const id3 = saveRun(
      { file: 'f3', projectType: 't', survivors: [], noCoverage: [] },
      { dir, max: 2, now: 3 },
    );
    expect(loadRun(id1, { dir, now: 3 })).toBeUndefined(); // oldest dropped
    expect(loadRun(id2, { dir, now: 3 })?.file).toBe('f2');
    expect(loadRun(id3, { dir, now: 3 })?.file).toBe('f3');
  });

  it('honors the default 24h TTL when no ttlMs is given', () => {
    // Pins DEFAULT_TTL_MS = 24*60*60*1000: an entry 23h old must still be a hit.
    // Any arithmetic mutation of that constant shrinks the window and expires it.
    const id = saveRun(
      { file: 'a', projectType: 't', survivors: [], noCoverage: [] },
      { dir, now: 0 },
    );
    expect(loadRun(id, { dir, now: 23 * 60 * 60 * 1000 })?.file).toBe('a');
  });

  it('loadRun keeps an entry whose age is exactly the TTL (strict >)', () => {
    const id = saveRun(
      { file: 'a', projectType: 't', survivors: [], noCoverage: [] },
      { dir, now: 1000 },
    );
    // age 100 == ttl 100 → `> ttl` is false → still a hit (kills `>=`).
    expect(loadRun(id, { dir, ttlMs: 100, now: 1100 })?.file).toBe('a');
  });

  it('excludes TTL-expired entries from the max-trim live set', () => {
    // Pre-place one expired + three live entries, then save one more with a small
    // max. The expired entry is dropped by the TTL pass; the live set (now-createdAt
    // <= ttl) is trimmed oldest-first to `max`. A `+` mutant in the live filter
    // would treat every entry as expired and skip trimming, leaving extra files.
    const put = (id: string, createdAt: number) =>
      writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({
          runId: id,
          file: id,
          projectType: 't',
          createdAt,
          survivors: [],
          noCoverage: [],
        }),
      );
    put('expired00', 1000); // age 4000 > ttl 100 → evicted by TTL pass
    put('liveaaaa1', 4950); // age 50 → live, oldest → trimmed
    put('liveaaaa2', 4960); // age 40 → live, trimmed
    put('liveaaaa3', 4970); // age 30 → live, newest → kept
    saveRun(
      { file: 'new', projectType: 't', survivors: [], noCoverage: [] },
      { dir, ttlMs: 100, max: 2, now: 5000 },
    );
    // Exactly max(2) survive: the newest pre-placed live entry + the new one.
    expect(jsonCount()).toBe(2);
    expect(existsSync(join(dir, 'expired00.json'))).toBe(false);
    expect(existsSync(join(dir, 'liveaaaa3.json'))).toBe(true);
  });

  it('counts an exactly-at-TTL entry as live, so the max-trim can evict it', () => {
    // The TTL pass keeps an entry whose age is exactly the TTL (`> ttl` is
    // false), so the live filter MUST use `<=` to match. With `<` the boundary
    // entry is retained on disk yet excluded from the live set: the trim then
    // computes one deletion too few and the cache ends up over `max` — the two
    // halves of the eviction disagreeing about the same entry.
    const put = (id: string, createdAt: number) =>
      writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({
          runId: id,
          file: id,
          projectType: 't',
          createdAt,
          survivors: [],
          noCoverage: [],
        }),
      );
    put('boundary1', 4900); // age exactly 100 == ttl
    put('liveaaaa1', 4950);
    put('liveaaaa2', 4960);
    saveRun(
      { file: 'new', projectType: 't', survivors: [], noCoverage: [] },
      { dir, ttlMs: 100, max: 2, now: 5000 },
    );
    expect(jsonCount()).toBe(2);
    expect(existsSync(join(dir, 'boundary1.json'))).toBe(false); // oldest live → trimmed
    expect(existsSync(join(dir, 'liveaaaa2.json'))).toBe(true);
  });

  it('still writes the new entry when the cache directory cannot be listed', () => {
    // Eviction is best-effort housekeeping; a directory that cannot be read
    // must degrade to "evict nothing", not take the save down with it. Without
    // the `return []`, the undefined name list is iterated and throws a
    // TypeError straight out of saveRun.
    vi.mocked(readdirSync).mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied, scandir');
    });
    const id = saveRun(
      { file: 'src/a.ts', projectType: 'typescript', survivors: [], noCoverage: [] },
      { dir },
    );
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(loadRun(id, { dir })?.file).toBe('src/a.ts');
  });

  /**
   * Eviction order must not depend on the order the directory happens to be
   * read in. It used to: `listEntries` returned entries in readdir order, and
   * run ids are random, so the victim a broken comparator picked changed from
   * run to run — the suite passed or failed on the same code depending on which
   * uuids came out. Pre-placing five known ids and dropping three pins the
   * whole ordering: every entry's fate is asserted, not just the count.
   */
  it('evicts oldest-first deterministically regardless of directory order', () => {
    const put = (id: string, createdAt: number) =>
      writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({
          runId: id,
          file: id,
          projectType: 't',
          createdAt,
          survivors: [],
          noCoverage: [],
        }),
      );
    // Ids deliberately counter-sorted against age so a comparator that ignores
    // createdAt (or adds instead of subtracting) cannot land on the right set.
    put('eeeeeeee', 100);
    put('dddddddd', 200);
    put('cccccccc', 300);
    put('bbbbbbbb', 400);
    put('aaaaaaaa', 500);

    // max 3 → room for the newcomer means dropping 5 - 3 + 1 = 3 entries.
    const fresh = saveRun(
      { file: 'new', projectType: 't', survivors: [], noCoverage: [] },
      { dir, max: 3, now: 600 },
    );

    expect(existsSync(join(dir, 'eeeeeeee.json'))).toBe(false);
    expect(existsSync(join(dir, 'dddddddd.json'))).toBe(false);
    expect(existsSync(join(dir, 'cccccccc.json'))).toBe(false);
    expect(existsSync(join(dir, 'bbbbbbbb.json'))).toBe(true);
    expect(existsSync(join(dir, 'aaaaaaaa.json'))).toBe(true);
    expect(loadRun(fresh, { dir, now: 600 })?.file).toBe('new');
    expect(jsonCount()).toBe(3);
  });

  /**
   * Two entries written in the same millisecond used to be separated by
   * readdir order alone — the same input could evict either one. The id breaks
   * the tie so the choice is reproducible.
   */
  it('breaks a createdAt tie by id so the victim is reproducible', () => {
    const put = (id: string, createdAt: number) =>
      writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({
          runId: id,
          file: id,
          projectType: 't',
          createdAt,
          survivors: [],
          noCoverage: [],
        }),
      );
    put('zzzzzzzz', 100);
    put('aaaaaaaa', 100);

    // Hand the scan the two entries in descending id order, the one order a
    // tie-break-free sort would resolve the wrong way. Without this the
    // assertion below passes on whatever order ext4 happens to return.
    const listing = readdirSync(dir) as unknown as string[];
    vi.mocked(readdirSync).mockReturnValueOnce(
      [...listing].sort().reverse() as unknown as ReturnType<typeof readdirSync>,
    );

    // max 2 → drop 2 - 2 + 1 = 1: the tie is resolved by the lower id.
    saveRun(
      { file: 'new', projectType: 't', survivors: [], noCoverage: [] },
      { dir, max: 2, now: 100 },
    );

    expect(existsSync(join(dir, 'aaaaaaaa.json'))).toBe(false);
    expect(existsSync(join(dir, 'zzzzzzzz.json'))).toBe(true);
  });

  it('loadRun rejects an entry whose createdAt is not a number', () => {
    // typeof parsed.createdAt !== 'number' guard (line 114).
    writeFileSync(join(dir, 'bbbbbbbb.json'), JSON.stringify({ file: 'x', createdAt: 'soon' }));
    expect(loadRun('bbbbbbbb', { dir, now: 1000 })).toBeUndefined();
  });

  it('removes the orphaned .tmp file when renameSync fails (L3)', () => {
    // Audit L3: writeFileSync + renameSync had no cleanup on rename failure,
    // orphaning a `${dest}.${pid}.tmp` file that evict()/listEntries() never
    // touch (they only glob *.json). saveRun must remove the tmp file itself
    // before rethrowing.
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('simulated ENOSPC on rename');
    });

    expect(() =>
      saveRun({ file: 'a', projectType: 't', survivors: [], noCoverage: [] }, { dir, now: 1 }),
    ).toThrow('simulated ENOSPC on rename');

    const leftoverTmp = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftoverTmp).toHaveLength(0);
  });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * `mintRunId` was duplicated verbatim in handler.ts and triage-handler.ts (same
 * compact payload, same projection, same non-fatal catch) before it moved here.
 * These cover the shared contract both tools now depend on.
 */
describe('mintRunId', () => {
  // mintRunId now takes the already-compacted payload: `buildResultPayload` is
  // a domain-layer (format.ts) function and run-cache.ts is a leaf util, so the
  // caller builds it. Built here through the real builder so these still pin
  // the MutationResult → cache-entry projection end to end.
  const payload = buildResultPayload(
    {
      target: 'src/a.ts',
      totalMutants: 2,
      killed: 1,
      survived: 1,
      mutationScore: '50.00%',
      vulnerabilities: [{ line: 10, mutator: 'ConditionalExpression', description: 'survived' }],
    },
    {},
  );

  it('caches the run under the workspace-relative key and returns its id', () => {
    const id = mintRunId(payload, 'src/a.ts', 'typescript', { dir });
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    const entry = loadRun(id as string, { dir });
    expect(entry?.file).toBe('src/a.ts');
    expect(entry?.projectType).toBe('typescript');
    expect(entry?.survivors).toEqual([{ line: 10, mutators: { ConditionalExpression: 1 } }]);
    expect(entry?.noCoverage).toEqual([]);
  });

  it('returns undefined instead of throwing when the cache cannot be written', () => {
    // A cache failure is non-fatal by design: the caller loses the runId, not
    // the audit it asked for.
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('simulated ENOSPC on rename');
    });
    expect(mintRunId(payload, 'src/a.ts', 'typescript', { dir })).toBeUndefined();
  });
});

/**
 * `runId` arrives as a tool argument and is interpolated straight into a
 * filename. Before this guard, `loadRun('../../secrets/creds')` read and parsed
 * an arbitrary JSON file anywhere on disk — reproduced against the built module
 * during the audit that added these tests.
 */
describe('loadRun — path traversal', () => {
  it('refuses an id containing a path separator', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chaos-traversal-'));
    const outside = mkdtempSync(join(tmpdir(), 'chaos-secret-'));
    try {
      writeFileSync(
        join(outside, 'creds.json'),
        JSON.stringify({
          runId: 'x',
          file: 'SECRET',
          projectType: 'typescript',
          createdAt: Date.now(),
          survivors: [],
          noCoverage: [],
        }),
        'utf8',
      );
      const traversal = `../${outside.split('/').pop() ?? ''}/creds`;
      expect(loadRun(traversal, { dir })).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses "..", which would resolve to the cache directory itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chaos-traversal-'));
    try {
      expect(loadRun('..', { dir })).toBeUndefined();
      expect(loadRun('.', { dir })).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an empty id, which would read a bare ".json" file', () => {
    // `basename('') === ''`, so the separator check alone lets an empty id
    // through and the lookup becomes `join(dir, '.json')` — a dotfile an
    // attacker (or a stray tool) could plant in the shared cache directory.
    // The explicit length guard is the only thing that stops it.
    writeFileSync(
      join(dir, '.json'),
      JSON.stringify({
        runId: 'planted',
        file: 'planted.ts',
        projectType: 't',
        createdAt: Date.now(),
        survivors: [],
        noCoverage: [],
      }),
    );
    expect(loadRun('', { dir })).toBeUndefined();
  });

  it('still loads a legitimately minted id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chaos-traversal-'));
    try {
      const id = saveRun(
        { file: 'src/a.ts', projectType: 'typescript', survivors: [], noCoverage: [] },
        { dir },
      );
      expect(loadRun(id, { dir })?.file).toBe('src/a.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
