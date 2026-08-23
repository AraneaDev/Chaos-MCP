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
  detectRustTestRunner,
  detectRawRustRunner,
  detectPythonPackageManager,
  detectPhpTestRunner,
  detectRawPhpRunner,
  supportedSourceExtensions,
  primarySourceExtensions,
  assertNeverProjectType,
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
      ['src/server.mjs', 'typescript'],
      ['src/legacy.cjs', 'typescript'],
      ['src/types.mts', 'typescript'],
      ['src/types.cts', 'typescript'],
    ] as const)('detects %s as %s', (filePath, expected) => {
      expect(detectProjectType(filePath)).toBe(expected);
    });
  });

  it('treats .go files as unsupported after Go removal', () => {
    expect(detectProjectType('src/main.go')).toBe('unsupported');
    const env = detectEnvironment('src/main.go');
    expect(env.projectType).toBe('unsupported');
    expect(env.testRunner).toBe('unknown');
  });

  it('detects .php files as php with the phpunit runner', () => {
    expect(detectProjectType('src/Calculator.php')).toBe('php');
    mockExistsSync.mockImplementation((p) => String(p).endsWith('composer.json'));
    const env = detectEnvironment('src/Calculator.php');
    expect(env.projectType).toBe('php');
    expect(env.testRunner).toBe('phpunit');
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

    it('matches extensions case-insensitively', () => {
      // On the case-insensitive filesystems where these are ordinary filenames
      // (macOS, Windows), an uppercase extension still names the same language.
      // Rejecting them as "Extension unsupported" was a confusing way to
      // describe a file that plainly has a supported extension.
      expect(detectProjectType('file.TS')).toBe('typescript');
      expect(detectProjectType('Main.RS')).toBe('rust');
      expect(detectProjectType('Foo.PHP')).toBe('php');
      expect(detectProjectType('Script.PY')).toBe('python');
      // Genuinely unsupported extensions are still rejected.
      expect(detectProjectType('file.TXT')).toBe('unsupported');
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

  it('does not ascend above the boundary directory', () => {
    // Only the grandparent /project has the marker, but the boundary is the
    // start dir — the walk must NOT climb above it (sandbox containment relies
    // on the workspace root staying within process.cwd()).
    mockExistsSync.mockImplementation((p) => {
      return String(p) === join(resolve('/project'), 'package.json');
    });

    const result = resolveWorkspaceRoot('/project/src', ['package.json'], '/project/src');
    expect(result).toBe(resolve('/project/src'));
  });

  it('still finds a marker located exactly at the boundary directory', () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p) === join(resolve('/project'), 'package.json');
    });

    const result = resolveWorkspaceRoot('/project/src', ['package.json'], '/project');
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

    describe('native vitest runner gating', () => {
      // StrykerJS 10's vitest-runner drives vitest 3 and 4, both verified
      // against `coverageAnalysis: 'perTest'` (see the HISTORY note on
      // toStrykerRunner). The only floor left is the runner's declared peer
      // range, `vitest: >=2.0.0`.

      it('keeps the native vitest runner on vitest 3', () => {
        mockReadFileSync.mockImplementation((p) => {
          const s = String(p);
          if (s === join('/workspace', 'node_modules', 'vitest', 'package.json')) {
            return JSON.stringify({ version: '3.0.5' });
          }
          if (s === join('/workspace', 'package.json')) {
            return JSON.stringify({ devDependencies: { vitest: '^3.0.0' } });
          }
          throw new Error('ENOENT');
        });

        expect(detectJsTestRunner('/workspace')).toBe('vitest');
      });

      it('keeps the native vitest runner on vitest 4', () => {
        mockReadFileSync.mockImplementation((p) => {
          const s = String(p);
          if (s === join('/workspace', 'node_modules', 'vitest', 'package.json')) {
            return JSON.stringify({ version: '4.1.11' });
          }
          if (s === join('/workspace', 'package.json')) {
            return JSON.stringify({ devDependencies: { vitest: '^4.0.0' } });
          }
          throw new Error('ENOENT');
        });

        expect(detectJsTestRunner('/workspace')).toBe('vitest');
      });

      it('keeps the native vitest runner when the installed vitest major is 2', () => {
        mockReadFileSync.mockImplementation((p) => {
          const s = String(p);
          if (s === join('/workspace', 'node_modules', 'vitest', 'package.json')) {
            return JSON.stringify({ version: '2.1.9' });
          }
          if (s === join('/workspace', 'package.json')) {
            return JSON.stringify({ devDependencies: { vitest: '^2.1.0' } });
          }
          throw new Error('ENOENT');
        });

        expect(detectJsTestRunner('/workspace')).toBe('vitest');
      });

      it('falls back to the command runner below the runner peer range (vitest 1)', () => {
        // `@stryker-mutator/vitest-runner` declares `vitest: >=2.0.0`, so a
        // vitest 1 project has no supported native runner.
        mockReadFileSync.mockImplementation((p) => {
          const s = String(p);
          if (s === join('/workspace', 'node_modules', 'vitest', 'package.json')) {
            return JSON.stringify({ version: '1.6.0' });
          }
          if (s === join('/workspace', 'package.json')) {
            return JSON.stringify({ devDependencies: { vitest: '^1.6.0' } });
          }
          throw new Error('ENOENT');
        });

        expect(detectJsTestRunner('/workspace')).toBe('command');
      });

      it('keeps vitest when the installed version cannot be determined (not installed)', () => {
        // vitest is declared but node_modules/vitest is absent → we cannot
        // confirm anything about the major, so prefer the native runner.
        mockReadFileSync.mockImplementation((p) => {
          if (String(p) === join('/workspace', 'package.json')) {
            return JSON.stringify({ devDependencies: { vitest: '^3.0.0' } });
          }
          throw new Error('ENOENT');
        });

        expect(detectJsTestRunner('/workspace')).toBe('vitest');
      });

      it('does not apply the vitest version gate to a jest project', () => {
        // The gate is runner-specific. Applied to every runner, a Jest project
        // that merely has an old vitest somewhere in its tree would be silently
        // moved onto the command runner.
        mockExistsSync.mockImplementation((p) => String(p).endsWith('jest.config.js'));
        mockReadFileSync.mockImplementation((p) => {
          const s = String(p);
          if (s === join('/workspace', 'node_modules', 'vitest', 'package.json')) {
            return JSON.stringify({ version: '1.6.0' });
          }
          if (s === join('/workspace', 'package.json')) {
            return JSON.stringify({ devDependencies: { jest: '^29.0.0' } });
          }
          throw new Error('ENOENT');
        });

        expect(detectJsTestRunner('/workspace')).toBe('jest');
      });

      it('reads a multi-digit vitest major, not just its first character', () => {
        // `version.split('.')` — split on the empty string instead and version
        // "12.0.0" reads as major 1, dropping a modern vitest onto the command
        // runner it does not need.
        mockReadFileSync.mockImplementation((p) => {
          const s = String(p);
          if (s === join('/workspace', 'node_modules', 'vitest', 'package.json')) {
            return JSON.stringify({ version: '12.0.0' });
          }
          if (s === join('/workspace', 'package.json')) {
            return JSON.stringify({ devDependencies: { vitest: '^12.0.0' } });
          }
          throw new Error('ENOENT');
        });

        expect(detectJsTestRunner('/workspace')).toBe('vitest');
      });

      it('finds a vitest hoisted to a monorepo root (ancestor node_modules)', () => {
        // Deliberately a SUB-PEER-RANGE version: with the gate now keyed on
        // `major < 2`, an in-range version would return 'vitest' whether or not
        // the ancestor walk found anything, so the assertion would prove
        // nothing. A vitest 1 at the repo root can only produce 'command' if
        // installedVitestMajor actually walked up to it.
        mockReadFileSync.mockImplementation((p) => {
          const s = String(p);
          if (s === join('/repo', 'node_modules', 'vitest', 'package.json')) {
            return JSON.stringify({ version: '1.6.0' });
          }
          if (s === join('/repo/packages/app', 'package.json')) {
            return JSON.stringify({ devDependencies: { vitest: '^1.6.0' } });
          }
          throw new Error('ENOENT');
        });

        expect(detectJsTestRunner('/repo/packages/app')).toBe('command');
      });
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

    it('does not treat a [tool.pytest] mention inside a comment as a pytest project', () => {
      mockExistsSync.mockImplementation((p) => String(p).endsWith('pyproject.toml'));
      mockReadFileSync.mockReturnValue(
        '# migrate the [tool.pytest.ini_options] block from setup.cfg one day\n' +
          '[tool.mutmut]\nrunner = "ward"\n',
      );
      expect(detectPythonTestRunner('/ws')).toBe('ward');
    });

    it('does not treat a [tool.pytest] mention inside a string value as a pytest project', () => {
      mockExistsSync.mockImplementation((p) => String(p).endsWith('pyproject.toml'));
      mockReadFileSync.mockReturnValue(
        '[project]\ndescription = "reads [tool.pytest] for you"\n[tool.mutmut]\nrunner = "green"\n',
      );
      expect(detectPythonTestRunner('/ws')).toBe('green');
    });

    it('still detects a real [tool.pytest.ini_options] table', () => {
      mockExistsSync.mockImplementation((p) => String(p).endsWith('pyproject.toml'));
      mockReadFileSync.mockReturnValue('[tool.pytest.ini_options]\naddopts = "-q"\n');
      expect(detectPythonTestRunner('/ws')).toBe('pytest');
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

    it('does NOT treat a setup.cfg lacking [tool:pytest] as pytest', () => {
      // A setup.cfg with no pytest section must fall through to the mutmut
      // runner override. Kills `'[tool:pytest]'`→"" (line 330): `includes("")`
      // is always true and would short-circuit to 'pytest' here.
      mockReadFileSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith('setup.cfg')) return '[metadata]\nname = foo';
        if (path.endsWith('pyproject.toml')) return '[tool.mutmut]\nrunner = "nose2"';
        throw new Error('ENOENT');
      });

      expect(detectPythonTestRunner('/workspace')).toBe('nose2');
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

  it('detects Rust project with nextest', () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      return path.endsWith('Cargo.toml') || path.endsWith('nextest.toml');
    });

    const result = detectEnvironment('src/main.rs');
    expect(result.projectType).toBe('rust');
    expect(result.testRunner).toBe('cargo nextest run');
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

// ─── detectPythonPackageManager tests ─────────────────────────────────────────

describe('detectPythonPackageManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  it('detects uv from uv.lock', () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p) === join('/workspace', 'uv.lock');
    });

    expect(detectPythonPackageManager('/workspace')).toBe('uv');
  });

  it('detects poetry from poetry.lock', () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p) === join('/workspace', 'poetry.lock');
    });

    expect(detectPythonPackageManager('/workspace')).toBe('poetry');
  });

  it('detects uv from pyproject.toml [tool.uv]', () => {
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith('pyproject.toml')) {
        return '[tool.uv]\nindex-url = "https://pypi.org/simple"';
      }
      throw new Error('ENOENT');
    });

    expect(detectPythonPackageManager('/workspace')).toBe('uv');
  });

  it('detects uv from pyproject.toml [tool.uv.sources]', () => {
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith('pyproject.toml')) {
        return '[tool.uv.sources]\nhttpx = { git = "..." }';
      }
      throw new Error('ENOENT');
    });

    expect(detectPythonPackageManager('/workspace')).toBe('uv');
  });

  it('detects poetry from pyproject.toml [tool.poetry]', () => {
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith('pyproject.toml')) {
        return '[tool.poetry]\nname = "my-project"';
      }
      throw new Error('ENOENT');
    });

    expect(detectPythonPackageManager('/workspace')).toBe('poetry');
  });

  it('detects poetry from pyproject.toml [tool.poetry.dependencies]', () => {
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith('pyproject.toml')) {
        return '[tool.poetry.dependencies]\npython = "^3.10"';
      }
      throw new Error('ENOENT');
    });

    expect(detectPythonPackageManager('/workspace')).toBe('poetry');
  });

  it('prioritizes lock file over pyproject.toml (uv.lock beats [tool.uv])', () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p) === join('/workspace', 'poetry.lock');
    });
    // pyproject.toml has [tool.uv] but poetry.lock exists
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith('pyproject.toml')) {
        return '[tool.uv]\nindex-url = "..."';
      }
      throw new Error('ENOENT');
    });

    // lock file takes priority
    expect(detectPythonPackageManager('/workspace')).toBe('poetry');
  });

  it('returns pip as default when no signals are found', () => {
    expect(detectPythonPackageManager('/workspace')).toBe('pip');
  });

  it('does not confuse [tool.pytest] with [tool.poetry]', () => {
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith('pyproject.toml')) {
        return '[tool.pytest]\naddopts = "-v"';
      }
      throw new Error('ENOENT');
    });

    expect(detectPythonPackageManager('/workspace')).toBe('pip');
  });
});

