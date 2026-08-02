/**
 * The vocabulary shared by every language detector.
 *
 * A leaf with no imports of its own, so the per-language detector modules and
 * `project-detector.ts` (which assembles them) can both depend on it without
 * forming a cycle.
 */

/**
 * Supported project types for mutation testing.
 */
export type ProjectType = 'typescript' | 'python' | 'rust' | 'php' | 'unsupported';

/**
 * The project types that map to a real mutation engine (everything but
 * 'unsupported').
 *
 * Declared here, in the detection leaf, rather than next to the engine registry
 * that consumes it: `utils/execution.ts` needs this type, and importing it from
 * `engines/registry.ts` made a utility depend on the engine layer — closing an
 * 8-module import cycle (exec-classify → execution → registry → engines →
 * exec-classify). `engines/registry.ts` re-exports it for existing callers.
 */
export type SupportedProjectType = Exclude<ProjectType, 'unsupported'>;

/**
 * Compile-time exhaustiveness guard for {@link SupportedProjectType} switches.
 *
 * Call it from a `default:` clause whose subject has been narrowed to `never`.
 * Adding a member to {@link ProjectType} then turns every unhandled switch into
 * a COMPILE error instead of a silent fallback (audit F15: seven of the eleven
 * sites a new language touches failed silently).
 *
 * Deliberately a no-op at runtime, NOT a throw: the call sites it guards all
 * have a safe fallback value today, and turning a silent fallback into a
 * runtime crash would change behaviour. The value is the compile error.
 */
export function assertNeverProjectType(value: never): void {
  void value;
}

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

/**
 * Per-language detection metadata. Single source of truth for "what languages
 * are supported and how each is detected", replacing the parallel
 * `projectType === '…'` ternary chains previously inlined in
 * `detectProjectType` and `detectEnvironment`. The execution-side counterpart
 * lives in engines/registry.ts.
 *
 * One of these is exported per language from `utils/detectors/<language>.ts`;
 * `project-detector.ts` assembles them into the registry. Adding a language is
 * a new module plus one line in that registry, rather than an edit in six
 * places of one 750-line file.
 */
export interface LanguageDetector {
  /** True when the target file belongs to this language (by extension). */
  matches: (filePath: string) => boolean;
  /**
   * Source-file extensions this language owns, most idiomatic first, lowercase
   * and dot-prefixed. This is the PROSE set: it is what the MCP tool schema
   * enumerates when it tells the calling model which files can be audited.
   *
   * It is NOT the discovery predicate. Both triage discovery
   * (`triage/discover-files.ts`) and the audit tool gate on
   * {@link LanguageDetector.matches} via `detectProjectType`, so they agree by
   * construction. This list used to serve both, and the two diverged: `matches`
   * accepts `.mjs`/`.cjs`/`.mts`/`.cts` and this list did not, so a pure-ESM
   * package was auditable file-by-file while a sweep over it reported "No
   * supported source files found".
   *
   * Keep it in step with `matches` anyway — an extension missing here is one
   * the schema never advertises, so a model has no reason to ask for it. Prefer
   * {@link LanguageDetector.primaryExtensions} where prose needs to stay short.
   */
  extensions: readonly string[];
  /**
   * The subset of {@link LanguageDetector.extensions} used in space-constrained
   * prose (schema descriptions that name a few representative extensions rather
   * than enumerating variant forms). Defaults to `extensions` when omitted.
   */
  primaryExtensions?: readonly string[];
  /** Root-marker files used to resolve the workspace root. */
  markers: readonly string[];
  /** Stryker/mutmut-compatible test-runner detection. */
  testRunner: (workspaceRoot: string) => string;
  /** Raw runner/orchestrator detection, for diagnostics (e.g. 'bun', 'tox'). */
  rawRunner: (workspaceRoot: string) => string;
  /** Package-manager detection — only meaningful for Python today. */
  packageManager?: (workspaceRoot: string) => string;
}
