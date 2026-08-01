/**
 * Workspace detection: which language a target file belongs to, where its
 * workspace root is, and how its tests are run.
 *
 * This module is the ASSEMBLY POINT and nothing else. It owns the parts that
 * are genuinely language-independent — the extension dispatch, the upward walk
 * for a root marker, and the `EnvironmentInfo` composition — while each
 * language's own signals live in `utils/detectors/<language>.ts` behind the
 * `LanguageDetector` seam. Adding a language is a new detector module plus one
 * line in {@link LANGUAGE_DETECTORS}, rather than six edits scattered through a
 * 750-line file.
 *
 * The per-language `detect*` functions are re-exported here because they are
 * the surface the test suite and the engines already import; the split moved
 * where they live, not what the module offers.
 */
import { existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { workspaceRootBoundary } from './path-safety.js';
import type { LanguageDetector, ProjectType, SupportedProjectType } from './detectors/types.js';
import { typescriptDetector } from './detectors/typescript.js';
import { pythonDetector } from './detectors/python.js';
import { rustDetector } from './detectors/rust.js';
import { phpDetector } from './detectors/php.js';
import type { EnvironmentInfo } from './detectors/types.js';

export type { ProjectType, SupportedProjectType, EnvironmentInfo };
export { assertNeverProjectType } from './detectors/types.js';
export { detectJsTestRunner, detectRawJsRunner } from './detectors/typescript.js';
export {
  detectPythonTestRunner,
  detectRawPythonRunner,
  detectPythonPackageManager,
} from './detectors/python.js';
export { detectRustTestRunner, detectRawRustRunner } from './detectors/rust.js';
export { detectPhpTestRunner, detectRawPhpRunner } from './detectors/php.js';

// ─── Per-language detection registry ─────────────────────────────────────────

const LANGUAGE_DETECTORS: Record<SupportedProjectType, LanguageDetector> = {
  typescript: typescriptDetector,
  python: pythonDetector,
  rust: rustDetector,
  php: phpDetector,
};

/** Detection order — preserves the original typescript→python→rust sequence. */
const LANGUAGE_DETECTOR_TYPES = Object.keys(LANGUAGE_DETECTORS) as SupportedProjectType[];

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
  //
  // Lowercased first: on the case-insensitive filesystems where `Main.RS` or
  // `Foo.PHP` are ordinary filenames, they are still Rust and PHP, and
  // reporting "Extension unsupported" for a file that plainly has a supported
  // extension is a confusing way to say so.
  const normalised = filePath.toLowerCase();
  for (const type of LANGUAGE_DETECTOR_TYPES) {
    if (LANGUAGE_DETECTORS[type].matches(normalised)) return type;
  }
  return 'unsupported';
}

// ─── Workspace root resolution ───────────────────────────────────────────────

/** Maximum number of parent directories to traverse when searching for a workspace root. */
const MAX_WALK_DEPTH = 10;

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

// ─── Extension inventories ───────────────────────────────────────────────────

/**
 * Every auditable source-file extension, deduped, in detection order
 * (typescript → python → rust → php). Derived from {@link LANGUAGE_DETECTORS},
 * so adding a language to that registry automatically widens triage discovery
 * and the tool-schema prose instead of leaving them silently stale.
 *
 * Lowercase and dot-prefixed; callers comparing real paths should lowercase the
 * path first (see `triage.ts`).
 */
export function supportedSourceExtensions(): string[] {
  return [...new Set(LANGUAGE_DETECTOR_TYPES.flatMap((t) => LANGUAGE_DETECTORS[t].extensions))];
}

/**
 * The representative subset of {@link supportedSourceExtensions} — variant
 * forms (`.tsx`/`.jsx`) collapsed away — for prose that names a few extensions
 * rather than enumerating all of them.
 */
export function primarySourceExtensions(): string[] {
  return [
    ...new Set(
      LANGUAGE_DETECTOR_TYPES.flatMap(
        (t) => LANGUAGE_DETECTORS[t].primaryExtensions ?? LANGUAGE_DETECTORS[t].extensions,
      ),
    ),
  ];
}

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
  // Clamp the upward walk to a boundary the sandbox will actually accept: the
  // process working directory, or — when the file lives under one — the
  // innermost CHAOS_ALLOWED_ROOTS entry. A root resolved above that boundary
  // would break every audit at provisioning.
  // (Med#5: run-from-subdirectory previously failed at provisioning.)
  const fileDir = dirname(resolve(filePath));
  const workspaceRoot = resolveWorkspaceRoot(
    fileDir,
    detector.markers,
    workspaceRootBoundary(fileDir),
  );

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
