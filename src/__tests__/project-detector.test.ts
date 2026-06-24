import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';

// Mock the fs module before importing the detector
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import {
  detectProjectType,
  detectEnvironment,
  resolveWorkspaceRoot,
  detectJsTestRunner,
  detectPythonTestRunner,
  detectRawJsRunner,
  detectRawPythonRunner,
  detectGoTestRunner,
  detectRawGoRunner,
  detectRustTestRunner,
  detectRawRustRunner,
} from '../utils/project-detector.js';
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

// ─── Original detectProjectType tests (preserved) ───────────────────────────

describe('detectProjectType', () => {
  describe('TypeScript/JavaScript files', () => {
    it.each([
      ['src/utils/helper.ts', 'typescript'],
      ['src/index.js', 'typescript'],
      ['components/App.tsx', 'typescript'],
      ['components/App.jsx', 'typescript'],
    ] as const)('detects %s as %s', (filePath, expected) => {
      expect(detectProjectType(filePath)).toBe(expected);
    });
  });

  describe('Go files', () => {
    it('detects .go files as go', () => {
      expect(detectProjectType('src/main.go')).toBe('go');
    });

    it('detects deeply nested .go files', () => {
      expect(detectProjectType('pkg/core/utils/helpers.go')).toBe('go');
    });
  });

  describe('Rust files', () => {
    it('detects .rs files as rust', () => {
      expect(detectProjectType('src/main.rs')).toBe('rust');
    });

    it('detects deeply nested .rs files', () => {
      expect(detectProjectType('crates/core/src/lib.rs')).toBe('rust');
    });
  });

  describe('Python files', () => {
    it('detects .py files as python', () => {
      expect(detectProjectType('src/main.py')).toBe('python');
    });

    it('detects deeply nested .py files', () => {
      expect(detectProjectType('packages/core/utils/helpers.py')).toBe('python');
    });
  });

  describe('unsupported files', () => {
    it.each(['main.rb', 'main.java', 'main.dart', 'README.md', 'config.yaml', ''])(
      'detects %s as unsupported',
      (filePath) => {
        expect(detectProjectType(filePath)).toBe('unsupported');
      },
    );
  });

  describe('edge cases', () => {
    it('does not match partial extensions', () => {
      // A file named "notes.typing" should not match .ts
      expect(detectProjectType('notes.typing')).toBe('unsupported');
    });

    it('does not match .py in the middle of a path', () => {
      // Only the file extension matters, not directory names
      expect(detectProjectType('src/python/main.rb')).toBe('unsupported');
    });

    it('matches case-sensitively', () => {
      // .TS uppercase should not match (extensions are lowercase by convention)
      expect(detectProjectType('file.TS')).toBe('unsupported');
    });
  });
});

// ─── resolveWorkspaceRoot tests ──────────────────────────────────────────────

describe('resolveWorkspaceRoot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the start directory when it contains a marker file', () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p) === join(resolve('/project'), 'package.json');
    });

    const result = resolveWorkspaceRoot('/project', ['package.json']);
    expect(result).toBe(resolve('/project'));
  });

  it('walks up to find a marker file in a parent directory', () => {
    mockExistsSync.mockImplementation((p) => {
      // Only the grandparent has package.json
      return String(p) === join(resolve('/project'), 'package.json');
    });

    const result = resolveWorkspaceRoot('/project/src/utils', ['package.json']);
    expect(result).toBe(resolve('/project'));
  });

  it('returns start directory when no marker is found within max depth', () => {
    mockExistsSync.mockReturnValue(false);

    const result = resolveWorkspaceRoot('/deeply/nested/path', ['package.json']);
    expect(result).toBe(resolve('/deeply/nested/path'));
  });

  it('checks multiple marker files at each level', () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p) === join(resolve('/project'), 'pyproject.toml');
    });

    const result = resolveWorkspaceRoot('/project/src', [
      'pyproject.toml',
      'setup.py',
      'setup.cfg',
    ]);
    expect(result).toBe(resolve('/project'));
  });
});

// ─── detectJsTestRunner tests ────────────────────────────────────────────────

