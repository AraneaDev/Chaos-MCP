/**
 * Diff-scope materialisation: turning the line ranges Chaos already computed
 * from `diffBase` into whatever each engine needs to act on them.
 *
 * StrykerJS (TypeScript) already consumes line ranges directly, so it needs
 * nothing here. cosmic-ray (Python) takes explicit ranges in its config too,
 * so those pass straight through. The other two engines need something built
 * INSIDE the disposable sandbox before they can be scoped:
 *
 * - Rust: `cargo mutants --in-diff <file>` wants a real unified diff. It is
 *   generated on the HOST, against the real repository, so the Rust container
 *   image never needs git installed.
 * - PHP: Infection insists on reading git itself, and the sandbox copy
 *   deliberately excludes `.git`. So a throwaway single-commit repository is
 *   built in the sandbox: the BASE content of the target file is committed on
 *   a branch named `chaos-base`, then the content that must sit alongside it
 *   is restored over it (the working tree content for a ref base, the INDEX
 *   content for the `'staged'` base, since that is the side `diff --cached`
 *   actually diffed). `git diff` inside the sandbox then reproduces exactly
 *   the ranges Chaos already computed from the real repository.
 *
 * Every failure path here is caught and turned into a `note`: a scoping
 * failure means "mutate the whole file and say why", never a failed audit.
 * This function must never throw and never reject, with ONE exception: a
 * failure to restore the sandbox file's content after the PHP base-commit
 * sequence propagates instead of degrading, because degrading it would let
 * the caller fall back to a "whole file" run that mutates the BASE content
 * left behind by the failed restore; see {@link SandboxRestoreFailedError}.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { runShell } from '../utils/exec.js';
import type { SupportedProjectType } from '../engines/registry.js';
import type { DiffScope } from '../engines/base.js';
import type { ResolvedDiffBase } from '../utils/git-diff.js';

/**
 * Re-exported from where it is defined ({@link DiffScope} in engines/base.ts,
 * beside `RunOptions`, which is what it describes) so existing
 * `from './diff-scope.js'` importers keep working.
 */
export type { DiffScope };

