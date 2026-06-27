import { runShell } from './exec.js';

/** A 1-based inclusive line range. */
export interface LineRange {
  start: number;
  end: number;
}

/** Classification of a target file's change status against a diff base. */
export type DiffResult =
  | { kind: 'ranges'; ranges: LineRange[] } // tracked file with ≥1 changed hunk
  | { kind: 'no-changes' } // tracked file, identical to base
  | { kind: 'untracked' } // file not known to git → whole file is "new"
  | { kind: 'not-a-repo' } // workspace is not a git work tree
  | { kind: 'bad-ref'; ref: string }; // diffBase could not be resolved

/** Read-only git calls get a tight timeout — they should be near-instant. */
const GIT_TIMEOUT_MS = 15_000;

/**
 * Parse unified-diff hunk headers (`@@ -a,b +c,d @@`) into NEW-side line ranges.
 * We mutate current file content, so the new side (`+c,d`) is what matters.
 * A hunk whose new-count is 0 (pure deletion) contributes no mutable lines.
 */
export function parseHunks(diff: string): LineRange[] {
  const ranges: LineRange[] = [];
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff)) !== null) {
    const start = parseInt(m[1], 10);
    const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
    if (count === 0) continue;
    ranges.push({ start, end: start + count - 1 });
  }
  return ranges;
}

/**
 * Determine which lines of `relFilePath` changed versus `diffBase`, running
 * read-only git in `workspaceRoot`. Never throws for expected conditions —
 * returns a classified {@link DiffResult} instead.
 */
export async function computeChangedRanges(
  relFilePath: string,
  workspaceRoot: string,
  diffBase: string,
): Promise<DiffResult> {
  const git = (args: string[]) =>
    runShell('git', args, { cwd: workspaceRoot, timeoutMs: GIT_TIMEOUT_MS });

  // 1. Must be a git work tree.
  try {
    await git(['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { kind: 'not-a-repo' };
  }

  // 2. Untracked / unknown file → the whole file is "new".
  try {
    await git(['ls-files', '--error-unmatch', '--', relFilePath]);
  } catch {
    return { kind: 'untracked' };
  }

  // 3. Build the diff command for the requested base.
  let diffArgs: string[];
  if (diffBase === 'staged') {
    diffArgs = ['diff', '--cached', '-U0', '--', relFilePath];
  } else {
    let base: string;
    try {
      const mb = await git(['merge-base', diffBase, 'HEAD']);
      base = mb.stdout.trim();
    } catch {
      return { kind: 'bad-ref', ref: diffBase };
    }
    diffArgs = ['diff', '-U0', base, '--', relFilePath];
  }

  let diffOut: string;
  try {
    diffOut = (await git(diffArgs)).stdout;
  } catch {
    // Repo confirmed and file tracked, so a diff failure is unexpected; the
    // most likely cause is an unusable base — surface it as a bad ref.
    return { kind: 'bad-ref', ref: diffBase };
  }

  const ranges = parseHunks(diffOut);
  return ranges.length === 0 ? { kind: 'no-changes' } : { kind: 'ranges', ranges };
}

/** Classification of the changed-file set against a diff base. */
export type ChangedFilesResult =
  | { kind: 'not-a-repo' }
  | { kind: 'bad-ref'; ref: string }
  | { kind: 'files'; files: string[] };

/**
 * List workspace-relative source paths that changed versus `diffBase`, unioned
 * with untracked files. Read-only git in `workspaceRoot`; never throws for
 * expected conditions. Same base resolution as {@link computeChangedRanges}
 * (merge-base for refs, `--cached` for "staged") so per-file ranges align.
 */
export async function listChangedFiles(
  workspaceRoot: string,
  diffBase: string,
): Promise<ChangedFilesResult> {
  const git = (args: string[]) =>
    runShell('git', args, { cwd: workspaceRoot, timeoutMs: GIT_TIMEOUT_MS });

  try {
    await git(['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { kind: 'not-a-repo' };
  }

  let nameOnly: string[];
  if (diffBase === 'staged') {
    nameOnly = ['diff', '--cached', '--name-only'];
  } else {
    let base: string;
    try {
      base = (await git(['merge-base', diffBase, 'HEAD'])).stdout.trim();
    } catch {
      return { kind: 'bad-ref', ref: diffBase };
    }
    nameOnly = ['diff', '--name-only', base];
  }

  let changed: string;
  try {
    changed = (await git(nameOnly)).stdout;
  } catch {
    return { kind: 'bad-ref', ref: diffBase };
  }

  let untracked = '';
  try {
    untracked = (await git(['ls-files', '--others', '--exclude-standard'])).stdout;
  } catch {
    untracked = ''; // best-effort: untracked discovery failing is non-fatal
  }

  const split = (s: string) =>
    s
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  const files = [...new Set([...split(changed), ...split(untracked)])].sort();
  return { kind: 'files', files };
}
