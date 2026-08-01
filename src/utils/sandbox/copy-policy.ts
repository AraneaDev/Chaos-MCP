/**
 * The copy/exclusion rules for one sandbox provision.
 *
 * Split out of `utils/sandbox.ts` because these rules decide things about plain
 * path strings and need no sandbox, no temp directory and no process state —
 * see {@link buildCopyPolicy}'s own note on being pure. `utils/sandbox.ts` (the
 * filesystem provisioner) is the only production consumer.
 */

import { existsSync } from 'fs';
import { join, sep } from 'path';
import { ALL_DEPENDENCY_DIRS } from '../dependency-dirs.js';
import { phpDetector } from '../detectors/php.js';
import { COMMON_IGNORE_DIRS } from '../ignore-dirs.js';

/**
 * Directories and files that should never be copied into the sandbox.
 *
 * {@link COMMON_IGNORE_DIRS} is the core every tree-walker in the codebase
 * shares; everything after it is exclusive to the sandbox copy filter and is
 * listed explicitly so the remaining drift against triage.ts / test-file.ts is
 * visible rather than buried in four hand-kept copies. Note this set also
 * carries FILE names, which the shared constant deliberately does not.
 *
 * @internal Exported for testing only — `ignore-dirs.test.ts` pins the
 * effective set byte-for-byte.
 */
export const ALWAYS_EXCLUDE = new Set([
  ...COMMON_IGNORE_DIRS,
  // ── sandbox-only ──
  '.svn',
  '.stryker-tmp',
  '.mutmut-cache',
  '.pytest_cache',
  '.tox',
  '.env',
  'coverage',
  '.nyc_output',
  '.next',
  'target', // Rust build artifacts (excluded — NOT symlinked; audit H1)
  // Our own derived output from a previous audit. Copying it in lets a run that
  // never produced a log read the old one and report it as a fresh result.
  'chaos-infection-log.json',
]);

/**
 * Directories that, when present in the workspace root, should be symlinked
 * into the sandbox rather than copied (they are large and read-only during
 * mutation runs).
 *
 * DERIVED, not hand-maintained: the union of every language's dependency
 * directories, deduped, in declaration order. A new language therefore cannot
 * ship with its dependency tree silently deep-copied into every sandbox — the
 * `DEPENDENCY_DIRS` entry it is forced to add carries the answer. Today that
 * yields exactly `['node_modules', '.venv', 'venv', 'vendor']`
 * (typescript → python → rust(none) → php), pinned by sandbox.test.ts.
 *
 * Taken from the `utils/dependency-dirs.ts` leaf rather than from
 * `engines/registry.ts#dependencyDirectories()`: the two are equal by
 * construction (the registry stamps each descriptor's `dependencyDirs` from the
 * same constant) and sandbox.test.ts pins them equal, but reaching through the
 * registry made this util import every engine class to learn four directory
 * names.
 *
 * Note: `target` (Rust build artifacts) is intentionally NOT symlinked — Rust
 * compiles into `target/`, and a symlink would let mutation runs corrupt the
 * host workspace's build cache (audit finding H1), so the Rust descriptor
 * declares no dependency dirs at all and `target` is bulk-excluded via
 * `ALWAYS_EXCLUDE` instead. Only list a directory in `dependencyDirs` when it is
 * safe to share across sandboxes.
 *
 * @internal Exported for testing only.
 */
export const SYMLINK_DIRS: readonly string[] = ALL_DEPENDENCY_DIRS;

/**
 * The single decision function for "does this path get copied into the sandbox?".
 *
 * Built once per {@link createSandbox} call and shared by the `fs.cp` filter and
 * the pre-copy size estimate, so the exclusion rules (and in particular the
 * trailing-separator / empty-pattern normalisation) exist in exactly one place.
 *
 * @internal Exported for testing only.
 */
