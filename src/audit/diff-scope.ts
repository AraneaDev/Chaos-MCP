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
 *   a branch named `chaos-base`, then the CURRENT content is restored over
 *   it. `git diff` inside the sandbox then reproduces exactly the ranges
 *   Chaos already computed from the real repository.
 *
 * Every failure path here is caught and turned into a `note`: a scoping
 * failure means "mutate the whole file and say why", never a failed audit.
 * This function must never throw and never reject.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { runShell } from '../utils/exec.js';
import type { SupportedProjectType } from '../engines/registry.js';

/** How a single engine should be pointed at the already-computed diff. */
export type DiffScope =
  | { kind: 'patch'; path: string }
  | { kind: 'git-base'; ref: string }
  | { kind: 'ranges'; ranges: { start: number; end: number }[] };

export interface MaterialiseInput {
  projectType: SupportedProjectType;
  /** Workspace-relative path of the file being mutated. */
  relFile: string;
  workspaceRoot: string;
  sandboxDir: string;
  diffBase: string;
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
  return runShell(command, args, {
    cwd: opts.cwd,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? DEFAULT_MATERIALISE_TIMEOUT_MS,
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

/** Generate a host-side unified diff for `relFile` and write it into the sandbox. */
async function materialiseRustPatch(
  input: MaterialiseInput,
  run: (command: string, args: string[], opts: { cwd: string }) => Promise<{ stdout: string }>,
  fs: { readFile(p: string): string; writeFile(p: string, c: string): void },
): Promise<MaterialiseResult> {
  try {
    const { stdout } = await run('git', ['diff', input.diffBase, '--', input.relFile], {
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
 * current content, fetch the BASE content from the host repository, commit
 * the base content on `chaos-base`, then restore the current content so the
 * sandbox's working tree diff reproduces the ranges Chaos already computed.
 */
async function materialisePhpGitBase(
  input: MaterialiseInput,
  run: (command: string, args: string[], opts: { cwd: string }) => Promise<{ stdout: string }>,
  fs: { readFile(p: string): string; writeFile(p: string, c: string): void },
): Promise<MaterialiseResult> {
  const sandboxFile = `${input.sandboxDir}/${input.relFile}`;
  try {
    const currentContent = fs.readFile(sandboxFile);

    const { stdout: baseContent } = await run(
      'git',
      ['show', `${input.diffBase}:${input.relFile}`],
      { cwd: input.workspaceRoot },
    );

    await run('git', ['init', '-q', '-b', CHAOS_BASE_REF], { cwd: input.sandboxDir });
    fs.writeFile(sandboxFile, baseContent);
    await run('git', ['add', '-f', input.relFile], { cwd: input.sandboxDir });
    await run('git', [...CHAOS_GIT_IDENTITY, 'commit', '-q', '-m', 'chaos-mcp base'], {
      cwd: input.sandboxDir,
    });
    fs.writeFile(sandboxFile, currentContent);

    return { diffScope: { kind: 'git-base', ref: CHAOS_BASE_REF } };
  } catch (err: unknown) {
    return { note: fallbackNote(errorMessage(err)) };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Prepare, inside the disposable sandbox, whatever the target engine needs to
 * mutate only the already-computed diff ranges. Never throws and never
 * rejects: every failure path collapses into a `note` explaining why the
 * caller should mutate the whole file instead.
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
    return { note: fallbackNote(errorMessage(err)) };
  }
}
