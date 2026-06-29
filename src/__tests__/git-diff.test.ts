import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/exec.js', () => ({
  runShell: vi.fn(),
  ExecFailureError: class ExecFailureError extends Error {},
}));

import { runShell, ExecFailureError } from '../utils/exec.js';
import { parseHunks, computeChangedRanges, listChangedFiles } from '../utils/git-diff.js';

const mockRunShell = vi.mocked(runShell);
const ok = (stdout = '') => ({ stdout, stderr: '', exit: 0, signal: null });

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
    mockRunShell.mockRejectedValueOnce(new ExecFailureError('not a repo'));
    expect(await computeChangedRanges('a.ts', '/w', 'HEAD')).toEqual({ kind: 'not-a-repo' });
  });

  it('returns untracked when ls-files fails', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // rev-parse
      .mockRejectedValueOnce(new ExecFailureError('not tracked')); // ls-files
    expect(await computeChangedRanges('a.ts', '/w', 'HEAD')).toEqual({ kind: 'untracked' });
  });

  it('returns bad-ref when merge-base fails', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // rev-parse
      .mockResolvedValueOnce(ok('a.ts\n')) // ls-files
      .mockRejectedValueOnce(new ExecFailureError('unknown ref')); // merge-base
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
      .mockRejectedValueOnce(new ExecFailureError('unknown ref')); // merge-base
    await computeChangedRanges('a.ts', '/w', 'nope');
    // Only 3 calls: rev-parse, ls-files, merge-base. The diff must NOT be called.
    expect(mockRunShell).toHaveBeenCalledTimes(3);
  });

  it('returns bad-ref when the diff command itself fails', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // rev-parse
      .mockResolvedValueOnce(ok('a.ts\n')) // ls-files
      .mockResolvedValueOnce(ok('abc123\n')) // merge-base
      .mockRejectedValueOnce(new ExecFailureError('diff failed')); // diff throws
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
      .mockRejectedValueOnce(new ExecFailureError('bad ref')); // merge-base
    const r = await listChangedFiles('/ws', 'nope');
    expect(r).toEqual({ kind: 'bad-ref', ref: 'nope' });
    // Only rev-parse + merge-base — the catch must return, not fall through.
    expect(mockRunShell).toHaveBeenCalledTimes(2);
  });

  it('returns bad-ref when the name-only diff itself fails', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // work-tree
      .mockResolvedValueOnce(ok('abc123\n')) // merge-base
      .mockRejectedValueOnce(new ExecFailureError('diff failed')); // diff --name-only
    expect(await listChangedFiles('/ws', 'main')).toEqual({ kind: 'bad-ref', ref: 'main' });
  });

  it('tolerates a failing untracked-files probe (returns tracked changes only)', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok('true\n')) // work-tree
      .mockResolvedValueOnce(ok('abc123\n')) // merge-base
      .mockResolvedValueOnce(ok('src/a.ts\nsrc/b.ts\n')) // diff --name-only
      .mockRejectedValueOnce(new ExecFailureError('ls-files blew up')); // ls-files --others
    const r = await listChangedFiles('/ws', 'main');
    expect(r).toEqual({ kind: 'files', files: ['src/a.ts', 'src/b.ts'] });
  });
});
