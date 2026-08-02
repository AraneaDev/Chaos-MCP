import { runShell } from './exec.js';
import { ExecFailureError } from './exec-error.js';
import { isCancel } from './cancel.js';

/** A 1-based inclusive line range. */
export interface LineRange {
  start: number;
  end: number;
}

/**
 * A git call failed for a reason that says NOTHING about the repository.
 *
 * `runShell` rejects for four quite different causes — a non-zero exit, a
 * timeout (`code: 'TIMEOUT'`), a missing binary (`code: 'ENOENT'`), and a
 * cancellation (`code: 'ABORTED'`) — and a bare `catch` around the work-tree
 * probe used to collapse all of them into `not-a-repo`. That told the user
 * `"<dir>" is not a git work tree`, a factual claim about THEIR repository,
 * when the real cause was our own exhausted time budget or a git binary that
 * isn't installed. Keeping the two apart is the whole point of this variant:
 * `not-a-repo` now means git ANSWERED the question, `git-failed` means it was
 * never asked successfully.
 *
 * Cancellation is deliberately absent — it is re-thrown, not classified; see
 * {@link classifyGitFailure}.
 */
export interface GitFailure {
  kind: 'git-failed';
  reason: 'timeout' | 'not-installed' | 'other';
  /** The underlying error text, safe to surface to the caller. */
  message: string;
}

/** Classification of a target file's change status against a diff base. */
export type DiffResult =
  | { kind: 'ranges'; ranges: LineRange[] } // tracked file with ≥1 changed hunk
  | { kind: 'no-changes' } // tracked file, identical to base
  | { kind: 'untracked' } // file not known to git → whole file is "new"
  | { kind: 'not-a-repo' } // git says the workspace is not a git work tree
  | GitFailure // git could not be asked (timeout / not installed / other)
  | { kind: 'bad-ref'; ref: string }; // diffBase could not be resolved

/** Read-only git calls get a tight timeout — they should be near-instant. */
const GIT_TIMEOUT_MS = 15_000;

/**
 * Per-call controls shared by the git helpers.
 *
 * These run BEFORE the sandbox is provisioned, so without them a cancelled
 * request kept up to four sequential 15-second git calls running with nothing
 * left to receive the result, and none of that time was charged against the
 * audit's wall-clock budget. `timeoutMs` lets the caller clamp them to whatever
 * remains of that budget.
 */
