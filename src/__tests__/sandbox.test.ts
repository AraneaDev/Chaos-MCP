import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs module (sync exports only — async fs.cp lives in fs/promises).
vi.mock('fs', () => ({
  mkdtempSync: vi.fn(),
  symlinkSync: vi.fn(),
  rmSync: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readdirSync: vi.fn(),
}));

// Mock fs/promises — cp is the audit C1 async copy primitive.
vi.mock('fs/promises', () => ({
  cp: vi.fn(),
}));

// Mock crypto
vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => '00000000-0000-0000-0000-000000000000'),
}));

// Mock os
vi.mock('os', () => ({
  tmpdir: vi.fn(() => '/tmp'),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  log: vi.fn(),
  isVerbose: vi.fn().mockReturnValue(false),
  warn: vi.fn(),
}));

import {
  mkdtempSync,
  symlinkSync,
  rmSync,
  existsSync,
  statSync,
  readdirSync,
} from 'fs';
import { cp } from 'fs/promises';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { createSandbox, SandboxContext } from '../utils/sandbox.js';

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
const mockSymlinkSync = vi.mocked(symlinkSync);
const mockRmSync = vi.mocked(rmSync);
const mockExistsSync = vi.mocked(existsSync);
const mockTmpdir = vi.mocked(tmpdir);

const SANDBOX_DIR = '/tmp/chaos-mcp-00000000-0000-0000-0000-000000000000';

