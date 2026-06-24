import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs module
vi.mock('fs', () => ({
  mkdtempSync: vi.fn(),
  cpSync: vi.fn(),
  symlinkSync: vi.fn(),
  rmSync: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readdirSync: vi.fn(),
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
}));

import { mkdtempSync, cpSync, symlinkSync, rmSync, existsSync } from 'fs';
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

const mockMkdtempSync = vi.mocked(mkdtempSync);
const mockCpSync = vi.mocked(cpSync);
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

    // Default: target file exists, node_modules exists
    mockExistsSync.mockImplementation((path: string) => {
      if (path === `${SANDBOX_DIR}/src/utils/math.ts`) return true;
      if (path === TEST_PROJECT_NODE_MODULES) return true;
      return false;
    });
  });

  it('creates a sandbox directory using os.tmpdir()', () => {
    mockTmpdir.mockReturnValue('/custom/tmp');
    mockMkdtempSync.mockReturnValue('/custom/tmp/chaos-mcp-00000000-0000-0000-0000-000000000000');
    mockExistsSync.mockImplementation((path: string) => {
      return (
        path === '/custom/tmp/chaos-mcp-00000000-0000-0000-0000-000000000000/src/utils/math.ts'
      );
    });

    sandbox = createSandbox('src/utils/math.ts', TEST_PROJECT);

    expect(mockMkdtempSync).toHaveBeenCalledWith(
      '/custom/tmp/chaos-mcp-00000000-0000-0000-0000-000000000000',
    );
  });

  it('returns context with workDir, targetFile, and cleanup', () => {
    sandbox = createSandbox('src/utils/math.ts', TEST_PROJECT);

    expect(sandbox.workDir).toBe(SANDBOX_DIR);
    expect(sandbox.targetFile).toBe('src/utils/math.ts');
    expect(typeof sandbox.cleanup).toBe('function');
  });

  it('copies the workspace tree to sandbox', () => {
    sandbox = createSandbox('src/utils/math.ts', TEST_PROJECT);

    expect(mockCpSync).toHaveBeenCalledWith(TEST_PROJECT, SANDBOX_DIR, {
      recursive: true,
      filter: expect.any(Function),
      dereference: false,
    });
  });

  it('symlinks node_modules into sandbox', () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === `${SANDBOX_DIR}/src/utils/math.ts`) return true;
      if (path === TEST_PROJECT_NODE_MODULES) return true;
      return false;
    });

    sandbox = createSandbox('src/utils/math.ts', TEST_PROJECT);

    expect(mockSymlinkSync).toHaveBeenCalledWith(
      TEST_PROJECT_NODE_MODULES,
      `${SANDBOX_DIR}/node_modules`,
      'dir',
    );
  });

  it('symlinks .venv into sandbox when present', () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === `${SANDBOX_DIR}/src/main.py`) return true;
      if (path === TEST_PROJECT_VENV) return true;
      return false;
    });

    sandbox = createSandbox('src/main.py', TEST_PROJECT);

    expect(mockSymlinkSync).toHaveBeenCalledWith(TEST_PROJECT_VENV, `${SANDBOX_DIR}/.venv`, 'dir');
  });

  it('refuses to sandbox when workspace resolves outside process cwd (C2)', () => {
    // /etc is an absolute path that escapes the test cwd.
    expect(() => createSandbox('src/utils/math.ts', '/etc')).toThrow(
      /Refusing to sandbox workspace outside process cwd/,
    );
  });

  it('accepts sandbox when workspace equals process cwd (Live-audit L1)', () => {
    // Previously `isPathInside(absoluteWorkspace, absoluteCwd)` returned false
    // when the two paths were equal (rel === ''). This blocked the legitimate
    // case where the user's workspace IS the cwd (the most common case).
    const cwd = process.cwd();
    mockExistsSync.mockImplementation((path: string) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts` || path === cwd;
    });

    expect(() => createSandbox('src/utils/math.ts', cwd)).not.toThrow();
  });

  it('strips trailing separator from ignorePatterns (Live-audit L2)', () => {
    // Convention `["fixtures/"]` should exclude the `fixtures` directory
    // segment, not silently fail because the segment lacks the trailing slash.
    mockExistsSync.mockImplementation((path: string) => {
      if (path === `${SANDBOX_DIR}/src/utils/math.ts`) return true;
      return false;
    });

    createSandbox('src/utils/math.ts', TEST_PROJECT, ['fixtures/']);

    const filter = mockCpSync.mock.calls[0][2]?.filter as (src: string) => boolean;
    expect(filter).toBeDefined();

    // `fixtures` segment should be excluded
    expect(filter(`${TEST_PROJECT}/fixtures/data.json`)).toBe(false);
    // Regular files should still be included
    expect(filter(`${TEST_PROJECT}/src/utils/math.ts`)).toBe(true);
  });

  it('does NOT symlink target/ for Rust builds (H1 regression)', () => {
    // Audit finding H1: target/ contains Rust build artifacts. Symlinking
    // would let mutation runs corrupt the host workspace's build cache.
    // The sandbox must exclude target/ outright (always) instead of symlinking.
    mockExistsSync.mockImplementation((path: string) => {
      if (path === `${SANDBOX_DIR}/src/main.rs`) return true;
      if (path === TEST_PROJECT_TARGET) return true;
      return false;
    });

    sandbox = createSandbox('src/main.rs', TEST_PROJECT);

    // symlinkSync must NOT be called for `target`.
    const symlinked = mockSymlinkSync.mock.calls.map((call) => call[1]);
    expect(symlinked).not.toContain(`${SANDBOX_DIR}/target`);
  });

  it('excludes by segment match, not substring match (M6 regression)', () => {
    // Audit finding M6: substring matching over-eagerly excludes files whose
    // path contains the pattern anywhere. Segment matching only excludes when
    // a single path segment equals the pattern.
    mockExistsSync.mockImplementation((path: string) => {
      if (path === `${SANDBOX_DIR}/src/utils/math.ts`) return true;
      return false;
    });

    createSandbox('src/utils/math.ts', TEST_PROJECT, ['test']);

    const filter = mockCpSync.mock.calls[0][2]?.filter as (src: string) => boolean;
    expect(filter).toBeDefined();

    // `latest.ts` contains 'test' as a substring but has no segment named 'test'.
    // Pre-M6 this was incorrectly excluded; post-M6 it is correctly included.
    expect(filter(`${TEST_PROJECT}/src/latest.ts`)).toBe(true);

    // A directory segment equal to `test` IS excluded.
    expect(filter(`${TEST_PROJECT}/test/file.ts`)).toBe(false);
  });

  it('skips symlinks for directories that do not exist', () => {
    mockExistsSync.mockImplementation((path: string) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    sandbox = createSandbox('src/utils/math.ts', TEST_PROJECT);

    expect(mockSymlinkSync).not.toHaveBeenCalled();
  });

  it('throws when target file does not exist in sandbox', () => {
    mockExistsSync.mockReturnValue(false);

    expect(() => createSandbox('src/utils/math.ts', TEST_PROJECT)).toThrow(
      /Sandbox provisioning failed/,
    );
  });

  it('cleans up temp dir on provisioning failure', () => {
    mockExistsSync.mockReturnValue(false);

    expect(() => createSandbox('src/utils/math.ts', TEST_PROJECT)).toThrow();

    expect(mockRmSync).toHaveBeenCalledWith(SANDBOX_DIR, { recursive: true, force: true });
  });

  it('cleanup() removes sandbox directory', () => {
    mockExistsSync.mockImplementation((path: string) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    sandbox = createSandbox('src/utils/math.ts', TEST_PROJECT);
    sandbox.cleanup();

    expect(mockRmSync).toHaveBeenCalledWith(SANDBOX_DIR, { recursive: true, force: true });
  });

  it('cleanup() swallows errors gracefully', () => {
    mockExistsSync.mockImplementation((path: string) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    mockRmSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });

    sandbox = createSandbox('src/utils/math.ts', TEST_PROJECT);

    expect(() => sandbox.cleanup()).not.toThrow();
  });

  it('filter excludes node_modules, .git, target, and generated dirs', () => {
    mockExistsSync.mockImplementation((path: string) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    createSandbox('src/utils/math.ts', TEST_PROJECT);

    const filter = mockCpSync.mock.calls[0][2]?.filter as (src: string) => boolean;
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
});
