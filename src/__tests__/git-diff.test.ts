import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Only the spawn front-end is stubbed. `ExecFailureError` now lives in
// `exec-error.js` and is imported for real, so `instanceof` narrowing in the
// code under test matches the errors these tests construct.
vi.mock('../utils/exec.js', () => ({
  runShell: vi.fn(),
}));

import { runShell } from '../utils/exec.js';
import { ExecFailureError } from '../utils/exec-error.js';
import { parseHunks, computeChangedRanges, listChangedFiles } from '../utils/git-diff.js';

/**
 * The UNMOCKED spawn front-end, for the fixture-repository suite at the bottom
 * of this file. Everything else drives `runShell` as a stub; those tests need a
 * real `git` because the bug they pin is in git's own output, not in ours.
 */
const realExec = await vi.importActual<typeof import('../utils/exec.js')>('../utils/exec.js');

const mockRunShell = vi.mocked(runShell);
const ok = (stdout = '') => ({ stdout, stderr: '', exit: 0, signal: null });
/** A failed git invocation, built the way `runShell` builds it. */
const fail = (message: string) =>
  new ExecFailureError({ stdout: '', stderr: message, exit: 1, signal: null }, message);
/**
 * A git invocation that never produced an exit code: `runShell` classifies
 * these by `code` ('ABORTED' | 'TIMEOUT' | 'ENOENT') and leaves `exit` null.
 * These are exactly the failures a bare `catch` used to report as "not a repo".
 */
const failWith = (code: string, message: string) =>
  new ExecFailureError({ stdout: '', stderr: '', exit: null, signal: null, code }, message);

describe('parseHunks', () => {
  it('parses a single hunk new-side range', () => {
    expect(parseHunks('@@ -1,2 +3,4 @@\n')).toEqual([{ start: 3, end: 6 }]);
  });

  it('parses multiple disjoint hunks', () => {
    const diff = '@@ -1,0 +1,3 @@\n@@ -10,2 +12,1 @@\n';
    expect(parseHunks(diff)).toEqual([
      { start: 1, end: 3 },
      { start: 12, end: 12 },
    ]);
  });

  it('treats a missing new-count as 1', () => {
    expect(parseHunks('@@ -5,0 +6 @@\n')).toEqual([{ start: 6, end: 6 }]);
  });

  it('skips pure-deletion hunks (new-count 0)', () => {
    expect(parseHunks('@@ -5,3 +4,0 @@\n')).toEqual([]);
  });

  it('ignores trailing section context after the closing @@', () => {
    expect(parseHunks('@@ -1,1 +1,1 @@ function foo() {\n')).toEqual([{ start: 1, end: 1 }]);
  });

  it('returns empty for an empty diff', () => {
    expect(parseHunks('')).toEqual([]);
  });

  it('parses a multi-digit old-side count (kills `,\\d+`→`,\\d`)', () => {
    // The old-side count must accept >1 digit; a single-digit-only mutant fails to
    // match this header entirely and would return [].
    expect(parseHunks('@@ -1,23 +5,2 @@\n')).toEqual([{ start: 5, end: 6 }]);
  });

  it('parses a multi-digit new-side count (kills `,(\\d+)`→`,(\\d)`)', () => {
    expect(parseHunks('@@ -1,1 +5,23 @@\n')).toEqual([{ start: 5, end: 27 }]);
  });

  it('parses a hunk with no old-side count (kills `(?:,\\d+)?`→`(?:,\\d+)`)', () => {
    // Old side `-5` has no `,count`; making that group required breaks the match.
    expect(parseHunks('@@ -5 +10,2 @@\n')).toEqual([{ start: 10, end: 11 }]);
  });

  it('anchors hunk headers to line start (kills removal of `^`)', () => {
    // A `@@ ... @@` sequence mid-line is NOT a real header; the `^` anchor must
    // reject it. Without the anchor this would parse a spurious range.
    expect(parseHunks('+ code with @@ -1,1 +9,1 @@ inside\n')).toEqual([]);
  });
});