export interface CopyPolicy {
  /** Whether the absolute path `src` should be copied into the sandbox. */
  shouldCopy(src: string): boolean;
  /**
   * The caller's ignorePatterns after normalisation: a single trailing
   * separator stripped and empty patterns dropped (an empty pattern matches
   * every `split(sep)` result and would silently exclude everything).
   */
  normalisedExcludes: Set<string>;
  /**
   * Heavyweight dirs {@link CopyPolicy.shouldCopy} refused, at any depth, so
   * Step 2 can symlink them back in. Populated as a side effect of the filter
   * (which `fs.cp` calls synchronously per entry).
   */
  skippedHeavyDirs: Set<string>;
}

/** Inputs for {@link buildCopyPolicy}. */
export interface CopyPolicyInput {
  /** Absolute path of the audited file inside the workspace. */
  absoluteTarget: string;
  /**
   * Heavyweight dirs that will be symlinked into the sandbox for THIS audit.
   *
   * Symlinked directories MUST be excluded from the workspace copy: Step 1 copies
   * the tree and Step 2 symlinks these dirs into the sandbox, so if the copy also
   * materialised them the symlink would collide with `EEXIST`. Excluding them here
   * (rather than relying on every entry ALSO being hand-listed in ALWAYS_EXCLUDE)
   * makes the "symlinked ⇒ never copied" invariant structural, so the two lists
   * cannot silently drift. Regression: `vendor` was in SYMLINK_DIRS but missing
   * from ALWAYS_EXCLUDE, so every PHP (Composer) project failed provisioning.
   */
  symlinkDirs: Iterable<string>;
  /** Caller-supplied ignorePatterns (workspace-relative dir/file segments). */
  userExcludes?: Iterable<string>;
  /**
   * Force-include the target file and every ancestor directory (default true).
   *
   * Only the copy filter wants this; see {@link estimateWorkspaceSize} for why
   * the size estimate deliberately opts out.
   */
  forceIncludeTarget?: boolean;
  /**
   * Match user excludes against EVERY segment of `src`, not just its basename
   * (default true).
   *
   * The copy filter sees each entry in isolation and must therefore reject a
   * path whose ancestor matched. A pruned walk (the size estimate) never
   * descends past a rejected ancestor, so it opts out to avoid ALSO matching
   * segments of the workspace root's own absolute path.
   */
  matchAncestorSegments?: boolean;
}

/**
 * Build the copy/exclusion policy for one sandbox provision.
 *
 * Pure: it touches no filesystem and holds no state beyond
 * {@link CopyPolicy.skippedHeavyDirs}, so the rules can be unit-tested on plain
 * path strings without provisioning a sandbox.
 *
 * @internal Exported for testing only.
 */