describe('detectJsTestRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  describe('config file detection (Priority 1)', () => {
    it('detects vitest from vitest.config.ts', () => {
      mockExistsSync.mockImplementation((p) => {
        return String(p) === join('/workspace', 'vitest.config.ts');
      });

      expect(detectJsTestRunner('/workspace')).toBe('vitest');
    });

    it('detects vitest from vitest.config.js', () => {
      mockExistsSync.mockImplementation((p) => {
        return String(p) === join('/workspace', 'vitest.config.js');
      });

      expect(detectJsTestRunner('/workspace')).toBe('vitest');
    });

    it('detects jest from jest.config.ts', () => {
      mockExistsSync.mockImplementation((p) => {
        return String(p) === join('/workspace', 'jest.config.ts');
      });

      expect(detectJsTestRunner('/workspace')).toBe('jest');
    });

    it('detects jest from jest.config.js', () => {
      mockExistsSync.mockImplementation((p) => {
        return String(p) === join('/workspace', 'jest.config.js');
      });

      expect(detectJsTestRunner('/workspace')).toBe('jest');
    });

    it('detects mocha from .mocharc.yml', () => {
      mockExistsSync.mockImplementation((p) => {
        return String(p) === join('/workspace', '.mocharc.yml');
      });

      expect(detectJsTestRunner('/workspace')).toBe('mocha');
    });

    it('detects mocha from .mocharc.json', () => {
      mockExistsSync.mockImplementation((p) => {
        return String(p) === join('/workspace', '.mocharc.json');
      });

      expect(detectJsTestRunner('/workspace')).toBe('mocha');
    });

    it('detects jasmine from jasmine.json', () => {
      mockExistsSync.mockImplementation((p) => {
        return String(p) === join('/workspace', 'jasmine.json');
      });

      expect(detectJsTestRunner('/workspace')).toBe('jasmine');
    });

    it('detects jasmine from spec/support/jasmine.json', () => {
      mockExistsSync.mockImplementation((p) => {
        return String(p) === join('/workspace', 'spec/support/jasmine.json');
      });

      expect(detectJsTestRunner('/workspace')).toBe('jasmine');
    });

    it('detects bun from bunfig.toml (maps to command)', () => {
      mockExistsSync.mockImplementation((p) => {
        return String(p) === join('/workspace', 'bunfig.toml');
      });

      // Stryker has no bun plugin → mapped to 'command'
      expect(detectJsTestRunner('/workspace')).toBe('command');
    });

    it('prioritizes vitest config over jest config when both exist', () => {
      mockExistsSync.mockImplementation((p) => {
        const path = String(p);
        return (
          path === join('/workspace', 'vitest.config.ts') ||
          path === join('/workspace', 'jest.config.js')
        );
      });

      expect(detectJsTestRunner('/workspace')).toBe('vitest');
    });

    it('prioritizes vitest config over bunfig.toml when both exist', () => {
      mockExistsSync.mockImplementation((p) => {
        const path = String(p);
        return (
          path === join('/workspace', 'vitest.config.ts') ||
          path === join('/workspace', 'bunfig.toml')
        );
      });

      expect(detectJsTestRunner('/workspace')).toBe('vitest');
    });
  });

  describe('package.json dependency detection (Priority 2)', () => {
    it('detects vitest from devDependencies', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          devDependencies: { vitest: '^3.0.0' },
        }),
      );

      expect(detectJsTestRunner('/workspace')).toBe('vitest');
    });

    it('detects jest from dependencies', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          dependencies: { jest: '^29.0.0' },
        }),
      );

      expect(detectJsTestRunner('/workspace')).toBe('jest');
    });

    it('detects mocha from devDependencies', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          devDependencies: { mocha: '^10.0.0' },
        }),
      );

      expect(detectJsTestRunner('/workspace')).toBe('mocha');
    });

    it('detects jasmine from devDependencies', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          devDependencies: { jasmine: '^5.0.0' },
        }),
      );

      expect(detectJsTestRunner('/workspace')).toBe('jasmine');
    });

    it('detects bun from dependencies (maps to command)', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          dependencies: { bun: '^1.0.0' },
        }),
      );

      expect(detectJsTestRunner('/workspace')).toBe('command');
    });

    it('detects bun from bun-types devDependency', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          devDependencies: { 'bun-types': '^1.0.0' },
        }),
      );

      expect(detectJsTestRunner('/workspace')).toBe('command');
    });

    it('prioritizes vitest over jest in dependencies', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          devDependencies: { vitest: '^3.0.0', jest: '^29.0.0' },
        }),
      );

      expect(detectJsTestRunner('/workspace')).toBe('vitest');
    });
  });

  describe('package.json scripts.test detection (Priority 3)', () => {
    it('detects vitest from test script', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          scripts: { test: 'vitest run' },
        }),
      );

      expect(detectJsTestRunner('/workspace')).toBe('vitest');
    });

    it('detects jest from test script', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          scripts: { test: 'jest --coverage' },
        }),
      );

      expect(detectJsTestRunner('/workspace')).toBe('jest');
    });

    it('detects mocha from test script', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          scripts: { test: 'mocha --recursive' },
        }),
      );

      expect(detectJsTestRunner('/workspace')).toBe('mocha');
    });

    it('detects jasmine from test script', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          scripts: { test: 'jasmine' },
        }),
      );

      expect(detectJsTestRunner('/workspace')).toBe('jasmine');
    });

    it('detects bun test from script (maps to command)', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          scripts: { test: 'bun test' },
        }),
      );

      expect(detectJsTestRunner('/workspace')).toBe('command');
    });

    it('detects bun run test from script (maps to command)', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          scripts: { test: 'bun run test --coverage' },
        }),
      );

      expect(detectJsTestRunner('/workspace')).toBe('command');
    });

    it('detects node --test from script (maps to command)', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          scripts: { test: 'node --test src/**/*.test.js' },
        }),
      );

      expect(detectJsTestRunner('/workspace')).toBe('command');
    });

    it('detects node:test from script (maps to command)', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          scripts: { test: 'node:test' },
        }),
      );

      expect(detectJsTestRunner('/workspace')).toBe('command');
    });
  });

  describe('fallback behavior', () => {
    it('returns command when no signals are found', () => {
      expect(detectJsTestRunner('/workspace')).toBe('command');
    });

    it('returns command when package.json is empty', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({}));

      expect(detectJsTestRunner('/workspace')).toBe('command');
    });

    it('returns command when package.json has invalid JSON', () => {
      mockReadFileSync.mockReturnValue('not json {{}}');

      expect(detectJsTestRunner('/workspace')).toBe('command');
    });
  });
});

