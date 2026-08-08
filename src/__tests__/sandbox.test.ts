import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs module (sync exports only — async fs.cp lives in fs/promises).
//
// `realpathSync` defaults to identity so the post-copy containment check
// (assertTargetInsideSandbox) sees a target that genuinely lives in the sandbox,
// which is the normal case every test below exercises. Tests covering the
// symlink-escape guard override it.
vi.mock('fs', () => ({
  mkdtempSync: vi.fn(),
  symlinkSync: vi.fn(),
  rmSync: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
  realpathSync: vi.fn((p: unknown) => String(p)),
}));

// Mock fs/promises — cp is the audit C1 async copy primitive, and readdir is
// the pre-copy size walk's directory reader (Med#17: the walk is async so an
// abort can actually land in the middle of it).
vi.mock('fs/promises', () => ({
  cp: vi.fn(),
  readdir: vi.fn(),
}));

// Mock crypto
vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => '00000000-0000-0000-0000-000000000000'),
}));

// Mock os
vi.mock('os', () => ({
  tmpdir: vi.fn(() => '/tmp'),
}));

// Partial mock of the process reaper: the real reaping helpers would signal
// pids, so wrap them to assert the sandbox calls them at the right moment
// instead.
vi.mock('../utils/process-reaper.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/process-reaper.js')>();
  return {
    ...actual,
    killProcessesUnder: vi.fn(() => 0),
    killAllTrackedProcesses: vi.fn(() => 0),
  };
});

// Mock logger
vi.mock('../utils/logger.js', () => ({
  log: vi.fn(),
  isVerbose: vi.fn(() => false),
  warn: vi.fn(),
}));