// ─── EnvironmentInfo.packageManager integration tests ─────────────────────────

describe('detectEnvironment packageManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  it('populates packageManager when it detects a uv Python project', () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      return path.endsWith('pyproject.toml') || path.endsWith('uv.lock');
    });

    const result = detectEnvironment('src/main.py');
    expect(result.projectType).toBe('python');
    expect(result.packageManager).toBe('uv');
  });

  it('populates packageManager as pip for standard Python projects', () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p).endsWith('pyproject.toml');
    });

    const result = detectEnvironment('src/main.py');
    expect(result.packageManager).toBe('pip');
  });

  it('leaves packageManager empty for non-Python projects', () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p).endsWith('package.json');
    });
    mockReadFileSync.mockReturnValue(JSON.stringify({}));

    const result = detectEnvironment('src/app.ts');
    expect(result.packageManager).toBe('');
  });

  it('leaves packageManager empty for unsupported project types', () => {
    const result = detectEnvironment('main.rb');
    expect(result.projectType).toBe('unsupported');
    expect(result.packageManager).toBe('');
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

  it('detects criterion in Cargo.toml via detectEnvironment', () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p).endsWith('Cargo.toml');
    });
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith('Cargo.toml')) {
        return '[dev-dependencies]\ncriterion = "0.5"';
      }
      throw new Error('ENOENT');
    });

    const result = detectEnvironment('src/main.rs');
    expect(result.projectType).toBe('rust');
    expect(result.testRunner).toBe('cargo test');
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

