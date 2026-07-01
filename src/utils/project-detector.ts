import { existsSync, readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';

/**
 * Supported project types for mutation testing.
 */
export type ProjectType = 'typescript' | 'python' | 'rust' | 'php' | 'unsupported';

/**
 * Structured environment information resolved from workspace signals.
 * Carries everything the mutation engines need to configure themselves.
 */
export interface EnvironmentInfo {
  /** Language family of the target file */
  projectType: ProjectType;

  /**
   * The test runner name to pass to the mutation engine.
   *
   * For JS/TS (Stryker-compatible): 'vitest' | 'jest' | 'mocha' | 'jasmine' | 'command'
   * For Python (Mutmut-compatible): 'pytest' | 'unittest' | custom command string
   *
   * Runners without native Stryker plugins (bun, ava, node:test) map to 'command'.
   */
  testRunner: string;

  /**
   * The raw runner detected from workspace signals, before mapping to a
   * Stryker/mutmut-compatible value. Useful for diagnostics.
   *
   * Example: when bun is detected, `testRunner` will be 'command' but
   * `detectedRunner` will be 'bun'.
   */
  detectedRunner: string;

  /**
   * Detected Python package manager ('pip', 'uv', 'poetry', or '' for non-Python).
   * Surfaces the project's dependency manager for diagnostics and future
   * prebuild-command defaults.
   */
  packageManager: string;

  /** Absolute path to the resolved workspace root directory */
  workspaceRoot: string;
}

// ─── File-extension detection (preserved from original) ──────────────────────

/**
 * Detect the project type based on the target file's extension.
 *
 * Currently uses file extension matching. Future versions may inspect
 * workspace configuration files (package.json, pyproject.toml, etc.)
 * for richer framework detection.
 *
 * @param filePath — the file path passed by the agent.
 * @returns The detected project type.
 */
export function detectProjectType(filePath: string): ProjectType {
  // Accept ESM/CJS variants (.mjs/.cjs/.mts/.cts) too — the runner detector
  // already recognises vitest.config.mts/.mjs, so source files in those forms
  // must be auditable rather than reported as unsupported. Extensions are
  // mutually exclusive, so iteration order over LANGUAGE_DETECTORS is moot.
  for (const type of LANGUAGE_DETECTOR_TYPES) {
    if (LANGUAGE_DETECTORS[type].matches(filePath)) return type;
  }
  return 'unsupported';
}

// ─── Workspace root resolution ───────────────────────────────────────────────

/** Maximum number of parent directories to traverse when searching for a workspace root. */
const MAX_WALK_DEPTH = 10;

/** Marker files that indicate a JS/TS project root. */
const JS_ROOT_MARKERS = ['package.json'] as const;

/** Marker files that indicate a Rust project root. */
const RUST_ROOT_MARKERS = ['Cargo.toml'] as const;

/** Marker files that indicate a PHP project root. */
const PHP_ROOT_MARKERS = ['composer.json'] as const;

/** Marker files that indicate a Python project root. */
const PY_ROOT_MARKERS = [
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'uv.lock',
  'poetry.lock',
] as const;

/**
 * Walk upward from `startDir` looking for a directory containing one of the
 * specified marker files. Returns the first matching directory, or `startDir`
 * if nothing is found within {@link MAX_WALK_DEPTH} levels.
 *
 * When `boundary` is supplied, the walk checks `boundary` itself for a marker
 * but never ascends above it. The sandbox refuses to copy a workspace outside
 * `process.cwd()` (audit C2), so a workspace root resolved above cwd would make
 * every audit fail at provisioning time. Passing cwd as the boundary keeps the
 * detected root within the copyable tree.
 *
 * @internal Exported for testing only.
 */
export function resolveWorkspaceRoot(
  startDir: string,
  markers: readonly string[],
  boundary?: string,
): string {
  let current = resolve(startDir);
  const limit = boundary !== undefined ? resolve(boundary) : undefined;

  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    for (const marker of markers) {
      if (existsSync(join(current, marker))) {
        return current;
      }
    }

    // Stop at the boundary directory — do not ascend above it.
    if (limit !== undefined && current === limit) break;

    const parent = dirname(current);
    // Reached filesystem root — stop
    if (parent === current) break;
    current = parent;
  }

  // Fallback: return the starting directory
  return resolve(startDir);
}

