import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  lstatSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox } from '../utils/sandbox.js';
import { ALLOWED_ROOTS_ENV } from '../utils/path-safety.js';
import { isSymlink } from '../utils/sandbox/dependency-link.js';

/**
 * The guarantee this file exists to defend (README: "your real workspace is
 * never touched"): a process running inside the sandbox must not be able to
 * create or overwrite files in the audited workspace's dependency tree.
 *
 * Real filesystem, no fs mock — the defect these tests were written for was
 * invisible to a mocked symlinkSync.
 */
describe('sandbox isolation: dependency directories', () => {
  let workspace: string;
  let originalAllowedRoots: string | undefined;

  // `createSandbox` refuses a workspace outside the process working directory
  // unless CHAOS_ALLOWED_ROOTS names it. Naming it is deliberate here rather
  // than `process.chdir(workspace)`: StrykerJS's vitest runner pins
  // `pool: 'threads'` unconditionally, and `process.chdir()` throws
  // "not supported in workers" under worker_threads, so a chdir here takes the
  // whole file — and every mutation run whose covering tests include it — down
  // in the dry run. `allowedWorkspaceRoots()` reads the variable fresh on every
  // call precisely so tests can set it per case.
  beforeEach(() => {
    originalAllowedRoots = process.env[ALLOWED_ROOTS_ENV];
    workspace = mkdtempSync(join(tmpdir(), 'chaos-isolation-'));
    mkdirSync(join(workspace, 'src'));
    mkdirSync(join(workspace, 'node_modules', 'somepkg'), { recursive: true });
    writeFileSync(join(workspace, 'package.json'), '{}');
    writeFileSync(join(workspace, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(workspace, 'node_modules', 'somepkg', 'index.js'), 'original\n');
    process.env[ALLOWED_ROOTS_ENV] = workspace;
  });

  afterEach(() => {
    if (originalAllowedRoots === undefined) {
      Reflect.deleteProperty(process.env, ALLOWED_ROOTS_ENV);
    } else {
      process.env[ALLOWED_ROOTS_ENV] = originalAllowedRoots;
    }
    rmSync(workspace, { recursive: true, force: true });
  });

  it('keeps a new path created under node_modules inside the sandbox', async () => {
    const sandbox = await createSandbox('src/a.ts', workspace);
    try {
      // This is WHY the write below stays contained: the sandbox's
      // node_modules is a real directory, not a symlink back to the host's —
      // a new path created under it is therefore a new path in the sandbox,
      // not in the workspace.
      expect(isSymlink(join(sandbox.workDir, 'node_modules'))).toBe(false);

      // What Vite does on every config load (see utils/container/args.ts).
      mkdirSync(join(sandbox.workDir, 'node_modules', '.vite-temp'), { recursive: true });
      writeFileSync(join(sandbox.workDir, 'node_modules', '.vite-temp', 'x.mjs'), 'scratch');
    } finally {
      sandbox.cleanup();
    }

    expect(() => readFileSync(join(workspace, 'node_modules', '.vite-temp', 'x.mjs'))).toThrow();
  });

  it('still resolves an installed package from inside the sandbox', async () => {
    const sandbox = await createSandbox('src/a.ts', workspace);
    try {
      // This is WHY resolution still works: the package ENTRY itself is a
      // symlink back to the host's copy (only the containing node_modules/ is
      // real — see the test above), so reading through it reaches the
      // original content without the whole directory being shared.
      expect(isSymlink(join(sandbox.workDir, 'node_modules', 'somepkg'))).toBe(true);

      const pkg = join(sandbox.workDir, 'node_modules', 'somepkg', 'index.js');
      expect(readFileSync(pkg, 'utf8')).toBe('original\n');
    } finally {
      sandbox.cleanup();
    }
  });

  it('copies the dependency tree when dependencies: "copy"', async () => {
    const sandbox = await createSandbox('src/a.ts', workspace, undefined, {
      dependencies: 'copy',
    });
    try {
      writeFileSync(join(sandbox.workDir, 'node_modules', 'somepkg', 'index.js'), 'mutated\n');
    } finally {
      sandbox.cleanup();
    }
    expect(readFileSync(join(workspace, 'node_modules', 'somepkg', 'index.js'), 'utf8')).toBe(
      'original\n',
    );
  });

  it('restores whole-directory sharing when dependencies: "share"', async () => {
    const sandbox = await createSandbox('src/a.ts', workspace, undefined, {
      dependencies: 'share',
    });
    try {
      expect(lstatSync(join(sandbox.workDir, 'node_modules')).isSymbolicLink()).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });

  it('omits a dependency directory the caller asked to ignore', async () => {
    const sandbox = await createSandbox('src/a.ts', workspace, ['node_modules']);
    try {
      expect(existsSync(join(sandbox.workDir, 'node_modules'))).toBe(false);
    } finally {
      sandbox.cleanup();
    }
  });

  it('omits a NESTED dependency directory the caller asked to ignore', async () => {
    // The layout the "Nested occurrences" comment on linkHeavyDirs describes
    // (e.g. workers/typescript/node_modules): the root node_modules/ is
    // absorbed and deleted from skippedHeavyDirs by loop 1, so it can never
    // exercise loop 2's segment-exclusion check. Only a SECOND, nested
    // node_modules survives into skippedHeavyDirs for loop 2 to see.
    mkdirSync(join(workspace, 'workers', 'typescript', 'node_modules', 'nested-pkg'), {
      recursive: true,
    });
    writeFileSync(
      join(workspace, 'workers', 'typescript', 'node_modules', 'nested-pkg', 'index.js'),
      'nested\n',
    );

    const sandbox = await createSandbox('src/a.ts', workspace, ['node_modules']);
    try {
      // The containing directory was copied normally (not excluded)...
      expect(existsSync(join(sandbox.workDir, 'workers', 'typescript'))).toBe(true);
      // ...but the nested node_modules was not linked into it.
      expect(existsSync(join(sandbox.workDir, 'workers', 'typescript', 'node_modules'))).toBe(
        false,
      );
    } finally {
      sandbox.cleanup();
    }
  });
});