// ─── Mutation hardening ──────────────────────────────────────────────────────
// Chaos-MCP flagged surviving mutants in the config-file name lists, the
// package.json object guards, and the bun/node:test detection (which the
// existing tests could not catch because detectJsTestRunner maps both to the
// 'command' fallback). These tests pin the exact filenames and use the RAW
// runner to distinguish real detection from the fallback.
describe('project-detector mutation hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  /** Make only the named workspace-root files "exist". */
  function filesExist(...names: string[]): void {
    const wanted = new Set(names.map((n) => join('/workspace', n)));
    mockExistsSync.mockImplementation((p) => wanted.has(String(p)));
  }

  /** Serve a package.json with the given parsed contents. */
  function packageJson(contents: unknown): void {
    mockExistsSync.mockImplementation((p) => String(p) === join('/workspace', 'package.json'));
    mockReadFileSync.mockImplementation((p) => {
      if (String(p) === join('/workspace', 'package.json')) return JSON.stringify(contents);
      throw new Error('ENOENT');
    });
  }

  // ── every config filename in JS_CONFIG_SIGNALS ──
  it.each([
    ['vitest.config.mts', 'vitest'],
    ['vitest.config.mjs', 'vitest'],
    ['jest.config.mjs', 'jest'],
    ['jest.config.cjs', 'jest'],
    ['.mocharc.yaml', 'mocha'],
    ['.mocharc.js', 'mocha'],
    ['.mocharc.cjs', 'mocha'],
  ])('detects %s as %s', (file, runner) => {
    filesExist(file);
    expect(detectJsTestRunner('/workspace')).toBe(runner);
  });

  // ── raw runner distinguishes bun/node:test from the 'command' fallback ──
  it('raw-detects bun from bunfig.toml', () => {
    filesExist('bunfig.toml');
    expect(detectRawJsRunner('/workspace')).toBe('bun');
  });

  it('raw-detects bun from bun.lockb', () => {
    filesExist('bun.lockb');
    expect(detectRawJsRunner('/workspace')).toBe('bun');
  });

  it('raw-detects bun from a dependency', () => {
    packageJson({ dependencies: { bun: '^1.0.0' } });
    expect(detectRawJsRunner('/workspace')).toBe('bun');
  });

  it('raw-detects bun from the bun-types devDependency', () => {
    packageJson({ devDependencies: { 'bun-types': '^1.0.0' } });
    expect(detectRawJsRunner('/workspace')).toBe('bun');
  });

  it.each([
    ['bun test', 'bun'],
    ['bun run test', 'bun'],
    ['node --test', 'node:test'],
    ['node:test ./x', 'node:test'],
  ])('raw-detects %s script as %s', (script, runner) => {
    packageJson({ scripts: { test: script } });
    expect(detectRawJsRunner('/workspace')).toBe(runner);
  });

  // ── package.json object guards (deps / devDeps / scripts) ──
  it('tolerates dependencies=null and still reads devDependencies', () => {
    packageJson({ dependencies: null, devDependencies: { vitest: '^3.0.0' } });
    expect(detectRawJsRunner('/workspace')).toBe('vitest');
  });

  it('tolerates devDependencies=null and still reads dependencies', () => {
    packageJson({ dependencies: { jest: '^29.0.0' }, devDependencies: null });
    expect(detectRawJsRunner('/workspace')).toBe('jest');
  });

  it('ignores a non-object dependencies field', () => {
    packageJson({ dependencies: 'not-an-object', scripts: { test: 'mocha' } });
    expect(detectRawJsRunner('/workspace')).toBe('mocha');
  });

  it('falls back to command when scripts is null', () => {
    packageJson({ scripts: null });
    expect(detectRawJsRunner('/workspace')).toBe('command');
  });

  it('falls back to command when scripts.test is not a string', () => {
    packageJson({ scripts: { test: 42 } });
    expect(detectRawJsRunner('/workspace')).toBe('command');
  });

  // ── detectProjectType regex anchoring ──
  it.each(['src/a.ts', 'src/b.js', 'c.tsx', 'd.jsx'])('classifies %s as typescript', (f) => {
    expect(detectProjectType(f)).toBe('typescript');
  });

  it('does not match an extension that is not at the end of the path', () => {
    expect(detectProjectType('foo.ts.bak')).toBe('unsupported');
    expect(detectProjectType('tsfile')).toBe('unsupported');
  });

  // ── detectEnvironment dispatch: all four languages + unsupported ──
  it('resolves a full Rust environment', () => {
    mockExistsSync.mockReturnValue(false); // no workspace markers
    const env = detectEnvironment('src/lib.rs');
    expect(env.projectType).toBe('rust');
    expect(env.testRunner).toBe('cargo test');
    expect(env.detectedRunner).toBe('cargo test');
    expect(env.packageManager).toBe('');
  });

  it('returns unknown runners for unsupported files', () => {
    const env = detectEnvironment('notes.md');
    expect(env.projectType).toBe('unsupported');
    expect(env.testRunner).toBe('unknown');
    expect(env.detectedRunner).toBe('unknown');
    expect(env.packageManager).toBe('');
  });
});

