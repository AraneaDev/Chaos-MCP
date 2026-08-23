import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Windows junction fallback in `safeSymlink`.
 *
 * On Windows a regular symlink needs Administrator privileges and fails EPERM;
 * a junction does not, and works for directories. On Linux and macOS an EPERM
 * is a genuine filesystem error (NFS root_squash, for one) and must propagate.
 *
 * `isWindows()` is `sep === '\\'`, so the entire branch is dead on this
 * platform — three mutants in it were reported as NoCoverage by the mutation
 * sweep, meaning nothing executed them at all. `sandbox.test.ts` pins the Linux
 * half; this file pins the Windows half by mocking `path.sep`. It lives apart
 * from that suite on purpose: a `path` mock is process-wide for the module
 * graph of the file that declares it, and sandbox.test.ts depends on real
 * POSIX joins.
 */
vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  return { ...actual, sep: '\\' };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, symlinkSync: vi.fn() };
});

import { symlinkSync } from 'fs';
import { safeSymlink } from '../utils/sandbox/dependency-link.js';

const mockSymlinkSync = vi.mocked(symlinkSync);

function eperm(): Error {
  return Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
}

describe('safeSymlink on Windows', () => {
  beforeEach(() => {
    mockSymlinkSync.mockReset();
  });

  it('retries a failed directory symlink as a junction', () => {
    mockSymlinkSync.mockImplementationOnce(() => {
      throw eperm();
    });

    expect(() => safeSymlink('C:\\host\\node_modules', 'C:\\sandbox\\node_modules')).not.toThrow();

    expect(mockSymlinkSync).toHaveBeenCalledTimes(2);
    expect(mockSymlinkSync).toHaveBeenNthCalledWith(
      1,
      'C:\\host\\node_modules',
      'C:\\sandbox\\node_modules',
      'dir',
    );
    expect(mockSymlinkSync).toHaveBeenNthCalledWith(
      2,
      'C:\\host\\node_modules',
      'C:\\sandbox\\node_modules',
      'junction',
    );
  });

  it('rethrows the ORIGINAL error object when the junction retry also fails', () => {
    // Junctions are directories-only, so a file target fails both ways. The
    // error that surfaces must be the first one, which explains the actual
    // problem (EPERM), not the junction attempt's secondary failure.
    //
    // Identity, not message. Matching on `'EPERM'` alone would also pass for a
    // freshly constructed error carrying the same text, which would lose the
    // original's `code` property and stack.
    const original = eperm();
    mockSymlinkSync
      .mockImplementationOnce(() => {
        throw original;
      })
      .mockImplementationOnce(() => {
        throw new Error('EINVAL: junctions are directories-only');
      });

    let caught: unknown;
    try {
      safeSymlink('C:\\host\\file.txt', 'C:\\sandbox\\file.txt', 'file');
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBe(original);
    expect(mockSymlinkSync).toHaveBeenCalledTimes(2);
  });

  it('does not attempt a junction when the first symlink succeeds', () => {
    expect(() => safeSymlink('C:\\host\\node_modules', 'C:\\sandbox\\node_modules')).not.toThrow();
    expect(mockSymlinkSync).toHaveBeenCalledTimes(1);
  });
});
