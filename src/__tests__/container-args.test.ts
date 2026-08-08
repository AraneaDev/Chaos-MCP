import {
  cpSync,
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
 * `buildCreateArgs` (via `dependencyMountArgs`/`pythonEnvArgs`) has to tell
 * three different on-disk shapes of a sandbox dependency directory apart —
 * one per `DependencyMode` (utils/config/types.ts) — and produce the right
 * `--mount`/`--env` argv for each. Real filesystem fixtures throughout, no
 * `lstatSync`/`realpathSync` mocking: the bug this covers (link-entries, the
 * new DEFAULT sandbox shape, silently emitted no mount at all) was invisible
 * to the existing mocked-`readdirSync`-only tests above precisely because
 * they never modelled a real symlink tree.
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

  describe('node_modules (typescript)', () => {
    it("'share': mounts the whole host tree the sandbox symlinks to", () => {
      const host = tempDir('share-host');
      const hostNodeModules = join(host, 'node_modules');
      mkdirSync(join(hostNodeModules, 'lodash'), { recursive: true });
      writeFileSync(join(hostNodeModules, 'lodash', 'index.js'), '');

      const sandbox = tempDir('share-sandbox');
      symlinkSync(hostNodeModules, join(sandbox, 'node_modules'), 'dir');

      const argv = buildCreateArgs('c', sandbox, 'typescript', config, 'img');

      expect(argv).toContain(readonlyMount(hostNodeModules));
      expect(argv).toContain(`${hostNodeModules}/.vite-temp:rw,nosuid,nodev,size=16m`);
    });

    it("'link-entries' (the new default sandbox shape): resolves and mounts the SAME host tree via any one linked entry, including a scoped package", () => {
      // Regression for the finding this suite exists to cover: before this
      // fix, `dependencyMountArgs` only checked whether the top-level dir
      // ITSELF was a symlink. Under 'link-entries' it never is (the sandbox
      // owns a REAL directory of per-package symlinks), so no mount was ever
      // emitted and every entry symlink dangled inside the container.
      const host = tempDir('link-host');
      const hostNodeModules = join(host, 'node_modules');
      mkdirSync(join(hostNodeModules, 'lodash'), { recursive: true });
      writeFileSync(join(hostNodeModules, 'lodash', 'index.js'), '');
      mkdirSync(join(hostNodeModules, '@scope', 'pkg'), { recursive: true });
      writeFileSync(join(hostNodeModules, '@scope', 'pkg', 'index.js'), '');

      const sandbox = tempDir('link-sandbox');
      linkDependencyEntries(hostNodeModules, join(sandbox, 'node_modules'));

      const argv = buildCreateArgs('c', sandbox, 'typescript', config, 'img');

      expect(argv).toContain(readonlyMount(hostNodeModules));
      expect(argv).toContain(`${hostNodeModules}/.vite-temp:rw,nosuid,nodev,size=16m`);
    });

    it("'copy': mounts nothing extra for node_modules — the copied tree is already inside the writable /workspace mount", () => {
      const host = tempDir('copy-host');
      const hostNodeModules = join(host, 'node_modules');
      mkdirSync(join(hostNodeModules, 'lodash'), { recursive: true });
      writeFileSync(join(hostNodeModules, 'lodash', 'index.js'), '');

      const sandbox = tempDir('copy-sandbox');
      cpSync(hostNodeModules, join(sandbox, 'node_modules'), { recursive: true });

      const argv = buildCreateArgs('c', sandbox, 'typescript', config, 'img');

      expect(argv.filter((a) => a.includes('node_modules'))).toEqual([]);
      // The whole sandbox (including its node_modules copy) is already
      // mounted at /workspace, and that mount is writable (no readonly flag).
      expect(argv).toContain(`type=bind,src=${sandbox},dst=/workspace`);
    });

    it("'link-entries': treats an unreadable dependency directory the same as an empty one, without crashing", () => {
      // `findLinkedEntry`'s own readdirSync can fail independently of the
      // lstatSync that already got past (a node_modules that exists but
      // becomes unreadable in between, or an NFS permission edge case) — it
      // must degrade the same way an empty directory does, not throw.
      const sandbox = tempDir('unreadable-sandbox');
      mkdirSync(join(sandbox, 'node_modules'));

      vi.mocked(readdirSync).mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied');
      });

      const argv = buildCreateArgs('c', sandbox, 'typescript', config, 'img');

      expect(argv.filter((a) => a.startsWith('type=bind') && a.includes('node_modules'))).toEqual(
        [],
      );
    });

    it("'copy': still mounts a pnpm-style symlink fs.cp rebased onto its original host location", () => {
      // pnpm symlinks `node_modules/<pkg>` to
      // `node_modules/.pnpm/<pkg>@ver/node_modules/<pkg>` using a RELATIVE
      // target. `fs.cp`'s `dereference: false` (what 'copy' mode uses) copies
      // that symlink rather than dereferencing it — but, verified
      // empirically, it does NOT preserve the raw relative string: it
      // rebases the target onto the symlink's ORIGINAL (host) location, so
      // the copied symlink still points at the host's pnpm store, not at
      // the sandbox copy. That host directory genuinely needs a bind mount
      // for the symlink to resolve inside the container.
      const host = tempDir('pnpm-host');
      const hostNodeModules = join(host, 'node_modules');
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

      const argv = buildCreateArgs('c', sandbox, 'typescript', config, 'img');

      expect(argv).toContain(readonlyMount(hostPnpmStore));
    });
  });

  describe('.venv (python)', () => {
    function makeVenv(root: string): string {
      const venv = join(root, '.venv');
      mkdirSync(join(venv, 'lib', 'python3.11', 'site-packages'), { recursive: true });
      writeFileSync(join(venv, 'pyvenv.cfg'), '');
      return venv;
    }

    it("'share': PYTHONPATH/PATH reference the host virtualenv the sandbox symlinks to", () => {
      const host = tempDir('py-share-host');
      const hostVenv = makeVenv(host);

      const sandbox = tempDir('py-share-sandbox');
      symlinkSync(hostVenv, join(sandbox, '.venv'), 'dir');

      const argv = buildCreateArgs('c', sandbox, 'python', config, 'img');

      expect(argv).toContain(`PYTHONPATH=${hostVenv}/lib/python3.11/site-packages`);
      expect(argv.some((a) => a.startsWith('PATH=') && a.endsWith(`:${hostVenv}/bin`))).toBe(true);
    });

    it("'link-entries': PYTHONPATH/PATH reference the SAME host virtualenv, resolved through any one linked entry", () => {
      const host = tempDir('py-link-host');
      const hostVenv = makeVenv(host);

      const sandbox = tempDir('py-link-sandbox');
      linkDependencyEntries(hostVenv, join(sandbox, '.venv'));

      const argv = buildCreateArgs('c', sandbox, 'python', config, 'img');

      expect(argv).toContain(`PYTHONPATH=${hostVenv}/lib/python3.11/site-packages`);
      expect(argv.some((a) => a.startsWith('PATH=') && a.endsWith(`:${hostVenv}/bin`))).toBe(true);
    });

    it("'copy': PYTHONPATH/PATH reference the GUEST /workspace path, not the host sandbox path", () => {
      // Create-time --env values never pass through the exec-time
      // `guestValue` translation (execution.ts), so a bare sandbox-host path
      // here would be a dangling reference inside the container.
      const host = tempDir('py-copy-host');
      const hostVenv = makeVenv(host);

      const sandbox = tempDir('py-copy-sandbox');
      cpSync(hostVenv, join(sandbox, '.venv'), { recursive: true });

      const argv = buildCreateArgs('c', sandbox, 'python', config, 'img');

      expect(argv).toContain('PYTHONPATH=/workspace/.venv/lib/python3.11/site-packages');
      expect(argv.some((a) => a.startsWith('PATH=') && a.endsWith(':/workspace/.venv/bin'))).toBe(
        true,
      );
      // No mount emitted for .venv — it is already inside /workspace.
      expect(argv.filter((a) => a.startsWith('type=bind') && a.includes('.venv'))).toEqual([]);
    });
  });
});