// ─── Mutation hardening: mutmut runner extraction + detectEnvironment dispatch ──
describe('project-detector mutation hardening (mutmut + dispatch)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  /** Serve pyproject.toml content (no other files exist). */
  function pyproject(content: string): void {
    mockReadFileSync.mockImplementation((p) => {
      if (String(p) === join('/workspace', 'pyproject.toml')) return content;
      throw new Error('ENOENT');
    });
  }

  it('extracts the mutmut runner when [tool.mutmut] is the final section', () => {
    pyproject('[tool.mutmut]\nrunner = "pytest -x"\n');
    expect(detectPythonTestRunner('/workspace')).toBe('pytest -x');
  });

  it('extracts the runner when the file ends exactly at the runner line (no trailing newline)', () => {
    // Forces the "no following section → slice to end-of-string" branch: if the
    // slice stopped one char short, the closing quote would be dropped and the
    // runner regex would not match.
    pyproject('[tool.mutmut]\nrunner = "pytest -x"');
    expect(detectPythonTestRunner('/workspace')).toBe('pytest -x');
  });

  it('extracts the runner only from the mutmut section, not a later one', () => {
    pyproject('[tool.mutmut]\nrunner = "custom-runner"\n\n[tool.other]\nrunner = "wrong"\n');
    expect(detectPythonTestRunner('/workspace')).toBe('custom-runner');
  });

  it('does not pick up a runner defined in a section BEFORE [tool.mutmut]', () => {
    pyproject('[tool.other]\nrunner = "before"\n\n[tool.mutmut]\nfoo = "bar"\n');
    // [tool.mutmut] has no runner key → falls through to the default.
    expect(detectPythonTestRunner('/workspace')).toBe('pytest');
  });

  it('returns the default when [tool.mutmut] exists without a runner key', () => {
    pyproject('[tool.mutmut]\nbackup = true\n');
    expect(detectPythonTestRunner('/workspace')).toBe('pytest');
  });

  it('returns the default when pyproject has content but no [tool.mutmut]', () => {
    pyproject('[tool.black]\nline-length = 88\n');
    expect(detectPythonTestRunner('/workspace')).toBe('pytest');
  });

  // ── detectEnvironment selects type-appropriate root markers ──
  it.each([
    ['/repo/src/a.ts', 'package.json'],
    ['/repo/src/a.py', 'pyproject.toml'],
    ['/repo/src/a.rs', 'Cargo.toml'],
    ['/repo/src/a.php', 'composer.json'],
  ])('resolves the workspace root of %s via its %s marker', (file, marker) => {
    mockExistsSync.mockImplementation((p) => String(p) === join(resolve('/repo'), marker));
    const env = detectEnvironment(file);
    // If the wrong marker set were chosen, the marker would not be found and
    // resolveWorkspaceRoot would fall back to the file's own directory.
    expect(env.workspaceRoot).toBe(resolve('/repo'));
  });
});