export interface GitOptions {
  /** Forwarded to the git subprocess so a cancel kills it in flight. */
  signal?: AbortSignal;
  /** Upper bound per git call; clamped to {@link GIT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Build the read-only git runner for one workspace, honouring caller controls. */
function gitRunner(workspaceRoot: string, options?: GitOptions) {
  // `Math.max(1, …)` keeps an exhausted budget from being passed through as a
  // zero/negative timeout, which Node reads as "no timeout at all".
  const timeoutMs =
    options?.timeoutMs === undefined
      ? GIT_TIMEOUT_MS
      : Math.max(1, Math.min(GIT_TIMEOUT_MS, options.timeoutMs));
  return (args: string[]) =>
    runShell('git', args, {
      cwd: workspaceRoot,
      timeoutMs,
      signal: options?.signal,
      killTree: true,
    });
}

/**
 * Re-throw a cancellation, or label anything else that made a git call reject.
 *
 * ALWAYS call this instead of writing a bare `catch` around a git invocation.
 *
 * Cancellation escapes as the ORIGINAL error rather than becoming a result
 * kind: every cancel path in this codebase funnels through `isCancel`
 * (utils/cancel.ts) so the handlers report the one string `'Operation
 * cancelled.'`. Swallowing an abort into a `DiffResult` here makes those
 * branches unreachable, and the user is told their repository is broken
 * because they pressed stop.
 *
 * A genuine non-zero EXIT is the one failure that is evidence about the
 * directory: `git rev-parse --is-inside-work-tree` exits 128 with "not a git
 * repository" outside a work tree. Timeouts, ENOENT and signal deaths leave
 * `exit === null` and are evidence about US, not about the repo.
 */
function classifyGitFailure(err: unknown): { kind: 'exit' } | GitFailure {
  if (isCancel(err)) throw err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof ExecFailureError) {
    if (err.code === 'TIMEOUT') return { kind: 'git-failed', reason: 'timeout', message };
    if (err.code === 'ENOENT') return { kind: 'git-failed', reason: 'not-installed', message };
    if (err.exit !== null) return { kind: 'exit' };
  }
  return { kind: 'git-failed', reason: 'other', message };
}

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
  options?: GitOptions,
): Promise<DiffResult> {
  const git = gitRunner(workspaceRoot, options);

  // 1. Must be a git work tree — and "must" is the only thing a non-zero exit
  // proves. A timeout or a missing binary comes back as `git-failed` so the
  // caller can say what actually went wrong instead of blaming the repository.
  try {
    await git(['rev-parse', '--is-inside-work-tree']);
  } catch (err: unknown) {
    const failure = classifyGitFailure(err);
    return failure.kind === 'exit' ? { kind: 'not-a-repo' } : failure;
  }

  // 2. Untracked / unknown file → the whole file is "new".
  //
  // NOTE: these paths deliberately keep their existing result kinds for every
  // non-cancel failure — a cancelled `ls-files` must not be reported as
  // "untracked, mutate the whole file", which is the most expensive possible
  // answer to a request the caller already abandoned.
  try {
    await git(['ls-files', '--error-unmatch', '--', relFilePath]);
  } catch (err: unknown) {
    if (isCancel(err)) throw err;
    return { kind: 'untracked' };
  }

  // 3. Build the diff command for the requested base.
  //
  // Unlike `listChangedFiles`, this call needs NO `--relative`: the pathspec
  // after `--` is already interpreted relative to the git cwd (`workspaceRoot`),
  // and the only thing read back out is the `@@` hunk headers — the `a/…  b/…`
  // header paths, which are the repository-root-relative part of the output,
  // are never parsed. Adding `--relative` here would change nothing and would
  // silently drop the file whenever `workspaceRoot` sits below it.
  let diffArgs: string[];
  if (diffBase === 'staged') {
    diffArgs = ['diff', '--cached', '-U0', '--', relFilePath];
  } else {
    let base: string;
    try {
      const mb = await git(['merge-base', diffBase, 'HEAD']);
      base = mb.stdout.trim();
    } catch (err: unknown) {
      if (isCancel(err)) throw err;
      return { kind: 'bad-ref', ref: diffBase };
    }
    diffArgs = ['diff', '-U0', base, '--', relFilePath];
  }

  let diffOut: string;
  try {
    diffOut = (await git(diffArgs)).stdout;
  } catch (err: unknown) {
    if (isCancel(err)) throw err;
    // Repo confirmed and file tracked, so a diff failure is unexpected; the
    // most likely cause is an unusable base — surface it as a bad ref.
    return { kind: 'bad-ref', ref: diffBase };
  }

  const ranges = parseHunks(diffOut);
  return ranges.length === 0 ? { kind: 'no-changes' } : { kind: 'ranges', ranges };
}

/**
 * Classification of the changed-file set against a diff base.
 *
 * Intentionally does NOT carry {@link GitFailure}: `resolveTriageTargets`
 * (triage/discover-targets.ts) narrows this union by elimination and reads
 * `.files`, so a fourth variant would not type-check there. Until that consumer
 * grows a branch for it, the non-repo failures below are re-thrown rather than
 * returned — see the work-tree probe in {@link listChangedFiles}.
 */
export type ChangedFilesResult =
  | { kind: 'not-a-repo' }
  | { kind: 'bad-ref'; ref: string }
  | { kind: 'files'; files: string[] };

