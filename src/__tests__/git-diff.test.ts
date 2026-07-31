import { describe, it, expect, vi, beforeEach } from 'vitest';

// Only the spawn front-end is stubbed. `ExecFailureError` now lives in
// `exec-error.js` and is imported for real, so `instanceof` narrowing in the
// code under test matches the errors these tests construct.
vi.mock('../utils/exec.js', () => ({
  runShell: vi.fn(),
}));

import { runShell } from '../utils/exec.js';
import { ExecFailureError } from '../utils/exec-error.js';
import { parseHunks, computeChangedRanges, listChangedFiles } from '../utils/git-diff.js';

const mockRunShell = vi.mocked(runShell);
const ok = (stdout = '') => ({ stdout, stderr: '', exit: 0, signal: null });
/** A failed git invocation, built the way `runShell` builds it. */
const fail = (message: string) =>
  new ExecFailureError({ stdout: '', stderr: message, exit: 1, signal: null }, message);

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

  it('returns not-a-repo when rev-parse fails', async () => {
    mockRunShell.mockRejectedValueOnce(fail('not a repo'));
    expect(await computeChangedRanges('a.ts', '/w', 'HEAD')).toEqual({ kind: 'not-a-repo' });
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
});

describe('listChangedFiles', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns not-a-repo when the work-tree check fails', async () => {
    mockRunShell.mockRejectedValueOnce(new Error('not a git repo'));
    const r = await listChangedFiles('/ws', 'main');
    expect(r).toEqual({ kind: 'not-a-repo' });
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
    // The diff command must use the TRIMMED merge-base SHA.
    expect(mockRunShell.mock.calls[2][1]).toEqual(['diff', '--name-only', 'abc123']);
    expect(mockRunShell.mock.calls[3][1]).toEqual(['ls-files', '--others', '--exclude-standard']);
  });

  it('uses exact --cached --name-only args for the staged base', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // work-tree
      .mockResolvedValueOnce(ok('src/a.ts\n')) // diff --cached --name-only
      .mockResolvedValueOnce(ok('')); // ls-files --others
    await listChangedFiles('/ws', 'staged');
    expect(mockRunShell.mock.calls[1][1]).toEqual(['diff', '--cached', '--name-only']);
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