// ─── Mutation hardening: walk-depth bound, pytest-priority vs mutmut override, ──
// ─── mutmut runner regex shape, and detectEnvironment detectedRunner dispatch ──
//
// These pin survivors that the earlier suites could not catch because the
// happy-path return value ('pytest', 'cargo test') happens to equal the
// downstream default. Each test forces a SECOND signal (a [tool.mutmut] runner
// override, or a deep marker) so that short-circuiting at the line under test
// produces a value that is distinguishable from the fallback.
describe('project-detector mutation hardening (priority short-circuits + regex)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  /** A pyproject [tool.mutmut] runner override used as the "fall-through" sentinel. */
  const MUTMUT_OVERRIDE = '\n[tool.mutmut]\nrunner = "MUTMUT-OVERRIDE"\n';

  /**
   * Serve a fixed set of workspace-root files: `exists` names answer existsSync,
   * `files` names answer readFileSync with their content (others throw ENOENT).
   */
  function serve(opts: { exists?: string[]; files?: Record<string, string> }): void {
    const existsSet = new Set((opts.exists ?? []).map((n) => join('/workspace', n)));
    mockExistsSync.mockImplementation((p) => existsSet.has(String(p)));
    const files = opts.files ?? {};
    mockReadFileSync.mockImplementation((p) => {
      const s = String(p);
      for (const [name, content] of Object.entries(files)) {
        if (s === join('/workspace', name)) return content;
      }
      throw new Error('ENOENT');
    });
  }

  // ── resolveWorkspaceRoot: the loop must stop at MAX_WALK_DEPTH (10) levels ──
  // A marker that only appears at the 11th directory (depth 10) must NOT be
  // found: `depth < 10` checks levels 0..9. Mutating `<` to `<=` would reach
  // level 10 and wrongly return '/root' instead of the start-dir fallback.
  it('does not find a marker that sits exactly one level beyond MAX_WALK_DEPTH', () => {
    const start = '/root/a/b/c/d/e/f/g/h/i/j'; // 11 components → '/root' is 10 levels up
    mockExistsSync.mockImplementation((p) => String(p) === join(resolve('/root'), 'package.json'));

    const result = resolveWorkspaceRoot(start, ['package.json']);
    // Correct (`< 10`): never reaches '/root' → falls back to the start dir.
    expect(result).toBe(resolve(start));
    expect(result).not.toBe(resolve('/root'));
  });

  // ── Priority 1: pyproject pytest markers win over a later mutmut override ──
  it('pyproject [tool.pytest] short-circuits before the mutmut runner override', () => {
    serve({ files: { 'pyproject.toml': '[tool.pytest]\naddopts = "-v"' + MUTMUT_OVERRIDE } });
    // Reading [tool.pytest] must return 'pytest'; if that branch were skipped the
    // function would fall through to the [tool.mutmut] runner override instead.
    expect(detectPythonTestRunner('/workspace')).toBe('pytest');
  });

  it('pyproject [tool.pytest.ini_options] short-circuits before the mutmut override', () => {
    serve({
      files: {
        'pyproject.toml': '[tool.pytest.ini_options]\nminversion = "6.0"' + MUTMUT_OVERRIDE,
      },
    });
    expect(detectPythonTestRunner('/workspace')).toBe('pytest');
  });

  // ── Priority 2: standalone pytest.ini / conftest.py win over the override ──
  it('pytest.ini short-circuits before the mutmut runner override', () => {
    serve({ exists: ['pytest.ini'], files: { 'pyproject.toml': MUTMUT_OVERRIDE } });
    expect(detectPythonTestRunner('/workspace')).toBe('pytest');
  });

  it('conftest.py short-circuits before the mutmut runner override', () => {
    serve({ exists: ['conftest.py'], files: { 'pyproject.toml': MUTMUT_OVERRIDE } });
    expect(detectPythonTestRunner('/workspace')).toBe('pytest');
  });

  // ── Priority 3: setup.cfg [tool:pytest] wins over the override ──
  it('setup.cfg [tool:pytest] short-circuits before the mutmut runner override', () => {
    serve({
      files: {
        'setup.cfg': '[tool:pytest]\naddopts = --strict-markers',
        'pyproject.toml': MUTMUT_OVERRIDE,
      },
    });
    expect(detectPythonTestRunner('/workspace')).toBe('pytest');
  });

  // ── Priority 4: tox.ini / noxfile.py win over the override ──
  it('tox.ini short-circuits before the mutmut runner override', () => {
    serve({ exists: ['tox.ini'], files: { 'pyproject.toml': MUTMUT_OVERRIDE } });
    expect(detectPythonTestRunner('/workspace')).toBe('pytest');
  });

  it('noxfile.py short-circuits before the mutmut runner override', () => {
    serve({ exists: ['noxfile.py'], files: { 'pyproject.toml': MUTMUT_OVERRIDE } });
    expect(detectPythonTestRunner('/workspace')).toBe('pytest');
  });

  // ── Priority 5: the runner regex shape (\s* around '=', '+' in the capture) ──
  it('extracts a mutmut runner that has no whitespace around the "=" sign', () => {
    // Pins the `\s*` quantifiers: tightening them to `\s+` would require spaces
    // and this value would no longer match, falling back to 'pytest'.
    serve({ files: { 'pyproject.toml': '[tool.mutmut]\nrunner="nospace"\n' } });
    expect(detectPythonTestRunner('/workspace')).toBe('nospace');
  });

  it('ignores an empty mutmut runner value and falls back to pytest', () => {
    // Pins the `+` in `[^"']+`: relaxing it to `*` would match the empty string
    // and return '' instead of the 'pytest' default.
    serve({ files: { 'pyproject.toml': '[tool.mutmut]\nrunner = ""\n' } });
    expect(detectPythonTestRunner('/workspace')).toBe('pytest');
  });

  // ── The runner key must be matched by NAME, not by suffix ──
  // The old `runner\s*=` was unanchored, so any key ENDING in `runner` matched.
  // Whatever it captured became cosmic-ray's `test-command`, shelled once per
  // mutant — from a key mutmut never reads.
  it.each([
    ['test_runner', '[tool.mutmut]\ntest_runner = "WRONG"\n'],
    ['custom_runner', '[tool.mutmut]\ncustom_runner = "WRONG"\n'],
    ['pre_runner', '[tool.mutmut]\npre_runner = "WRONG"\n'],
  ])('does not treat the %s key as the mutmut runner', (_name, content) => {
    serve({ files: { 'pyproject.toml': content } });
    expect(detectPythonTestRunner('/workspace')).toBe('pytest');
  });

  it('still finds the real runner key alongside a suffix-matching neighbour', () => {
    // The anchor must exclude the decoy without also excluding the real key.
    serve({
      files: { 'pyproject.toml': '[tool.mutmut]\ntest_runner = "WRONG"\nrunner = "right"\n' },
    });
    expect(detectPythonTestRunner('/workspace')).toBe('right');
  });

  // ── The section header must be a real TOML table header ──
  it('ignores a [tool.mutmut] mentioned in a comment', () => {
    // `indexOf('[tool.mutmut]')` matched the literal anywhere, so this comment
    // opened a "section" whose first `runner = …` line became a shell command.
    serve({
      files: {
        'pyproject.toml': '# migrate the old [tool.mutmut] block\n[tool.other]\nrunner = "WRONG"\n',
      },
    });
    expect(detectPythonTestRunner('/workspace')).toBe('pytest');
  });

  it('ignores a [tool.mutmut] that appears inside a string value', () => {
    serve({
      files: {
        'pyproject.toml':
          '[project]\ndescription = "drop-in for [tool.mutmut] users"\nrunner = "WRONG"\n',
      },
    });
    expect(detectPythonTestRunner('/workspace')).toBe('pytest');
  });

  it('accepts a real header carrying a trailing TOML comment', () => {
    // Anchoring must not become so strict that a legal header stops matching.
    serve({ files: { 'pyproject.toml': '[tool.mutmut]  # legacy config\nrunner = "nose2"\n' } });
    expect(detectPythonTestRunner('/workspace')).toBe('nose2');
  });

  it('accepts a real header that is indented', () => {
    serve({ files: { 'pyproject.toml': '  [tool.mutmut]\n  runner = "ward"\n' } });
    expect(detectPythonTestRunner('/workspace')).toBe('ward');
  });

  it('prefers the real header when a commented mention precedes it', () => {
    serve({
      files: {
        'pyproject.toml':
          '# see [tool.mutmut] below\n[tool.other]\nrunner = "WRONG"\n\n[tool.mutmut]\nrunner = "right"\n',
      },
    });
    expect(detectPythonTestRunner('/workspace')).toBe('right');
  });

  // ── detectEnvironment: workspaceRoot for unsupported files is resolve('.') ──
  it('resolves the unsupported workspaceRoot to the current directory', () => {
    const env = detectEnvironment('notes.md');
    expect(env.projectType).toBe('unsupported');
    expect(env.workspaceRoot).toBe(resolve('.'));
  });

  // ── detectEnvironment: detectedRunner uses the Python-specific raw detector ──
  it('populates detectedRunner via the Python raw detector (tox orchestrator)', () => {
    // Only tox.ini "exists" — no Python root marker — so the workspace root
    // falls back to the file dir, where detectRawPythonRunner sees tox.ini.
    mockExistsSync.mockImplementation((p) => String(p).endsWith('tox.ini'));

    const env = detectEnvironment('src/main.py');
    expect(env.projectType).toBe('python');
    // testRunner maps tox → pytest, but the RAW detected runner is 'tox'. If the
    // detectedRunner dispatch skipped the python arm it would return 'cargo test'.
    expect(env.detectedRunner).toBe('tox');
    expect(env.testRunner).toBe('pytest');
  });
});

