import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

import { discoverSitePackages, SHARED_DEPENDENCY_DIRS } from '../utils/container/args.js';
import { dependencyDirectories } from '../engines/registry.js';

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