// ─── detectPythonTestRunner tests ────────────────────────────────────────────

describe('detectPythonTestRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  describe('pyproject.toml pytest markers (Priority 1)', () => {
    it('detects pytest from [tool.pytest] section', () => {
      mockReadFileSync.mockImplementation((p) => {
        if (String(p).endsWith('pyproject.toml')) {
          return '[tool.pytest]\naddopts = "-v"';
        }
        throw new Error('ENOENT');
      });

      expect(detectPythonTestRunner('/workspace')).toBe('pytest');
    });

    it('detects pytest from [tool.pytest.ini_options] section', () => {
      mockReadFileSync.mockImplementation((p) => {
        if (String(p).endsWith('pyproject.toml')) {
          return '[tool.pytest.ini_options]\nminversion = "6.0"';
        }
        throw new Error('ENOENT');
      });

      expect(detectPythonTestRunner('/workspace')).toBe('pytest');
    });
  });

  describe('standalone pytest markers (Priority 2)', () => {
    it('detects pytest from pytest.ini', () => {
      mockExistsSync.mockImplementation((p) => {
        return String(p) === join('/workspace', 'pytest.ini');
      });

      expect(detectPythonTestRunner('/workspace')).toBe('pytest');
    });

    it('detects pytest from conftest.py', () => {
      mockExistsSync.mockImplementation((p) => {
        return String(p) === join('/workspace', 'conftest.py');
      });

      expect(detectPythonTestRunner('/workspace')).toBe('pytest');
    });
  });

  describe('setup.cfg pytest markers (Priority 3)', () => {
    it('detects pytest from setup.cfg [tool:pytest]', () => {
      mockReadFileSync.mockImplementation((p) => {
        if (String(p).endsWith('setup.cfg')) {
          return '[tool:pytest]\naddopts = --strict-markers';
        }
        throw new Error('ENOENT');
      });

      expect(detectPythonTestRunner('/workspace')).toBe('pytest');
    });
  });

  describe('tox/nox orchestrator detection (Priority 4)', () => {
    it('detects tox from tox.ini (returns pytest for mutmut)', () => {
      mockExistsSync.mockImplementation((p) => {
        return String(p) === join('/workspace', 'tox.ini');
      });

      expect(detectPythonTestRunner('/workspace')).toBe('pytest');
    });

    it('detects nox from noxfile.py (returns pytest for mutmut)', () => {
      mockExistsSync.mockImplementation((p) => {
        return String(p) === join('/workspace', 'noxfile.py');
      });

      expect(detectPythonTestRunner('/workspace')).toBe('pytest');
    });

    it('prioritizes pytest config over tox.ini', () => {
      mockExistsSync.mockImplementation((p) => {
        const path = String(p);
        return path === join('/workspace', 'pytest.ini') || path === join('/workspace', 'tox.ini');
      });

      // pytest.ini is Priority 2, tox.ini is Priority 4
      expect(detectPythonTestRunner('/workspace')).toBe('pytest');
    });
  });

  describe('mutmut runner override (Priority 5)', () => {
    it('reads custom runner from pyproject.toml [tool.mutmut]', () => {
      mockReadFileSync.mockImplementation((p) => {
        if (String(p).endsWith('pyproject.toml')) {
          return '[tool.mutmut]\npaths_to_mutate = ["src/"]\nrunner = "python -m unittest discover"';
        }
        throw new Error('ENOENT');
      });

      expect(detectPythonTestRunner('/workspace')).toBe('python -m unittest discover');
    });

    it('reads runner with single quotes', () => {
      mockReadFileSync.mockImplementation((p) => {
        if (String(p).endsWith('pyproject.toml')) {
          return "[tool.mutmut]\nrunner = 'unittest'";
        }
        throw new Error('ENOENT');
      });

      expect(detectPythonTestRunner('/workspace')).toBe('unittest');
    });
  });

  describe('fallback behavior', () => {
    it('returns pytest as default when no signals are found (Priority 6)', () => {
      expect(detectPythonTestRunner('/workspace')).toBe('pytest');
    });
  });
});