describe('computeChangedRanges', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns not-a-repo when rev-parse EXITS non-zero', async () => {
    // A non-zero exit is git answering the question. Every other rejection is
    // covered by the `git-failed` cases below.
    mockRunShell.mockRejectedValueOnce(fail('not a repo'));
    expect(await computeChangedRanges('a.ts', '/w', 'HEAD')).toEqual({ kind: 'not-a-repo' });
  });

  /**
   * `runShell` rejects for four unrelated reasons and the work-tree probe used
   * to collapse all of them into `not-a-repo`, so an exhausted time budget or a
   * missing git binary was reported to the user as
   * `"<dir>" is not a git work tree` — a false claim about their repository
   * that sent them looking in entirely the wrong place.
   */
  it('reports a timed-out work-tree probe as git-failed, not as not-a-repo', async () => {
    mockRunShell.mockRejectedValueOnce(failWith('TIMEOUT', 'Command timed out after 1ms: git'));
    expect(await computeChangedRanges('a.ts', '/w', 'HEAD')).toEqual({
      kind: 'git-failed',
      reason: 'timeout',
      message: 'Command timed out after 1ms: git',
    });
  });

  it('reports a missing git binary as git-failed/not-installed', async () => {
    mockRunShell.mockRejectedValueOnce(failWith('ENOENT', 'Command not found: git'));
    expect(await computeChangedRanges('a.ts', '/w', 'HEAD')).toEqual({
      kind: 'git-failed',
      reason: 'not-installed',
      message: 'Command not found: git',
    });
  });

  it('reports an unattributable git failure as git-failed/other', async () => {
    // No exit code and no recognised errno — e.g. killed by an external signal.
    mockRunShell.mockRejectedValueOnce(new Error('spawn blew up'));
    expect(await computeChangedRanges('a.ts', '/w', 'HEAD')).toEqual({
      kind: 'git-failed',
      reason: 'other',
      message: 'spawn blew up',
    });
  });

  it('does not read a SIGNAL death as evidence about the repository', async () => {
    // The case above throws a bare Error, which never enters the
    // `instanceof ExecFailureError` block at all — so it cannot exercise the
    // `exit !== null` test inside it. This one does: a real ExecFailureError,
    // an unrecognised code, and NO exit status, which is what an externally
    // killed git leaves behind. Treating that as an "exit" hands the caller a
    // `{ kind: 'exit', exit: null }` that the work-tree probe reads as a
    // non-zero exit — and tells a user whose git was killed that their
    // directory is not a git repository.
    mockRunShell.mockRejectedValueOnce(failWith('SIGKILL', 'git was killed by a signal'));

    expect(await computeChangedRanges('a.ts', '/w', 'HEAD')).toEqual({
      kind: 'git-failed',
      reason: 'other',
      message: 'git was killed by a signal',
    });
  });

  /**
   * Cancellation must ESCAPE rather than become a result kind. Every cancel
   * path in this codebase funnels through `isCancel` so the handlers report the
   * single string 'Operation cancelled.'; swallowing the abort here made those
   * branches unreachable and told a user who pressed stop that their repository
   * was not a git work tree.
   */
  it('re-throws a cancellation from the work-tree probe instead of classifying it', async () => {
    const aborted = failWith('ABORTED', 'Command was cancelled: git');
    mockRunShell.mockRejectedValueOnce(aborted);
    await expect(computeChangedRanges('a.ts', '/w', 'HEAD')).rejects.toBe(aborted);
  });

  it('re-throws a cancellation from the tracked-file probe instead of returning untracked', async () => {
    const aborted = failWith('ABORTED', 'Command was cancelled: git');
    mockRunShell.mockResolvedValueOnce(ok('true\n')).mockRejectedValueOnce(aborted);
    await expect(computeChangedRanges('a.ts', '/w', 'HEAD')).rejects.toBe(aborted);
  });

  it('re-throws a cancellation from merge-base instead of returning bad-ref', async () => {
    const aborted = failWith('ABORTED', 'Command was cancelled: git');
    mockRunShell
      .mockResolvedValueOnce(ok('true\n'))
      .mockResolvedValueOnce(ok('a.ts\n'))
      .mockRejectedValueOnce(aborted);
    await expect(computeChangedRanges('a.ts', '/w', 'main')).rejects.toBe(aborted);
  });

  it('re-throws a cancellation from the diff itself instead of returning bad-ref', async () => {
    const aborted = failWith('ABORTED', 'Command was cancelled: git');
    mockRunShell
      .mockResolvedValueOnce(ok('true\n'))
      .mockResolvedValueOnce(ok('a.ts\n'))
      .mockResolvedValueOnce(ok('abc123\n'))
      .mockRejectedValueOnce(aborted);
    await expect(computeChangedRanges('a.ts', '/w', 'main')).rejects.toBe(aborted);
  });

  it('returns untracked when ls-files fails', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // rev-parse
      .mockRejectedValueOnce(fail('not tracked')); // ls-files
    expect(await computeChangedRanges('a.ts', '/w', 'HEAD')).toEqual({ kind: 'untracked' });
  });

  it('returns bad-ref when merge-base fails', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // rev-parse
      .mockResolvedValueOnce(ok('a.ts\n')) // ls-files
      .mockRejectedValueOnce(fail('unknown ref')); // merge-base
    expect(await computeChangedRanges('a.ts', '/w', 'nope')).toEqual({
      kind: 'bad-ref',
      ref: 'nope',
    });
  });

  it('returns no-changes for an empty diff', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // rev-parse
      .mockResolvedValueOnce(ok('a.ts\n')) // ls-files
      .mockResolvedValueOnce(ok('abc123\n')) // merge-base
      .mockResolvedValueOnce(ok('')); // diff
    expect(await computeChangedRanges('a.ts', '/w', 'HEAD')).toEqual({ kind: 'no-changes' });
  });

  it('returns ranges parsed from the diff (ref path → merge-base + diff)', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n'))
      .mockResolvedValueOnce(ok('a.ts\n'))
      .mockResolvedValueOnce(ok('abc123\n'))
      .mockResolvedValueOnce(ok('@@ -1,0 +3,2 @@\n@@ -9,1 +20,1 @@\n'));
    expect(await computeChangedRanges('a.ts', '/w', 'main')).toEqual({
      kind: 'ranges',
      ranges: [
        { start: 3, end: 4 },
        { start: 20, end: 20 },
      ],
    });
  });

  it('uses --cached for the staged base (no merge-base call)', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // rev-parse
      .mockResolvedValueOnce(ok('a.ts\n')) // ls-files
      .mockResolvedValueOnce(ok('@@ -1,1 +1,1 @@\n')); // diff --cached
    const res = await computeChangedRanges('a.ts', '/w', 'staged');
    expect(res).toEqual({ kind: 'ranges', ranges: [{ start: 1, end: 1 }] });
    const diffCall = mockRunShell.mock.calls[2];
    expect(diffCall[1]).toEqual(['diff', '--cached', '-U0', '--', 'a.ts']);
  });

  it('calls runShell with "git" as the command and correct workspace options on every call', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // rev-parse
      .mockResolvedValueOnce(ok('a.ts\n')) // ls-files
      .mockResolvedValueOnce(ok('abc123\n')) // merge-base
      .mockResolvedValueOnce(ok('')); // diff
    await computeChangedRanges('a.ts', '/workspace', 'HEAD');
    expect(mockRunShell).toHaveBeenCalledTimes(4);
    for (const call of mockRunShell.mock.calls) {
      expect(call[0]).toBe('git');
      expect(call[2]).toMatchObject({ cwd: '/workspace', timeoutMs: 15_000 });
    }
  });

  it('clamps a caller-supplied timeout instead of ignoring or inverting it', async () => {
    // These git calls run BEFORE the sandbox exists, so `timeoutMs` is how the
    // caller charges them against whatever is left of the audit budget.
    // Ignoring the option (always GIT_TIMEOUT_MS) or clamping the wrong way
    // round (Math.max instead of Math.min) both hand git more time than the
    // caller has left.
    mockRunShell
      .mockResolvedValueOnce(ok('true\n'))
      .mockResolvedValueOnce(ok('a.ts\n'))
      .mockResolvedValueOnce(ok('abc123\n'))
      .mockResolvedValueOnce(ok(''));
    await computeChangedRanges('a.ts', '/workspace', 'HEAD', { timeoutMs: 5_000 });
    for (const call of mockRunShell.mock.calls) {
      expect(call[2]).toMatchObject({ timeoutMs: 5_000 });
    }
  });

  it('never lets a caller raise the timeout above the built-in ceiling', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n'))
      .mockResolvedValueOnce(ok('a.ts\n'))
      .mockResolvedValueOnce(ok('abc123\n'))
      .mockResolvedValueOnce(ok(''));
    await computeChangedRanges('a.ts', '/workspace', 'HEAD', { timeoutMs: 60_000 });
    for (const call of mockRunShell.mock.calls) {
      expect(call[2]).toMatchObject({ timeoutMs: 15_000 });
    }
  });

  it('floors an exhausted budget at 1ms rather than passing through 0', async () => {
    // Node reads a zero or negative timeout as "no timeout at all", so a spent
    // budget would silently become unbounded — the exact opposite of the intent.
    mockRunShell.mockResolvedValueOnce(ok('true\n')).mockResolvedValueOnce(ok(''));
    await computeChangedRanges('a.ts', '/workspace', 'HEAD', { timeoutMs: 0 });
    expect(mockRunShell.mock.calls[0][2]).toMatchObject({ timeoutMs: 1 });
  });

  it('kills the whole git process tree on timeout or cancel', async () => {
    // git shells out to pagers and helpers; killing only the direct child
    // leaves them holding the pipe and the call never settles.
    mockRunShell.mockResolvedValueOnce(ok('true\n')).mockResolvedValueOnce(ok(''));
    await computeChangedRanges('a.ts', '/workspace', 'HEAD');
    expect(mockRunShell.mock.calls[0][2]).toMatchObject({ killTree: true });
  });

  it('calls rev-parse and ls-files with the correct args', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // rev-parse
      .mockResolvedValueOnce(ok('a.ts\n')) // ls-files
      .mockResolvedValueOnce(ok('abc123\n')) // merge-base
      .mockResolvedValueOnce(ok('')); // diff
    await computeChangedRanges('a.ts', '/workspace', 'HEAD');
    expect(mockRunShell.mock.calls[0][1]).toEqual(['rev-parse', '--is-inside-work-tree']);
    expect(mockRunShell.mock.calls[1][1]).toEqual(['ls-files', '--error-unmatch', '--', 'a.ts']);
  });

  it('trims trailing whitespace from the merge-base SHA before using it in the diff command', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // rev-parse
      .mockResolvedValueOnce(ok('a.ts\n')) // ls-files
      .mockResolvedValueOnce(ok('abc123\n')) // merge-base returns SHA with trailing newline
      .mockResolvedValueOnce(ok('')); // diff
    await computeChangedRanges('a.ts', '/w', 'main');
    // The diff command must use the trimmed SHA (no trailing newline).
    expect(mockRunShell.mock.calls[3][1]).toEqual(['diff', '-U0', 'abc123', '--', 'a.ts']);
  });

  it('calls merge-base with diffBase and HEAD when base is not "staged"', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // rev-parse
      .mockResolvedValueOnce(ok('a.ts\n')) // ls-files
      .mockResolvedValueOnce(ok('abc123\n')) // merge-base
      .mockResolvedValueOnce(ok('')); // diff
    await computeChangedRanges('a.ts', '/w', 'main');
    expect(mockRunShell.mock.calls[2][1]).toEqual(['merge-base', 'main', 'HEAD']);
  });

  it('does not call the diff command when merge-base fails', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // rev-parse
      .mockResolvedValueOnce(ok('a.ts\n')) // ls-files
      .mockRejectedValueOnce(fail('unknown ref')); // merge-base
    await computeChangedRanges('a.ts', '/w', 'nope');
    // Only 3 calls: rev-parse, ls-files, merge-base. The diff must NOT be called.
    expect(mockRunShell).toHaveBeenCalledTimes(3);
  });

  it('returns bad-ref when the diff command itself fails', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // rev-parse
      .mockResolvedValueOnce(ok('a.ts\n')) // ls-files
      .mockResolvedValueOnce(ok('abc123\n')) // merge-base
      .mockRejectedValueOnce(fail('diff failed')); // diff throws
    expect(await computeChangedRanges('a.ts', '/w', 'HEAD')).toEqual({
      kind: 'bad-ref',
      ref: 'HEAD',
    });
  });

  it('reports a timed-out ls-files as git-failed, not as an untracked file', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // rev-parse
      .mockRejectedValueOnce(failWith('TIMEOUT', 'Command timed out after 15000ms: git'));

    const result = await computeChangedRanges('src/a.ts', '/ws', 'HEAD');

    expect(result).toMatchObject({ kind: 'git-failed', reason: 'timeout' });
  });

  it('reports a timed-out merge-base as git-failed, not as a bad ref', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // rev-parse
      .mockResolvedValueOnce(ok('a.ts\n')) // ls-files
      .mockRejectedValueOnce(failWith('TIMEOUT', 'Command timed out after 15000ms: git'));

    const result = await computeChangedRanges('src/a.ts', '/ws', 'main');

    expect(result).toMatchObject({ kind: 'git-failed', reason: 'timeout' });
  });

  it('reports a missing git binary during diff as git-failed, not as a bad ref', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // rev-parse
      .mockResolvedValueOnce(ok('a.ts\n')) // ls-files
      .mockResolvedValueOnce(ok('abc123\n')) // merge-base
      .mockRejectedValueOnce(failWith('ENOENT', 'Command not found: git'));

    const result = await computeChangedRanges('src/a.ts', '/ws', 'main');

    expect(result).toMatchObject({ kind: 'git-failed', reason: 'not-installed' });
  });

  it('still reports a genuinely unresolvable ref as a bad ref', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n'))
      .mockResolvedValueOnce(ok('a.ts\n'))
      .mockRejectedValueOnce(fail('fatal: Not a valid object name nope'));

    expect(await computeChangedRanges('src/a.ts', '/ws', 'nope')).toEqual({
      kind: 'bad-ref',
      ref: 'nope',
    });
  });

  it('still reports a genuinely untracked file as untracked', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n'))
      .mockRejectedValueOnce(fail('did not match any file(s) known to git'));

    expect(await computeChangedRanges('src/a.ts', '/ws', 'HEAD')).toEqual({ kind: 'untracked' });
  });

  it('reports a FATAL ls-files exit as git-failed, not as an untracked file', async () => {
    // `ls-files --error-unmatch` documents exit 1 for "the path did not match".
    // 128 is git's own fatal status — an unreadable or locked index, a pathspec
    // that resolves outside the repository, a work tree that vanished since the
    // probe above — and proves nothing about the file. Treating every non-zero
    // exit as "untracked" turned those into a WHOLE-FILE mutation run, which is
    // both the most expensive answer available and a false claim about the
    // caller's repository: the same defect class this module was rewritten to
    // remove, surviving in the one branch that reads the exit code loosely.
    mockRunShell
      .mockResolvedValueOnce(ok('true\n'))
      .mockRejectedValueOnce(
        new ExecFailureError(
          { stdout: '', stderr: 'fatal: index file corrupt', exit: 128, signal: null },
          'fatal: index file corrupt',
        ),
      );

    const result = await computeChangedRanges('src/a.ts', '/ws', 'HEAD');

    expect(result).toMatchObject({ kind: 'git-failed', reason: 'other' });
    expect(result).not.toMatchObject({ kind: 'untracked' });
  });
});