// ─── JS/TS test runner detection ─────────────────────────────────────────────

/** Config files whose presence unambiguously identifies a test runner. */
const JS_CONFIG_SIGNALS: { files: string[]; runner: string }[] = [
  {
    files: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs'],
    runner: 'vitest',
  },
  {
    files: ['jest.config.ts', 'jest.config.js', 'jest.config.mjs', 'jest.config.cjs'],
    runner: 'jest',
  },
  {
    files: ['.mocharc.yml', '.mocharc.yaml', '.mocharc.json', '.mocharc.js', '.mocharc.cjs'],
    runner: 'mocha',
  },
  {
    files: ['jasmine.json', 'spec/support/jasmine.json'],
    runner: 'jasmine',
  },
];

/**
 * Read and parse a JSON file, returning `null` on any failure.
 * @internal
 */
function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Shared low-level runner detection that returns the raw runner name.
 * Callers should use {@link detectJsTestRunner} for Stryker-compatible values.
 *
 * Returns 'bun' or 'node:test' etc. when those runners are detected.
 *
 * @internal
 */
function detectJsRunnerRaw(workspaceRoot: string): string {
  // ── Priority 1: config files ──
  for (const signal of JS_CONFIG_SIGNALS) {
    for (const file of signal.files) {
      if (existsSync(join(workspaceRoot, file))) {
        return signal.runner;
      }
    }
  }

  // ── Priority 1.5: bunfig.toml or bun.lockb (bun project signals) ──
  if (
    existsSync(join(workspaceRoot, 'bunfig.toml')) ||
    existsSync(join(workspaceRoot, 'bun.lockb'))
  ) {
    return 'bun';
  }

  // ── Priority 2 & 3: package.json scanning ──
  const pkgPath = join(workspaceRoot, 'package.json');
  const pkg = readJsonSafe(pkgPath);

  if (pkg) {
    const deps = {
      ...(typeof pkg.dependencies === 'object' && pkg.dependencies !== null
        ? (pkg.dependencies as Record<string, unknown>)
        : {}),
      ...(typeof pkg.devDependencies === 'object' && pkg.devDependencies !== null
        ? (pkg.devDependencies as Record<string, unknown>)
        : {}),
    };

    // Priority 2: dependency keys
    if ('vitest' in deps) return 'vitest';
    if ('jest' in deps) return 'jest';
    if ('mocha' in deps) return 'mocha';
    if ('jasmine' in deps) return 'jasmine';
    if ('bun' in deps || 'bun-types' in deps) return 'bun';

    // Priority 3: scripts.test content
    const scripts =
      typeof pkg.scripts === 'object' && pkg.scripts !== null
        ? (pkg.scripts as Record<string, unknown>)
        : {};

    const testScript = typeof scripts.test === 'string' ? scripts.test : '';

    if (testScript.includes('vitest')) return 'vitest';
    if (testScript.includes('jest')) return 'jest';
    if (testScript.includes('mocha')) return 'mocha';
    if (testScript.includes('jasmine')) return 'jasmine';
    if (/bun (?:run )?test/.test(testScript)) return 'bun';
    if (testScript.includes('node --test') || testScript.includes('node:test')) return 'node:test';
  }

  // ── Priority 4: generic fallback ──
  return 'command';
}

/**
 * Map a raw runner name to a Stryker-compatible value.
 * Runners without native Stryker plugins (bun, node:test) map to 'command'.
 */
function toStrykerRunner(raw: string): string {
  if (raw === 'bun' || raw === 'node:test') return 'command';
  return raw;
}

/**
 * Detect the JS/TS test runner from workspace signals, returning a
 * Stryker-compatible value.
 *
 * Priority order:
 * 1. Dedicated config files (vitest.config.*, jest.config.*, .mocharc.*, jasmine.json, bunfig.toml)
 * 2. package.json dependencies / devDependencies
 * 3. package.json scripts.test content
 * 4. Fallback: 'command' (Stryker's generic npm test runner)
 *
 * Runners without native Stryker plugins (bun, node:test) are detected
 * but mapped to 'command' since Stryker falls back to `npm test`.
 * Use {@link detectRawJsRunner} to get the unmapped value.
 *
 * @internal Exported for testing only.
 */
