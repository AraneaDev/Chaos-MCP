import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `symlinkSync` is wrapped (not stubbed) so every test below still performs a
// REAL link by default — only the two failure-reporting tests below override
// it, and both restore the real implementation in their own `afterEach` so no
// other test in this file is affected. Every other bare-'fs' export passes
// straight through `importOriginal`, untouched.
//
// The restore reference below is fetched via `vi.importActual`, NOT a
// `node:fs` import: Vite/Vitest resolve `node:fs` and `fs` to the SAME module
// record, so a `node:fs` import of `symlinkSync` in a file that mocks bare
// `fs` would resolve to this very mock — calling it from inside its own
// override would recurse into itself instead of reaching the real syscall.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    symlinkSync: vi.fn(actual.symlinkSync),
    readdirSync: vi.fn(actual.readdirSync),
  };
});

// `warn()` writes to stderr unconditionally (see utils/logger.ts) — mocked so
// the two failure-reporting tests can assert on it without printing to the
// test run's own stderr.
vi.mock('../utils/logger.js', () => ({
  log: vi.fn(),
  isVerbose: vi.fn(() => false),
  warn: vi.fn(),
}));

import { symlinkSync, readdirSync } from 'fs';
import { warn } from '../utils/logger.js';
import { linkDependencyEntries, isSymlink } from '../utils/sandbox/dependency-link.js';