describe('listChangedFiles', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns not-a-repo when the work-tree check EXITS non-zero', async () => {
    mockRunShell.mockRejectedValueOnce(fail('not a git repo'));
    const r = await listChangedFiles('/ws', 'main');
    expect(r).toEqual({ kind: 'not-a-repo' });
  });

  /**
   * `ChangedFilesResult` has no `git-failed` variant (adding one would not
   * type-check in `resolveTriageTargets`, which narrows by elimination), so a
   * failure that is NOT evidence about the repository escapes with git's own
   * error instead of being laundered into "not a git work tree".
   */
  it('re-throws a timed-out work-tree probe rather than reporting not-a-repo', async () => {
    const timedOut = failWith('TIMEOUT', 'Command timed out after 1ms: git');
    mockRunShell.mockRejectedValueOnce(timedOut);
    await expect(listChangedFiles('/ws', 'main')).rejects.toBe(timedOut);
  });

  it('re-throws a missing git binary rather than reporting not-a-repo', async () => {
    const missing = failWith('ENOENT', 'Command not found: git');
    mockRunShell.mockRejectedValueOnce(missing);
    await expect(listChangedFiles('/ws', 'main')).rejects.toBe(missing);
  });

  it('re-throws a cancellation from the work-tree probe', async () => {
    const aborted = failWith('ABORTED', 'Command was cancelled: git');
    mockRunShell.mockRejectedValueOnce(aborted);
    await expect(listChangedFiles('/ws', 'main')).rejects.toBe(aborted);
  });

  it('re-throws a cancellation from merge-base instead of returning bad-ref', async () => {
    const aborted = failWith('ABORTED', 'Command was cancelled: git');
    mockRunShell.mockResolvedValueOnce(ok('true\n')).mockRejectedValueOnce(aborted);
    await expect(listChangedFiles('/ws', 'main')).rejects.toBe(aborted);
  });

  /**
   * Untracked discovery is otherwise best-effort, but a CANCELLED `ls-files`
   * would silently hand back the tracked half of an abandoned sweep as if it
   * were the complete answer.
   */
  it('re-throws a cancellation from the untracked probe instead of returning a partial list', async () => {
    const aborted = failWith('ABORTED', 'Command was cancelled: git');
    mockRunShell
      .mockResolvedValueOnce(ok('true\n'))
      .mockResolvedValueOnce(ok('abc123\n'))
      .mockResolvedValueOnce(ok('src/a.ts\n'))
      .mockRejectedValueOnce(aborted);
    await expect(listChangedFiles('/ws', 'main')).rejects.toBe(aborted);
  });

  /**
   * The third of the three cancellable calls in this function, and the only one
   * whose catch turns a failure into `bad-ref`. Swallowing a cancel there tells
   * a user who pressed stop that the ref they named is unusable — and, worse,
   * hands the sweep a normal-looking result for a run that was abandoned.
   */
  it('re-throws a cancellation from the name-only diff instead of returning bad-ref', async () => {
    const aborted = failWith('ABORTED', 'Command was cancelled: git');
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // rev-parse work-tree
      .mockResolvedValueOnce(ok('abc123\n')) // merge-base
      .mockRejectedValueOnce(aborted); // diff --name-only
    await expect(listChangedFiles('/ws', 'main')).rejects.toBe(aborted);
  });

  it('returns bad-ref when merge-base fails', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // rev-parse work-tree
      .mockRejectedValueOnce(new Error('bad ref')); // merge-base
    const r = await listChangedFiles('/ws', 'nope');
    expect(r).toEqual({ kind: 'bad-ref', ref: 'nope' });
  });

  it('unions tracked-changed and untracked, deduped', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // work-tree
      .mockResolvedValueOnce(ok('abc123\n')) // merge-base
      .mockResolvedValueOnce(ok('src/a.ts\nsrc/b.ts\n')) // diff --name-only
      .mockResolvedValueOnce(ok('src/b.ts\nsrc/c.ts\n')); // ls-files --others
    const r = await listChangedFiles('/ws', 'main');
    expect(r).toEqual({ kind: 'files', files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] });
  });

  it('uses --cached for staged', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // work-tree
      .mockResolvedValueOnce(ok('src/a.ts\n')) // diff --cached --name-only
      .mockResolvedValueOnce(ok('')); // ls-files --others
    const r = await listChangedFiles('/ws', 'staged');
    expect(r).toEqual({ kind: 'files', files: ['src/a.ts'] });
    // assert no merge-base call happened
    const calls = mockRunShell.mock.calls.map((c) => c[1].join(' '));
    expect(calls.some((c) => c.includes('merge-base'))).toBe(false);
  });

  /**
   * Git writes one path per line, and a checkout with CRLF endings leaves a
   * `\r` on each. Untrimmed, `src/a.ts\r` reaches the engines as a path that
   * does not exist, so the file is silently dropped from the audit.
   */
  it('trims carriage returns and stray whitespace off each path', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // work-tree
      .mockResolvedValueOnce(ok('abc123\n')) // merge-base
      .mockResolvedValueOnce(ok('src/a.ts\r\n  src/b.ts  \n')) // diff --name-only
      .mockResolvedValueOnce(ok('src/c.ts\r\n')); // ls-files --others

    const r = await listChangedFiles('/ws', 'main');

    expect(r).toEqual({ kind: 'files', files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] });
  });

  /**
   * The list is the work-order for a triage run. Leaving it in git's order
   * makes the same working tree audit its files in a different sequence
   * depending on which git command reported them, so a truncated run
   * (`maxFiles`) covers a different set each time.
   */
  it('returns the paths sorted, not in the order git reported them', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // work-tree
      .mockResolvedValueOnce(ok('abc123\n')) // merge-base
      .mockResolvedValueOnce(ok('src/z.ts\nsrc/m.ts\n')) // diff --name-only
      .mockResolvedValueOnce(ok('src/a.ts\n')); // ls-files --others

    const r = await listChangedFiles('/ws', 'main');

    expect(r).toEqual({ kind: 'files', files: ['src/a.ts', 'src/m.ts', 'src/z.ts'] });
  });

  /**
   * Untracked discovery is best-effort: when `ls-files` fails the tracked
   * changes still stand. What must not happen is the failed command's state
   * leaking into the result as a phantom path.
   */
  it('keeps the tracked changes when untracked discovery fails', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // work-tree
      .mockResolvedValueOnce(ok('abc123\n')) // merge-base
      .mockResolvedValueOnce(ok('src/a.ts\n')) // diff --name-only
      .mockRejectedValueOnce(fail('ls-files exploded')); // ls-files --others

    const r = await listChangedFiles('/ws', 'main');

    expect(r).toEqual({ kind: 'files', files: ['src/a.ts'] });
  });

  it('runs every git call as "git" in the workspace with the read-only timeout', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // work-tree
      .mockResolvedValueOnce(ok('abc123\n')) // merge-base
      .mockResolvedValueOnce(ok('src/a.ts\n')) // diff --name-only
      .mockResolvedValueOnce(ok('')); // ls-files --others
    await listChangedFiles('/workspace', 'main');
    for (const call of mockRunShell.mock.calls) {
      expect(call[0]).toBe('git');
      expect(call[2]).toMatchObject({ cwd: '/workspace', timeoutMs: 15_000 });
    }
  });

  it('calls rev-parse, merge-base, diff --name-only and ls-files --others with exact args', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // work-tree
      .mockResolvedValueOnce(ok('abc123\n')) // merge-base (trailing newline trimmed)
      .mockResolvedValueOnce(ok('src/a.ts\n')) // diff --name-only
      .mockResolvedValueOnce(ok('')); // ls-files --others
    await listChangedFiles('/ws', 'main');
    expect(mockRunShell.mock.calls[0][1]).toEqual(['rev-parse', '--is-inside-work-tree']);
    expect(mockRunShell.mock.calls[1][1]).toEqual(['merge-base', 'main', 'HEAD']);
    // The diff command must use the TRIMMED merge-base SHA, and both of these
    // flags are load-bearing: `--relative` puts the tracked half of the union in
    // the SAME base as `ls-files --others` (cwd-relative), and `--diff-filter=d`
    // keeps files deleted since the base out of the sweep.
    expect(mockRunShell.mock.calls[2][1]).toEqual([
      'diff',
      '--relative',
      '--diff-filter=d',
      '--name-only',
      'abc123',
    ]);
    expect(mockRunShell.mock.calls[3][1]).toEqual(['ls-files', '--others', '--exclude-standard']);
  });

  it('uses exact --cached --name-only args for the staged base', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // work-tree
      .mockResolvedValueOnce(ok('src/a.ts\n')) // diff --cached --name-only
      .mockResolvedValueOnce(ok('')); // ls-files --others
    await listChangedFiles('/ws', 'staged');
    // The staged form carries the same two flags; `--cached` composes with both.
    expect(mockRunShell.mock.calls[1][1]).toEqual([
      'diff',
      '--cached',
      '--relative',
      '--diff-filter=d',
      '--name-only',
    ]);
  });

  it('does not run the diff command when merge-base fails', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // work-tree
      .mockRejectedValueOnce(fail('bad ref')); // merge-base
    const r = await listChangedFiles('/ws', 'nope');
    expect(r).toEqual({ kind: 'bad-ref', ref: 'nope' });
    // Only rev-parse + merge-base — the catch must return, not fall through.
    expect(mockRunShell).toHaveBeenCalledTimes(2);
  });

  it('returns bad-ref when the name-only diff itself fails', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // work-tree
      .mockResolvedValueOnce(ok('abc123\n')) // merge-base
      .mockRejectedValueOnce(fail('diff failed')); // diff --name-only
    expect(await listChangedFiles('/ws', 'main')).toEqual({ kind: 'bad-ref', ref: 'main' });
  });

  it('tolerates a failing untracked-files probe (returns tracked changes only)', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // work-tree
      .mockResolvedValueOnce(ok('abc123\n')) // merge-base
      .mockResolvedValueOnce(ok('src/a.ts\nsrc/b.ts\n')) // diff --name-only
      .mockRejectedValueOnce(fail('ls-files blew up')); // ls-files --others
    const r = await listChangedFiles('/ws', 'main');
    expect(r).toEqual({ kind: 'files', files: ['src/a.ts', 'src/b.ts'] });
  });
});

