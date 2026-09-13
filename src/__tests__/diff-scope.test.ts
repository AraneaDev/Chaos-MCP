import { describe, it, expect, vi } from 'vitest';
import {
  materialiseDiffScope,
  MATERIALISATION_FALLBACK_PREFIX,
  SandboxRestoreFailedError,
} from '../audit/diff-scope.js';
import { ExecFailureError } from '../utils/exec-error.js';
import type { ResolvedDiffBase } from '../utils/git-diff.js';

vi.mock('../utils/exec.js', () => ({ runShell: vi.fn() }));
import { runShell } from '../utils/exec.js';
const mockRunShell = vi.mocked(runShell);

const ranges = [{ start: 10, end: 14 }];
const headBase: ResolvedDiffBase = { ref: 'HEAD', staged: false };

function harness(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const written: Record<string, string> = {};
  return {
    calls,
    written,
    run: async (command: string, args: string[], opts: { cwd: string }) => {
      calls.push({ command, args, cwd: opts.cwd });
      if (args[0] === 'diff') return { stdout: 'diff --git a/x b/x\n@@ -1 +1 @@\n' };
      if (args[0] === 'show') return { stdout: 'BASE CONTENT\n' };
      return { stdout: '' };
    },
    fs: {
      readFile: () => 'CURRENT CONTENT\n',
      writeFile: (p: string, c: string) => {
        written[p] = c;
      },
    },
    ...overrides,
  };
}