export interface MaterialiseInput {
  projectType: SupportedProjectType;
  /** Workspace-relative path of the file being mutated. */
  relFile: string;
  workspaceRoot: string;
  sandboxDir: string;
  /**
   * The SAME base {@link computeChangedRanges} (utils/git-diff.ts) resolved
   * `ranges` from, resolved exactly once by the caller and handed here rather
   * than re-resolved. Passing the raw `diffBase` string through a second
   * resolution is exactly the bug this field exists to close: a diverged
   * branch's `diffBase: "main"` resolves to a different commit each time
   * `merge-base` is asked from a different HEAD, and the `'staged'` sentinel
   * is not a valid revision for `git diff`/`git show` at all.
   */
  resolvedBase: ResolvedDiffBase;
  ranges: { start: number; end: number }[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injected for tests; defaults to the real shell runner. */
  run?: (command: string, args: string[], opts: { cwd: string }) => Promise<{ stdout: string }>;
  /** Injected for tests; defaults to node:fs. */
  fs?: { readFile(p: string): string; writeFile(p: string, c: string): void };
}

export interface MaterialiseResult {
  diffScope?: DiffScope;
  /** Set when scoping could not be prepared; the caller mutates the whole file. */
  note?: string;
}

/** The chaos-mcp family name for generated artefacts, so nothing collides
 * with a file the audited project actually owns. */
const PATCH_FILE_NAME = '.chaos-mcp.in-diff.patch';

/** The throwaway branch the PHP git-base sequence commits the BASE content on. */
const CHAOS_BASE_REF = 'chaos-base';

/** Read-only-ish git calls get a tight, bounded timeout. */
const DEFAULT_MATERIALISE_TIMEOUT_MS = 15_000;

/** A throwaway identity, inline, never repository config and never the operator's own. */
const CHAOS_GIT_IDENTITY = ['-c', 'user.name=chaos-mcp', '-c', 'user.email=chaos-mcp@localhost'];

function defaultRun(
  command: string,
  args: string[],
  opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ stdout: string }> {
  // `Math.min`, not `??`: the caller (audit/audit-file.ts) always passes a
  // value, the run's own remaining budget, which can be minutes, so the
  // `??` fallback this used to be never actually applied, and a hung `git
  // show`/`git diff` could eat the whole audit window. Materialisation is a
  // handful of read-only git calls; it gets its own tight ceiling regardless
  // of how much of the run's budget is left, the same clamp pattern
  // `gitRunner` (utils/git-diff.ts) already applies for the same reason.
  const timeoutMs =
    opts.timeoutMs === undefined
      ? DEFAULT_MATERIALISE_TIMEOUT_MS
      : Math.max(1, Math.min(DEFAULT_MATERIALISE_TIMEOUT_MS, opts.timeoutMs));
  return runShell(command, args, {
    cwd: opts.cwd,
    signal: opts.signal,
    timeoutMs,
    killTree: true,
  });
}

const REAL_FS = {
  readFile: (p: string) => readFileSync(p, 'utf-8'),
  writeFile: (p: string, c: string) => writeFileSync(p, c, 'utf-8'),
};

/** Build a `note` for a scoping failure that always mentions the fallback. */
function fallbackNote(reason: string): string {
  return `Diff scoping unavailable (${reason}); mutating the whole file instead.`;
}

/**
 * Thrown ONLY when the PHP sequence's `finally` cannot restore the sandbox
 * file's CURRENT content after writing the BASE content over it. Every other
 * failure in this module degrades to a `note` and a whole-file fallback,
 * which is safe because the sandbox file still holds the right content. This
 * one case is not safe: the fallback would run against the BASE content the
 * failed restore left behind and silently score the wrong version of the
 * file. So this propagates past the usual catch-and-degrade handling in both
 * {@link materialisePhpGitBase} and {@link materialiseDiffScope}, and out to
 * the caller, which must fail the run rather than fall back.
 */
export class SandboxRestoreFailedError extends Error {}

/**
 * Build the `git diff` argv that reproduces the SAME ranges
 * `computeChangedRanges` (utils/git-diff.ts) already computed from
 * `resolvedBase`, plus `--relative` so the patch's `a/`/`b/` header paths are
 * relative to `cwd` (the workspace root) rather than the repository root.
 *
 * `git diff`'s header paths are repository-root relative by construction;
 * `computeChangedRanges` never needs to care, since it only parses `@@` hunk
 * headers, but this patch is handed to cargo-mutants as `--in-diff` and
 * matched against `relFile`, which is WORKSPACE-root relative. Those two
 * agree only when the workspace root IS the repository root; the moment the
 * workspace is a sub-directory (a crate inside a monorepo), an un-relativised
 * header like `b/crates/foo/src/lib.rs` matches nothing under `relFile`
 * (`src/lib.rs`), cargo-mutants scopes to zero mutants, and the run reports a
 * clean scoped result that never mutated anything.
 */
function rustDiffArgs(resolvedBase: ResolvedDiffBase, relFile: string): string[] {
  const base = resolvedBase.staged ? ['--cached', resolvedBase.ref] : [resolvedBase.ref];
  return ['diff', '--relative', ...base, '--', relFile];
}

/** Generate a host-side unified diff for `relFile` and write it into the sandbox. */
async function materialiseRustPatch(
  input: MaterialiseInput,
  run: (command: string, args: string[], opts: { cwd: string }) => Promise<{ stdout: string }>,
  fs: { readFile(p: string): string; writeFile(p: string, c: string): void },
): Promise<MaterialiseResult> {
  try {
    const { stdout } = await run('git', rustDiffArgs(input.resolvedBase, input.relFile), {
      cwd: input.workspaceRoot,
    });
    const path = `${input.sandboxDir}/${PATCH_FILE_NAME}`;
    fs.writeFile(path, stdout);
    return { diffScope: { kind: 'patch', path } };
  } catch (err: unknown) {
    return { note: fallbackNote(errorMessage(err)) };
  }
}

/**
 * Build the throwaway single-commit repository in the sandbox: read the
 * sandbox's own content, fetch the BASE content from the host repository,
 * commit the base content on `chaos-base`, then restore whichever content
 * matches the side `computeChangedRanges` actually diffed (the index for the
 * `'staged'` base, the working tree otherwise), so the sandbox's own diff
 * reproduces the ranges Chaos already computed.
 */
async function materialisePhpGitBase(
  input: MaterialiseInput,
  run: (command: string, args: string[], opts: { cwd: string }) => Promise<{ stdout: string }>,
  fs: { readFile(p: string): string; writeFile(p: string, c: string): void },
): Promise<MaterialiseResult> {
  const sandboxFile = `${input.sandboxDir}/${input.relFile}`;
  try {
    const currentContent = fs.readFile(sandboxFile);

    // `<rev>:<path>` treats `path` as REPOSITORY-root relative unless it
    // starts with `./` or `../`, in which case git resolves it against `cwd`
    // (here, the workspace root) instead (see gitrevisions(7), "A suffix :
    // followed by a path"). `relFile` is workspace-root relative, so without
    // the `./` prefix this silently read the wrong blob whenever the
    // workspace is a sub-directory of the repository (a crate/package inside
    // a monorepo): same root-vs-workspace mismatch as the Rust patch, but
    // this one degrades to a `note` instead of scoping to nothing.
    const { stdout: baseContent } = await run(
      'git',
      ['show', `${input.resolvedBase.ref}:./${input.relFile}`],
      { cwd: input.workspaceRoot },
    );

    // The staged case needs the INDEX content here, not the working tree
    // copy already sitting in the sandbox. `computeChangedRanges` computed
    // its ranges from `git diff --cached` (INDEX versus HEAD), so the
    // sandbox's own diff has to reproduce index-versus-HEAD too. Restoring
    // the worktree content instead would make it HEAD-versus-worktree, which
    // agrees with the reported ranges only when there are no unstaged edits
    // layered on top of the staged ones; the moment there are, Infection
    // mutates (and reports survivors on) lines outside the ranges the row
    // claims. `git show :<path>` reads the index (stage 0); the `./` prefix
    // is the same repository-root-vs-workspace-root fix as the base fetch
    // above.
    const restoreContent = input.resolvedBase.staged
      ? (await run('git', ['show', `:./${input.relFile}`], { cwd: input.workspaceRoot })).stdout
      : currentContent;

    await run('git', ['init', '-q', '-b', CHAOS_BASE_REF], { cwd: input.sandboxDir });

    // From here on the sandbox file holds the BASE content, not the real one.
    // Once that write happens, restoring `restoreContent` is not optional
    // cleanup, it is the difference between a scoped audit and a silent wrong
    // answer: a caller that falls back to whole-file mutation because `add`
    // or `commit` failed must still find the right content on disk, never
    // the base version. The restore below always runs, whether or not `add`/`commit`
    // succeeded (deliberately NOT a `try/finally`: `no-unsafe-finally`
    // forbids throwing out of a `finally`, and this needs to: the restore
    // failure must win over whatever `commitError` holds, not be masked by
    // it, so both are captured and it is this function's own code, not the
    // language's finally-unwind order, that decides which one propagates).
    //
    // A failure of the restore ITSELF is not the same kind of failure as
    // everything else in this module: every other catch below degrades to a
    // note because the sandbox file is known-good either way, but here the
    // sandbox file is known-BAD (it holds base content) and staying that way
    // is precisely the silent-wrong-answer this whole sequence exists to
    // prevent. `SandboxRestoreFailedError` marks that one case so the outer
    // catches (here and in `materialiseDiffScope`) can refuse to convert it
    // into a fallback note.
    let commitError: unknown;
    try {
      fs.writeFile(sandboxFile, baseContent);
      await run('git', ['add', '-f', input.relFile], { cwd: input.sandboxDir });
      await run('git', [...CHAOS_GIT_IDENTITY, 'commit', '-q', '-m', 'chaos-mcp base'], {
        cwd: input.sandboxDir,
      });
    } catch (err: unknown) {
      commitError = err;
    }
    let restoreError: unknown;
    try {
      fs.writeFile(sandboxFile, restoreContent);
    } catch (err: unknown) {
      restoreError = err;
    }
    if (restoreError !== undefined) {
      throw new SandboxRestoreFailedError(
        `Failed to restore ${input.relFile} after diff-scope materialisation left it ` +
          `holding base content: ${errorMessage(restoreError)}. ` +
          'Refusing to fall back, which would mutate the base content instead.',
      );
    }
    if (commitError !== undefined) throw commitError;

    return { diffScope: { kind: 'git-base', ref: CHAOS_BASE_REF } };
  } catch (err: unknown) {
    if (err instanceof SandboxRestoreFailedError) throw err;
    return { note: fallbackNote(errorMessage(err)) };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Prepare, inside the disposable sandbox, whatever the target engine needs to
 * mutate only the already-computed diff ranges. Never throws and never
 * rejects, EXCEPT for {@link SandboxRestoreFailedError}: every other failure
 * path collapses into a `note` explaining why the caller should mutate the
 * whole file instead, but a failed restore means the sandbox file is left
 * holding base content, and a whole-file fallback would mutate that instead
 * of the real one, so it propagates and the caller must fail the run.
 */
export async function materialiseDiffScope(input: MaterialiseInput): Promise<MaterialiseResult> {
  try {
    const run =
      input.run ??
      ((command: string, args: string[], opts: { cwd: string }) =>
        defaultRun(command, args, { ...opts, signal: input.signal, timeoutMs: input.timeoutMs }));
    const fs = input.fs ?? REAL_FS;

    switch (input.projectType) {
      case 'rust':
        return await materialiseRustPatch(input, run, fs);
      case 'php':
        return await materialisePhpGitBase(input, run, fs);
      case 'python':
        return { diffScope: { kind: 'ranges', ranges: input.ranges } };
      case 'typescript':
        return {};
    }
  } catch (err: unknown) {
    if (err instanceof SandboxRestoreFailedError) throw err;
    return { note: fallbackNote(errorMessage(err)) };
  }
}
