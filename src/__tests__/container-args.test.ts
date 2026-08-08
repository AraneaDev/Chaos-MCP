import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
  };
});

import {
  buildCreateArgs,
  discoverSitePackages,
  SHARED_DEPENDENCY_DIRS,
} from '../utils/container/args.js';
import { dependencyDirectories } from '../engines/registry.js';
import { linkDependencyEntries } from '../utils/sandbox/dependency-link.js';
import type { ContainerConfig } from '../utils/config-loader.js';

describe('container create argv', () => {
  it('derives SHARED_DEPENDENCY_DIRS from the engine registry with the list unchanged', () => {
    // This used to be a THIRD verbatim copy of the dependency-dir list (after
    // EngineDescriptor.dependencyDirs and utils/sandbox.ts's SYMLINK_DIRS), so a
    // new language's dependency tree would never get bind-mounted. It is now
    // derived from the same data the registry exposes. Both halves matter:
    //   1. the rendered list is byte-for-byte what it was before, IN ORDER —
    //      that order fixes the order of the generated `--mount` argv;
    //   2. it really is the registry's union, not a coincidence.
    expect(SHARED_DEPENDENCY_DIRS).toEqual(['node_modules', '.venv', 'venv', 'vendor']);
    expect(SHARED_DEPENDENCY_DIRS).toEqual(dependencyDirectories());
  });
});

describe('discoverSitePackages', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function virtualenv(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `chaos-sitepkgs-${prefix}-`));
    tempDirs.push(dir);
    return dir;
  }

  it('collects one site-packages path per python* interpreter directory', () => {
    const venv = virtualenv('multi');
    mkdirSync(join(venv, 'lib', 'python3.13', 'site-packages'), { recursive: true });
    mkdirSync(join(venv, 'lib', 'python3.9', 'site-packages'), { recursive: true });

    expect(discoverSitePackages(venv).sort()).toEqual([
      `${venv}/lib/python3.13/site-packages`,
      `${venv}/lib/python3.9/site-packages`,
    ]);
  });

  it('reports a site-packages path even when that directory does not exist yet', () => {
    const venv = virtualenv('bare-interpreter');
    mkdirSync(join(venv, 'lib', 'python3.12'), { recursive: true });

    expect(discoverSitePackages(venv)).toEqual([`${venv}/lib/python3.12/site-packages`]);
  });

  it('ignores non-directory entries and directories not named python*', () => {
    const venv = virtualenv('filtered');
    mkdirSync(join(venv, 'lib', 'not-python', 'site-packages'), { recursive: true });
    mkdirSync(join(venv, 'lib', 'pypy3.10'), { recursive: true });
    writeFileSync(join(venv, 'lib', 'python-file'), '');

    expect(discoverSitePackages(venv)).toEqual([]);
  });

  it('returns paths in the order the filesystem yields them, without sorting', () => {
    const venv = virtualenv('order');
    vi.mocked(readdirSync).mockReturnValueOnce([
      { name: 'python3.9', isDirectory: () => true },
      { name: 'python3.13', isDirectory: () => true },
      { name: 'python3.11', isDirectory: () => true },
    ] as unknown as ReturnType<typeof readdirSync>);

    expect(discoverSitePackages(venv)).toEqual([
      `${venv}/lib/python3.9/site-packages`,
      `${venv}/lib/python3.13/site-packages`,
      `${venv}/lib/python3.11/site-packages`,
    ]);
    expect(vi.mocked(readdirSync).mock.calls[0]).toEqual([`${venv}/lib`, { withFileTypes: true }]);
  });

  it('yields nothing for an empty lib directory', () => {
    const venv = virtualenv('empty');
    mkdirSync(join(venv, 'lib'));

    expect(discoverSitePackages(venv)).toEqual([]);
  });

  it('swallows an unreadable or missing lib directory instead of throwing', () => {
    const venv = virtualenv('missing-lib');

    expect(discoverSitePackages(venv)).toEqual([]);
    expect(discoverSitePackages(join(venv, 'no-such-virtualenv'))).toEqual([]);

    vi.mocked(readdirSync).mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });
    expect(discoverSitePackages(venv)).toEqual([]);
  });
});