describe('detectPhpTestRunner', () => {
  it('always resolves to phpunit — the only runner Infection drives', () => {
    // Infection's initial-test-run integration is PHPUnit-specific, so the
    // detector is deliberately a constant rather than a filesystem probe.
    // Pinning the literal keeps a mutant that blanks it from silently emitting
    // an empty test command.
    expect(detectPhpTestRunner('/any/workspace')).toBe('phpunit');
  });

  it('does not consult the filesystem to decide', () => {
    // A workspace where nothing exists must still resolve — this is what makes
    // the function safe to call before a sandbox is provisioned.
    mockExistsSync.mockClear();
    mockExistsSync.mockReturnValue(false);
    expect(detectPhpTestRunner('/missing')).toBe('phpunit');
    expect(mockExistsSync).not.toHaveBeenCalled();
  });
});

describe('detectRawPhpRunner', () => {
  it('agrees with detectPhpTestRunner for the same workspace', () => {
    // The "raw" variants exist so callers that want the un-wrapped command have
    // a stable entry point; for PHP the two must not drift apart.
    expect(detectRawPhpRunner('/any/workspace')).toBe(detectPhpTestRunner('/any/workspace'));
    expect(detectRawPhpRunner('/any/workspace')).toBe('phpunit');
  });
});

// ─── Extension registry accessors (audit F15) ───────────────────────────────

