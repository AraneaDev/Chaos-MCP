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
import { createSandbox, SandboxContext } from '../utils/sandbox.js';

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
      if (path === '/project/node_modules') return true;
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

    sandbox = createSandbox('src/utils/math.ts', '/project');

    expect(mockMkdtempSync).toHaveBeenCalledWith(
      '/custom/tmp/chaos-mcp-00000000-0000-0000-0000-000000000000',
    );
  });

  it('returns context with workDir, targetFile, and cleanup', () => {
    sandbox = createSandbox('src/utils/math.ts', '/project');

    expect(sandbox.workDir).toBe(SANDBOX_DIR);
    expect(sandbox.targetFile).toBe('src/utils/math.ts');
    expect(typeof sandbox.cleanup).toBe('function');
  });

  it('copies the workspace tree to sandbox', () => {
    sandbox = createSandbox('src/utils/math.ts', '/project');

    expect(mockCpSync).toHaveBeenCalledWith('/project', SANDBOX_DIR, {
      recursive: true,
      filter: expect.any(Function),
      dereference: false,
    });
  });

  it('symlinks node_modules into sandbox', () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === `${SANDBOX_DIR}/src/utils/math.ts`) return true;
      if (path === '/project/node_modules') return true;
      return false;
    });

    sandbox = createSandbox('src/utils/math.ts', '/project');

    expect(mockSymlinkSync).toHaveBeenCalledWith(
      '/project/node_modules',
      `${SANDBOX_DIR}/node_modules`,
      'dir',
    );
  });

  it('symlinks .venv into sandbox when present', () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === `${SANDBOX_DIR}/src/main.py`) return true;
      if (path === '/project/.venv') return true;
      return false;
    });

    sandbox = createSandbox('src/main.py', '/project');

    expect(mockSymlinkSync).toHaveBeenCalledWith('/project/.venv', `${SANDBOX_DIR}/.venv`, 'dir');
  });

  it('symlinks target/ into sandbox when present (Rust)', () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === `${SANDBOX_DIR}/src/main.rs`) return true;
      if (path === '/project/target') return true;
      return false;
    });

    sandbox = createSandbox('src/main.rs', '/project');

    expect(mockSymlinkSync).toHaveBeenCalledWith('/project/target', `${SANDBOX_DIR}/target`, 'dir');
  });

  it('skips symlinks for directories that do not exist', () => {
    mockExistsSync.mockImplementation((path: string) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    sandbox = createSandbox('src/utils/math.ts', '/project');

    expect(mockSymlinkSync).not.toHaveBeenCalled();
  });

  it('throws when target file does not exist in sandbox', () => {
    mockExistsSync.mockReturnValue(false);

    expect(() => createSandbox('src/utils/math.ts', '/project')).toThrow(
      /Sandbox provisioning failed/,
    );
  });

  it('cleans up temp dir on provisioning failure', () => {
    mockExistsSync.mockReturnValue(false);

    expect(() => createSandbox('src/utils/math.ts', '/project')).toThrow();

    expect(mockRmSync).toHaveBeenCalledWith(SANDBOX_DIR, { recursive: true, force: true });
  });

  it('cleanup() removes sandbox directory', () => {
    mockExistsSync.mockImplementation((path: string) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    sandbox = createSandbox('src/utils/math.ts', '/project');
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

    sandbox = createSandbox('src/utils/math.ts', '/project');

    expect(() => sandbox.cleanup()).not.toThrow();
  });

  it('filter excludes node_modules, .git, target, and generated dirs', () => {
    mockExistsSync.mockImplementation((path: string) => {
      return path === `${SANDBOX_DIR}/src/utils/math.ts`;
    });

    createSandbox('src/utils/math.ts', '/project');

    const filter = mockCpSync.mock.calls[0][2]?.filter as (src: string) => boolean;
    expect(filter).toBeDefined();

    expect(filter('/project/node_modules')).toBe(false);
    expect(filter('/project/.git')).toBe(false);
    expect(filter('/project/.stryker-tmp')).toBe(false);
    expect(filter('/project/.mutmut-cache')).toBe(false);
    expect(filter('/project/__pycache__')).toBe(false);
    expect(filter('/project/.venv')).toBe(false);
    expect(filter('/project/venv')).toBe(false);
    expect(filter('/project/dist')).toBe(false);
    expect(filter('/project/build')).toBe(false);
    expect(filter('/project/coverage')).toBe(false);
    expect(filter('/project/target')).toBe(false);

    // Normal directories should be included
    expect(filter('/project/src')).toBe(true);
    expect(filter('/project/src/utils/math.ts')).toBe(true);
    expect(filter('/project/package.json')).toBe(true);
  });
});
