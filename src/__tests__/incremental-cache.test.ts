/**
 * Publication mechanics of the host-side Stryker incremental cache.
 *
 * The cache is best-effort by design — losing it costs a full run, never an
 * audit — but a TORN entry is worse than no entry: `seedIncrementalFile` copies
 * whatever it finds into the next sandbox and Stryker then rejects (or worse,
 * misreads) it. These cases pin the two defects that made a torn or foreign
 * entry reachable:
 *
 *  1. The publish step claimed "write-then-rename" in a comment but performed a
 *     second `copyFileSync`, which truncates the live cache file and streams
 *     into it — so a crash, SIGKILL or ENOSPC mid-copy left exactly the
 *     half-written file the comment said was impossible.
 *  2. The staging path was keyed by `process.pid` alone while `cachePath` is a
 *     hash of (workspaceRoot, targetFile), so two concurrent harvests of the
 *     same target — ordinary here: overlapping CallTool requests, and
 *     `triage_test_coverage` auditing `poolSize` files inside one process —
 *     shared a single scratch file and silently published each other's state.
 *
 * `node:fs` is mocked so the exact call sequence is observable; the real-fs
 * round-trip behaviour is covered in audit-fixes.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  copyFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
}));

import { copyFileSync, renameSync, rmSync } from 'node:fs';
import { harvestIncrementalFile, INCREMENTAL_FILE_NAME } from '../utils/incremental-cache.js';

const mockCopyFileSync = vi.mocked(copyFileSync);
const mockRenameSync = vi.mocked(renameSync);
const mockRmSync = vi.mocked(rmSync);

const CACHE_PATH = '/cache/abc123.json';
const PRODUCED = `/sandbox-a/${INCREMENTAL_FILE_NAME}`;

describe('harvestIncrementalFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stages a copy and PUBLISHES it with a rename, never a second copy', () => {
    harvestIncrementalFile(CACHE_PATH, '/sandbox-a');

    // Exactly one copy: sandbox file -> staging file. A second copy here would
    // be an in-place truncate-and-stream over the live cache entry.
    expect(mockCopyFileSync).toHaveBeenCalledTimes(1);
    const [source, staged] = mockCopyFileSync.mock.calls[0] as [string, string];
    expect(source).toBe(PRODUCED);
    expect(mockCopyFileSync).not.toHaveBeenCalledWith(expect.anything(), CACHE_PATH);

    expect(mockRenameSync).toHaveBeenCalledTimes(1);
    expect(mockRenameSync).toHaveBeenCalledWith(staged, CACHE_PATH);
  });

  it('stages inside the cache directory, so the rename is same-filesystem', () => {
    // A rename is only atomic within one filesystem. Staging anywhere other
    // than beside `cachePath` would degrade it to a cross-device copy+unlink
    // (EXDEV), which is the non-atomic behaviour this replaced.
    harvestIncrementalFile(CACHE_PATH, '/sandbox-a');

    const staged = String((mockCopyFileSync.mock.calls[0] as [string, string])[1]);
    expect(staged.startsWith(`${CACHE_PATH}.`)).toBe(true);
    expect(staged.endsWith('.tmp')).toBe(true);
  });

  it('gives every harvest of the SAME target its own staging path', () => {
    // The interleaving this prevents: A copies to tmp, B overwrites tmp, A
    // publishes B's state, A unlinks tmp, B's publish fails ENOENT into the
    // swallowing catch. The cache then holds another run's bookkeeping under
    // this target's key — a silent wrong answer, not a visible failure.
    harvestIncrementalFile(CACHE_PATH, '/sandbox-a');
    harvestIncrementalFile(CACHE_PATH, '/sandbox-b');

    const first = (mockCopyFileSync.mock.calls[0] as [string, string])[1];
    const second = (mockCopyFileSync.mock.calls[1] as [string, string])[1];
    expect(first).not.toBe(second);
  });

  it('cleans up its own staging path and nothing else', () => {
    harvestIncrementalFile(CACHE_PATH, '/sandbox-a');

    const staged = (mockCopyFileSync.mock.calls[0] as [string, string])[1];
    // The rename consumed `staged`, so this is a no-op on the success path —
    // but it must still target only the path this call created.
    expect(mockRmSync).toHaveBeenCalledWith(staged, { force: true });
    expect(mockRmSync).not.toHaveBeenCalledWith(CACHE_PATH, expect.anything());
  });

  it('swallows a failed publish rather than failing a completed audit', () => {
    // Best-effort is the documented contract: the audit has already produced
    // its result by the time this runs.
    mockRenameSync.mockImplementationOnce(() => {
      throw new Error('EXDEV');
    });

    expect(() => harvestIncrementalFile(CACHE_PATH, '/sandbox-a')).not.toThrow();
    // The staging file is still removed, so a failed publish leaks nothing.
    const staged = (mockCopyFileSync.mock.calls[0] as [string, string])[1];
    expect(mockRmSync).toHaveBeenCalledWith(staged, { force: true });
  });
});