/**
 * Real-git regression fixtures.
 *
 * Every test above stubs `runShell`, so they pin the argv we send but say
 * nothing about the paths git sends back — and the bug this suite exists for
 * lives entirely in that return value. It is also invisible from a repository
 * ROOT, which is the only place the mocked tests ever pretended to run: there,
 * `diff --name-only` (repository-root-relative) and `ls-files --others`
 * (cwd-relative) happen to agree. Anchor the workspace ONE directory down — the
 * monorepo layout `anchorToWorkspace` exists to serve — and the two halves of
 * the union arrive in different bases. That is why a green suite missed it.
 *
 * So these drive the REAL `runShell` against a repository built on disk.
 */
describe('listChangedFiles against a real repository', () => {
  let repoRoot: string;
  let pkg: string;

  /** Run git synchronously for fixture setup (never through the code under test). */
  const setupGit = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });

  beforeEach(() => {
    mockRunShell.mockImplementation(realExec.runShell);
    // realpath: on macOS `tmpdir()` is a symlink, and git reports the resolved
    // path, which would make the assertions below compare two different strings.
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'chaos-git-diff-'));
    pkg = join(repoRoot, 'pkg');
    mkdirSync(join(pkg, 'src'), { recursive: true });

    setupGit(['init', '-q', '-b', 'main', '.'], repoRoot);
    setupGit(['config', 'user.email', 'test@example.com'], repoRoot);
    setupGit(['config', 'user.name', 'Chaos Test'], repoRoot);
    setupGit(['config', 'commit.gpgsign', 'false'], repoRoot);

    writeFileSync(join(pkg, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(pkg, 'src', 'gone.ts'), 'export const gone = 1;\n');
    // Tracked, but ABOVE the workspace root the sweep is anchored to.
    writeFileSync(join(repoRoot, 'outside.ts'), 'export const o = 1;\n');
    setupGit(['add', '-A'], repoRoot);
    setupGit(['commit', '-qm', 'init'], repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /**
   * The headline bug: callers resolve every entry with `resolve(rootCwd, file)`
   * (triage/discover-targets.ts, triage/audit-one.ts). Without `--relative` the
   * tracked half came back as `pkg/src/a.ts` and resolved to
   * `<repo>/pkg/pkg/src/a.ts`, which does not exist — every tracked change
   * became a "Sandbox provisioning failed" row while the untracked half worked,
   * so the sweep half-succeeded and read as a flaky engine rather than a bug.
   */
  it('reports tracked and untracked paths in the SAME base when the workspace is a subdirectory', async () => {
    writeFileSync(join(pkg, 'src', 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(pkg, 'src', 'new.ts'), 'export const n = 1;\n');

    const r = await listChangedFiles(pkg, 'HEAD');

    expect(r).toEqual({ kind: 'files', files: ['src/a.ts', 'src/new.ts'] });
    // The contract callers actually depend on: resolving against the workspace
    // root must land on a file that exists.
    for (const file of (r as { files: string[] }).files) {
      expect(existsSync(resolve(pkg, file))).toBe(true);
    }
  });

  /**
   * `--relative` also drops changes above the workspace root. That is correct
   * and deliberate: they are outside the sweep's boundary and the realpath
   * check in `resolveTriageTargets` would reject them anyway — but only after
   * they had been resolved into a path that escapes the workspace.
   */
  it('excludes changed files above the workspace root', async () => {
    writeFileSync(join(repoRoot, 'outside.ts'), 'export const o = 2;\n');
    writeFileSync(join(pkg, 'src', 'a.ts'), 'export const a = 2;\n');

    const r = await listChangedFiles(pkg, 'HEAD');

    expect(r).toEqual({ kind: 'files', files: ['src/a.ts'] });
  });

  /**
   * A path deleted since the base is still "changed" to `--name-only`. It
   * passed the extension filter and the boundary check, then failed deep in
   * `createSandbox` with "target file … was not found", inflating
   * `filesErrored` with files that legitimately no longer exist.
   */
  it('omits files deleted since the diff base', async () => {
    setupGit(['rm', '-q', 'src/gone.ts'], pkg);
    writeFileSync(join(pkg, 'src', 'a.ts'), 'export const a = 2;\n');

    const r = await listChangedFiles(pkg, 'HEAD');

    expect(r).toEqual({ kind: 'files', files: ['src/a.ts'] });
  });

  /** Both flags have to compose with the `--cached` (staged) form too. */
  it('applies the relative base and the deletion filter to the staged base', async () => {
    writeFileSync(join(pkg, 'src', 'a.ts'), 'export const a = 2;\n');
    setupGit(['add', 'src/a.ts'], pkg);
    setupGit(['rm', '-q', 'src/gone.ts'], pkg); // stages a deletion

    const r = await listChangedFiles(pkg, 'staged');

    expect(r).toEqual({ kind: 'files', files: ['src/a.ts'] });
  });

  /** Sanity: from the repository root the two bases coincide, as they always did. */
  it('still reports workspace-relative paths when the workspace IS the repository root', async () => {
    writeFileSync(join(pkg, 'src', 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(repoRoot, 'untracked.ts'), 'export const u = 1;\n');

    const r = await listChangedFiles(repoRoot, 'HEAD');

    expect(r).toEqual({ kind: 'files', files: ['pkg/src/a.ts', 'untracked.ts'] });
  });

  it('returns not-a-repo for a directory that genuinely is not a work tree', async () => {
    const plain = mkdtempSync(join(realpathSync(tmpdir()), 'chaos-not-git-'));
    try {
      expect(await listChangedFiles(plain, 'HEAD')).toEqual({ kind: 'not-a-repo' });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  /**
   * `computeChangedRanges` is NOT affected by the base mismatch and must not
   * grow `--relative`: its pathspec after `--` is already cwd-relative, and the
   * only thing it reads back is the `@@` hunk headers. This pins that it still
   * finds the changed lines of a file inside a subdirectory workspace.
   */
  it('computeChangedRanges still resolves ranges from a subdirectory workspace', async () => {
    writeFileSync(join(pkg, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');

    const r = await computeChangedRanges('src/a.ts', pkg, 'HEAD');

    expect(r).toEqual({ kind: 'ranges', ranges: [{ start: 2, end: 2 }] });
  });
});
