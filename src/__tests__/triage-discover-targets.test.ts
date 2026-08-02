import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'path';
import { ExecFailureError } from '../utils/exec-error.js';

const mockListChangedFiles = vi.hoisted(() => vi.fn());
const mockIsPathPermitted = vi.hoisted(() => vi.fn());

vi.mock('../utils/git-diff.js', () => ({ listChangedFiles: mockListChangedFiles }));
vi.mock('../utils/path-safety.js', () => ({ isPathPermitted: mockIsPathPermitted }));

const { resolveTriageTargets } = await import('../triage/discover-targets.js');
const { AuditDeadline } = await import('../utils/deadline.js');

const ROOT = resolve('/workspace');

const run = (over: Partial<Parameters<typeof resolveTriageTargets>[0]> = {}) =>
  resolveTriageTargets({
    rootCwd: ROOT,
    paths: undefined,
    diffBase: 'main',
    maxFiles: 25,
    deadline: new AuditDeadline(60_000),
    cleanupReserveMs: 0,
    ...over,
  });

describe('resolveTriageTargets — diff mode path normalisation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPathPermitted.mockReturnValue(true);
    mockListChangedFiles.mockResolvedValue({
      kind: 'files',
      files: ['src/a.ts', 'src/util/b.ts', 'pkg/c.rs'],
    });
  });

  it('matches "./src" and "src/" against git output just like the filesystem branch', async () => {
    // The workspace root has to reach discoverChangedFiles for this to work —
    // without it "./src" is compared verbatim against "src/a.ts" and the sweep
    // reports "no changed supported source files found".
    for (const spelling of ['./src', 'src/', 'src']) {
      const targets = await run({ paths: [spelling] });
      expect(targets.kind).toBe('targets');
      if (targets.kind !== 'targets') return;
      expect(targets.files).toEqual(['src/a.ts', 'src/util/b.ts']);
      expect(targets.discovered).toBe(2);
    }
  });
});

describe('resolveTriageTargets — files rejected by the workspace boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListChangedFiles.mockResolvedValue({
      kind: 'files',
      files: ['src/a.ts', 'src/escaped.ts'],
    });
  });

  it('counts a boundary-rejected file as skipped so the totals still add up', async () => {
    mockIsPathPermitted.mockImplementation((abs: string) => !abs.endsWith('escaped.ts'));
    const targets = await run();
    expect(targets.kind).toBe('targets');
    if (targets.kind !== 'targets') return;
    expect(targets.files).toEqual(['src/a.ts']);
    // Passing the unfiltered `skipped` through made the rejected file vanish
    // from every count: discovered no longer equalled audited + skipped.
    expect(targets.discovered).toBe(2);
    expect(targets.skipped).toBe(1);
    expect(targets.files.length + targets.skipped).toBe(targets.discovered);
  });

  it('adds boundary rejections to the maxFiles skips rather than replacing them', async () => {
    mockListChangedFiles.mockResolvedValue({
      kind: 'files',
      files: ['src/a.ts', 'src/escaped.ts', 'src/z.ts'],
    });
    mockIsPathPermitted.mockImplementation((abs: string) => !abs.endsWith('escaped.ts'));
    // Sorted: a.ts, escaped.ts, z.ts. maxFiles=2 selects the first two (1 skip),
    // then the boundary drops escaped.ts (1 more) — the two counts must sum.
    const targets = await run({ maxFiles: 2 });
    expect(targets.kind).toBe('targets');
    if (targets.kind !== 'targets') return;
    expect(targets.files).toEqual(['src/a.ts']);
    expect(targets.discovered).toBe(3);
    expect(targets.skipped).toBe(2);
  });

  it('reports no skips when every changed file is permitted', async () => {
    mockIsPathPermitted.mockReturnValue(true);
    const targets = await run();
    expect(targets.kind).toBe('targets');
    if (targets.kind !== 'targets') return;
    expect(targets.skipped).toBe(0);
  });
});

describe('resolveTriageTargets — a git call that never answered', () => {
  /**
   * `listChangedFiles` re-throws timeout / ENOENT / other failures rather than
   * returning them (`ChangedFilesResult` cannot carry `GitFailure` while this
   * consumer narrows by elimination), so without an explicit catch here they
   * escaped `resolveTriageTargets` as a raw rejection.
   */
  const failWith = (code: string, message: string) =>
    new ExecFailureError({ stdout: '', stderr: '', exit: null, signal: null, code }, message);

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPathPermitted.mockReturnValue(true);
  });

  it('reports a missing git binary as an error result, not a rejection', async () => {
    mockListChangedFiles.mockRejectedValue(failWith('ENOENT', 'Command not found: git'));
    const targets = await run();
    expect(targets.kind).toBe('error');
    if (targets.kind !== 'error') return;
    // The reason is what keeps this apart from "your directory is not a repo".
    expect(targets.message).toContain('(not-installed)');
    expect(targets.message).toContain('Command not found: git');
    expect(targets.message).not.toContain('is not one');
  });

  it('reports a git timeout as a timeout rather than as a broken repository', async () => {
    mockListChangedFiles.mockRejectedValue(
      failWith('TIMEOUT', 'Command timed out after 15000ms: git'),
    );
    const targets = await run();
    expect(targets.kind).toBe('error');
    if (targets.kind !== 'error') return;
    expect(targets.message).toContain('(timeout)');
    expect(targets.message).toContain('timed out');
    // The pre-split behaviour: OUR exhausted budget reported as a factual claim
    // about the caller's workspace.
    expect(targets.message).not.toContain('not a git work tree');
  });

  it('falls back to "other" for a failure with no exec code', async () => {
    mockListChangedFiles.mockRejectedValue(new Error('spawn EAGAIN'));
    const targets = await run();
    expect(targets.kind).toBe('error');
    if (targets.kind !== 'error') return;
    expect(targets.message).toContain('(other)');
    expect(targets.message).toContain('spawn EAGAIN');
  });

  it('re-throws a cancel so the handler reports it as a cancel', async () => {
    // Swallowing an abort into `kind: 'error'` would make the handler's
    // `isCancel` branch unreachable and tell the user git failed because they
    // pressed stop.
    const aborted = failWith('ABORTED', 'Command was cancelled: git');
    mockListChangedFiles.mockRejectedValue(aborted);
    await expect(run()).rejects.toBe(aborted);
  });

  it('re-throws when the request signal is already aborted, whatever the error looks like', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = new Error('git exited with code 128');
    mockListChangedFiles.mockRejectedValue(err);
    await expect(run({ signal: controller.signal })).rejects.toBe(err);
  });
});
