/**
 * Target selection for one triage sweep: which files the leaderboard will rank.
 *
 * Both branches are thin glue over `triage.ts` (`discoverChangedFiles` /
 * `discoverFiles`), which is why they belong beside it rather than inside
 * `handleTriageCall` — the handler's job is to sequence phases, not to know how
 * a git ref becomes a file list.
 */
import { resolve } from 'path';
import { discoverFiles, discoverChangedFiles } from '../triage.js';
import { listChangedFiles, type ChangedFilesResult } from '../utils/git-diff.js';
import { isPathPermitted } from '../utils/path-safety.js';
import { isCancel } from '../utils/cancel.js';
import { ExecFailureError } from '../utils/exec-error.js';
import type { AuditDeadline } from '../utils/deadline.js';

/** The files to audit, or a ready-to-report reason why none can be selected. */
export type TriageTargets =
  | { kind: 'error'; message: string }
  | {
      kind: 'targets';
      files: string[];
      discovered: number;
      skipped: number;
      /** Set only in diff mode: how the sweep was scoped, shown in the payload. */
      scopeNote?: string;
    };

export interface TriageTargetInput {
  /** Workspace root the caller's paths and git invocations resolve against. */
  rootCwd: string;
  /** Explicit path targets, or `undefined` when the sweep is diff-driven only. */
  paths: string[] | undefined;
  /** Validated git ref, or `undefined` for a filesystem sweep. */
  diffBase: string | undefined;
  maxFiles: number;
  /** The sweep's wall-clock budget; the git call spends from the same clock. */
  deadline: AuditDeadline;
  /** Wall-clock left unspent so the response can still be built. */
  cleanupReserveMs: number;
  signal?: AbortSignal;
}

/**
 * Describe a git call that never ANSWERED, in the same shape a returned
 * `GitFailure` would have carried.
 *
 * `listChangedFiles` re-throws timeout / missing-binary / other failures instead
 * of returning them, because `ChangedFilesResult` cannot carry `GitFailure`
 * while the diff branch below narrows that union by elimination to read
 * `.files` (see the note on the type in utils/git-diff.ts). Catching them here
 * is what keeps the two apart: `not-a-repo` is a factual claim about the user's
 * directory, whereas a timeout or a missing `git` binary is a fact about US, and
 * the sweep used to report the second as the first.
 *
 * The reason is derived from the SAME `ExecFailureError.code` values
 * `classifyGitFailure` reads, so the wording cannot drift from the returned
 * variant.
 */
function gitFailureMessage(error: unknown, rootCwd: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof ExecFailureError ? error.code : undefined;
  const reason = code === 'TIMEOUT' ? 'timeout' : code === 'ENOENT' ? 'not-installed' : 'other';
  return `diffBase requires git, but the git call in "${rootCwd}" failed (${reason}): ${message}`;
}

/**
 * Resolve the sweep's file list from `diffBase` (git) or `paths` (filesystem).
 *
 * Git failures that make the request unanswerable — not a work tree, ref that
 * does not resolve, a git call that could not be made at all — come back as
 * `kind: 'error'` with the message to return; they are not thrown, because the
 * handler reports them as a tool error rather than as a crash. Cancellation is
 * the single exception and is re-thrown, so the handler's `isCancel` branch
 * reports it with the same 'Operation cancelled.' string as every other abort.
 */
export async function resolveTriageTargets(input: TriageTargetInput): Promise<TriageTargets> {
  const { rootCwd, paths, diffBase, maxFiles } = input;

  if (diffBase !== undefined) {
    let listed: ChangedFilesResult;
    try {
      listed = await listChangedFiles(rootCwd, diffBase, {
        signal: input.signal,
        timeoutMs: input.deadline.remainingMs(input.cleanupReserveMs),
      });
    } catch (error: unknown) {
      // A cancel is the handler's to report: every abort path in this codebase
      // funnels through `isCancel` so the caller sees one string. Turning it
      // into a sweep error here would make that branch unreachable and tell the
      // user their git setup failed because they pressed stop.
      if (isCancel(error, { signal: input.signal })) throw error;
      return { kind: 'error', message: gitFailureMessage(error, rootCwd) };
    }
    if (listed.kind === 'not-a-repo') {
      return {
        kind: 'error',
        message: `diffBase requires a git work tree, but "${rootCwd}" is not one. Remove diffBase or run inside a git repository.`,
      };
    }
    if (listed.kind === 'bad-ref') {
      return {
        kind: 'error',
        message: `diffBase "${listed.ref}" could not be resolved as a git ref.`,
      };
    }
    // `rootCwd` is what the caller's `paths` are normalised against, so "./src",
    // "src/" and "src" all intersect the git output the same way they do in the
    // filesystem branch below.
    const sel = discoverChangedFiles(listed.files, paths, maxFiles, rootCwd);
    // Defense-in-depth: git normally only reports workspace-relative paths, but
    // filter any path whose realpath resolves outside the workspace root. (C2 parity)
    const permitted = sel.files.filter((file) => isPathPermitted(resolve(rootCwd, file)));
    return {
      kind: 'targets',
      files: permitted,
      discovered: sel.discovered,
      // A file dropped by the boundary filter was still discovered, so count it
      // as skipped — otherwise it vanishes from every total and `discovered` no
      // longer equals audited + skipped + errored + unaudited.
      skipped: sel.skipped + (sel.files.length - permitted.length),
      scopeNote: `Scoped to files changed vs ${diffBase}. TypeScript files mutated on changed lines; other languages whole-file.`,
    };
  }

  const disc = discoverFiles(paths as string[], rootCwd, maxFiles);
  return { kind: 'targets', files: disc.files, discovered: disc.discovered, skipped: disc.skipped };
}