/**
 * `buildCreateArgs` (via `dependencyMountArgs`/`pythonEnvArgs`) now takes the
 * host `workspaceRoot` and the resolved `DependencyMode` as EXPLICIT
 * parameters instead of trying to infer the host dependency root by
 * `realpathSync`-resolving a sandbox entry. That inference approach was tried
 * and reverted: `realpathSync` returns an entry's FINAL target, not
 * `join(hostDir, entry.name)` (what `linkDependencyEntries` actually links
 * to), so it broke on npm/pnpm workspaces (`web -> ../packages/web` resolves
 * to `<repo>/packages`, not `<repo>/node_modules`), on pnpm's own store
 * layout, and — via the same unguarded suffix-stripping arithmetic — on a
 * plain `python3 -m venv`'s `lib64 -> lib` on Linux, in one case producing a
 * truncated, nonexistent bind source that made `docker create` fail outright
 * under 'copy' mode. The fixtures below are built to reproduce exactly those
 * shapes (not simplified ones an inference-based implementation could still
 * pass), so each one pins the corresponding failure mode directly.
 */
describe('buildCreateArgs dependency mounts across sandbox.dependencies shapes', () => {
  const tempDirs: string[] = [];
  const config: ContainerConfig = {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `chaos-container-args-${prefix}-`));
    tempDirs.push(dir);
    return dir;
  }

  function readonlyMount(hostPath: string): string {
    return `type=bind,src=${hostPath},dst=${hostPath},readonly`;
  }

  /** Every `--mount type=bind,src=X,...` argv entry actually names a source path that exists. */
  function mountSources(argv: string[]): string[] {
    return argv
      .filter((a) => a.startsWith('type=bind,'))
      .map((a) => /,src=([^,]+),/.exec(a)?.[1])
      .filter((src): src is string => src !== undefined);
  }

  describe('node_modules (typescript)', () => {
    it("'share': mounts the whole host tree the sandbox symlinks to", () => {
      const workspaceRoot = tempDir('share-host');
      const hostNodeModules = join(workspaceRoot, 'node_modules');
      mkdirSync(join(hostNodeModules, 'lodash'), { recursive: true });
      writeFileSync(join(hostNodeModules, 'lodash', 'index.js'), '');

      const sandbox = tempDir('share-sandbox');
      symlinkSync(hostNodeModules, join(sandbox, 'node_modules'), 'dir');

      const argv = buildCreateArgs(
        'c',
        sandbox,
        workspaceRoot,
        'share',
        'typescript',
        config,
        'img',
      );

      expect(argv).toContain(readonlyMount(hostNodeModules));
      expect(argv).toContain(`${hostNodeModules}/.vite-temp:rw,nosuid,nodev,size=16m`);
    });

    it("'link-entries' (the default sandbox shape): mounts the WORKSPACE ROOT's node_modules directly — not an entry's resolved target — so a workspace-style entry symlink still resolves inside the container", () => {
      // The exact shape that broke the realpathSync-inference approach: npm
      // workspaces symlink a package to another directory in the repo
      // (`node_modules/web -> ../packages/web`), so resolving THAT entry's
      // ultimate target landed on `<repo>/packages`, not `<repo>/node_modules`
      // — the wrong directory was mounted (or, for a name whose basename
      // didn't match the entry's own name, an unguarded slice truncated it
      // into a nonexistent path entirely). The fix does not look at a single
      // sandbox entry at all: `linkDependencyEntries` always links to
      // `join(hostDir, entry.name)` by construction, so mounting `hostDir`
      // itself (workspaceRoot/node_modules) is sufficient regardless of what
      // any individual entry points at.
      const workspaceRoot = tempDir('link-workspace');
      const hostNodeModules = join(workspaceRoot, 'node_modules');
      mkdirSync(hostNodeModules, { recursive: true });
      const webPackage = join(workspaceRoot, 'packages', 'web');
      mkdirSync(webPackage, { recursive: true });
      writeFileSync(join(webPackage, 'index.js'), '');
      // Workspace-style symlink: node_modules/web -> ../packages/web
      symlinkSync(join('..', 'packages', 'web'), join(hostNodeModules, 'web'), 'dir');

      const sandbox = tempDir('link-sandbox');
      // The real production materialiser: sandbox/node_modules is a real
      // directory whose one entry (`web`) is a symlink to the HOST's own
      // `node_modules/web` entry — which is ITSELF the workspace symlink above.
      linkDependencyEntries(hostNodeModules, join(sandbox, 'node_modules'));

      const argv = buildCreateArgs(
        'c',
        sandbox,
        workspaceRoot,
        'link-entries',
        'typescript',
        config,
        'img',
      );

      expect(argv).toContain(readonlyMount(hostNodeModules));
      expect(argv).toContain(`${hostNodeModules}/.vite-temp:rw,nosuid,nodev,size=16m`);
      // NOT the entry's resolved target, and not a truncated fragment of it.
      expect(argv.some((a) => a.includes(join(workspaceRoot, 'packages')))).toBe(false);
      // Every mount source this argv asks the runtime to bind actually exists
      // — the concrete way "docker create would fail" is ruled out here.
      for (const src of mountSources(argv)) expect(existsSync(src)).toBe(true);
    });

    it("'link-entries': mounts nothing when the host directory does not exist", () => {
      const workspaceRoot = tempDir('link-missing-workspace');
      const sandbox = tempDir('link-missing-sandbox');

      const argv = buildCreateArgs(
        'c',
        sandbox,
        workspaceRoot,
        'link-entries',
        'typescript',
        config,
        'img',
      );

      expect(argv.filter((a) => a.startsWith('type=bind,') && a.includes('node_modules'))).toEqual(
        [],
      );
    });

    it("'copy': mounts nothing extra for node_modules — the copied tree is already inside the writable /workspace mount", () => {
      const workspaceRoot = tempDir('copy-host');
      const hostNodeModules = join(workspaceRoot, 'node_modules');
      mkdirSync(join(hostNodeModules, 'lodash'), { recursive: true });
      writeFileSync(join(hostNodeModules, 'lodash', 'index.js'), '');

      const sandbox = tempDir('copy-sandbox');
      cpSync(hostNodeModules, join(sandbox, 'node_modules'), { recursive: true });

      const argv = buildCreateArgs(
        'c',
        sandbox,
        workspaceRoot,
        'copy',
        'typescript',
        config,
        'img',
      );

      expect(argv.filter((a) => a.includes('node_modules'))).toEqual([]);
      // The whole sandbox (including its node_modules copy) is already
      // mounted at /workspace, and that mount is writable (no readonly flag).
      expect(argv).toContain(`type=bind,src=${sandbox},dst=/workspace`);
    });

    it("'copy': mounts nothing, even with TWO dependencies and a pnpm-style symlink fs.cp rebased onto its original host location among them", () => {
      // Verified end-to-end against the built artifact: the previous
      // (reverted) approach re-inspected the COPIED tree for symlinks even
      // under 'copy' mode, found the rebased pnpm-style symlink, and tried to
      // mount a truncated, nonexistent path derived from it — `docker create`
      // FAILED outright. A single-dependency fixture could not catch this: it
      // takes a second, ordinary dependency present alongside the symlinked
      // one to prove the fix doesn't merely mount the ONE it happens to find.
      // The correct behaviour under 'copy' needs no inspection at all: the
      // whole tree is already inside the writable /workspace mount.
      const workspaceRoot = tempDir('pnpm-host');
      const hostNodeModules = join(workspaceRoot, 'node_modules');
      mkdirSync(join(hostNodeModules, 'axios'), { recursive: true });
      writeFileSync(join(hostNodeModules, 'axios', 'index.js'), '');
      const hostPnpmStore = join(hostNodeModules, '.pnpm', 'lodash@1.0.0', 'node_modules');
      mkdirSync(join(hostPnpmStore, 'lodash'), { recursive: true });
      writeFileSync(join(hostPnpmStore, 'lodash', 'index.js'), '');
      symlinkSync(
        join('.pnpm', 'lodash@1.0.0', 'node_modules', 'lodash'),
        join(hostNodeModules, 'lodash'),
        'dir',
      );

      const sandbox = tempDir('pnpm-sandbox');
      cpSync(hostNodeModules, join(sandbox, 'node_modules'), { recursive: true });

      const argv = buildCreateArgs(
        'c',
        sandbox,
        workspaceRoot,
        'copy',
        'typescript',
        config,
        'img',
      );

      expect(argv.filter((a) => a.includes('node_modules'))).toEqual([]);
    });
  });

  describe('.venv (python)', () => {
    /**
     * `lib64 -> lib` is what every real `python3 -m venv` produces on Linux —
     * exactly the shape whose realpath-and-slice arithmetic silently
     * truncated to `<workspaceRoot>/.ve` under the reverted approach. Real,
     * not mocked: the bug was invisible to the earlier hand-built fixtures
     * that never included this symlink at all.
     */
    function makeVenv(root: string): string {
      const venv = join(root, '.venv');
      mkdirSync(join(venv, 'lib', 'python3.11', 'site-packages'), { recursive: true });
      symlinkSync('lib', join(venv, 'lib64'), 'dir');
      writeFileSync(join(venv, 'pyvenv.cfg'), '');
      return venv;
    }

    it("'share': PYTHONPATH/PATH reference the host virtualenv the sandbox symlinks to", () => {
      const workspaceRoot = tempDir('py-share-host');
      const hostVenv = makeVenv(workspaceRoot);

      const sandbox = tempDir('py-share-sandbox');
      symlinkSync(hostVenv, join(sandbox, '.venv'), 'dir');

      const argv = buildCreateArgs('c', sandbox, workspaceRoot, 'share', 'python', config, 'img');

      expect(argv).toContain(`PYTHONPATH=${hostVenv}/lib/python3.11/site-packages`);
      expect(argv.some((a) => a.startsWith('PATH=') && a.endsWith(`:${hostVenv}/bin`))).toBe(true);
    });

    it("'link-entries': mounts the workspace root's .venv directly (lib64 -> lib included) and PYTHONPATH/PATH reference it untruncated", () => {
      const workspaceRoot = tempDir('py-link-host');
      const hostVenv = makeVenv(workspaceRoot);

      const sandbox = tempDir('py-link-sandbox');
      linkDependencyEntries(hostVenv, join(sandbox, '.venv'));

      const argv = buildCreateArgs(
        'c',
        sandbox,
        workspaceRoot,
        'link-entries',
        'python',
        config,
        'img',
      );

      expect(argv).toContain(readonlyMount(hostVenv));
      expect(argv).toContain(`PYTHONPATH=${hostVenv}/lib/python3.11/site-packages`);
      expect(argv.some((a) => a.startsWith('PATH=') && a.endsWith(`:${hostVenv}/bin`))).toBe(true);
      // No truncated fragment (e.g. the reverted code's `<workspaceRoot>/.ve`)
      // reaches the argv, and every bind-mount source genuinely exists.
      for (const src of mountSources(argv)) expect(existsSync(src)).toBe(true);
      expect(argv.some((a) => a.includes('/.ve,') || a.endsWith('/.ve'))).toBe(false);
    });

    it("'copy': PYTHONPATH/PATH reference the GUEST /workspace path, not the host sandbox path, with lib64 -> lib present", () => {
      // Create-time --env values never pass through the exec-time
      // `guestValue` translation (execution.ts), so a bare sandbox-host path
      // here would be a dangling reference inside the container.
      const workspaceRoot = tempDir('py-copy-host');
      const hostVenv = makeVenv(workspaceRoot);

      const sandbox = tempDir('py-copy-sandbox');
      cpSync(hostVenv, join(sandbox, '.venv'), { recursive: true });

      const argv = buildCreateArgs('c', sandbox, workspaceRoot, 'copy', 'python', config, 'img');

      expect(argv).toContain('PYTHONPATH=/workspace/.venv/lib/python3.11/site-packages');
      expect(argv.some((a) => a.startsWith('PATH=') && a.endsWith(':/workspace/.venv/bin'))).toBe(
        true,
      );
      // No mount emitted for .venv — it is already inside /workspace.
      expect(argv.filter((a) => a.startsWith('type=bind') && a.includes('.venv'))).toEqual([]);
    });
  });
});