describe('createSandbox', () => {
  let sandbox: SandboxContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTmpdir.mockReturnValue('/tmp');
    mockMkdtempSync.mockReturnValue(SANDBOX_DIR);
    // Default: cp resolves to undefined (mimics successful copy).
    mockCp.mockResolvedValue(undefined as never);

    // Default: target file exists, node_modules exists
    mockExistsSync.mockImplementation((path: string) => {
      if (path === `${SANDBOX_DIR}/src/utils/math.ts`) return true;
      if (path === TEST_PROJECT_NODE_MODULES) return true;
      return false;
    });
  });

  it('creates a sandbox directory using os.tmpdir()', async () => {
    mockTmpdir.mockReturnValue('/custom/tmp');
    mockMkdtempSync.mockReturnValue('/custom/tmp/chaos-mcp-00000000-0000-0000-0000-000000000000');
    mockExistsSync.mockImplementation((path: string) => {
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
    mockExistsSync.mockImplementation((path: string) => {
      if (path === `${SANDBOX_DIR}/src/utils/math.ts`) return true;
      if (path === TEST_PROJECT_NODE_MODULES) return true;
      return false;
    });

    sandbox = await createSandbox('src/utils/math.ts', TEST_PROJECT);

    expect(mockSymlinkSync).toHaveBeenCalledWith(
      TEST_PROJECT_NODE_MODULES,
      `${SANDBOX_DIR}/node_modules`,
      'dir',
    );
  });

  it('symlinks .venv into sandbox when present', async () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === `${SANDBOX_DIR}/src/main.py`) return true;
      if (path === TEST_PROJECT_VENV) return true;
      return false;
    });

    sandbox = await createSandbox('src/main.py', TEST_PROJECT);

    expect(mockSymlinkSync).toHaveBeenCalledWith(TEST_PROJECT_VENV, `${SANDBOX_DIR}/.venv`, 'dir');
  });

  it('symlinks vendor into sandbox when present', async () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === `${SANDBOX_DIR}/src/Calculator.php`) return true;
      if (path === TEST_PROJECT_VENDOR) return true;
      return false;
    });

    sandbox = await createSandbox('src/Calculator.php', TEST_PROJECT);

    expect(mockSymlinkSync).toHaveBeenCalledWith(
      TEST_PROJECT_VENDOR,
      `${SANDBOX_DIR}/vendor`,
      'dir',
    );
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
    mockExistsSync.mockImplementation((path: string) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts` || path === cwd;
    });

    await expect(createSandbox('src/utils/math.ts', cwd)).resolves.toBeDefined();
  });

  it('strips trailing separator from ignorePatterns (Live-audit L2)', async () => {
    // Convention `["fixtures/"]` should exclude the `fixtures` directory
    // segment, not silently fail because the segment lacks the trailing slash.
    mockExistsSync.mockImplementation((path: string) => {
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
    mockExistsSync.mockImplementation((path: string) => {
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
    mockExistsSync.mockImplementation((path: string) => {
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
    mockExistsSync.mockImplementation((path: string) => {
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
    mockExistsSync.mockImplementation((path: string) => {
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
    mockExistsSync.mockImplementation((path: string) => {
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
    mockExistsSync.mockImplementation((path: string) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    sandbox = await createSandbox('src/utils/math.ts', TEST_PROJECT);
    sandbox.cleanup();

    expect(mockRmSync).toHaveBeenCalledWith(SANDBOX_DIR, { recursive: true, force: true });
  });

  it('cleanup() swallows errors gracefully', async () => {
    mockExistsSync.mockImplementation((path: string) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    mockRmSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });

    sandbox = await createSandbox('src/utils/math.ts', TEST_PROJECT);

    expect(() => sandbox.cleanup()).not.toThrow();
  });

  it('filter excludes node_modules, .git, target, and generated dirs', async () => {
    mockExistsSync.mockImplementation((path: string) => {
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
    mockExistsSync.mockImplementation((path: string) => {
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

  it('retries with junction on Windows EPERM, surfaces error on Linux', async () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === `${SANDBOX_DIR}/src/utils/math.ts`) return true;
      if (path === TEST_PROJECT_NODE_MODULES) return true;
      return false;
    });

    mockSymlinkSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });

    await expect(createSandbox('src/utils/math.ts', TEST_PROJECT)).rejects.toThrow('EPERM');
  });

  it('ensureExitHandler does not double-register on subsequent sandbox creations', async () => {
    const processOnSpy = vi.spyOn(process, 'on');
    processOnSpy.mockClear();

    // Create sandbox twice with fresh module
    vi.resetModules();
    const freshSandbox = await import('../utils/sandbox.js');
    mockMkdtempSync.mockReturnValue(SANDBOX_DIR);
    mockExistsSync.mockImplementation((path: string) => {
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

    // Mock readdirSync to return a directory with a giant file
    vi.mocked(readdirSync).mockReturnValueOnce([
      { name: 'src', isDirectory: () => true, isFile: () => false },
    ] as never);
    vi.mocked(readdirSync).mockReturnValueOnce([
      { name: 'giant.bin', isDirectory: () => false, isFile: () => true },
    ] as never);
    vi.mocked(statSync).mockReturnValueOnce({
      size: 250 * 1024 * 1024,
    } as never);

    mockExistsSync.mockImplementation((path: string) => {
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
    vi.mocked(readdirSync).mockImplementation((p: unknown) =>
      String(p).endsWith('node_modules')
        ? ([{ name: 'giant.bin', isDirectory: () => false, isFile: () => true }] as never)
        : ([{ name: 'node_modules', isDirectory: () => true, isFile: () => false }] as never),
    );
    vi.mocked(statSync).mockReturnValue({ size: 250 * 1024 * 1024 } as never);

    mockExistsSync.mockImplementation((path: string) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await createSandbox('src/utils/math.ts', TEST_PROJECT);

    const mbWarnings = mockedWarn.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('MB'),
    );
    expect(mbWarnings).toHaveLength(0);

    // Reset implementations so the path-based mocks don't bleed into later tests.
    vi.mocked(readdirSync).mockReset();
    vi.mocked(statSync).mockReset();
  });

  it('does not count user ignorePatterns directories toward the size estimate', async () => {
    const { warn } = await import('../utils/logger.js');
    const mockedWarn = vi.mocked(warn);
    mockedWarn.mockClear();

    // Root holds only a user-ignored 'huge' dir with a 250MB file. Since the
    // copy will skip it, the size estimate must skip it too — otherwise the
    // warning fires for bytes that are never copied.
    vi.mocked(readdirSync).mockImplementation((p: unknown) =>
      String(p).endsWith('huge')
        ? ([{ name: 'giant.bin', isDirectory: () => false, isFile: () => true }] as never)
        : ([{ name: 'huge', isDirectory: () => true, isFile: () => false }] as never),
    );
    vi.mocked(statSync).mockReturnValue({ size: 250 * 1024 * 1024 } as never);

    mockExistsSync.mockImplementation((path: string) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await createSandbox('src/utils/math.ts', TEST_PROJECT, ['huge']);

    const mbWarnings = mockedWarn.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('MB'),
    );
    expect(mbWarnings).toHaveLength(0);

    vi.mocked(readdirSync).mockReset();
    vi.mocked(statSync).mockReset();
  });

  it('does not warn on workspaces under 200MB', async () => {
    const { warn } = await import('../utils/logger.js');
    const mockedWarn = vi.mocked(warn);
    mockedWarn.mockClear();

    vi.mocked(readdirSync).mockReturnValueOnce([
      { name: 'src', isDirectory: () => true, isFile: () => false },
    ] as never);
    vi.mocked(readdirSync).mockReturnValueOnce([
      { name: 'small.ts', isDirectory: () => false, isFile: () => true },
    ] as never);
    vi.mocked(statSync).mockReturnValueOnce({ size: 1000 } as never);

    mockExistsSync.mockImplementation((path: string) => {
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
    mockExistsSync.mockImplementation((path: string) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await createSandbox('src/utils/math.ts', TEST_PROJECT, ['', 'fixtures', '']);

    const filter = mockCp.mock.calls[0][2]?.filter as (src: string) => boolean;
    // Empty patterns are skipped, fixtures is still excluded
    expect(filter(`${TEST_PROJECT}/fixtures/data.json`)).toBe(false);
    expect(filter(`${TEST_PROJECT}/src/utils/math.ts`)).toBe(true);
  });

  it('excludes by segment containing trailing separator in ignorePattern', async () => {
    mockExistsSync.mockImplementation((path: string) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await createSandbox('src/utils/math.ts', TEST_PROJECT, ['dist/', 'build/']);

    const filter = mockCp.mock.calls[0][2]?.filter as (src: string) => boolean;
    expect(filter(`${TEST_PROJECT}/dist/bundle.js`)).toBe(false);
    expect(filter(`${TEST_PROJECT}/build/output.js`)).toBe(false);
    expect(filter(`${TEST_PROJECT}/src/dist-utils.js`)).toBe(true);
  });

  // ─── estimateWorkspaceSize error-catch paths ─────────────────────────────

  it('estimateWorkspaceSize handles readdirSync errors gracefully', async () => {
    mockExistsSync.mockImplementation((path: string) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    // Simulate a permission error when reading a directory
    vi.mocked(readdirSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });

    // Should not throw — estimateWorkspaceSize catches readdirSync errors
    await expect(createSandbox('src/utils/math.ts', TEST_PROJECT)).resolves.toBeDefined();
  });

  it('estimateWorkspaceSize handles statSync errors gracefully', async () => {
    mockExistsSync.mockImplementation((path: string) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    // First readdirSync: return a dir with a file
    vi.mocked(readdirSync).mockReturnValueOnce([
      { name: 'src', isDirectory: () => true, isFile: () => false },
    ] as never);
    vi.mocked(readdirSync).mockReturnValueOnce([
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
    mockExistsSync.mockImplementation((path: string) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await expect(createSandbox('src/utils/math.ts', parentCwd)).rejects.toThrow(
      /Refusing to sandbox workspace outside process cwd/,
    );
  });

  it('rejects workspace that is a sibling directory of cwd (rel starts with ..)', async () => {
    // isPathInside should reject sibling directories (rel = '../sibling')
    const siblingDir = resolve(process.cwd(), '..', 'sibling-project');
    mockExistsSync.mockImplementation((path: string) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    await expect(createSandbox('src/utils/math.ts', siblingDir)).rejects.toThrow(
      /Refusing to sandbox workspace outside process cwd/,
    );
  });

  // ─── !success finally cleanup path ────────────────────────────────────

  it('cleans up sandbox when fs.cp throws (success stays false)', async () => {
    mockExistsSync.mockImplementation((path: string) => {
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
    mockExistsSync.mockImplementation((path: string) => {
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

  it('symlinks each SYMLINK_DIRS entry that exists (node_modules, .venv, venv)', async () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === `${SANDBOX_DIR}/src/utils/math.ts`) return true;
      return (
        path === TEST_PROJECT_NODE_MODULES ||
        path === TEST_PROJECT_VENV ||
        path === `${TEST_PROJECT}/venv`
      );
    });

    await createSandbox('src/utils/math.ts', TEST_PROJECT);

    const linked = mockSymlinkSync.mock.calls.map((c) => String(c[0]));
    expect(linked).toContain(TEST_PROJECT_NODE_MODULES);
    expect(linked).toContain(TEST_PROJECT_VENV);
    expect(linked).toContain(`${TEST_PROJECT}/venv`);
  });

  it('does not exclude everything when an ignorePattern is only a separator', async () => {
    mockExistsSync.mockImplementation((path: string) => {
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

    mockExistsSync.mockImplementation((path: string) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    // Exactly at the 200MB cap → strictly-greater-than guard must NOT warn.
    mockedWarn.mockClear();
    vi.mocked(readdirSync).mockReturnValueOnce([
      { name: 'big.bin', isDirectory: () => false, isFile: () => true },
    ] as never);
    vi.mocked(statSync).mockReturnValueOnce({ size: 200 * 1024 * 1024 } as never);
    await createSandbox('src/utils/math.ts', TEST_PROJECT);
    expect(mockedWarn.mock.calls.filter((c) => String(c[0]).includes('MB'))).toHaveLength(0);

    // 300MB → warns, and the human-readable size is computed correctly.
    mockedWarn.mockClear();
    vi.mocked(readdirSync).mockReturnValueOnce([
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
    expect(mockRmSync).not.toHaveBeenCalled();
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
    mockExistsSync.mockImplementation((path: string) => {
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

  it('signal handler cleans up then exits with 128 + signal number', async () => {
    vi.resetModules();
    const fresh = await import('../utils/sandbox.js');
    const onSpy = vi.spyOn(process, 'on');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    mockMkdtempSync.mockReturnValue(SANDBOX_DIR);
    mockExistsSync.mockImplementation((path: string) => {
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