const mockedSymlinkSync = vi.mocked(symlinkSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedWarn = vi.mocked(warn);
let realSymlinkSync: typeof import('fs').symlinkSync;
let realReaddirSync: typeof import('fs').readdirSync;

describe('linkDependencyEntries', () => {
  let root: string;
  let host: string;
  let sandbox: string;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    realSymlinkSync = actual.symlinkSync;
    realReaddirSync = actual.readdirSync;
  });

  beforeEach(() => {
    mockedWarn.mockClear();
    root = mkdtempSync(join(tmpdir(), 'chaos-deplink-'));
    host = join(root, 'host');
    sandbox = join(root, 'sandbox', 'node_modules');
    mkdirSync(join(host, 'plain'), { recursive: true });
    mkdirSync(join(host, '@scope', 'pkg'), { recursive: true });
    writeFileSync(join(host, 'plain', 'index.js'), 'plain\n');
    writeFileSync(join(host, '@scope', 'pkg', 'index.js'), 'scoped\n');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('makes the dependency directory itself real, not a symlink', () => {
    linkDependencyEntries(host, sandbox);
    expect(lstatSync(sandbox).isSymbolicLink()).toBe(false);
    expect(lstatSync(sandbox).isDirectory()).toBe(true);
  });

  it('links each top-level entry so packages still resolve', () => {
    linkDependencyEntries(host, sandbox);
    expect(lstatSync(join(sandbox, 'plain')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(sandbox, 'plain', 'index.js'), 'utf8')).toBe('plain\n');
  });

  it('recurses one level into a scope directory so a new scoped package lands locally', () => {
    linkDependencyEntries(host, sandbox);
    expect(lstatSync(join(sandbox, '@scope')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(sandbox, '@scope', 'pkg')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(sandbox, '@scope', 'pkg', 'index.js'), 'utf8')).toBe('scoped\n');
  });

  it('leaves an entry that already exists in the sandbox alone', () => {
    mkdirSync(join(sandbox, 'plain'), { recursive: true });
    writeFileSync(join(sandbox, 'plain', 'index.js'), 'copied\n');
    linkDependencyEntries(host, sandbox);
    expect(lstatSync(join(sandbox, 'plain')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(sandbox, 'plain', 'index.js'), 'utf8')).toBe('copied\n');
  });

  it('is a no-op when the host directory does not exist', () => {
    expect(() => linkDependencyEntries(join(root, 'absent'), sandbox)).not.toThrow();
  });

  it('isSymlink distinguishes a linked entry from a real dir and a missing path', () => {
    linkDependencyEntries(host, sandbox);
    expect(isSymlink(join(sandbox, 'plain'))).toBe(true);
    expect(isSymlink(sandbox)).toBe(false); // real directory, not a symlink
    expect(isSymlink(join(sandbox, 'does-not-exist'))).toBe(false); // lstatSync throws
  });

  it("passes the entry's real type through to symlinkSync instead of hard-coding 'dir'", () => {
    // .venv/pyvenv.cfg, node_modules/.package-lock.json — entry-level linking
    // reaches plain files, not just directories. A 'dir'-typed symlink to a
    // file is broken on Windows (finding 2).
    writeFileSync(join(host, 'plain-file.txt'), 'x\n');

    linkDependencyEntries(host, sandbox);

    const calls = mockedSymlinkSync.mock.calls.map((c) => [String(c[0]), c[2]]);
    expect(calls).toContainEqual([join(host, 'plain'), 'dir']);
    expect(calls).toContainEqual([join(host, 'plain-file.txt'), 'file']);
  });

  describe('failure reporting (finding 1: best-effort must not mean silent)', () => {
    afterEach(() => {
      // Restore the real implementations so no later test in this file (or in
      // this describe block's own next case) inherits a stubbed symlinkSync /
      // readdirSync.
      mockedSymlinkSync.mockImplementation(realSymlinkSync);
      mockedReaddirSync.mockImplementation(realReaddirSync);
    });

    it('warns when the host dependency directory cannot be read', () => {
      // A file (not a directory) makes the real readdirSync fail with ENOTDIR
      // — a genuine, deterministic filesystem error, no mocking required. This
      // is the shape of the "existsSync just confirmed it, but readdir fails
      // anyway" scenario the finding describes (e.g. a permission-denied
      // node_modules): the directory is there, but unreadable.
      const unreadable = join(root, 'unreadable-file');
      writeFileSync(unreadable, 'not a directory\n');

      expect(() => linkDependencyEntries(unreadable, sandbox)).not.toThrow();

      expect(mockedWarn).toHaveBeenCalledWith(expect.stringContaining(unreadable));
    });

    it('falls back to String(error) when readdirSync throws a non-Error value', () => {
      mockedReaddirSync.mockImplementationOnce(() => {
        // Deliberately non-Error, to cover the `String(error)` defensive fallback.
        throw 'boom';
      });

      expect(() => linkDependencyEntries(host, sandbox)).not.toThrow();

      expect(mockedWarn).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });

    it('warns when every entry in a directory fails to link, so the failure is not silent', () => {
      // Simulates an NFS root_squash / permission-denied workspace where
      // EVERY symlinkSync throws: createSandbox must not resolve as if the
      // dependency tree were intact, because the engine's next "module not
      // found" would otherwise be misdiagnosed as a bug in the audited code.
      mockedSymlinkSync.mockImplementation(() => {
        throw Object.assign(new Error('EPERM: operation not permitted, symlink'), {
          code: 'EPERM',
        });
      });

      linkDependencyEntries(host, sandbox);

      // Nothing actually got linked.
      expect(isSymlink(join(sandbox, 'plain'))).toBe(false);
      // At least one warning names the affected directory and reports 0 linked.
      const messages = mockedWarn.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes(host) && m.includes('0 of'))).toBe(true);
      expect(messages.some((m) => m.includes('provisioning problem'))).toBe(true);
    });

    it('warns (without treating it as total failure) when only some entries fail to link', () => {
      // A second top-level entry alongside 'plain' so a deterministic failure
      // of exactly ONE of them is genuinely partial at this directory's own
      // level — 'plain' alone would make host's own count 0-of-1, which is
      // indistinguishable from a wholesale failure (see the test above).
      mkdirSync(join(host, 'other'), { recursive: true });
      writeFileSync(join(host, 'other', 'index.js'), 'other\n');
      // Fail only 'plain', deterministically by target path rather than call
      // order — readdirSync's entry order (and therefore which symlinkSync
      // call is "first") is not something this test should depend on.
      const failingTarget = join(host, 'plain');
      mockedSymlinkSync.mockImplementation(((target: unknown, path: unknown, type: unknown) => {
        if (String(target) === failingTarget) {
          throw Object.assign(new Error('EPERM: operation not permitted, symlink'), {
            code: 'EPERM',
          });
        }
        return realSymlinkSync(target as never, path as never, type as never);
      }) as typeof symlinkSync);

      linkDependencyEntries(host, sandbox);

      // The unaffected entry still linked.
      expect(isSymlink(join(sandbox, 'other'))).toBe(true);
      const messages = mockedWarn.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes(host) && m.includes('1 of 2'))).toBe(true);
      expect(messages.some((m) => m.includes('provisioning problem'))).toBe(false);
    });
  });
});
