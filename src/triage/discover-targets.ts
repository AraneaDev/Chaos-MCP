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
import { listChangedFiles } from '../utils/git-diff.js';
import { isPathPermitted } from '../utils/path-safety.js';
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
 * Resolve the sweep's file list from `diffBase` (git) or `paths` (filesystem).
 *
 * Git failures that make the request unanswerable — not a work tree, ref that
 * does not resolve — come back as `kind: 'error'` with the message to return;
 * they are not thrown, because the handler reports them as a tool error rather
 * than as a "Chaos Engine Halted" crash.
 */
export async function resolveTriageTargets(input: TriageTargetInput): Promise<TriageTargets> {
  const { rootCwd, paths, diffBase, maxFiles } = input;

  if (diffBase !== undefined) {
    const listed = await listChangedFiles(rootCwd, diffBase, {
      signal: input.signal,
      timeoutMs: input.deadline.remainingMs(input.cleanupReserveMs),
    });
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
    const sel = discoverChangedFiles(listed.files, paths, maxFiles);
    return {
      kind: 'targets',
      // Defense-in-depth: git normally only reports workspace-relative paths, but
      // filter any path whose realpath resolves outside the workspace root. (C2 parity)
      files: sel.files.filter((file) => isPathPermitted(resolve(rootCwd, file))),
      discovered: sel.discovered,
      skipped: sel.skipped,
      scopeNote: `Scoped to files changed vs ${diffBase}. TypeScript files mutated on changed lines; other languages whole-file.`,
    };
  }

  const disc = discoverFiles(paths as string[], rootCwd, maxFiles);
  return { kind: 'targets', files: disc.files, discovered: disc.discovered, skipped: disc.skipped };
}
