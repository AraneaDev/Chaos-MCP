import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSandbox } from '../utils/sandbox.js';
import { assertTargetInsideSandbox } from '../utils/sandbox.js';

/**
 * The sandbox exists to guarantee one thing: a mutation run never touches the
 * real working tree. These tests exercise that guarantee against the case that
 * defeated it.
 *
 * The workspace copy runs with `dereference: false`, so a symlinked source file
 * — or a source file under a symlinked directory — is reproduced in the sandbox
 * AS a symlink pointing back at the original. The old existence check used
 * `existsSync`, which FOLLOWS symlinks and so happily confirmed such a target
 * was "in the sandbox". cosmic-ray mutates in place, so the injected fault
 * would then be written straight into the user's real source file, and a
 * crashed or cancelled run would leave it there.
 *
 * Real filesystem, real symlinks — mocking `fs` here would test the mock.
 */
describe('sandbox symlink escape guard', () => {
  const created: string[] = [];

  function makeWorkspace(): string {
    // Inside cwd so the workspace-boundary check (C2) accepts it.
    const dir = mkdtempSync(join(process.cwd(), 'chaos-symlink-test-'));
    created.push(dir);
    return dir;
  }

  afterEach(() => {
    while (created.length > 0) {
      const dir = created.pop();
      if (dir === undefined) continue;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it('refuses a target that is a symlink back into the real workspace', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws, 'src'), { recursive: true });
    mkdirSync(join(ws, 'real'), { recursive: true });
    // The file that must never be mutated.
    const realFile = join(ws, 'real', 'math.py');
    writeFileSync(realFile, 'def add(a, b):\n    return a + b\n', 'utf8');
    // The audited path is a symlink to it.
    symlinkSync(realFile, join(ws, 'src', 'math.py'));

    await expect(createSandbox('src/math.py', ws)).rejects.toThrow(/outside the sandbox/);

    // And the real file is untouched — nothing was provisioned to mutate it in.
    expect(readFileSync(realFile, 'utf8')).toContain('return a + b');
  });

  it('names the escape target and what to do instead', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws, 'src'), { recursive: true });
    mkdirSync(join(ws, 'real'), { recursive: true });
    writeFileSync(join(ws, 'real', 'math.py'), 'x = 1\n', 'utf8');
    symlinkSync(join(ws, 'real', 'math.py'), join(ws, 'src', 'math.py'));

    await expect(createSandbox('src/math.py', ws)).rejects.toThrow(
      /modify your actual source tree|Audit the symlink's target path directly/,
    );
  });

  it('refuses a target living under a symlinked DIRECTORY', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws, 'shared'), { recursive: true });
    writeFileSync(join(ws, 'shared', 'util.py'), 'y = 2\n', 'utf8');
    // `packages/app/shared -> ../../shared`, the monorepo layout that makes
    // this reachable without anyone symlinking an individual file.
    mkdirSync(join(ws, 'packages', 'app'), { recursive: true });
    symlinkSync(join(ws, 'shared'), join(ws, 'packages', 'app', 'shared'));

    await expect(createSandbox('packages/app/shared/util.py', ws)).rejects.toThrow(
      /outside the sandbox/,
    );
  });

  it('still provisions an ordinary (non-symlinked) target', async () => {
    // The guard must not reject the normal case.
    const ws = makeWorkspace();
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'src', 'math.py'), 'z = 3\n', 'utf8');

    const sandbox = await createSandbox('src/math.py', ws);
    try {
      expect(sandbox.workDir).not.toBe(ws);
      // The sandbox copy is a real file, and writing to it leaves the original
      // alone — the property the whole module exists to provide.
      writeFileSync(join(sandbox.workDir, 'src', 'math.py'), 'z = 99\n', 'utf8');
      expect(readFileSync(join(ws, 'src', 'math.py'), 'utf8')).toBe('z = 3\n');
    } finally {
      sandbox.cleanup();
    }
  });
});

describe('assertTargetInsideSandbox', () => {
  it('accepts a path inside the sandbox', () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), 'chaos-assert-'));
    try {
      const target = join(sandboxDir, 'a.ts');
      writeFileSync(target, '', 'utf8');
      expect(() => assertTargetInsideSandbox(target, sandboxDir, 'a.ts')).not.toThrow();
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('fails closed when the target cannot be resolved at all', () => {
    // An unresolvable target is one we cannot prove is safe to mutate, so the
    // guard must reject rather than assume.
    const sandboxDir = mkdtempSync(join(tmpdir(), 'chaos-assert-'));
    try {
      expect(() =>
        assertTargetInsideSandbox(join(sandboxDir, 'missing.ts'), sandboxDir, 'missing.ts'),
      ).toThrow(/could not resolve the real path/);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });
});