// ─── detectEnvironment integration tests ─────────────────────────────────────

describe('detectEnvironment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  it('returns unsupported for unknown file extensions', () => {
    const result = detectEnvironment('main.rb');
    expect(result.projectType).toBe('unsupported');
    expect(result.testRunner).toBe('unknown');
  });

  it('detects typescript project with vitest config', () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      // Walk up finds package.json, and vitest.config.ts exists at that root
      return path.endsWith('package.json') || path.endsWith('vitest.config.ts');
    });

    const result = detectEnvironment('src/utils/math.ts');
    expect(result.projectType).toBe('typescript');
    expect(result.testRunner).toBe('vitest');
  });

  it('detects typescript project falling back to command runner', () => {
    // package.json exists but has no runner signals
    mockExistsSync.mockImplementation((p) => {
      return String(p).endsWith('package.json');
    });
    mockReadFileSync.mockReturnValue(JSON.stringify({}));

    const result = detectEnvironment('src/index.ts');
    expect(result.projectType).toBe('typescript');
    expect(result.testRunner).toBe('command');
  });

  it('detects python project with pytest', () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      return path.endsWith('pyproject.toml') || path.endsWith('conftest.py');
    });
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith('pyproject.toml')) {
        return '[tool.pytest.ini_options]\nminversion = "6.0"';
      }
      throw new Error('ENOENT');
    });

    const result = detectEnvironment('src/main.py');
    expect(result.projectType).toBe('python');
    expect(result.testRunner).toBe('pytest');
  });

  it('detects Go project with go.mod', () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p).endsWith('go.mod');
    });

    const result = detectEnvironment('src/main.go');
    expect(result.projectType).toBe('go');
    expect(result.testRunner).toBe('go test');
    expect(result.detectedRunner).toBe('go test');
  });

  it('includes a workspaceRoot in the result', () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p).endsWith('package.json');
    });
    mockReadFileSync.mockReturnValue(JSON.stringify({}));

    const result = detectEnvironment('src/test.ts');
    expect(result.workspaceRoot).toBeDefined();
    expect(typeof result.workspaceRoot).toBe('string');
  });

  it('populates detectedRunner for bun project (mapped testRunner vs raw detection)', () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      // package.json exists for workspace root, bunfig.toml exists for bun detection
      return path.endsWith('package.json') || path.endsWith('bunfig.toml');
    });
    mockReadFileSync.mockReturnValue(JSON.stringify({}));

    const result = detectEnvironment('src/app.ts');
    expect(result.projectType).toBe('typescript');
    // Stryker-compatible: bun maps to command
    expect(result.testRunner).toBe('command');
    // Raw detection: we actually saw bun
    expect(result.detectedRunner).toBe('bun');
  });

  it('populates detectedRunner for node:test project', () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p).endsWith('package.json');
    });
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ scripts: { test: 'node --test src/**/*.test.js' } }),
    );

    const result = detectEnvironment('src/app.ts');
    expect(result.testRunner).toBe('command');
    expect(result.detectedRunner).toBe('node:test');
  });
});

// ─── detectRawJsRunner tests ────────────────────────────────────────────────