export function detectJsTestRunner(workspaceRoot: string): string {
  return toStrykerRunner(detectJsRunnerRaw(workspaceRoot));
}

/**
 * Detect the raw JS/TS test runner from workspace signals, without mapping
 * to Stryker-compatible values.
 *
 * Returns 'bun' or 'node:test' when those runners are detected, unlike
 * {@link detectJsTestRunner} which maps them to 'command'.
 *
 * @internal Exported for testing only.
 */
export function detectRawJsRunner(workspaceRoot: string): string {
  return detectJsRunnerRaw(workspaceRoot);
}

// ─── Python test runner detection ────────────────────────────────────────────

/**
 * Read a file as UTF-8 text, returning `null` on any failure.
 * @internal
 */
function readTextSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Detect the Python test runner from workspace signals.
 *
 * Priority order:
 * 1. pyproject.toml contains [tool.pytest] or [tool.pytest.ini_options]
 * 2. pytest.ini or conftest.py exists in workspace root
 * 3. setup.cfg contains [tool:pytest]
 * 4. tox.ini or noxfile.py — detected as tox/nox orchestrator (maps to 'pytest' for mutmut)
 * 5. pyproject.toml [tool.mutmut] runner key
 * 6. Fallback: 'pytest'
 *
 * Note: tox and nox are CI orchestrators, not test runners themselves.
 * When detected, the engine will still default to 'pytest' since that is
 * what tox typically runs underneath. Use `detectedRunner` on
 * {@link EnvironmentInfo} to see the raw detection result.
 *
 * @internal Exported for testing only.
 */
export function detectPythonTestRunner(workspaceRoot: string): string {
  // ── Priority 1: pyproject.toml pytest markers ──
  const pyprojectPath = join(workspaceRoot, 'pyproject.toml');
  const pyprojectContent = readTextSafe(pyprojectPath);

  if (pyprojectContent) {
    if (
      pyprojectContent.includes('[tool.pytest]') ||
      pyprojectContent.includes('[tool.pytest.ini_options]')
    ) {
      return 'pytest';
    }
  }

  // ── Priority 2: standalone pytest markers ──
  if (existsSync(join(workspaceRoot, 'pytest.ini'))) return 'pytest';
  if (existsSync(join(workspaceRoot, 'conftest.py'))) return 'pytest';

  // ── Priority 3: setup.cfg pytest markers ──
  const setupCfgContent = readTextSafe(join(workspaceRoot, 'setup.cfg'));
  if (setupCfgContent && setupCfgContent.includes('[tool:pytest]')) {
    return 'pytest';
  }

  // ── Priority 4: tox / nox orchestrator markers ──
  // tox.ini and noxfile.py indicate the project uses these CI orchestrators.
  // They are not test runners themselves — mutmut defaults to 'pytest' underneath.
  if (existsSync(join(workspaceRoot, 'tox.ini'))) return 'pytest';
  if (existsSync(join(workspaceRoot, 'noxfile.py'))) return 'pytest';

  // ── Priority 5: mutmut config runner override ──
  if (pyprojectContent) {
    const sectionIndex = pyprojectContent.indexOf('[tool.mutmut]');
    if (sectionIndex !== -1) {
      let nextSectionIndex = pyprojectContent.indexOf('\n[', sectionIndex);
      if (nextSectionIndex === -1) nextSectionIndex = pyprojectContent.length;

      const mutmutSection = pyprojectContent.slice(sectionIndex, nextSectionIndex);
      const runnerMatch = mutmutSection.match(/runner\s*=\s*["']([^"']+)["']/);
      if (runnerMatch) {
        return runnerMatch[1];
      }
    }
  }

  // ── Priority 6: default ──
  return 'pytest';
}

/**
 * Detect the raw Python test runner / orchestrator from workspace signals,
 * without mapping tox/nox to 'pytest'.
 *
 * Returns 'tox' or 'nox' when those orchestrators are detected, unlike
 * {@link detectPythonTestRunner} which returns 'pytest' in those cases.
 *
 * @internal Exported for testing only.
 */
