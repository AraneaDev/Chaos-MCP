import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveRun, loadRun } from '../utils/run-cache.js';

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
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));