describe('detectRawJsRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  it('returns bun when bunfig.toml is present', () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p) === join('/workspace', 'bunfig.toml');
    });

    expect(detectRawJsRunner('/workspace')).toBe('bun');
  });

  it('returns bun when bun is in dependencies', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ devDependencies: { bun: '^1.0.0' } }));

    expect(detectRawJsRunner('/workspace')).toBe('bun');
  });

  it('returns node:test from script detection', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ scripts: { test: 'node --test' } }));

    expect(detectRawJsRunner('/workspace')).toBe('node:test');
  });

  it('returns vitest when vitest config exists (no mapping needed)', () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p) === join('/workspace', 'vitest.config.ts');
    });

    expect(detectRawJsRunner('/workspace')).toBe('vitest');
  });

  it('returns command when no signals are found', () => {
    expect(detectRawJsRunner('/workspace')).toBe('command');
  });
});

// ─── detectGoTestRunner tests ───────────────────────────────────────────────

describe('detectGoTestRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  it('detects testify from go.mod', () => {
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith('go.mod')) {
        return 'module example.com/my-project\n\ngo 1.23\n\nrequire (\n  github.com/stretchr/testify v1.10.0\n)';
      }
      throw new Error('ENOENT');
    });

    expect(detectGoTestRunner('/workspace')).toBe('testify');
  });

  it('detects ginkgo from go.mod', () => {
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith('go.mod')) {
        return 'module example.com/my-project\n\ngo 1.23\n\nrequire (\n  github.com/onsi/ginkgo/v2 v2.22.0\n  github.com/onsi/gomega v1.36.0\n)';
      }
      throw new Error('ENOENT');
    });

    expect(detectGoTestRunner('/workspace')).toBe('ginkgo');
  });

  it('returns go test when go.mod has no framework deps', () => {
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith('go.mod')) {
        return 'module example.com/my-project\n\ngo 1.23';
      }
      throw new Error('ENOENT');
    });

    expect(detectGoTestRunner('/workspace')).toBe('go test');
  });

  it('returns go test when go.mod does not exist', () => {
    expect(detectGoTestRunner('/workspace')).toBe('go test');
  });

  it('detectRawGoRunner returns same as detectGoTestRunner', () => {
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith('go.mod')) {
        return 'require github.com/stretchr/testify v1.10.0';
      }
      throw new Error('ENOENT');
    });

    expect(detectRawGoRunner('/workspace')).toBe('testify');
  });
});

// ─── detectRustTestRunner tests ──────────────────────────────────────────────

describe('detectRustTestRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  it('detects cargo-nextest from nextest.toml', () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p) === join('/workspace', 'nextest.toml');
    });

    expect(detectRustTestRunner('/workspace')).toBe('cargo nextest run');
  });

  it('detects cargo-nextest from .config/nextest.toml', () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p) === join('/workspace', '.config', 'nextest.toml');
    });

    expect(detectRustTestRunner('/workspace')).toBe('cargo nextest run');
  });

  it('returns cargo test when criterion is in Cargo.toml dev-dependencies', () => {
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith('Cargo.toml')) {
        return '[dev-dependencies]\ncriterion = "0.5"';
      }
      throw new Error('ENOENT');
    });

    expect(detectRustTestRunner('/workspace')).toBe('cargo test');
  });

  it('returns cargo test when no signals found', () => {
    expect(detectRustTestRunner('/workspace')).toBe('cargo test');
  });

  it('detectRawRustRunner returns same as detectRustTestRunner', () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p) === join('/workspace', 'nextest.toml');
    });

    expect(detectRawRustRunner('/workspace')).toBe('cargo nextest run');
  });
});

// ─── detectRawPythonRunner tests ───────────────────────────────────────────

describe('detectRawPythonRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  it('returns tox when tox.ini is present', () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p) === join('/workspace', 'tox.ini');
    });

    expect(detectRawPythonRunner('/workspace')).toBe('tox');
  });

  it('returns nox when noxfile.py is present', () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p) === join('/workspace', 'noxfile.py');
    });

    expect(detectRawPythonRunner('/workspace')).toBe('nox');
  });

  it('returns pytest when no tox/nox signals are found', () => {
    expect(detectRawPythonRunner('/workspace')).toBe('pytest');
  });

  it('returns the mutmut runner override when configured', () => {
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith('pyproject.toml')) {
        return "[tool.mutmut]\nrunner = 'unittest'";
      }
      throw new Error('ENOENT');
    });

    expect(detectRawPythonRunner('/workspace')).toBe('unittest');
  });
});