import { mkdtempSync, symlinkSync, rmSync, existsSync, statSync, readdirSync, mkdirSync } from 'fs';
import type { PathLike } from 'fs';
import { cp, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { resolve, join, sep } from 'path';
import { createSandbox, SandboxContext } from '../utils/sandbox.js';
import { safeSymlink } from '../utils/sandbox/dependency-link.js';
import { buildCopyPolicy, SYMLINK_DIRS } from '../utils/sandbox/copy-policy.js';
import { ENGINE_REGISTRY, dependencyDirectories } from '../engines/registry.js';
import { killProcessesUnder, killAllTrackedProcesses } from '../utils/process-reaper.js';
import { ALLOWED_ROOTS_ENV } from '../utils/path-safety.js';

// Test workspace root — must resolve inside the test process cwd because
// createSandbox now refuses workspaces that escape cwd (audit finding C2).
const TEST_PROJECT = resolve(process.cwd(), 'sandbox-test-project');
// Common paths used across multiple tests (backtick template literals —
// do not single-quote or the interpolation stops working).
const TEST_PROJECT_NODE_MODULES = `${TEST_PROJECT}/node_modules`;
const TEST_PROJECT_VENV = `${TEST_PROJECT}/.venv`;
const TEST_PROJECT_TARGET = `${TEST_PROJECT}/target`;
const TEST_PROJECT_VENDOR = `${TEST_PROJECT}/vendor`;

const mockMkdtempSync = vi.mocked(mkdtempSync);
const mockCp = vi.mocked(cp);
const mockReaddir = vi.mocked(readdir);
const mockSymlinkSync = vi.mocked(symlinkSync);
const mockRmSync = vi.mocked(rmSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockTmpdir = vi.mocked(tmpdir);

const SANDBOX_DIR = '/tmp/chaos-mcp-00000000-0000-0000-0000-000000000000';
const mockKillUnder = vi.mocked(killProcessesUnder);
const mockKillAll = vi.mocked(killAllTrackedProcesses);

describe('createSandbox', () => {
  let sandbox: SandboxContext;

  // Snapshot the ambient allow-list once, and reset to a clean (unset) state
  // before every case so a test that sets it cannot widen the boundary for the
  // cwd-rejection cases that follow it.
  const originalAllowedRoots = process.env[ALLOWED_ROOTS_ENV];
  afterEach(() => {
    if (originalAllowedRoots === undefined) Reflect.deleteProperty(process.env, ALLOWED_ROOTS_ENV);
    else process.env[ALLOWED_ROOTS_ENV] = originalAllowedRoots;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Reflect.deleteProperty(process.env, ALLOWED_ROOTS_ENV);
    mockTmpdir.mockReturnValue('/tmp');
    mockMkdtempSync.mockReturnValue(SANDBOX_DIR);
    // Default: cp resolves to undefined (mimics successful copy).
    mockCp.mockResolvedValue(undefined as never);
    // Default: no dependency entries to link. linkDependencyEntries calls
    // readdirSync unconditionally whenever a symlink dir's source exists (see
    // the default existsSync below, which makes node_modules "exist"), so
    // without this every such test would iterate `undefined` and throw.
    mockReaddirSync.mockReturnValue([]);

    // Default: target file exists, node_modules exists
    mockExistsSync.mockImplementation((path: PathLike) => {
      if (path === `${SANDBOX_DIR}/src/utils/math.ts`) return true;
      if (path === TEST_PROJECT_NODE_MODULES) return true;
      return false;
    });
  });

  it('creates a sandbox directory using os.tmpdir()', async () => {
    mockTmpdir.mockReturnValue('/custom/tmp');
    mockMkdtempSync.mockReturnValue('/custom/tmp/chaos-mcp-00000000-0000-0000-0000-000000000000');
    mockExistsSync.mockImplementation((path: PathLike) => {
      return (
        path === '/custom/tmp/chaos-mcp-00000000-0000-0000-0000-000000000000/src/utils/math.ts'
      );
    });

    sandbox = await createSandbox('src/utils/math.ts', TEST_PROJECT);

    expect(mockMkdtempSync).toHaveBeenCalledWith(
      '/custom/tmp/chaos-mcp-00000000-0000-0000-0000-000000000000',
    );
  });

  it('returns context with workDir, targetFile, and cleanup', async () => {
    sandbox = await createSandbox('src/utils/math.ts', TEST_PROJECT);

    expect(sandbox.workDir).toBe(SANDBOX_DIR);
    expect(sandbox.targetFile).toBe('src/utils/math.ts');
    expect(typeof sandbox.cleanup).toBe('function');
  });

  it('copies the workspace tree to sandbox via fs.cp', async () => {
    sandbox = await createSandbox('src/utils/math.ts', TEST_PROJECT);

    expect(mockCp).toHaveBeenCalledWith(TEST_PROJECT, SANDBOX_DIR, {
      recursive: true,
      filter: expect.any(Function),
      dereference: false,
    });
  });

  it('symlinks node_modules into sandbox', async () => {
    mockExistsSync.mockImplementation((path: PathLike) => {
      if (path === `${SANDBOX_DIR}/src/utils/math.ts`) return true;
      if (path === TEST_PROJECT_NODE_MODULES) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([{ name: 'somepkg', isDirectory: () => true }] as never);

    sandbox = await createSandbox('src/utils/math.ts', TEST_PROJECT);

    expect(mockMkdirSync).toHaveBeenCalledWith(`${SANDBOX_DIR}/node_modules`, {
      recursive: true,
    });
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      join(TEST_PROJECT_NODE_MODULES, 'somepkg'),
      join(`${SANDBOX_DIR}/node_modules`, 'somepkg'),
      'dir',
    );
  });

  it('symlinks .venv into sandbox when present', async () => {
    mockExistsSync.mockImplementation((path: PathLike) => {
      if (path === `${SANDBOX_DIR}/src/main.py`) return true;
      if (path === TEST_PROJECT_VENV) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([{ name: 'somepkg', isDirectory: () => true }] as never);

    sandbox = await createSandbox('src/main.py', TEST_PROJECT);

    expect(mockSymlinkSync).toHaveBeenCalledWith(
      join(TEST_PROJECT_VENV, 'somepkg'),
      join(`${SANDBOX_DIR}/.venv`, 'somepkg'),
      'dir',
    );
  });

  it('symlinks vendor into sandbox when present', async () => {
    mockExistsSync.mockImplementation((path: PathLike) => {
      if (path === `${SANDBOX_DIR}/src/Calculator.php`) return true;
      if (path === TEST_PROJECT_VENDOR) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([{ name: 'somepkg', isDirectory: () => true }] as never);

    sandbox = await createSandbox('src/Calculator.php', TEST_PROJECT);

    expect(mockSymlinkSync).toHaveBeenCalledWith(
      join(TEST_PROJECT_VENDOR, 'somepkg'),
      join(`${SANDBOX_DIR}/vendor`, 'somepkg'),
      'dir',
    );
  });

  it('COPIES vendor (does not symlink) for a Composer PHP audit — isolation + EEXIST regression', async () => {
    // Composer's autoloader derives its base dir from __DIR__, which PHP
    // resolves THROUGH symlinks back to the real project. A symlinked vendor/
    // would make PHPUnit/Infection load the ORIGINAL source instead of the
    // sandbox copy, silently invalidating mutation testing. So for a Composer
    // PHP audit vendor/ must be COPIED, not symlinked — which also means the
    // copy+symlink collision (EEXIST) that failed every PHP project cannot
    // occur, because vendor is never symlinked.
    mockExistsSync.mockImplementation((path: PathLike) => {
      if (path === `${SANDBOX_DIR}/src/Calculator.php`) return true;
      if (path === TEST_PROJECT_VENDOR) return true;
      if (path === `${TEST_PROJECT}/composer.json`) return true; // marks a Composer project
      return false;
    });

    await createSandbox('src/Calculator.php', TEST_PROJECT);

    // vendor is COPIED (filter includes it), not excluded.
    const filter = mockCp.mock.calls[0][2]?.filter as (src: string) => boolean;
    expect(filter).toBeDefined();
    expect(filter(`${TEST_PROJECT}/vendor`)).toBe(true);
    // ...and vendor is NOT symlinked, so no EEXIST collision is possible.
    const symlinkedDsts = mockSymlinkSync.mock.calls.map((c) => c[1]);
    expect(symlinkedDsts).not.toContain(`${SANDBOX_DIR}/vendor`);
  });

  it('treats an UPPERCASE .PHP target as a Composer audit too', async () => {
    // The extension test delegates to `phpDetector.matches`, which is
    // case-SENSITIVE by contract; `isComposerPhpAudit` lowercases the path
    // first. On case-insensitive filesystems `Calculator.PHP` is a legal
    // spelling of the same file, and losing the lowercase step would send it
    // down the symlinked-vendor path — where Composer's `__DIR__` escapes the
    // sandbox and Infection reports "No source code … was executed". This pins
    // the lowercasing so a future refactor of the detector call cannot drop it.
    mockExistsSync.mockImplementation((path: PathLike) => {
      if (path === `${SANDBOX_DIR}/src/Calculator.PHP`) return true;
      if (path === TEST_PROJECT_VENDOR) return true;
      if (path === `${TEST_PROJECT}/composer.json`) return true;
      return false;
    });

    await createSandbox('src/Calculator.PHP', TEST_PROJECT);

    const filter = mockCp.mock.calls[0][2]?.filter as (src: string) => boolean;
    expect(filter(`${TEST_PROJECT}/vendor`)).toBe(true);
    const symlinkedDsts = mockSymlinkSync.mock.calls.map((c) => c[1]);
    expect(symlinkedDsts).not.toContain(`${SANDBOX_DIR}/vendor`);
  });

  it('symlinks vendor for a NON-Composer .php audit (no composer.json marker)', async () => {
    // Without a Composer marker (composer.json / vendor/composer) there is no
    // autoloader-through-symlink hazard, so vendor keeps the cheap symlink path
    // and is excluded from the copy (symlinked ⇔ not copied).
    mockExistsSync.mockImplementation((path: PathLike) => {
      if (path === `${SANDBOX_DIR}/src/Calculator.php`) return true;
      if (path === TEST_PROJECT_VENDOR) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([{ name: 'somepkg', isDirectory: () => true }] as never);

    await createSandbox('src/Calculator.php', TEST_PROJECT);

    expect(mockSymlinkSync).toHaveBeenCalledWith(
      join(TEST_PROJECT_VENDOR, 'somepkg'),
      join(`${SANDBOX_DIR}/vendor`, 'somepkg'),
      'dir',
    );
    const filter = mockCp.mock.calls[0][2]?.filter as (src: string) => boolean;
    expect(filter(`${TEST_PROJECT}/vendor`)).toBe(false);
  });

  // ─── Target INSIDE a symlinked heavyweight dir ─────────────────────────────
  //
  // The copy filter force-includes the target and every ancestor BEFORE it
  // checks the symlink-dir list, so a target under vendor/ (or node_modules/,
  // .venv/, venv/) makes `cp` materialise that whole directory. `linkHeavyDirs`
  // still calls `linkDependencyEntries` on it — a bare-directory EEXIST is no
  // longer even possible (nothing symlinks the directory itself any more), and
  // the interesting behaviour is now per entry: linkDependencyEntries's own
  // `existsSync(dst)` guard leaves an already-copied entry alone, and links in
  // any entry the copy DIDN'T produce (e.g. one an ignorePattern excluded),
  // completing a partially-materialised directory instead of leaving it with a
  // silent gap.

  it('completes a force-copied vendor/: leaves copied entries alone, links entries the copy skipped', async () => {
    // A JS/TS repo that vendors first-party code: vendor/ is in SYMLINK_DIRS
    // (no Composer marker here, so it is NOT the isComposerPhpAudit path), yet
    // the target's ancestors force it into the copy.
    const target = 'vendor/my-lib/index.ts';
    const copiedEntryDst = `${SANDBOX_DIR}/vendor/my-lib`;
    const skippedEntryDst = `${SANDBOX_DIR}/vendor/sibling-pkg`;
    mockExistsSync.mockImplementation((path: PathLike) => {
      if (path === `${SANDBOX_DIR}/${target}`) return true;
      if (path === TEST_PROJECT_VENDOR) return true;
      // Step 1 already materialised vendor/ AND my-lib/ inside the sandbox...
      if (path === `${SANDBOX_DIR}/vendor`) return true;
      if (path === copiedEntryDst) return true;
      // ...but not sibling-pkg/ — say, excluded by an ignorePattern, or any
      // other reason the copy didn't produce this one entry.
      return false;
    });
    mockReaddirSync.mockReturnValue([
      { name: 'my-lib', isDirectory: () => true },
      { name: 'sibling-pkg', isDirectory: () => true },
    ] as never);

    await expect(createSandbox(target, TEST_PROJECT)).resolves.toBeDefined();

    const symlinkedDsts = mockSymlinkSync.mock.calls.map((c) => String(c[1]));
    // Already-copied entry: left alone, not relinked.
    expect(symlinkedDsts).not.toContain(copiedEntryDst);
    // Entry the copy skipped: completed via a host symlink rather than left
    // silently missing from the sandbox.
    expect(symlinkedDsts).toContain(skippedEntryDst);
  });

  it('force-includes vendor/ in the copy when the target lives under it', async () => {
    // The other half of the invariant: skipping the symlink is only safe
    // because the copy really does materialise the directory.
    const target = 'vendor/my-lib/index.ts';
    mockExistsSync.mockImplementation((path: PathLike) => {
      if (path === `${SANDBOX_DIR}/${target}`) return true;
      if (path === TEST_PROJECT_VENDOR) return true;
      if (path === `${SANDBOX_DIR}/vendor`) return true;
      return false;
    });

    await createSandbox(target, TEST_PROJECT);

    const filter = mockCp.mock.calls[0][2]?.filter as (src: string) => boolean;
    expect(filter(TEST_PROJECT_VENDOR)).toBe(true);
    expect(filter(`${TEST_PROJECT}/vendor/my-lib`)).toBe(true);
    expect(filter(`${TEST_PROJECT}/vendor/my-lib/index.ts`)).toBe(true);
    // A sibling package inside vendor/ is copied too — the directory is
    // materialised whole, which is why the sandbox is complete without a link.
    expect(filter(`${TEST_PROJECT}/vendor/other-lib/lib.ts`)).toBe(true);
  });

  it('leaves an already-copied entry alone when the target lives inside node_modules/', async () => {
    const target = 'node_modules/@acme/widget/src/index.ts';
    // The target's own ancestor chain — including the @acme scope dir — was
    // materialised by the copy (force-include), so this entry must be left
    // exactly as the copy produced it.
    const copiedEntryDst = `${SANDBOX_DIR}/node_modules/@acme`;
    mockExistsSync.mockImplementation((path: PathLike) => {
      if (path === `${SANDBOX_DIR}/${target}`) return true;
      if (path === TEST_PROJECT_NODE_MODULES) return true;
      if (path === `${SANDBOX_DIR}/node_modules`) return true;
      if (path === copiedEntryDst) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([{ name: '@acme', isDirectory: () => true }] as never);

    await expect(createSandbox(target, TEST_PROJECT)).resolves.toBeDefined();

    const symlinkedDsts = mockSymlinkSync.mock.calls.map((c) => String(c[1]));
    expect(symlinkedDsts).not.toContain(copiedEntryDst);
  });

  it('leaves an already-copied entry alone inside a NESTED heavyweight dir', async () => {
    // Defensive counterpart of the root-level test above: the SECOND loop in
    // linkHeavyDirs (nested occurrences recorded in skippedHeavyDirs, e.g.
    // workers/typescript/node_modules) must honour the same per-entry
    // existsSync(dst) guard as the top-level SYMLINK_DIRS loop, not just link
    // blindly because it takes a different code path to get there.
    const nested = `${TEST_PROJECT}/workers/typescript/node_modules`;
    const nestedDst = `${SANDBOX_DIR}/workers/typescript/node_modules`;
    const copiedEntryDst = `${nestedDst}/somepkg`;
    mockExistsSync.mockImplementation((path: PathLike) => {
      if (path === `${SANDBOX_DIR}/src/utils/math.ts`) return true;
      if (path === nested) return true;
      if (path === nestedDst) return true;
      if (path === copiedEntryDst) return true; // already materialised by the copy
      return false;
    });
    mockCp.mockImplementation((async (
      _s: string,
      _d: string,
      opts: { filter: (src: string) => boolean },
    ) => {
      opts.filter(nested); // records it in skippedHeavyDirs
    }) as never);
    mockReaddirSync.mockReturnValue([{ name: 'somepkg', isDirectory: () => true }] as never);

    await expect(createSandbox('src/utils/math.ts', TEST_PROJECT)).resolves.toBeDefined();

    const symlinkedDsts = mockSymlinkSync.mock.calls.map((c) => String(c[1]));
    expect(symlinkedDsts).not.toContain(copiedEntryDst);
  });

  it('refuses to sandbox when workspace resolves outside process cwd (C2)', async () => {
    // /etc is an absolute path that escapes the test cwd.
    await expect(createSandbox('src/utils/math.ts', '/etc')).rejects.toThrow(
      /Refusing to sandbox workspace outside process cwd/,
    );
    // Also pin the second half of the message so its string literal is covered.
    await expect(createSandbox('src/utils/math.ts', '/etc')).rejects.toThrow(/is not inside/);
  });

  it('does not create a temp dir when the cwd-boundary guard trips (M4)', async () => {
    // Audit M4: previously mkdtempSync ran before the isPathInside check, so
    // a boundary-guard trip left an empty, untracked temp dir on disk. The
    // check must now run first, so mkdtempSync is never even called.
    mockMkdtempSync.mockClear();

    await expect(createSandbox('src/utils/math.ts', '/etc')).rejects.toThrow(
      /Refusing to sandbox workspace outside process cwd/,
    );

    expect(mockMkdtempSync).not.toHaveBeenCalled();
    // Nothing was created, so there is nothing to clean up either.
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('accepts sandbox when workspace equals process cwd (Live-audit L1)', async () => {
    // Previously `isPathInside(absoluteWorkspace, absoluteCwd)` returned false
    // when the two paths were equal (rel === ''). This blocked the legitimate
    // case where the user's workspace IS the cwd (the most common case).
    const cwd = process.cwd();
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts` || path === cwd;
    });

    await expect(createSandbox('src/utils/math.ts', cwd)).resolves.toBeDefined();
  });

  it('strips trailing separator from ignorePatterns (Live-audit L2)', async () => {
    // Convention `["fixtures/"]` should exclude the `fixtures` directory
    // segment, not silently fail because the segment lacks the trailing slash.
    mockExistsSync.mockImplementation((path: PathLike) => {
      if (path === `${SANDBOX_DIR}/src/utils/math.ts`) return true;
      return false;
    });

    await createSandbox('src/utils/math.ts', TEST_PROJECT, ['fixtures/']);

    const filter = mockCp.mock.calls[0][2]?.filter as (src: string) => boolean;
    expect(filter).toBeDefined();

    // `fixtures` segment should be excluded
    expect(filter(`${TEST_PROJECT}/fixtures/data.json`)).toBe(false);
    // Regular files should still be included
    expect(filter(`${TEST_PROJECT}/src/utils/math.ts`)).toBe(true);
  });

  it('never excludes the target file or its ancestor dirs, even under an excluded name', async () => {
    // 'build' is in ALWAYS_EXCLUDE, but here it is an ancestor of the audited
    // target. Excluding it would drop the file and fail provisioning. The
    // target and every directory on the path to it must be force-included.
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/build/gen.ts`;
    });

    await createSandbox('build/gen.ts', TEST_PROJECT);

    const filter = mockCp.mock.calls[0][2]?.filter as (src: string) => boolean;
    expect(filter(`${TEST_PROJECT}/build`)).toBe(true);
    expect(filter(`${TEST_PROJECT}/build/gen.ts`)).toBe(true);
    // A different 'build' dir that is NOT on the path to the target stays excluded.
    expect(filter(`${TEST_PROJECT}/src/build`)).toBe(false);
  });

  it('never excludes the target when an ignorePattern matches an ancestor segment', async () => {
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/fixtures/keep.ts`;
    });

    await createSandbox('fixtures/keep.ts', TEST_PROJECT, ['fixtures']);

    const filter = mockCp.mock.calls[0][2]?.filter as (src: string) => boolean;
    expect(filter(`${TEST_PROJECT}/fixtures`)).toBe(true);
    expect(filter(`${TEST_PROJECT}/fixtures/keep.ts`)).toBe(true);
    // An unrelated 'fixtures' dir is still excluded.
    expect(filter(`${TEST_PROJECT}/other/fixtures`)).toBe(false);
  });

  it('does NOT symlink target/ for Rust builds (H1 regression)', async () => {
    // Audit finding H1: target/ contains Rust build artifacts. Symlinking
    // would let mutation runs corrupt the host workspace's build cache.
    // The sandbox must exclude target/ outright (always) instead of symlinking.
    mockExistsSync.mockImplementation((path: PathLike) => {
      if (path === `${SANDBOX_DIR}/src/main.rs`) return true;
      if (path === TEST_PROJECT_TARGET) return true;
      return false;
    });

    sandbox = await createSandbox('src/main.rs', TEST_PROJECT);

    // symlinkSync must NOT be called for `target`.
    const symlinked = mockSymlinkSync.mock.calls.map((call) => call[1]);
    expect(symlinked).not.toContain(`${SANDBOX_DIR}/target`);
  });

  it('excludes by segment match, not substring match (M6 regression)', async () => {
    // Audit finding M6: substring matching over-eagerly excludes files whose
    // path contains the pattern anywhere. Segment matching only excludes when
    // a single path segment equals the pattern.
    mockExistsSync.mockImplementation((path: PathLike) => {
      if (path === `${SANDBOX_DIR}/src/utils/math.ts`) return true;
      return false;
    });

    await createSandbox('src/utils/math.ts', TEST_PROJECT, ['test']);

    const filter = mockCp.mock.calls[0][2]?.filter as (src: string) => boolean;
    expect(filter).toBeDefined();

    // `latest.ts` contains 'test' as a substring but has no segment named 'test'.
    // Pre-M6 this was incorrectly excluded; post-M6 it is correctly included.
    expect(filter(`${TEST_PROJECT}/src/latest.ts`)).toBe(true);

    // A directory segment equal to `test` IS excluded.
    expect(filter(`${TEST_PROJECT}/test/file.ts`)).toBe(false);
  });

  it('skips symlinks for directories that do not exist', async () => {
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    sandbox = await createSandbox('src/utils/math.ts', TEST_PROJECT);

    expect(mockSymlinkSync).not.toHaveBeenCalled();
  });

  it('throws when target file does not exist in sandbox', async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(createSandbox('src/utils/math.ts', TEST_PROJECT)).rejects.toThrow(
      /Sandbox provisioning failed/,
    );
    // Pin the rest of the message (target filename + workspace root) so its
    // string literals are covered.
    await expect(createSandbox('src/utils/math.ts', TEST_PROJECT)).rejects.toThrow(
      /target file "src\/utils\/math\.ts" was not found in the copied workspace/,
    );
    // The second line of the message (its own string literal).
    await expect(createSandbox('src/utils/math.ts', TEST_PROJECT)).rejects.toThrow(
      new RegExp(`Workspace root: ${TEST_PROJECT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  });

  it('cleans up temp dir on provisioning failure', async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(createSandbox('src/utils/math.ts', TEST_PROJECT)).rejects.toThrow();

    expect(mockRmSync).toHaveBeenCalledWith(SANDBOX_DIR, { recursive: true, force: true });
  });

  it('cleanup() removes sandbox directory', async () => {
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    sandbox = await createSandbox('src/utils/math.ts', TEST_PROJECT);
    sandbox.cleanup();

    expect(mockRmSync).toHaveBeenCalledWith(SANDBOX_DIR, { recursive: true, force: true });
  });

  it('kills the engine processes running in the sandbox BEFORE deleting it', async () => {
    // Order is the whole point. Removing the directory does not stop a `vitest`
    // executing inside it — it just leaves it running against a path that no
    // longer exists, holding memory until someone notices. Kill first.
    mockKillUnder.mockClear();
    mockRmSync.mockClear();
    sandbox = await createSandbox('src/utils/math.ts', TEST_PROJECT);

    sandbox.cleanup();

    expect(mockKillUnder).toHaveBeenCalledWith(SANDBOX_DIR);
    expect(mockKillUnder.mock.invocationCallOrder[0]).toBeLessThan(
      mockRmSync.mock.invocationCallOrder[0],
    );
  });

  it('reaps only its OWN sandbox, not every running engine', async () => {
    // A triage sweep tears sandboxes down while its siblings are still
    // auditing; a global kill here would abort the rest of the run.
    mockKillUnder.mockClear();
    mockKillAll.mockClear();
    sandbox = await createSandbox('src/utils/math.ts', TEST_PROJECT);

    sandbox.cleanup();

    expect(mockKillUnder).toHaveBeenCalledTimes(1);
    expect(mockKillAll).not.toHaveBeenCalled();
  });

  it('cleanup() swallows errors gracefully', async () => {
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    mockRmSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });

    sandbox = await createSandbox('src/utils/math.ts', TEST_PROJECT);

    expect(() => sandbox.cleanup()).not.toThrow();
  });

  it('filter excludes node_modules, .git, target, and generated dirs', async () => {
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await createSandbox('src/utils/math.ts', TEST_PROJECT);

    const filter = mockCp.mock.calls[0][2]?.filter as (src: string) => boolean;
    expect(filter).toBeDefined();

    expect(filter(`${TEST_PROJECT}/node_modules`)).toBe(false);
    expect(filter(`${TEST_PROJECT}/.git`)).toBe(false);
    expect(filter(`${TEST_PROJECT}/.stryker-tmp`)).toBe(false);
    expect(filter(`${TEST_PROJECT}/.mutmut-cache`)).toBe(false);
    expect(filter(`${TEST_PROJECT}/__pycache__`)).toBe(false);
    expect(filter(`${TEST_PROJECT}/.venv`)).toBe(false);
    expect(filter(`${TEST_PROJECT}/venv`)).toBe(false);
    expect(filter(`${TEST_PROJECT}/dist`)).toBe(false);
    expect(filter(`${TEST_PROJECT}/build`)).toBe(false);
    expect(filter(`${TEST_PROJECT}/coverage`)).toBe(false);
    expect(filter(`${TEST_PROJECT}/target`)).toBe(false);

    // Normal directories should be included
    expect(filter(`${TEST_PROJECT}/src`)).toBe(true);
    expect(filter(`${TEST_PROJECT}/src/utils/math.ts`)).toBe(true);
    expect(filter(`${TEST_PROJECT}/package.json`)).toBe(true);
  });

  // ─── Exit cleanup handler ──────────────────────────────────────────────────

  it('cleanup() removes sandbox from active registry', async () => {
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    sandbox = await createSandbox('src/utils/math.ts', TEST_PROJECT);

    // First cleanup should succeed
    sandbox.cleanup();
    expect(mockRmSync).toHaveBeenCalledWith(SANDBOX_DIR, {
      recursive: true,
      force: true,
    });

    // Second cleanup should be a no-op (directory already removed from registry)
    mockRmSync.mockClear();
    sandbox.cleanup();
    // rmSync is still called (best-effort), but the active-sandbox delete
    // in the finally block doesn't throw even if the dir is gone
    expect(mockRmSync).toHaveBeenCalledTimes(1);
  });

  // ─── safeSymlink and Windows junction fallback ──────────────────────────

  it('safeSymlink rethrows a Linux EPERM without a Windows junction retry', () => {
    // `safeSymlink` moved into dependency-link.ts (Task 2) but its Windows
    // fallback contract is unchanged: on this (non-Windows) platform an EPERM
    // must propagate directly, with no 'junction' retry attempt appended.
    // Testing it directly — rather than through createSandbox — is now
    // required: linkDependencyEntries (below) swallows a per-entry symlink
    // failure, so createSandbox itself no longer surfaces this error.
    mockSymlinkSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });

    expect(() => safeSymlink('/host/node_modules', '/sandbox/node_modules')).toThrow('EPERM');
    expect(mockSymlinkSync).toHaveBeenCalledTimes(1);
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      '/host/node_modules',
      '/sandbox/node_modules',
      'dir',
    );
  });

  it('does not fail the whole provision when one dependency entry cannot be linked', async () => {
    // Behaviour change from Task 2: linkDependencyEntries links per entry and
    // treats a failure as best-effort (see its docblock), so a single
    // unlinkable package — e.g. a Linux EPERM from an unusual host
    // filesystem — no longer aborts provisioning the way the old
    // whole-directory safeSymlink call did.
    mockExistsSync.mockImplementation((path: PathLike) => {
      if (path === `${SANDBOX_DIR}/src/utils/math.ts`) return true;
      if (path === TEST_PROJECT_NODE_MODULES) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([{ name: 'badpkg', isDirectory: () => true }] as never);
    mockSymlinkSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });

    await expect(createSandbox('src/utils/math.ts', TEST_PROJECT)).resolves.toBeDefined();
  });

  it('ensureExitHandler does not double-register on subsequent sandbox creations', async () => {
    const processOnSpy = vi.spyOn(process, 'on');
    processOnSpy.mockClear();

    // Create sandbox twice with fresh module
    vi.resetModules();
    const freshSandbox = await import('../utils/sandbox.js');
    mockMkdtempSync.mockReturnValue(SANDBOX_DIR);
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });
    mockCp.mockResolvedValue(undefined as never);

    await freshSandbox.createSandbox('src/utils/math.ts', TEST_PROJECT);
    const firstRegistrations = processOnSpy.mock.calls.filter((call) =>
      ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'exit'].includes(call[0] as string),
    ).length;

    processOnSpy.mockClear();
    await freshSandbox.createSandbox('src/utils/math.ts', TEST_PROJECT);
    const secondRegistrations = processOnSpy.mock.calls.filter((call) =>
      ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'exit'].includes(call[0] as string),
    ).length;

    // Second sandbox creation should NOT re-register handlers (exitHandlerRegistered guard)
    expect(secondRegistrations).toBe(0);
    expect(firstRegistrations).toBeGreaterThan(0);
  });

  // ─── estimateWorkspaceSize tests ─────────────────────────────────────────

  it('warns on workspaces larger than 200MB', async () => {
    const { warn } = await import('../utils/logger.js');
    const mockedWarn = vi.mocked(warn);
    mockedWarn.mockClear();

    // Mock readdir to return a directory with a giant file
    mockReaddir.mockResolvedValueOnce([
      { name: 'src', isDirectory: () => true, isFile: () => false },
    ] as never);
    mockReaddir.mockResolvedValueOnce([
      { name: 'giant.bin', isDirectory: () => false, isFile: () => true },
    ] as never);
    vi.mocked(statSync).mockReturnValueOnce({
      size: 250 * 1024 * 1024,
    } as never);

    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await createSandbox('src/utils/math.ts', TEST_PROJECT);

    expect(mockedWarn).toHaveBeenCalledWith(expect.stringContaining('MB'));
    // Second half of the warning string (its own literal).
    expect(mockedWarn).toHaveBeenCalledWith(
      expect.stringContaining('Consider using ignorePatterns'),
    );
  });

  it('does not count ALWAYS_EXCLUDE directories toward the size estimate', async () => {
    const { warn } = await import('../utils/logger.js');
    const mockedWarn = vi.mocked(warn);
    mockedWarn.mockClear();

    // Root contains only node_modules (excluded) holding a 250MB file. The
    // estimator must skip node_modules entirely; a mutant that drops the
    // ALWAYS_EXCLUDE guard would recurse into it and warn. Path-based
    // implementations (not Once-queues) so nothing leaks into later tests.
    mockReaddir.mockImplementation((p: unknown) =>
      String(p).endsWith('node_modules')
        ? (Promise.resolve([
            { name: 'giant.bin', isDirectory: () => false, isFile: () => true },
          ]) as never)
        : (Promise.resolve([
            { name: 'node_modules', isDirectory: () => true, isFile: () => false },
          ]) as never),
    );
    vi.mocked(statSync).mockReturnValue({ size: 250 * 1024 * 1024 } as never);

    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await createSandbox('src/utils/math.ts', TEST_PROJECT);

    const mbWarnings = mockedWarn.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('MB'),
    );
    expect(mbWarnings).toHaveLength(0);
  });

  it('does not count user ignorePatterns directories toward the size estimate', async () => {
    const { warn } = await import('../utils/logger.js');
    const mockedWarn = vi.mocked(warn);
    mockedWarn.mockClear();

    // Root holds only a user-ignored 'huge' dir with a 250MB file. Since the
    // copy will skip it, the size estimate must skip it too — otherwise the
    // warning fires for bytes that are never copied.
    mockReaddir.mockImplementation((p: unknown) =>
      String(p).endsWith('huge')
        ? (Promise.resolve([
            { name: 'giant.bin', isDirectory: () => false, isFile: () => true },
          ]) as never)
        : (Promise.resolve([
            { name: 'huge', isDirectory: () => true, isFile: () => false },
          ]) as never),
    );
    vi.mocked(statSync).mockReturnValue({ size: 250 * 1024 * 1024 } as never);

    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await createSandbox('src/utils/math.ts', TEST_PROJECT, ['huge']);

    const mbWarnings = mockedWarn.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('MB'),
    );
    expect(mbWarnings).toHaveLength(0);
  });

  it('does not warn on workspaces under 200MB', async () => {
    const { warn } = await import('../utils/logger.js');
    const mockedWarn = vi.mocked(warn);
    mockedWarn.mockClear();

    mockReaddir.mockResolvedValueOnce([
      { name: 'src', isDirectory: () => true, isFile: () => false },
    ] as never);
    mockReaddir.mockResolvedValueOnce([
      { name: 'small.ts', isDirectory: () => false, isFile: () => true },
    ] as never);
    vi.mocked(statSync).mockReturnValueOnce({ size: 1000 } as never);

    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await createSandbox('src/utils/math.ts', TEST_PROJECT);

    // No MB warning should have been emitted
    const warnCalls = mockedWarn.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('MB'),
    );
    expect(warnCalls).toHaveLength(0);
  });

  // ─── Exit handler signals ───────────────────────────────────────────────

  it('registers handlers for SIGTERM, SIGINT, SIGHUP, and SIGQUIT', async () => {
    // Reset sandbox module state so exitHandlerRegistered starts fresh
    vi.resetModules();
    const freshSandbox = await import('../utils/sandbox.js');

    // Re-mock fs/crypto/os for the fresh module
    const processOnSpy = vi.spyOn(process, 'on');

    await freshSandbox.createSandbox('src/utils/math.ts', TEST_PROJECT);

    const signalRegs = processOnSpy.mock.calls.filter(
      (call) =>
        call[0] === 'SIGTERM' ||
        call[0] === 'SIGINT' ||
        call[0] === 'SIGHUP' ||
        call[0] === 'SIGQUIT',
    );
    expect(signalRegs).toHaveLength(4);
  });

  // ─── ignorePatterns edge cases ──────────────────────────────────────────

  it('skips empty ignorePatterns', async () => {
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await createSandbox('src/utils/math.ts', TEST_PROJECT, ['', 'fixtures', '']);

    const filter = mockCp.mock.calls[0][2]?.filter as (src: string) => boolean;
    // Empty patterns are skipped, fixtures is still excluded
    expect(filter(`${TEST_PROJECT}/fixtures/data.json`)).toBe(false);
    expect(filter(`${TEST_PROJECT}/src/utils/math.ts`)).toBe(true);
  });

  it('excludes by segment containing trailing separator in ignorePattern', async () => {
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await createSandbox('src/utils/math.ts', TEST_PROJECT, ['dist/', 'build/']);

    const filter = mockCp.mock.calls[0][2]?.filter as (src: string) => boolean;
    expect(filter(`${TEST_PROJECT}/dist/bundle.js`)).toBe(false);
    expect(filter(`${TEST_PROJECT}/build/output.js`)).toBe(false);
    expect(filter(`${TEST_PROJECT}/src/dist-utils.js`)).toBe(true);
  });

  // ─── estimateWorkspaceSize error-catch paths ─────────────────────────────

  it('estimateWorkspaceSize handles readdir errors gracefully', async () => {
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    // Simulate a permission error when reading a directory
    mockReaddir.mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    );

    // Should not throw — estimateWorkspaceSize catches readdir rejections
    await expect(createSandbox('src/utils/math.ts', TEST_PROJECT)).resolves.toBeDefined();
  });

  it('estimateWorkspaceSize handles statSync errors gracefully', async () => {
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    // First readdir: return a dir with a file
    mockReaddir.mockResolvedValueOnce([
      { name: 'src', isDirectory: () => true, isFile: () => false },
    ] as never);
    mockReaddir.mockResolvedValueOnce([
      { name: 'broken.txt', isDirectory: () => false, isFile: () => true },
    ] as never);
    // statSync throws for 'broken.txt'
    vi.mocked(statSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOENT: file removed during scan'), { code: 'ENOENT' });
    });

    // Should not throw — estimateWorkspaceSize catches statSync errors
    await expect(createSandbox('src/utils/math.ts', TEST_PROJECT)).resolves.toBeDefined();
  });

  // ─── isPathInside edge cases ─────────────────────────────────────────────

  it('rejects workspace that is parent of cwd (rel === "..")', async () => {
    // isPathInside should reject when the workspace resolves to the parent of cwd
    const parentCwd = resolve(process.cwd(), '..');
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await expect(createSandbox('src/utils/math.ts', parentCwd)).rejects.toThrow(
      /Refusing to sandbox workspace outside process cwd/,
    );
  });

  it('rejects workspace that is a sibling directory of cwd (rel starts with ..)', async () => {
    // isPathInside should reject sibling directories (rel = '../sibling')
    const siblingDir = resolve(process.cwd(), '..', 'sibling-project');
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await expect(createSandbox('src/utils/math.ts', siblingDir)).rejects.toThrow(
      /Refusing to sandbox workspace outside process cwd/,
    );
  });

  // ─── CHAOS_ALLOWED_ROOTS opt-in ──────────────────────────────────────────

  it('accepts a workspace outside cwd when it is listed in CHAOS_ALLOWED_ROOTS', async () => {
    // An MCP server runs with one fixed cwd, so without this a server started
    // in project A could not audit project B at all. The opt-in list restores
    // that without dropping the boundary.
    const siblingDir = resolve(process.cwd(), '..', 'sibling-project');
    process.env[ALLOWED_ROOTS_ENV] = siblingDir;
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await expect(createSandbox('src/utils/math.ts', siblingDir)).resolves.toBeDefined();
  });

  it('accepts a workspace nested under a CHAOS_ALLOWED_ROOTS entry', async () => {
    const allowedRoot = resolve(process.cwd(), '..', 'monorepo');
    const nested = join(allowedRoot, 'packages', 'api');
    process.env[ALLOWED_ROOTS_ENV] = allowedRoot;
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await expect(createSandbox('src/utils/math.ts', nested)).resolves.toBeDefined();
  });

  it('still rejects a workspace that no CHAOS_ALLOWED_ROOTS entry covers', async () => {
    // Widening to one root must not widen to its siblings.
    process.env[ALLOWED_ROOTS_ENV] = resolve(process.cwd(), '..', 'allowed-project');
    const otherDir = resolve(process.cwd(), '..', 'unlisted-project');
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await expect(createSandbox('src/utils/math.ts', otherDir)).rejects.toThrow(
      /Refusing to sandbox workspace outside process cwd/,
    );
  });

  it('names the configured roots in the rejection so the misconfiguration is visible', async () => {
    const allowed = resolve(process.cwd(), '..', 'allowed-project');
    process.env[ALLOWED_ROOTS_ENV] = allowed;
    const otherDir = resolve(process.cwd(), '..', 'unlisted-project');
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await expect(createSandbox('src/utils/math.ts', otherDir)).rejects.toThrow(
      new RegExp(`${ALLOWED_ROOTS_ENV} entry \\(${allowed.replace(/[/\\]/g, '\\$&')}\\)`),
    );
  });

  it('points at the variable when nothing is configured at all', async () => {
    Reflect.deleteProperty(process.env, ALLOWED_ROOTS_ENV);
    const otherDir = resolve(process.cwd(), '..', 'unlisted-project');
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await expect(createSandbox('src/utils/math.ts', otherDir)).rejects.toThrow(
      new RegExp(`Set ${ALLOWED_ROOTS_ENV} to audit workspaces`),
    );
  });

  // ─── !success finally cleanup path ────────────────────────────────────

  it('cleans up sandbox when fs.cp throws (success stays false)', async () => {
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    // fs.cp rejects before symlinks/target-check run, so success never becomes true.
    // Use mockRejectedValueOnce so the rejection does not leak into later tests.
    mockCp.mockRejectedValueOnce(new Error('EACCES: permission denied on fs.cp'));

    // The cp rejection is the only error that escapes createSandbox.
    await expect(createSandbox('src/utils/math.ts', TEST_PROJECT)).rejects.toThrow(/EACCES/);

    // The finally block must call rmSync to clean up the partially created sandbox
    expect(mockRmSync).toHaveBeenCalledWith(
      SANDBOX_DIR,
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  // ─── Mutation hardening ──────────────────────────────────────────────────

  it('does not delete the sandbox on a successful provision (success flag)', async () => {
    mockExistsSync.mockImplementation((path: PathLike) => {
      if (path === `${SANDBOX_DIR}/src/utils/math.ts`) return true;
      return false;
    });

    await createSandbox('src/utils/math.ts', TEST_PROJECT);

    // The finally block only removes the dir when success === false; a healthy
    // run must leave it in place for the caller to use.
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it.each([
    '.svn',
    '.stryker-tmp',
    '.mutmut-cache',
    '__pycache__',
    '.pytest_cache',
    '.tox',
    '.venv',
    'venv',
    '.env',
    'dist',
    'coverage',
    '.nyc_output',
    '.next',
    'target',
  ])('filter excludes the always-excluded directory %s', async (dir) => {
    await createSandbox('src/utils/math.ts', TEST_PROJECT);
    const filter = mockCp.mock.calls[0][2]?.filter as (src: string) => boolean;
    expect(filter(`${TEST_PROJECT}/${dir}`)).toBe(false);
    // A sibling whose name merely contains the token is NOT excluded.
    expect(filter(`${TEST_PROJECT}/${dir}-keep/file.ts`)).toBe(true);
  });

  it('derives SYMLINK_DIRS from the engine registry with the list unchanged', () => {
    // Finding 35b: SYMLINK_DIRS used to be a hand-written array covering all
    // four languages at once, so a new language's dependency tree would be
    // deep-copied into every sandbox. It is now the union of
    // EngineDescriptor.dependencyDirs. Both halves matter:
    //   1. the rendered list is byte-for-byte what it was before, in order;
    //   2. it really is the registry's union, not a coincidence.
    expect(SYMLINK_DIRS).toEqual(['node_modules', '.venv', 'venv', 'vendor']);
    expect(SYMLINK_DIRS).toEqual(dependencyDirectories());
  });

  it('never symlinks a directory the copy filter always excludes as build output', () => {
    // `target` (Rust) is in ALWAYS_EXCLUDE and must stay OUT of SYMLINK_DIRS:
    // a symlink would let a mutation run corrupt the host's build cache (H1).
    expect(SYMLINK_DIRS).not.toContain('target');
    expect(ENGINE_REGISTRY.rust.dependencyDirs).toEqual([]);
  });

  it('symlinks each SYMLINK_DIRS entry that exists (node_modules, .venv, venv)', async () => {
    mockExistsSync.mockImplementation((path: PathLike) => {
      if (path === `${SANDBOX_DIR}/src/utils/math.ts`) return true;
      return (
        path === TEST_PROJECT_NODE_MODULES ||
        path === TEST_PROJECT_VENV ||
        path === `${TEST_PROJECT}/venv`
      );
    });
    mockReaddirSync.mockReturnValue([{ name: 'pkg', isDirectory: () => true }] as never);

    await createSandbox('src/utils/math.ts', TEST_PROJECT);

    const linked = mockSymlinkSync.mock.calls.map((c) => String(c[0]));
    expect(linked).toContain(join(TEST_PROJECT_NODE_MODULES, 'pkg'));
    expect(linked).toContain(join(TEST_PROJECT_VENV, 'pkg'));
    expect(linked).toContain(join(`${TEST_PROJECT}/venv`, 'pkg'));
  });

  it('symlinks a nested node_modules the copy filter skipped, not just the root one', async () => {
    // The copy filter matches on a path SEGMENT, so it skips `node_modules` at
    // every depth, but Step 2 only ever symlinked the workspace root. In a
    // workspace layout (npm workspaces, a PHP project shipping a Node worker)
    // the nested dependencies were therefore dropped from the sandbox
    // altogether: Knossos-MCP's PHP suite spawns `workers/typescript`, whose
    // node_modules vanished, so its test run errored and Infection never got
    // past its initial run.
    const nested = `${TEST_PROJECT}/workers/typescript/node_modules`;
    mockExistsSync.mockImplementation((path: PathLike) => {
      if (path === `${SANDBOX_DIR}/src/utils/math.ts`) return true;
      return path === TEST_PROJECT_NODE_MODULES || path === nested;
    });
    mockReaddirSync.mockReturnValue([{ name: 'pkg', isDirectory: () => true }] as never);
    // Real `cp` consults the filter per entry as it walks; the mock must too,
    // or the nested dir is never observed as skipped.
    let skippedNested: boolean | undefined;
    mockCp.mockImplementation((async (
      _s: string,
      _d: string,
      opts: { filter: (src: string) => boolean },
    ) => {
      skippedNested = opts.filter(nested);
    }) as never);

    await createSandbox('src/utils/math.ts', TEST_PROJECT);

    expect(skippedNested).toBe(false); // skipped by the copy…
    const linked = mockSymlinkSync.mock.calls.map((c) => String(c[0]));
    expect(linked).toContain(join(TEST_PROJECT_NODE_MODULES, 'pkg'));
    expect(linked).toContain(join(nested, 'pkg'));
  });

  it('skips a nested dependency dir in "share" mode when its destination already exists', async () => {
    // Symmetry with the root-level check a few lines above in `linkHeavyDirs`:
    // `safeSymlink` cannot target a path that already exists (EEXIST), so
    // `'share'` mode must check `existsSync(dst)` for a NESTED skipped dir too,
    // not just the workspace-root one, even though a real `fs.cp` never
    // actually materialises a dir this loop is about to visit (it was excluded
    // from the copy precisely because it landed in `skippedHeavyDirs`). The
    // guard is defensive, so this test manufactures the state directly.
    const nested = `${TEST_PROJECT}/workers/typescript/node_modules`;
    const nestedDst = `${SANDBOX_DIR}/workers/typescript/node_modules`;
    mockExistsSync.mockImplementation((path: PathLike) => {
      if (path === `${SANDBOX_DIR}/src/utils/math.ts`) return true;
      if (path === TEST_PROJECT_NODE_MODULES) return true;
      if (path === nested) return true;
      if (path === nestedDst) return true; // manufactured: "already there"
      return false;
    });
    let skippedNested: boolean | undefined;
    mockCp.mockImplementation((async (
      _s: string,
      _d: string,
      opts: { filter: (src: string) => boolean },
    ) => {
      skippedNested = opts.filter(nested);
    }) as never);

    await createSandbox('src/utils/math.ts', TEST_PROJECT, undefined, { dependencies: 'share' });

    expect(skippedNested).toBe(false); // skipped by the copy…
    // …and NOT re-symlinked on top of the destination that "already exists".
    const linkedDsts = mockSymlinkSync.mock.calls.map((c) => String(c[1]));
    expect(linkedDsts).not.toContain(nestedDst);
  });

  it('does not exclude everything when an ignorePattern is only a separator', async () => {
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await createSandbox('src/utils/math.ts', TEST_PROJECT, ['/']);

    const filter = mockCp.mock.calls[0][2]?.filter as (src: string) => boolean;
    // A "/" pattern normalises to "" and must be skipped, not treated as a
    // segment that matches every path.
    expect(filter(`${TEST_PROJECT}/src/utils/math.ts`)).toBe(true);
  });

  it('warns with the computed size and does not warn exactly at the threshold', async () => {
    const { warn } = await import('../utils/logger.js');
    const mockedWarn = vi.mocked(warn);

    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    // Exactly at the 200MB cap → strictly-greater-than guard must NOT warn.
    mockedWarn.mockClear();
    mockReaddir.mockResolvedValueOnce([
      { name: 'big.bin', isDirectory: () => false, isFile: () => true },
    ] as never);
    vi.mocked(statSync).mockReturnValueOnce({ size: 200 * 1024 * 1024 } as never);
    await createSandbox('src/utils/math.ts', TEST_PROJECT);
    expect(mockedWarn.mock.calls.filter((c) => String(c[0]).includes('MB'))).toHaveLength(0);

    // 300MB → warns, and the human-readable size is computed correctly.
    mockedWarn.mockClear();
    mockReaddir.mockResolvedValueOnce([
      { name: 'big.bin', isDirectory: () => false, isFile: () => true },
    ] as never);
    vi.mocked(statSync).mockReturnValueOnce({ size: 300 * 1024 * 1024 } as never);
    await createSandbox('src/utils/math.ts', TEST_PROJECT);
    expect(mockedWarn).toHaveBeenCalledWith(expect.stringContaining('~300MB'));
  });

  // ─── Audit C1: AbortSignal support ────────────────────────────────────

  it('rejects with AbortError when the signal is already aborted', async () => {
    // A pre-aborted signal must short-circuit BEFORE mkdtempSync + cp,
    // without leaving a temp dir behind.
    mockMkdtempSync.mockClear();
    const controller = new AbortController();
    controller.abort();

    await expect(
      createSandbox('src/utils/math.ts', TEST_PROJECT, undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // The abort happened before any dp allocation.
    expect(mockMkdtempSync).not.toHaveBeenCalled();
    // ...and before the copy — so this fails if cancellation is honoured late.
    expect(mockCp).not.toHaveBeenCalled();
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('honours an abort that lands during the workspace size estimate', async () => {
    // The walk polls the signal per directory. Without that poll a cancelled
    // request keeps walking to completion before anyone notices.
    const controller = new AbortController();
    mockMkdtempSync.mockClear();
    mockExistsSync.mockImplementation(
      (path: PathLike) => path === `${SANDBOX_DIR}/src/utils/math.ts` || path === TEST_PROJECT,
    );
    mockReaddir.mockImplementation((() => {
      // Abort as soon as the walk reads its first directory.
      controller.abort();
      return Promise.resolve([{ name: 'a', isDirectory: () => true, isFile: () => false }]);
    }) as never);

    await expect(
      createSandbox('src/utils/math.ts', TEST_PROJECT, undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // The abort escaped the size estimate's best-effort catch rather than being
    // swallowed and reported as "size 0".
    expect(mockMkdtempSync).not.toHaveBeenCalled();
  });

  it('observes an abort flipped by an interleaved task mid-walk (Med#17)', async () => {
    // The case the synchronous walk could NOT pass. `controller.abort()` runs
    // on the event loop, so with a sync `readdirSync` walk the whole tree is
    // visited in one uninterruptible turn: the per-directory `signal.aborted`
    // poll can never see a flag flipped by a task that has not been allowed to
    // run yet. Only an async walk gives that task a turn.
    //
    // Nobody touches the controller from inside the walk here — the abort comes
    // from an ordinary macrotask racing it, exactly like an MCP cancellation.
    const controller = new AbortController();
    mockMkdtempSync.mockClear();
    mockExistsSync.mockImplementation(
      (path: PathLike) => path === `${SANDBOX_DIR}/src/utils/math.ts` || path === TEST_PROJECT,
    );

    // A 40-directory tree. Each readdir resolves on a real macrotask, the way
    // threadpool-backed fs.promises.readdir does.
    const CHILD_DIRS = 40;
    mockReaddir.mockImplementation((async (p: unknown) => {
      await new Promise<void>((r) => setTimeout(r, 0));
      return String(p) === TEST_PROJECT
        ? Array.from({ length: CHILD_DIRS }, (_unused, i) => ({
            name: `d${i}`,
            isDirectory: () => true,
            isFile: () => false,
          }))
        : [{ name: 'leaf.ts', isDirectory: () => false, isFile: () => true }];
    }) as never);
    vi.mocked(statSync).mockReturnValue({ size: 1 } as never);

    const inFlight = createSandbox('src/utils/math.ts', TEST_PROJECT, undefined, {
      signal: controller.signal,
    });
    // Scheduled AFTER the walk starts, on the same timer queue the mocked
    // directory reads resolve on, so it lands between two directories.
    setTimeout(() => controller.abort(), 0);

    await expect(inFlight).rejects.toMatchObject({ name: 'AbortError' });

    // Mid-walk, not after it: the walk stopped well short of all 41 directories
    // and never reached the temp-dir allocation that follows the estimate.
    expect(mockReaddir.mock.calls.length).toBeLessThan(CHILD_DIRS);
    expect(mockMkdtempSync).not.toHaveBeenCalled();
  });

  it('cleans up the partial sandbox when abort fires between copy and symlinks', async () => {
    // Mock cp to block on a deferred promise so the test can resolve it
    // deterministically BEFORE calling controller.abort(). fs.cp cannot truly
    // abort a half-finished copy from Node, so createSandbox's post-copy
    // `signal?.aborted` check is the canonical cancel boundary — this test
    // drives that branch deterministically.
    //
    // Use a method-object pattern (resolveIt can always be called) rather
    // than `let abortIt: () => void | undefined` followed by `abortIt!()` —
    // the non-null assertion is forbidden by the project lint config and the
    // method-object form lets us drop the bang entirely.
    const cpDeferred = { resolveIt: (): void => undefined };
    mockCp.mockImplementationOnce(async (_src, _dst, _opts) => {
      await new Promise<void>((resolve) => {
        cpDeferred.resolveIt = resolve;
      });
    });

    const controller = new AbortController();
    const inFlight = createSandbox('src/utils/math.ts', TEST_PROJECT, undefined, {
      signal: controller.signal,
    });

    // Deterministic scheduling (reviewer feedback): setImmediate yields one
    // macrotask, by which point cp() is guaranteed in-flight and its
    // continuation is pending on the microtask queue. We then resolve cp()
    // and abort the controller IN THE SAME SYNCHRONOUS STEP, before yielding
    // again — this guarantees control returns to createSandbox's `await
    // cp(...)` resumption microtask with `signal.aborted === true`. Using
    // two separate `queueMicrotask` calls worked but relied on V8's
    // microtask FIFO ordering; this explicit setImmediate+sync-pair is
    // more robust.
    await new Promise<void>((r) => setImmediate(r));
    cpDeferred.resolveIt();
    controller.abort();

    await expect(inFlight).rejects.toMatchObject({ name: 'AbortError' });
    // Symlinks did NOT run because the post-copy abort branch rejected first.
    expect(mockSymlinkSync).not.toHaveBeenCalled();
    // The partially-created sandbox was cleaned up by the !success finally.
    expect(mockRmSync).toHaveBeenCalledWith(
      SANDBOX_DIR,
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  // ─── Exit/signal handler bodies (previously NoCoverage) ───────────────────

  it('exit handler removes every active sandbox and clears the registry', async () => {
    vi.resetModules();
    const fresh = await import('../utils/sandbox.js');
    const onSpy = vi.spyOn(process, 'on');

    mockMkdtempSync.mockReturnValue(SANDBOX_DIR);
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });
    mockCp.mockResolvedValue(undefined as never);
    await fresh.createSandbox('src/utils/math.ts', TEST_PROJECT);

    const exitCall = onSpy.mock.calls.find((c) => c[0] === 'exit');
    if (!exitCall) throw new Error('exit handler was not registered');
    const exitHandler = exitCall[1] as () => void;

    mockRmSync.mockClear();
    exitHandler();
    // cleanupAll() rmSync's the registered sandbox dir.
    expect(mockRmSync).toHaveBeenCalledWith(
      SANDBOX_DIR,
      expect.objectContaining({ recursive: true, force: true }),
    );

    // Running it again is idempotent — the registry was cleared, so no rmSync.
    mockRmSync.mockClear();
    exitHandler();
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('cleans up but does NOT exit when the process owner claims shutdown', async () => {
    // `setSandboxSignalExit(false)` hands termination to the server, which
    // closes the MCP transport first. If this leaf module exits anyway it
    // pre-empts that and drops the in-flight response — the exact bug the flag
    // exists to prevent. Cleanup must still happen; only the exit is withheld.
    vi.resetModules();
    const fresh = await import('../utils/sandbox.js');
    // Same reset, so this resolves to the very module instance `fresh` just
    // pulled in — the one whose ACTIVE_SANDBOXES the handlers below walk.
    const freshRegistry = await import('../utils/sandbox/registry.js');
    const onSpy = vi.spyOn(process, 'on');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    mockMkdtempSync.mockReturnValue(SANDBOX_DIR);
    mockExistsSync.mockImplementation(
      (path: PathLike) => path === `${SANDBOX_DIR}/src/utils/math.ts`,
    );
    mockCp.mockResolvedValue(undefined as never);
    await fresh.createSandbox('src/utils/math.ts', TEST_PROJECT);

    freshRegistry.setSandboxSignalExit(false);

    const sigCall = onSpy.mock.calls.find((c) => c[0] === 'SIGTERM');
    if (!sigCall) throw new Error('SIGTERM handler was not registered');
    mockRmSync.mockClear();
    exitSpy.mockClear();

    (sigCall[1] as () => void)();

    expect(mockRmSync).toHaveBeenCalledWith(
      SANDBOX_DIR,
      expect.objectContaining({ recursive: true, force: true }),
    );
    expect(exitSpy).not.toHaveBeenCalled();

    freshRegistry.setSandboxSignalExit(true);
    exitSpy.mockRestore();
  });

  it('signal handler cleans up then exits with 128 + signal number', async () => {
    vi.resetModules();
    const fresh = await import('../utils/sandbox.js');
    const onSpy = vi.spyOn(process, 'on');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    mockMkdtempSync.mockReturnValue(SANDBOX_DIR);
    mockExistsSync.mockImplementation((path: PathLike) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });
    mockCp.mockResolvedValue(undefined as never);
    await fresh.createSandbox('src/utils/math.ts', TEST_PROJECT);

    const sigCall = onSpy.mock.calls.find((c) => c[0] === 'SIGTERM');
    if (!sigCall) throw new Error('SIGTERM handler was not registered');
    const sigHandler = sigCall[1] as () => void;

    mockRmSync.mockClear();
    sigHandler();
    expect(mockRmSync).toHaveBeenCalledWith(
      SANDBOX_DIR,
      expect.objectContaining({ recursive: true, force: true }),
    );
    // Conventional exit code for a SIGTERM (15) kill is 128 + 15 = 143, so the
    // process doesn't masquerade as a clean exit (0).
    expect(exitSpy).toHaveBeenCalledWith(143);

    exitSpy.mockRestore();
  });
});

describe('cleanupAllSandboxes', () => {
  const originalAllowedRoots = process.env[ALLOWED_ROOTS_ENV];
  afterEach(() => {
    if (originalAllowedRoots === undefined) Reflect.deleteProperty(process.env, ALLOWED_ROOTS_ENV);
    else process.env[ALLOWED_ROOTS_ENV] = originalAllowedRoots;
  });

  /**
   * Fresh module per case: the active-sandbox registry is module-level state,
   * so a leaked entry from an earlier test would make these assertions pass for
   * the wrong reason.
   *
   * Both imports happen after ONE `resetModules()`, so `utils/sandbox.js` and
   * `utils/sandbox/registry.js` resolve to the same fresh pair — the provisioner
   * registers into exactly the Set `cleanupAllSandboxes` then walks.
   */
  const freshModule = async (): Promise<
    typeof import('../utils/sandbox.js') & typeof import('../utils/sandbox/registry.js')
  > => {
    vi.resetModules();
    const [sandbox, registry] = await Promise.all([
      import('../utils/sandbox.js'),
      import('../utils/sandbox/registry.js'),
    ]);
    return { ...sandbox, ...registry };
  };

  const armMocks = (dirs: string[]): void => {
    vi.clearAllMocks();
    Reflect.deleteProperty(process.env, ALLOWED_ROOTS_ENV);
    mockTmpdir.mockReturnValue('/tmp');
    mockCp.mockResolvedValue(undefined as never);
    let next = 0;
    mockMkdtempSync.mockImplementation(() => dirs[Math.min(next++, dirs.length - 1)]);
    mockExistsSync.mockImplementation((path: PathLike) =>
      dirs.some((d) => path === `${d}/src/utils/math.ts`),
    );
  };

  it('kills every tracked engine process before removing the directories', async () => {
    // The process-exit path: nothing is left to receive an engine's output, so
    // every group goes, whatever directory it runs in. Directories alone were
    // reaped here before — the processes were not.
    const dirs = ['/tmp/chaos-mcp-a', '/tmp/chaos-mcp-b'];
    armMocks(dirs);
    const fresh = await freshModule();
    await fresh.createSandbox('src/utils/math.ts', TEST_PROJECT);
    await fresh.createSandbox('src/utils/math.ts', TEST_PROJECT);

    mockKillAll.mockClear();
    mockRmSync.mockClear();
    fresh.cleanupAllSandboxes();

    expect(mockKillAll).toHaveBeenCalledTimes(1);
    expect(mockKillAll.mock.invocationCallOrder[0]).toBeLessThan(
      mockRmSync.mock.invocationCallOrder[0],
    );
  });

  it('removes every sandbox the process still owns', async () => {
    const dirs = ['/tmp/chaos-mcp-a', '/tmp/chaos-mcp-b'];
    armMocks(dirs);
    const fresh = await freshModule();
    await fresh.createSandbox('src/utils/math.ts', TEST_PROJECT);
    await fresh.createSandbox('src/utils/math.ts', TEST_PROJECT);

    mockRmSync.mockClear();
    fresh.cleanupAllSandboxes();

    // Both registered sandboxes are removed — not just the most recent one.
    for (const dir of dirs) {
      expect(mockRmSync).toHaveBeenCalledWith(
        dir,
        expect.objectContaining({ recursive: true, force: true }),
      );
    }
    expect(mockRmSync).toHaveBeenCalledTimes(dirs.length);
  });

  it('is idempotent — a second call removes nothing', async () => {
    armMocks(['/tmp/chaos-mcp-a']);
    const fresh = await freshModule();
    await fresh.createSandbox('src/utils/math.ts', TEST_PROJECT);

    fresh.cleanupAllSandboxes();
    mockRmSync.mockClear();
    fresh.cleanupAllSandboxes();

    // The registry is cleared, so re-running from a second exit signal must not
    // re-issue removals for directories that are already gone.
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('keeps going when one removal throws, and still clears the registry', async () => {
    const dirs = ['/tmp/chaos-mcp-a', '/tmp/chaos-mcp-b'];
    armMocks(dirs);
    const fresh = await freshModule();
    await fresh.createSandbox('src/utils/math.ts', TEST_PROJECT);
    await fresh.createSandbox('src/utils/math.ts', TEST_PROJECT);

    mockRmSync.mockClear();
    mockRmSync.mockImplementation((path: PathLike) => {
      if (path === dirs[0]) throw new Error('EBUSY');
    });

    // Best-effort by design: this runs from an exit handler, where throwing
    // would abort shutdown and leak every remaining sandbox.
    expect(() => fresh.cleanupAllSandboxes()).not.toThrow();
    expect(mockRmSync).toHaveBeenCalledWith(dirs[1], expect.objectContaining({ force: true }));

    mockRmSync.mockClear();
    mockRmSync.mockImplementation(() => undefined);
    fresh.cleanupAllSandboxes();
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('does nothing when no sandbox was ever created', async () => {
    armMocks(['/tmp/chaos-mcp-a']);
    const fresh = await freshModule();

    mockRmSync.mockClear();
    fresh.cleanupAllSandboxes();
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('removes a sandbox whose workspace copy has not finished yet', async () => {
    // Registration used to happen AFTER `await copyWorkspaceTree(...)` — the
    // longest phase of provisioning by a wide margin. A SIGTERM landing during
    // the copy therefore walked a registry that did not contain this directory
    // and then called process.exit, so createSandbox's `finally` never ran and
    // the half-copied tree stayed in tmpdir() forever. This pins the fix: the
    // directory is reachable from cleanupAllSandboxes() the moment mkdtempSync
    // returns, not once the copy resolves.
    const dir = '/tmp/chaos-mcp-inflight';
    armMocks([dir]);
    const cpDeferred = { resolveIt: (): void => undefined };
    mockCp.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        cpDeferred.resolveIt = resolve;
      });
    });

    const fresh = await freshModule();
    const inFlight = fresh.createSandbox('src/utils/math.ts', TEST_PROJECT);

    // One macrotask is enough for mkdtempSync to have run and for cp() to be
    // pending — provisioning is now blocked inside Step 1.
    await new Promise<void>((r) => setImmediate(r));
    expect(mockCp).toHaveBeenCalled();

    mockRmSync.mockClear();
    fresh.cleanupAllSandboxes();
    expect(mockRmSync).toHaveBeenCalledWith(
      dir,
      expect.objectContaining({ recursive: true, force: true }),
    );

    cpDeferred.resolveIt();
    await inFlight;
  });

  it('drops a sandbox whose provisioning failed, so it is not reaped twice', async () => {
    // The `!success` branch removes the directory itself; leaving the entry in
    // the registry would make a later shutdown re-issue rmSync for a path that
    // no longer exists (harmless, but it also misreports what the process owns).
    armMocks(['/tmp/chaos-mcp-a']);
    // Target missing from the copied tree ⇒ verifyTarget throws ⇒ !success.
    mockExistsSync.mockReturnValue(false);
    const fresh = await freshModule();

    await expect(fresh.createSandbox('src/utils/math.ts', TEST_PROJECT)).rejects.toThrow(
      /was not found in the copied workspace/,
    );

    mockRmSync.mockClear();
    fresh.cleanupAllSandboxes();
    expect(mockRmSync).not.toHaveBeenCalled();
  });
});

describe('_resetSandboxSignalState', () => {
  const originalAllowedRoots = process.env[ALLOWED_ROOTS_ENV];
  afterEach(() => {
    if (originalAllowedRoots === undefined) Reflect.deleteProperty(process.env, ALLOWED_ROOTS_ENV);
    else process.env[ALLOWED_ROOTS_ENV] = originalAllowedRoots;
  });

  it('un-installs the process listeners and restores both latches', async () => {
    // Signal state is process-lifetime module state, so without this hook a
    // single `setSandboxSignalExit(false)` silently disables signal-driven exit
    // for every remaining test in the worker, and the exit-handler latch lets
    // only the first sandbox-creating test ever observe installation.
    vi.clearAllMocks();
    Reflect.deleteProperty(process.env, ALLOWED_ROOTS_ENV);
    mockTmpdir.mockReturnValue('/tmp');
    mockCp.mockResolvedValue(undefined as never);
    mockMkdtempSync.mockReturnValue(SANDBOX_DIR);
    mockExistsSync.mockImplementation(
      (path: PathLike) => path === `${SANDBOX_DIR}/src/utils/math.ts`,
    );

    // One reset, both imports: the provisioner must register into the same
    // module instance whose latches are being reset (see freshModule above).
    vi.resetModules();
    const [fresh, registry] = await Promise.all([
      import('../utils/sandbox.js'),
      import('../utils/sandbox/registry.js'),
    ]);

    // Deltas, not absolutes: earlier cases in this file installed handlers from
    // module instances that no longer exist and can never be removed.
    const baseExit = process.listenerCount('exit');
    const baseSigterm = process.listenerCount('SIGTERM');

    await fresh.createSandbox('src/utils/math.ts', TEST_PROJECT);
    expect(process.listenerCount('exit')).toBe(baseExit + 1);
    expect(process.listenerCount('SIGTERM')).toBe(baseSigterm + 1);

    registry.setSandboxSignalExit(false);
    registry._resetSandboxSignalState();

    // A flag-only reset would leave these counts elevated forever and let the
    // next ensureExitHandler() stack a second generation on the live one.
    expect(process.listenerCount('exit')).toBe(baseExit);
    expect(process.listenerCount('SIGTERM')).toBe(baseSigterm);

    // Re-arming installs exactly ONE generation, not two.
    await fresh.createSandbox('src/utils/math.ts', TEST_PROJECT);
    expect(process.listenerCount('exit')).toBe(baseExit + 1);
    expect(process.listenerCount('SIGTERM')).toBe(baseSigterm + 1);

    // …and signalExitEnabled is back to its default, so the fresh handler
    // terminates the process again instead of inheriting the `false` above.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const sigtermListeners = process.listeners('SIGTERM');
    (sigtermListeners[sigtermListeners.length - 1] as () => void)();
    expect(exitSpy).toHaveBeenCalledWith(143);
    exitSpy.mockRestore();

    // Leave the process exactly as this case found it.
    registry._resetSandboxSignalState();
    expect(process.listenerCount('SIGTERM')).toBe(baseSigterm);
  });
});

/**
 * The copy/exclusion policy used to be a 40-line closure inside the `fs.cp`
 * options object inside createSandbox, so every rule below could only be
 * exercised by provisioning a whole sandbox. It is now a pure function over
 * path strings — no filesystem, no temp dir, no mocks.
 */
describe('buildCopyPolicy', () => {
  const ROOT = resolve(process.cwd(), 'policy-project');
  const TARGET = join(ROOT, 'src', 'utils', 'math.ts');
  // The module's real SYMLINK_DIRS. The policy takes the per-audit list as an
  // argument precisely so it can be varied (Composer PHP drops `vendor`).
  const HEAVY = [...SYMLINK_DIRS];

  const policyFor = (
    userExcludes?: string[],
    over: Partial<Parameters<typeof buildCopyPolicy>[0]> = {},
  ): ReturnType<typeof buildCopyPolicy> =>
    buildCopyPolicy({ absoluteTarget: TARGET, symlinkDirs: HEAVY, userExcludes, ...over });

  describe('exclusion rules', () => {
    it('copies ordinary source paths', () => {
      const policy = policyFor();

      expect(policy.shouldCopy(join(ROOT, 'src'))).toBe(true);
      expect(policy.shouldCopy(join(ROOT, 'src', 'utils', 'other.ts'))).toBe(true);
      expect(policy.shouldCopy(join(ROOT, 'package.json'))).toBe(true);
    });

    it('refuses ALWAYS_EXCLUDE names at any depth without recording them', () => {
      const policy = policyFor();

      expect(policy.shouldCopy(join(ROOT, '.git'))).toBe(false);
      expect(policy.shouldCopy(join(ROOT, 'dist'))).toBe(false);
      expect(policy.shouldCopy(join(ROOT, 'pkgs', 'a', 'coverage'))).toBe(false);
      expect(policy.shouldCopy(join(ROOT, 'chaos-infection-log.json'))).toBe(false);
      // Rust build output is excluded but NEVER symlinked (audit H1).
      expect(policy.shouldCopy(join(ROOT, 'target'))).toBe(false);
      expect(policy.skippedHeavyDirs.size).toBe(0);
    });

    it('records every heavyweight dir it skips, at any depth, for the symlink step', () => {
      const policy = policyFor();
      const nested = join(ROOT, 'workers', 'typescript', 'node_modules');

      expect(policy.shouldCopy(join(ROOT, 'node_modules'))).toBe(false);
      expect(policy.shouldCopy(nested)).toBe(false);
      expect(policy.shouldCopy(join(ROOT, '.venv'))).toBe(false);

      // node_modules is in ALWAYS_EXCLUDE too; the symlink check must run FIRST
      // or Step 2 never learns the dir was skipped and the sandbox loses it.
      expect(policy.skippedHeavyDirs).toEqual(
        new Set([join(ROOT, 'node_modules'), nested, join(ROOT, '.venv')]),
      );
    });

    it('copies vendor/ when the per-audit symlink list omits it (Composer PHP)', () => {
      const policy = policyFor(undefined, {
        symlinkDirs: HEAVY.filter((d) => d !== 'vendor'),
      });

      expect(policy.shouldCopy(join(ROOT, 'vendor'))).toBe(true);
      expect(policy.shouldCopy(join(ROOT, 'vendor', 'composer'))).toBe(true);
      expect(policy.skippedHeavyDirs.has(join(ROOT, 'vendor'))).toBe(false);
    });

    it('matches user excludes by whole segment, not substring (M6)', () => {
      const policy = policyFor(['fixtures']);

      expect(policy.shouldCopy(join(ROOT, 'fixtures'))).toBe(false);
      expect(policy.shouldCopy(join(ROOT, 'src', 'fixtures', 'a.ts'))).toBe(false);
      expect(policy.shouldCopy(join(ROOT, 'fixtures-lite'))).toBe(true);
      expect(policy.shouldCopy(join(ROOT, 'my-fixtures'))).toBe(true);
    });
  });

  describe('ignorePattern normalisation', () => {
    it('strips exactly one trailing separator (L2)', () => {
      const policy = policyFor([`fixtures${sep}`]);

      expect(policy.normalisedExcludes).toEqual(new Set(['fixtures']));
      expect(policy.shouldCopy(join(ROOT, 'fixtures'))).toBe(false);
    });

    it('drops empty and separator-only patterns instead of excluding everything', () => {
      const policy = policyFor(['', sep]);

      expect(policy.normalisedExcludes.size).toBe(0);
      expect(policy.shouldCopy(join(ROOT, 'src'))).toBe(true);
    });

    it('strips only ONE trailing separator, leaving a pattern that matches nothing', () => {
      // `//` normalises to `/`, which is never a segment of a split path — so
      // it is inert rather than an accidental exclude-everything.
      const policy = policyFor([`${sep}${sep}`]);

      expect(policy.normalisedExcludes).toEqual(new Set([sep]));
      expect(policy.shouldCopy(join(ROOT, 'src'))).toBe(true);
    });

    it('normalises once, so duplicate spellings collapse', () => {
      const policy = policyFor(['fixtures', `fixtures${sep}`, 'docs']);

      expect(policy.normalisedExcludes).toEqual(new Set(['fixtures', 'docs']));
    });
  });

  describe('force-include of the target', () => {
    it('wins over the heavyweight-dir check for a target inside vendor/', () => {
      const target = join(ROOT, 'vendor', 'my-lib', 'index.ts');
      const policy = policyFor(undefined, { absoluteTarget: target });

      // Both the dir and the target must be copied, and vendor must NOT be
      // recorded for symlinking — Step 2 would otherwise hit EEXIST.
      expect(policy.shouldCopy(join(ROOT, 'vendor'))).toBe(true);
      expect(policy.shouldCopy(join(ROOT, 'vendor', 'my-lib'))).toBe(true);
      expect(policy.shouldCopy(target)).toBe(true);
      expect(policy.skippedHeavyDirs.size).toBe(0);
    });

    it('wins over ALWAYS_EXCLUDE and user excludes for the target chain (Med#7)', () => {
      const target = join(ROOT, 'dist', 'shipped.ts');
      const policy = policyFor(['dist'], { absoluteTarget: target });

      expect(policy.shouldCopy(join(ROOT, 'dist'))).toBe(true);
      expect(policy.shouldCopy(target)).toBe(true);
      // A SIBLING under the same excluded name is still dropped.
      expect(policy.shouldCopy(join(ROOT, 'dist', 'other.ts'))).toBe(false);
    });

    it('force-includes ancestors only — not a sibling with a shared prefix', () => {
      const policy = policyFor();

      expect(policy.shouldCopy(join(ROOT, 'src', 'utils'))).toBe(true);
      expect(policy.shouldCopy(`${join(ROOT, 'src', 'utils', 'math')}.spec.ts`)).toBe(true);
      expect(policy.shouldCopy(join(ROOT, 'src', 'utils', 'node_modules'))).toBe(false);
    });
  });

  describe('estimate mode (opt-outs that keep the size warning as it was)', () => {
    it('skips heavyweight dirs even when the target lives inside one', () => {
      const target = join(ROOT, 'node_modules', 'my-lib', 'index.ts');
      const policy = policyFor(undefined, {
        absoluteTarget: target,
        forceIncludeTarget: false,
      });

      // The copy pulls this whole tree in; the size estimate never has.
      expect(policy.shouldCopy(join(ROOT, 'node_modules'))).toBe(false);
    });

    it('matches user excludes on the entry name only, not on ancestor segments', () => {
      const policy = policyFor(['fixtures'], { matchAncestorSegments: false });

      expect(policy.shouldCopy(join(ROOT, 'fixtures'))).toBe(false);
      // A pruned walk never reaches this path, so the ancestor match is
      // redundant — and skipping it keeps the workspace root's own path
      // segments from excluding the entire tree.
      expect(policy.shouldCopy(join(ROOT, 'fixtures', 'a.ts'))).toBe(true);
    });
  });
});