describe('supportedSourceExtensions', () => {
  it('returns exactly the eleven auditable extensions, in detection order', () => {
    // Pinned literally: this list IS the contract the MCP tool-schema prose
    // derives from, and it must not drift silently while the four supported
    // languages are unchanged.
    //
    // The ESM/CJS variants were always auditable — `matches` accepts them — but
    // were absent here, so the schema never advertised them. Discovery no
    // longer derives from this list (it gates on `detectProjectType`), but the
    // two must still agree or the schema under-reports what the tools accept.
    expect(supportedSourceExtensions()).toEqual([
      '.ts',
      '.js',
      '.tsx',
      '.jsx',
      '.mjs',
      '.cjs',
      '.mts',
      '.cts',
      '.py',
      '.rs',
      '.php',
    ]);
  });

  it('agrees with detectProjectType for every extension it advertises', () => {
    // The whole point of deriving the list from the detection registry: an
    // extension triage will walk into must be one an audit can actually run.
    for (const ext of supportedSourceExtensions()) {
      expect(detectProjectType(`src/sample${ext}`)).not.toBe('unsupported');
    }
  });

  it('is dot-prefixed, lowercase, and free of duplicates', () => {
    const exts = supportedSourceExtensions();
    expect(new Set(exts).size).toBe(exts.length);
    for (const ext of exts) {
      expect(ext).toBe(ext.toLowerCase());
      expect(ext.startsWith('.')).toBe(true);
    }
  });

  it('hands back a fresh array each call so callers cannot mutate the registry', () => {
    const first = supportedSourceExtensions();
    first.push('.go');
    expect(supportedSourceExtensions()).not.toContain('.go');
  });
});

describe('primarySourceExtensions', () => {
  it('collapses the JSX/TSX variants for compact prose', () => {
    expect(primarySourceExtensions()).toEqual(['.ts', '.js', '.py', '.rs', '.php']);
  });

  it('is a subset of the full extension list', () => {
    const all = new Set(supportedSourceExtensions());
    for (const ext of primarySourceExtensions()) {
      expect(all.has(ext)).toBe(true);
    }
  });
});

describe('assertNeverProjectType', () => {
  it('is a runtime no-op, so a guarded switch keeps its silent fallback', () => {
    // The guard exists to fail the BUILD when a language is added without
    // handling; it must never turn today's fallback path into a throw.
    expect(() => assertNeverProjectType(undefined as never)).not.toThrow();
    expect(assertNeverProjectType(undefined as never)).toBeUndefined();
  });
});
