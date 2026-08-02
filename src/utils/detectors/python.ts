/**
 * Python workspace detection: root markers, test-runner signals, the
 * `[tool.mutmut]` runner override, and package-manager detection.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { readTextSafe } from './fs-read.js';
import type { LanguageDetector } from './types.js';

/** Marker files that indicate a Python project root. */
export const PY_ROOT_MARKERS = [
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'uv.lock',
  'poetry.lock',
] as const;

/**
 * The `[tool.mutmut]` table header, on a line of its own.
 *
 * Anchored (`^…$` with `m`) rather than located with `indexOf('[tool.mutmut]')`,
 * which matched the literal ANYWHERE — inside a `# see [tool.mutmut] for …`
 * comment, or inside a string value such as `description = "reads [tool.mutmut]"`.
 * Either produced a "section" that was really prose, and whatever `runner = "…"`
 * happened to follow it became a shell command cosmic-ray runs once per mutant.
 * A trailing `# comment` after the header is tolerated because TOML allows it;
 * anything else on the line (including a leading `#`) disqualifies the match.
 */
const MUTMUT_SECTION_RE = /^[ \t]*\[tool\.mutmut\][ \t]*(?:#.*)?$/m;

/**
 * The `runner` key inside that table.
 *
 * `^\s*` (with `m`) is load-bearing: the previous unanchored `runner\s*=` also
 * matched every key ENDING in `runner` — `test_runner = "…"`, `custom_runner =
 * "…"` — and mutmut reads neither. The value is used verbatim as cosmic-ray's
 * `test-command`, so matching the wrong key shells the wrong string per mutant.
 */
const MUTMUT_RUNNER_RE = /^\s*runner\s*=\s*["']([^"']+)["']/m;

/** The start of the NEXT TOML table, used to bound the `[tool.mutmut]` slice. */
const NEXT_TABLE_RE = /^[ \t]*\[/m;

/**
 * Extract `[tool.mutmut] runner` from pyproject.toml content, or `null`.
 *
 * Deliberately NOT a TOML parser: pulling a parser dependency into the detection
 * leaf (shared by all four languages) to read one optional key is not worth the
 * weight, and the anchored regexes above close the two holes that actually
 * mattered — a header matched inside a comment/string, and a key matched by
 * suffix. Residual limitation, accepted knowingly: a `[tool.mutmut]` header or a
 * `runner = "…"` line that appears at the start of a line INSIDE a TOML
 * multi-line basic string (`"""…"""`) is still matched, because recognising
 * those requires tracking string state across the whole file. Such content in a
 * real pyproject.toml would be pathological, and the value it produces is still
 * gated by `isRepoTestCommandAllowed` in engines/python.ts before it can reach a
 * shell.
 *
 * @internal
 */
function readMutmutRunner(pyprojectContent: string): string | null {
  const header = MUTMUT_SECTION_RE.exec(pyprojectContent);
  if (header === null) return null;

  // Bound the section at the next table header so a `runner` key belonging to a
  // LATER table (`[tool.other] runner = "wrong"`) is never picked up.
  const afterHeader = pyprojectContent.slice(header.index + header[0].length);
  const nextTable = afterHeader.search(NEXT_TABLE_RE);
  const section = nextTable === -1 ? afterHeader : afterHeader.slice(0, nextTable);

  const runnerMatch = MUTMUT_RUNNER_RE.exec(section);
  return runnerMatch === null ? null : runnerMatch[1];
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
 * `EnvironmentInfo` to see the raw detection result.
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
  const mutmutRunner = pyprojectContent ? readMutmutRunner(pyprojectContent) : null;
  if (mutmutRunner !== null) return mutmutRunner;

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

export const pythonDetector: LanguageDetector = {
  matches: (p) => p.endsWith('.py'),
  extensions: ['.py'],
  markers: PY_ROOT_MARKERS,
  testRunner: detectPythonTestRunner,
  rawRunner: detectRawPythonRunner,
  packageManager: detectPythonPackageManager,
};