export function detectRawPythonRunner(workspaceRoot: string): string {
  // Check for tox/nox BEFORE pytest markers (they're orchestrators, not runners)
  if (existsSync(join(workspaceRoot, 'tox.ini'))) return 'tox';
  if (existsSync(join(workspaceRoot, 'noxfile.py'))) return 'nox';

  // Fall back to the standard runner detection
  return detectPythonTestRunner(workspaceRoot);
}

// ─── Python package manager detection ────────────────────────────────────────

/**
 * Detect the Python package manager from workspace signals.
 *
 * Priority order:
 * 1. uv.lock exists → 'uv'
 * 2. poetry.lock exists → 'poetry'
 * 3. pyproject.toml contains [tool.uv] or [tool.uv.*] → 'uv'
 * 4. pyproject.toml contains [tool.poetry] or [tool.poetry.*] → 'poetry'
 * 5. Fallback: 'pip'
 *
 * @internal Exported for testing only.
 */
export function detectPythonPackageManager(workspaceRoot: string): string {
  // Priority 1-2: lock files (fastest signal)
  if (existsSync(join(workspaceRoot, 'uv.lock'))) return 'uv';
  if (existsSync(join(workspaceRoot, 'poetry.lock'))) return 'poetry';

  // Priority 3-4: pyproject.toml sections
  const pyprojectContent = readTextSafe(join(workspaceRoot, 'pyproject.toml'));
  if (pyprojectContent) {
    // [tool.uv] or [tool.uv.sources] etc.
    if (/\[tool\.uv\b/.test(pyprojectContent)) return 'uv';
    // [tool.poetry] or [tool.poetry.dependencies] etc.
    if (/\[tool\.poetry\b/.test(pyprojectContent)) return 'poetry';
  }

  // Priority 5: default
  return 'pip';
}

// ─── Rust test runner detection ──────────────────────────────────────────────

/**
 * Detect the Rust test runner from workspace signals.
 *
 * Priority order:
 * 1. nextest.toml or .config/nextest.toml exists → 'cargo nextest run'
 * 2. Cargo.toml [dev-dependencies] contains criterion → 'cargo test' (with criterion benchmarks)
 * 3. Fallback: 'cargo test'
 *
 * Note: cargo-nextest is a separately installed CLI tool, not a Cargo.toml
 * dependency. We detect it via its config file.
 *
 * @internal Exported for testing only.
 */
export function detectRustTestRunner(workspaceRoot: string): string {
  // Priority 1: cargo-nextest config file
  if (
    existsSync(join(workspaceRoot, 'nextest.toml')) ||
    existsSync(join(workspaceRoot, '.config', 'nextest.toml'))
  ) {
    return 'cargo nextest run';
  }

  // Priority 2: criterion benchmarks in Cargo.toml dev-dependencies
  const cargoContent = readTextSafe(join(workspaceRoot, 'Cargo.toml'));
  if (cargoContent && cargoContent.includes('criterion')) {
    // criterion is a benchmarking library, not a test runner — still use cargo test
    // but note the presence for diagnostics
    return 'cargo test';
  }

  // Priority 3: default
  return 'cargo test';
}

/**
 * Detect the raw Rust test runner without mapping.
 *
 * @internal Exported for testing only.
 */
export function detectRawRustRunner(workspaceRoot: string): string {
  return detectRustTestRunner(workspaceRoot);
}

// ─── PHP test runner detection ───────────────────────────────────────────────

/**
 * Detect the PHP test runner. v1 targets PHPUnit only: presence of
 * phpunit.xml / phpunit.xml.dist (or a project-supplied infection.json which
 * carries its own framework) resolves to 'phpunit'. Returns 'phpunit' as the
 * default since Infection defaults to PHPUnit.
 *
 * @internal Exported for testing only.
 */
export function detectPhpTestRunner(_workspaceRoot: string): string {
  return 'phpunit';
}

/**
 * Detect the raw PHP test runner without mapping.
 * @internal Exported for testing only.
 */
export function detectRawPhpRunner(workspaceRoot: string): string {
  return detectPhpTestRunner(workspaceRoot);
}

// ─── Per-language detection registry ─────────────────────────────────────────

/**
 * Per-language detection metadata. Single source of truth for "what languages
 * are supported and how each is detected", replacing the parallel
 * `projectType === '…'` ternary chains previously inlined in
 * {@link detectProjectType} and {@link detectEnvironment}. The execution-side
 * counterpart lives in engines/registry.ts.
 */
interface LanguageDetector {
  /** True when the target file belongs to this language (by extension). */
  matches: (filePath: string) => boolean;
  /** Root-marker files used to resolve the workspace root. */
  markers: readonly string[];
  /** Stryker/mutmut-compatible test-runner detection. */
  testRunner: (workspaceRoot: string) => string;
  /** Raw runner/orchestrator detection, for diagnostics (e.g. 'bun', 'tox'). */
  rawRunner: (workspaceRoot: string) => string;
  /** Package-manager detection — only meaningful for Python today. */
  packageManager?: (workspaceRoot: string) => string;
}

const LANGUAGE_DETECTORS: Record<Exclude<ProjectType, 'unsupported'>, LanguageDetector> = {
  typescript: {
    matches: (p) => /\.(c|m)?[jt]sx?$/.test(p),
    markers: JS_ROOT_MARKERS,
    testRunner: detectJsTestRunner,
    rawRunner: detectRawJsRunner,
  },
  python: {
    matches: (p) => p.endsWith('.py'),
    markers: PY_ROOT_MARKERS,
    testRunner: detectPythonTestRunner,
    rawRunner: detectRawPythonRunner,
    packageManager: detectPythonPackageManager,
  },
  rust: {
    matches: (p) => p.endsWith('.rs'),
    markers: RUST_ROOT_MARKERS,
    testRunner: detectRustTestRunner,
    rawRunner: detectRawRustRunner,
  },
  php: {
    matches: (p) => p.endsWith('.php'),
    markers: PHP_ROOT_MARKERS,
    testRunner: detectPhpTestRunner,
    rawRunner: detectRawPhpRunner,
  },
};

/** Detection order — preserves the original typescript→python→rust sequence. */
const LANGUAGE_DETECTOR_TYPES = Object.keys(LANGUAGE_DETECTORS) as Exclude<
  ProjectType,
  'unsupported'
>[];

// ─── Main detection entry point ──────────────────────────────────────────────

/**
 * Detect the full environment for a target file: project type, test runner,
 * and workspace root.
 *
 * This is the primary API for the handler to call before dispatching to an engine.
 *
 * @param filePath — workspace-relative path to the target source file.
 * @returns Fully resolved environment information.
 */
export function detectEnvironment(filePath: string): EnvironmentInfo {
  const projectType = detectProjectType(filePath);

  if (projectType === 'unsupported') {
    return {
      projectType,
      testRunner: 'unknown',
      detectedRunner: 'unknown',
      packageManager: '',
      workspaceRoot: resolve('.'),
    };
  }

  const detector = LANGUAGE_DETECTORS[projectType];

  // Resolve the workspace root from the file's directory.
  // Clamp the upward walk to the current working directory: the sandbox refuses
  // to copy a workspace outside cwd, so a root resolved above cwd would break
  // every audit. (Med#5: run-from-subdirectory previously failed at provisioning.)
  const fileDir = dirname(resolve(filePath));
  const workspaceRoot = resolveWorkspaceRoot(fileDir, detector.markers, process.cwd());

  // Stryker/mutmut-compatible runner, plus the raw runner/orchestrator so
  // EnvironmentInfo.detectedRunner captures the actual signal (e.g. 'bun',
  // 'tox', 'nox', 'ginkgo') even when testRunner maps to a compatible value.
  const testRunner = detector.testRunner(workspaceRoot);
  const detectedRunner = detector.rawRunner(workspaceRoot);

  // Package manager is only meaningful for languages that declare a detector.
  const packageManager = detector.packageManager ? detector.packageManager(workspaceRoot) : '';

  return {
    projectType,
    testRunner,
    detectedRunner,
    packageManager,
    workspaceRoot,
  };
}
