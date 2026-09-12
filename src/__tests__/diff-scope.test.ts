import { describe, it, expect } from 'vitest';
import { materialiseDiffScope } from '../audit/diff-scope.js';

const ranges = [{ start: 10, end: 14 }];

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
      diffBase: 'HEAD',
      ranges,
      run: h.run,
      fs: h.fs,
    });
    expect(result.diffScope).toEqual({ kind: 'patch', path: expect.stringContaining('/sandbox/') });
    // The patch is generated from the REAL repository, on the host, so the Rust
    // image never needs git.
    const diff = h.calls.find((c) => c.args[0] === 'diff');
    expect(diff?.cwd).toBe('/work');
    expect(diff?.args).toEqual(['diff', 'HEAD', '--', 'src/notify.rs']);
    expect(h.calls.some((c) => c.args[0] === 'init')).toBe(false);
  });

  it('passes ranges straight through for python, with no git at all', async () => {
    const h = harness();
    const result = await materialiseDiffScope({
      projectType: 'python',
      relFile: 'calc.py',
      workspaceRoot: '/work',
      sandboxDir: '/sandbox',
      diffBase: 'HEAD',
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
      diffBase: 'origin/main',
      ranges,
      run: h.run,
      fs: h.fs,
    });
    expect(result.diffScope).toEqual({ kind: 'git-base', ref: 'chaos-base' });

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
      diffBase: 'HEAD',
      ranges,
      run: h.run as never,
      fs: h.fs,
    });
    expect(result.diffScope).toBeUndefined();
    expect(result.note).toMatch(/whole file/i);
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
      diffBase: 'HEAD',
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
      diffBase: 'HEAD',
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

  it('returns nothing at all for typescript, which needs no materialisation', async () => {
    const h = harness();
    const result = await materialiseDiffScope({
      projectType: 'typescript',
      relFile: 'src/a.ts',
      workspaceRoot: '/work',
      sandboxDir: '/sandbox',
      diffBase: 'HEAD',
      ranges,
      run: h.run,
      fs: h.fs,
    });
    expect(result).toEqual({});
    expect(h.calls).toEqual([]);
  });
});