/**
 * Build the `diff --name-only` argv for `diffBase`, given an already-resolved
 * merge base (or `undefined` for the staged form).
 *
 * Two flags here are load-bearing and were both absent:
 *
 * `--relative` — WITHOUT it, `diff --name-only` prints REPOSITORY-ROOT-relative
 * paths while `ls-files --others` (below) prints CWD-relative ones, so the two
 * halves of the union arrive in different bases. Callers resolve every entry
 * against the workspace root (`resolve(rootCwd, file)` in
 * triage/discover-targets.ts and triage/audit-one.ts), so as soon as the
 * workspace is a SUBDIRECTORY of the git root — the monorepo layout
 * `anchorToWorkspace` exists to serve — tracked changes resolved to
 * `<root>/pkg/pkg/src/x.ts`, did not exist, and came back as "Sandbox
 * provisioning failed" rows. Untracked files resolved fine, so the sweep
 * half-worked and the bug read as a flaky engine. `--relative` also drops
 * changes above the workspace root, which is correct: they are outside the
 * sweep's boundary and would be rejected by the realpath check anyway.
 *
 * `--diff-filter=d` — lowercase `d` EXCLUDES deletions. A file removed since
 * the base is still "changed" as far as `--name-only` is concerned, and it
 * passed the extension filter and the boundary check before failing deep in
 * `createSandbox` with "target file … was not found", inflating `filesErrored`
 * with files that legitimately no longer exist.
 */
function nameOnlyArgs(base: string | undefined): string[] {
  const filters = ['--relative', '--diff-filter=d', '--name-only'];
  return base === undefined ? ['diff', '--cached', ...filters] : ['diff', ...filters, base];
}

/**
 * List workspace-relative source paths that changed versus `diffBase`, unioned
 * with untracked files. Read-only git in `workspaceRoot`; never throws for
 * expected conditions. Same base resolution as {@link computeChangedRanges}
 * (merge-base for refs, `--cached` for "staged") so per-file ranges align.
 *
 * Every returned path is relative to `workspaceRoot`, from BOTH git commands —
 * see {@link nameOnlyArgs} for why that needed saying out loud.
 */
export async function listChangedFiles(
  workspaceRoot: string,
  diffBase: string,
  options?: GitOptions,
): Promise<ChangedFilesResult> {
  const git = gitRunner(workspaceRoot, options);

  // A cancel re-throws (as everywhere else in this module). A timeout or a
  // missing git binary has no home in `ChangedFilesResult`, so rather than
  // libel the user's repository as "not a work tree" the ORIGINAL error escapes
  // — it still carries its `TIMEOUT`/`ENOENT` code and git's own message. See
  // the note on the union above for the consumer-side follow-up.
  try {
    await git(['rev-parse', '--is-inside-work-tree']);
  } catch (err: unknown) {
    if (classifyGitFailure(err).kind !== 'exit') throw err;
    return { kind: 'not-a-repo' };
  }

  let nameOnly: string[];
  if (diffBase === 'staged') {
    nameOnly = nameOnlyArgs(undefined);
  } else {
    let base: string;
    try {
      base = (await git(['merge-base', diffBase, 'HEAD'])).stdout.trim();
    } catch (err: unknown) {
      if (isCancel(err)) throw err;
      return { kind: 'bad-ref', ref: diffBase };
    }
    nameOnly = nameOnlyArgs(base);
  }

  let changed: string;
  try {
    changed = (await git(nameOnly)).stdout;
  } catch (err: unknown) {
    if (isCancel(err)) throw err;
    return { kind: 'bad-ref', ref: diffBase };
  }

  // Best-effort: untracked discovery failing is non-fatal, so the initial
  // empty value stands and only the tracked changes are reported. Re-assigning
  // it in the catch would say the same thing twice — and each assignment would
  // mask a fault in the other, leaving neither pinned by any test.
  // A cancel is the one exception: silently returning the tracked half of an
  // abandoned sweep would report a partial file list as a complete one.
  let untracked = '';
  try {
    untracked = (await git(['ls-files', '--others', '--exclude-standard'])).stdout;
  } catch (err: unknown) {
    if (isCancel(err)) throw err;
    /* keep the empty default */
  }

  const split = (s: string) =>
    s
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  const files = [...new Set([...split(changed), ...split(untracked)])].sort();
  return { kind: 'files', files };
}