export function buildCopyPolicy({
  absoluteTarget,
  symlinkDirs,
  userExcludes,
  forceIncludeTarget = true,
  matchAncestorSegments = true,
}: CopyPolicyInput): CopyPolicy {
  const symlinkDirsSet = new Set(symlinkDirs);

  // Strip a single trailing separator so the common convention `["fixtures/"]`
  // matches directory segments named `fixtures` (Live-audit L2 fix), and drop
  // patterns that normalise to empty — they would match every split and
  // silently exclude the entire workspace.
  const normalisedExcludes = new Set<string>();
  for (const pattern of userExcludes ?? []) {
    if (pattern.length === 0) continue;
    const normalised = pattern.endsWith(sep) ? pattern.slice(0, -1) : pattern;
    if (normalised.length > 0) normalisedExcludes.add(normalised);
  }

  const skippedHeavyDirs = new Set<string>();

  return {
    normalisedExcludes,
    skippedHeavyDirs,
    shouldCopy(src: string): boolean {
      // Force-include the target file itself and any ancestor directory. This
      // deliberately wins over BOTH checks below: a target under a
      // conventionally-named dir (build/, dist/, coverage/, vendor/,
      // node_modules/) or matched by an ignorePattern would otherwise be
      // dropped and provisioning would fail with a confusing "target not
      // found" (Med#7). Step 2's symlink loops guard on `!existsSync(dst)`
      // precisely because this can materialise a heavyweight dir.
      if (forceIncludeTarget && (src === absoluteTarget || absoluteTarget.startsWith(src + sep))) {
        return true;
      }

      const segments = src.split(sep);
      const basename = segments[segments.length - 1] ?? '';

      // Symlinked heavyweight dirs (node_modules, .venv, venv, and — except
      // for Composer PHP audits — vendor) are materialised as symlinks in
      // Step 2, so they must never be copied here: a copied dir would make the
      // later symlinkSync fail with EEXIST. Dirs we deliberately COPY (vendor
      // for PHP) are absent from this set and fall through to be copied.
      //
      // This matches on a path SEGMENT, so it skips these dirs at every depth.
      // Record each one: Step 2 used to symlink only the workspace root, so a
      // workspace layout (npm workspaces, or a PHP project shipping a Node
      // worker) lost its NESTED dependencies from the sandbox entirely.
      //
      // Checked BEFORE ALWAYS_EXCLUDE because node_modules/.venv/venv appear
      // in both lists; an ALWAYS_EXCLUDE hit first would drop them silently
      // instead of recording them for re-linking.
      if (symlinkDirsSet.has(basename)) {
        skippedHeavyDirs.add(src);
        return false;
      }
      if (ALWAYS_EXCLUDE.has(basename)) return false;

      // Audit finding M6: segment-based matching prevents over-eager substring
      // exclusion. Excludes only when a path segment exactly equals the
      // pattern, not when the pattern is a substring of any path component.
      if (matchAncestorSegments) {
        for (const segment of segments) {
          if (normalisedExcludes.has(segment)) return false;
        }
        return true;
      }
      return !normalisedExcludes.has(basename);
    },
  };
}

/**
 * Detect a Composer (PHP) audit that must COPY `vendor/` rather than symlink it.
 *
 * Composer's autoloader (vendor/composer/ClassLoader.php + autoload_*.php) derives
 * its project base dir from `__DIR__`, and PHP resolves `__DIR__` THROUGH symlinks
 * to the real path. So if `vendor/` is a symlink into the sandbox, the autoloader
 * (and the phpunit/infection bin stubs, which `require __DIR__/../autoload.php`)
 * resolve back to the ORIGINAL workspace and load the real source — not the
 * mutated sandbox copy. Coverage then attributes execution to the real files and
 * Infection reports "No source code … was executed", silently invalidating the
 * whole mutation run. Copying vendor/ keeps every `__DIR__` inside the sandbox.
 *
 * Gated on a `.php` target AND a Composer marker (composer.json or vendor/composer)
 * so non-PHP audits keep the cheap symlink for their heavyweight dirs.
 *
 * @internal Exported only so `utils/sandbox.ts` can pick the per-audit symlink set.
 */
export function isComposerPhpAudit(targetFile: string, absoluteWorkspace: string): boolean {
  // "Is this a PHP file?" is answered by `phpDetector`, not by a literal here:
  // a hand-written `.endsWith('.php')` was the fifth copy of that rule in the
  // codebase, and a language whose extension list later grows (or gains a
  // second suffix) would silently keep the symlinked-vendor path here while
  // every other call site moved on. The `.toLowerCase()` stays OUTSIDE the
  // detector: `phpDetector.matches` is case-SENSITIVE by contract (its other
  // callers lowercase first), and dropping it would break `Calculator.PHP` on
  // the case-insensitive filesystems where such a name is legal.
  if (!phpDetector.matches(targetFile.toLowerCase())) return false;
  return (
    existsSync(join(absoluteWorkspace, 'composer.json')) ||
    existsSync(join(absoluteWorkspace, 'vendor', 'composer'))
  );
}