describe('materialiseDiffScope', () => {
  it('writes a host-generated patch for rust and points at it', async () => {
    const h = harness();
    const result = await materialiseDiffScope({
      projectType: 'rust',
      relFile: 'src/notify.rs',
      workspaceRoot: '/work',
      sandboxDir: '/sandbox',
      resolvedBase: headBase,
      ranges,
      run: h.run,
      fs: h.fs,
    });
    expect(result.diffScope).toEqual({ kind: 'patch', path: expect.stringContaining('/sandbox/') });
    // The patch is generated from the REAL repository, on the host, so the Rust
    // image never needs git.
    const diff = h.calls.find((c) => c.args[0] === 'diff');
    expect(diff?.cwd).toBe('/work');
    // `--relative`, not a bare `git diff HEAD -- <path>` (IMPORTANT: `git
    // diff` header paths are repository-root relative, but this patch is
    // matched against `relFile`, which is workspace-root relative. Without
    // `--relative` the two disagree the moment the workspace is a
    // sub-directory of the repository, and cargo-mutants matches nothing).
    expect(diff?.args).toEqual(['diff', '--relative', 'HEAD', '--', 'src/notify.rs']);
    expect(h.calls.some((c) => c.args[0] === 'init')).toBe(false);
  });

  it('adds --cached for a staged resolved base', async () => {
    const h = harness();
    await materialiseDiffScope({
      projectType: 'rust',
      relFile: 'src/notify.rs',
      workspaceRoot: '/work',
      sandboxDir: '/sandbox',
      // `staged: true` is the flag a resolved 'HEAD' ref alone cannot carry
      // (CRITICAL: the 'staged' sentinel is not a valid `git diff` revision,
      // and without `--cached` a plain `git diff HEAD` reads the WORKING TREE
      // rather than the staged changes `computeChangedRanges` actually scored).
      resolvedBase: { ref: 'HEAD', staged: true },
      ranges,
      run: h.run,
      fs: h.fs,
    });
    const diff = h.calls.find((c) => c.args[0] === 'diff');
    expect(diff?.args).toEqual(['diff', '--relative', '--cached', 'HEAD', '--', 'src/notify.rs']);
  });

  it('passes ranges straight through for python, with no git at all', async () => {
    const h = harness();
    const result = await materialiseDiffScope({
      projectType: 'python',
      relFile: 'calc.py',
      workspaceRoot: '/work',
      sandboxDir: '/sandbox',
      resolvedBase: headBase,
      ranges,
      run: h.run,
      fs: h.fs,
    });
    expect(result.diffScope).toEqual({ kind: 'ranges', ranges });
    expect(h.calls).toEqual([]);
  });

  it('builds a throwaway repository for php and commits the BASE content', async () => {
    const h = harness();
    const result = await materialiseDiffScope({
      projectType: 'php',
      relFile: 'src/Calculator.php',
      workspaceRoot: '/work',
      sandboxDir: '/sandbox',
      resolvedBase: { ref: 'origin/main', staged: false },
      ranges,
      run: h.run,
      fs: h.fs,
    });
    expect(result.diffScope).toEqual({ kind: 'git-base', ref: 'chaos-base' });

    // `./` prefix (IMPORTANT): `<rev>:<path>` treats `path` as
    // REPOSITORY-root relative unless it starts with `./`, in which case git
    // resolves it against `cwd` (the workspace root) instead. Without it, a
    // workspace below the repository root reads the wrong blob.
    const show = h.calls.find((c) => c.args[0] === 'show');
    expect(show?.cwd).toBe('/work');
    expect(show?.args).toEqual(['show', 'origin/main:./src/Calculator.php']);

    const inSandbox = h.calls.filter((c) => c.cwd === '/sandbox').map((c) => c.args);
    expect(inSandbox[0]).toEqual(['init', '-q', '-b', 'chaos-base']);
    // Staged with -f so a .gitignore in the audited project cannot exclude it.
    expect(inSandbox.some((a) => a.includes('add') && a.includes('-f'))).toBe(true);
    // A throwaway identity, inline, never repo config and never the operator's.
    const commit = inSandbox.find((a) => a.includes('commit'));
    expect(commit).toContain('user.email=chaos-mcp@localhost');
    // The base content is committed, then the current content is restored, so
    // the working tree diff reproduces the ranges Chaos already computed.
    expect(h.written['/sandbox/src/Calculator.php']).toBe('CURRENT CONTENT\n');
  });

  it('restores the INDEX content, not the worktree content, for a staged base', async () => {
    // LOW residual from re-review: `computeChangedRanges`'s staged ranges
    // come from `git diff --cached` (INDEX versus HEAD), but the sandbox
    // copy holds the WORKING TREE content, which can differ from the index
    // when a file carries unstaged edits layered on top of staged ones.
    // Restoring the worktree copy after the base commit would make
    // Infection's in-sandbox diff HEAD-versus-worktree instead of the
    // index-versus-HEAD ranges the row actually reports, so it would mutate
    // (and report survivors on) lines outside its own stated scope. `git
    // show :<path>` reads the index (stage 0), which is what must land back
    // in the sandbox for the staged case.
    const written: Record<string, string> = {};
    const result = await materialiseDiffScope({
      projectType: 'php',
      relFile: 'src/Calculator.php',
      workspaceRoot: '/work',
      sandboxDir: '/sandbox',
      resolvedBase: { ref: 'HEAD', staged: true },
      ranges,
      run: async (command: string, args: string[]) => {
        if (args[0] === 'show' && args[1] === 'HEAD:./src/Calculator.php') {
          return { stdout: 'HEAD CONTENT\n' };
        }
        if (args[0] === 'show' && args[1] === ':./src/Calculator.php') {
          return { stdout: 'INDEX CONTENT\n' };
        }
        return { stdout: '' };
      },
      fs: {
        // Deliberately different from both HEAD and the index: an unstaged
        // edit sitting on top of a staged one.
        readFile: () => 'WORKTREE CONTENT\n',
        writeFile: (p: string, c: string) => {
          written[p] = c;
        },
      },
    });

    expect(result.diffScope).toEqual({ kind: 'git-base', ref: 'chaos-base' });
    expect(written['/sandbox/src/Calculator.php']).toBe('INDEX CONTENT\n');
  });

  it('degrades to a note when git is unavailable, never throws', async () => {
    const h = harness({
      run: async () => {
        throw new Error('git: command not found');
      },
    });
    const result = await materialiseDiffScope({
      projectType: 'php',
      relFile: 'src/Calculator.php',
      workspaceRoot: '/work',
      sandboxDir: '/sandbox',
      resolvedBase: headBase,
      ranges,
      run: h.run as never,
      fs: h.fs,
    });
    expect(result.diffScope).toBeUndefined();
    expect(result.note).toMatch(/whole file/i);
    // A triage row recognises a fallback by this exported prefix. If the note
    // stopped carrying it, rows would silently go back to claiming "scored on
    // changed lines" over a whole-file score.
    expect(result.note?.startsWith(MATERIALISATION_FALLBACK_PREFIX)).toBe(true);
  });

  it('degrades to a note when the base content cannot be read', async () => {
    const h = harness({
      run: async (command: string, args: string[]) => {
        if (args[0] === 'show') throw new Error('fatal: path does not exist');
        return { stdout: '' };
      },
    });
    const result = await materialiseDiffScope({
      projectType: 'php',
      relFile: 'src/New.php',
      workspaceRoot: '/work',
      sandboxDir: '/sandbox',
      resolvedBase: headBase,
      ranges,
      run: h.run as never,
      fs: h.fs,
    });
    expect(result.diffScope).toBeUndefined();
    expect(result.note).toBeDefined();
  });

  it('restores the CURRENT content even when a later git step fails', async () => {
    const h = harness({
      run: async (command: string, args: string[]) => {
        if (args[0] === 'add') throw new Error('git add failed');
        if (args[0] === 'show') return { stdout: 'BASE CONTENT\n' };
        return { stdout: '' };
      },
    });
    const result = await materialiseDiffScope({
      projectType: 'php',
      relFile: 'src/Calculator.php',
      workspaceRoot: '/work',
      sandboxDir: '/sandbox',
      resolvedBase: headBase,
      ranges,
      run: h.run as never,
      fs: h.fs,
    });
    expect(result.diffScope).toBeUndefined();
    expect(result.note).toBeDefined();
    // The write of the BASE content must never be left standing: whatever
    // failed after it, the sandbox file must hold the CURRENT content again.
    expect(h.written['/sandbox/src/Calculator.php']).toBe('CURRENT CONTENT\n');
  });

  it('fails the run rather than falling back when the restore write itself fails', async () => {
    // MINOR finding: before this, a restore failure was caught by the same
    // outer try/catch as everything else here and turned into a fallback
    // note, so the caller fell back to a "whole file" run against a sandbox
    // file that was STILL HOLDING BASE CONTENT (the restore that was
    // supposed to undo that is exactly what failed). A silent wrong answer,
    // not a degraded one. This must reject instead of resolving to a note.
    let writeCount = 0;
    const h = harness({
      run: async (command: string, args: string[]) => {
        if (args[0] === 'show') return { stdout: 'BASE CONTENT\n' };
        return { stdout: '' };
      },
      fs: {
        readFile: () => 'CURRENT CONTENT\n',
        writeFile: (_p: string, _c: string) => {
          writeCount += 1;
          // First write is the BASE content before the commit; the second is
          // the restore in the `finally`. Only the restore fails.
          if (writeCount === 2) throw new Error('ENOSPC: no space left on device');
        },
      },
    });
    await expect(
      materialiseDiffScope({
        projectType: 'php',
        relFile: 'src/Calculator.php',
        workspaceRoot: '/work',
        sandboxDir: '/sandbox',
        resolvedBase: headBase,
        ranges,
        run: h.run as never,
        fs: h.fs as never,
      }),
    ).rejects.toBeInstanceOf(SandboxRestoreFailedError);
  });

  it('returns nothing at all for typescript, which needs no materialisation', async () => {
    const h = harness();
    const result = await materialiseDiffScope({
      projectType: 'typescript',
      relFile: 'src/a.ts',
      workspaceRoot: '/work',
      sandboxDir: '/sandbox',
      resolvedBase: headBase,
      ranges,
      run: h.run,
      fs: h.fs,
    });
    expect(result).toEqual({});
    expect(h.calls).toEqual([]);
  });

  it('rethrows a cancelled rust patch generation instead of degrading to a note (Finding 2)', async () => {
    // The default runner (`utils/exec.ts`'s `runShell`) classifies an aborted
    // child as `ExecFailureError` with `code: 'ABORTED'`. Before this fix, the
    // catch around `materialiseRustPatch` treated that exactly like any other
    // git failure and returned a fallback note, so `auditFile` carried on and
    // started a WHOLE-FILE engine run after the caller had already cancelled.
    const h = harness({
      run: async () => {
        throw new ExecFailureError(
          { stdout: '', stderr: '', exit: null, signal: null, code: 'ABORTED' },
          'ABORT_ERR: aborted',
        );
      },
    });
    await expect(
      materialiseDiffScope({
        projectType: 'rust',
        relFile: 'src/notify.rs',
        workspaceRoot: '/work',
        sandboxDir: '/sandbox',
        resolvedBase: headBase,
        ranges,
        run: h.run as never,
        fs: h.fs,
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('rethrows a cancelled php base sequence instead of degrading to a note (Finding 2)', async () => {
    const h = harness({
      run: async () => {
        throw new ExecFailureError(
          { stdout: '', stderr: '', exit: null, signal: null, code: 'ABORTED' },
          'ABORT_ERR: aborted',
        );
      },
    });
    await expect(
      materialiseDiffScope({
        projectType: 'php',
        relFile: 'src/Calculator.php',
        workspaceRoot: '/work',
        sandboxDir: '/sandbox',
        resolvedBase: headBase,
        ranges,
        run: h.run as never,
        fs: h.fs,
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

/**
 * IMPORTANT finding: `DEFAULT_MATERIALISE_TIMEOUT_MS` was only a `??`
 * fallback, and `audit/audit-file.ts` always passes a value (the run's own
 * remaining budget, which can be minutes), so the fallback never actually
 * applied and a hung `git show`/`git diff` could eat the whole audit window.
 * These exercise the REAL `run` (no `run` override), the only path that goes
 * through `defaultRun` and its clamp, with `runShell` mocked underneath.
 */
describe('materialiseDiffScope bounds its own git calls to a tight timeout', () => {
  it('clamps a much larger caller-supplied timeoutMs down to the materialisation ceiling', async () => {
    mockRunShell.mockResolvedValue({ stdout: 'diff --git a/x b/x\n@@ -1 +1 @@\n' } as never);

    await materialiseDiffScope({
      projectType: 'rust',
      relFile: 'src/notify.rs',
      workspaceRoot: '/work',
      sandboxDir: '/sandbox',
      resolvedBase: headBase,
      ranges,
      // The run's own remaining budget can be minutes; materialisation must
      // not be handed anywhere near that much.
      timeoutMs: 5 * 60_000,
      fs: {
        readFile: () => 'CURRENT CONTENT\n',
        writeFile: () => undefined,
      },
    });

    expect(mockRunShell).toHaveBeenCalledWith(
      'git',
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });

  it('still honours a caller timeout that is already tighter than the ceiling', async () => {
    mockRunShell.mockResolvedValue({ stdout: 'diff --git a/x b/x\n@@ -1 +1 @@\n' } as never);

    await materialiseDiffScope({
      projectType: 'rust',
      relFile: 'src/notify.rs',
      workspaceRoot: '/work',
      sandboxDir: '/sandbox',
      resolvedBase: headBase,
      ranges,
      timeoutMs: 2_000,
      fs: {
        readFile: () => 'CURRENT CONTENT\n',
        writeFile: () => undefined,
      },
    });

    expect(mockRunShell).toHaveBeenCalledWith(
      'git',
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 2_000 }),
    );
  });
});
