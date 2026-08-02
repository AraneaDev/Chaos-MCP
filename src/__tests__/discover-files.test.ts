import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { discoverFiles, discoverChangedFiles } from '../triage/discover-files.js';

const mockReaddirSync = vi.mocked(readdirSync);
const actualFs = await vi.importActual<typeof import('fs')>('fs');

/**
 * `triage/discover-files.ts` had no test file. A mutation audit found two behaviours
 * with nothing behind them: the catch that skips an unreadable directory, and the
 * trailing-slash normalisation on caller-supplied paths.
 *
 * The unreadable-directory case is driven by making readdirSync throw rather than by
 * chmod, because these tests run as root and root bypasses the permission bit — a
 * chmod-based test would pass whether or not the catch existed.
 */

let ws: string;

beforeEach(() => {
  vi.clearAllMocks();
  mockReaddirSync.mockImplementation(actualFs.readdirSync as never);
  ws = mkdtempSync(join(tmpdir(), 'chaos-discover-'));
  mkdirSync(join(ws, 'src', 'nested'), { recursive: true });
  writeFileSync(join(ws, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(ws, 'src', 'nested', 'b.ts'), 'export const b = 2;\n');
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe('discoverFiles — unreadable directories', () => {
  it('skips a directory it cannot read instead of failing the whole sweep', () => {
    mockReaddirSync.mockImplementation(((dir: string, opts: unknown) => {
      if (String(dir).endsWith('nested')) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return (actualFs.readdirSync as (d: string, o: unknown) => unknown)(dir, opts);
    }) as never);

    const found = discoverFiles(['src'], ws, 25);

    // The readable part of the tree still comes back — an unreadable subdirectory
    // must cost only its own contents, not the entire discovery.
    expect(found.files).toEqual(['src/a.ts']);
  });

  it('returns nothing rather than throwing when the root itself is unreadable', () => {
    mockReaddirSync.mockImplementation((() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    }) as never);

    expect(() => discoverFiles(['src'], ws, 25)).not.toThrow();
    expect(discoverFiles(['src'], ws, 25).files).toEqual([]);
  });
});

/**
 * These pin a user-facing contract, NOT the `.replace(/\/+$/, '')` calls that look like
 * they implement it. Those strips are unreachable no-ops: `path.resolve()` collapses
 * trailing slashes before `relative()` ever sees them, so `relative(ws, resolve(ws,
 * 'src///'))` is already 'src'. Mutating or deleting either strip changes nothing, which
 * is why a mutation audit reports them as survivors — they are equivalent, not untested.
 *
 * The tests are kept because the behaviour they describe is real and worth holding: they
 * would fail if the upstream resolve()/relative() normalisation were ever dropped.
 */
describe('discoverFiles — path normalisation', () => {
  it('treats a trailing slash the same as none', () => {
    expect(discoverFiles(['src/'], ws, 25).files).toEqual(discoverFiles(['src'], ws, 25).files);
  });

  it('treats repeated trailing slashes the same as none', () => {
    expect(discoverFiles(['src///'], ws, 25).files).toEqual(discoverFiles(['src'], ws, 25).files);
  });
});

describe('discoverChangedFiles — path filtering', () => {
  const changed = ['src/a.ts', 'src/nested/b.ts', 'docs/readme.md'];

  it('keeps only supported sources under the requested paths', () => {
    const found = discoverChangedFiles(changed, ['src/nested'], 25, ws);
    expect(found.files).toEqual(['src/nested/b.ts']);
  });

  it('matches a requested path given with repeated trailing slashes', () => {
    // Same caveat as above: equivalent by construction, since git reports FILE paths and
    // never emits a trailing slash. Kept as a contract on the caller-facing behaviour.
    expect(discoverChangedFiles(changed, ['src/nested///'], 25, ws).files).toEqual([
      'src/nested/b.ts',
    ]);
  });

  it('treats an empty path list as no filter at all', () => {
    const found = discoverChangedFiles(changed, [], 25, ws);
    expect(found.files).toEqual(['src/a.ts', 'src/nested/b.ts']);
  });

  it('treats "." as the workspace root, which contains everything', () => {
    const found = discoverChangedFiles(changed, ['.'], 25, ws);
    expect(found.files).toEqual(['src/a.ts', 'src/nested/b.ts']);
  });
});
