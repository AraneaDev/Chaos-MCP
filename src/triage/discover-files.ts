/**
 * Target DISCOVERY for a triage sweep: turning caller-supplied paths (or a git
 * changed-file list) into the workspace-relative source files a sweep may rank.
 *
 * This is the filesystem half of what used to be `triage.ts`. That module was
 * two programs sharing a filename: a directory walker (this one) and the
 * ranking/payload/text renderer (still `triage.ts`). The halves shared NOTHING —
 * no state, no imports, no types. This side speaks only `fs`/`path` and knows
 * nothing about mutation results; the renderer speaks only `format.js`/`gate.js`/
 * `enrich.js` and never touches the disk. Neither imports the other, so the
 * split is a genuine seam rather than a file boundary drawn through one program.
 *
 * It lands in `src/triage/` next to `discover-targets.ts`, whose own header
 * already argued that these functions "belong beside it rather than inside
 * `handleTriageCall`" — that module is the thin git-vs-filesystem glue over the
 * two entry points exported here, and it is now the only production consumer.
 */
import { readdirSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import { COMMON_IGNORE_DIRS } from '../utils/ignore-dirs.js';
import { supportedSourceExtensions } from '../utils/project-detector.js';

/**
 * Auditable source extensions, derived from the per-language detection registry
 * rather than restated here. Restating them meant a newly added language was
 * invisible to triage discovery with no compile error to say so — the tool just
 * returned an empty leaderboard (audit F15).
 */
const SUPPORTED_EXT = supportedSourceExtensions();
/**
 * Directory names discovery never descends into.
 *
 * This list used to be JS-only while {@link SUPPORTED_EXT} already covered
 * `.py`/`.rs`/`.php`, so a Python `.venv`, a PHP `vendor/`, or a Rust `target/`
 * was walked as if it were the caller's code. Discovery sorts lexicographically
 * before `slice(0, maxFiles)`, and `.venv/...` sorts BEFORE `src/...` — so a
 * sweep could fill its whole budget with third-party files and rank none of the
 * user's.
 *
 * The shared core now comes from {@link COMMON_IGNORE_DIRS}, the import-free
 * leaf that `utils/sandbox.ts` and `test-file.ts` also compose from, so the
 * entries all four walkers agree on can no longer drift. Everything after it is
 * exclusive to triage discovery and is spelled out here on purpose: the residual
 * difference against `TEST_SEARCH_SKIP` (which still lacks `.tox`, `out`,
 * `.next`, `.cache`, `reports` and `site-packages`) is a real behavioural
 * difference in which files each walker sees, not an oversight to paper over.
 *
 * @internal Exported for testing only — `ignore-dirs.test.ts` pins the
 * effective set byte-for-byte.
 */
export const IGNORE_DIRS = new Set([
  ...COMMON_IGNORE_DIRS,
  // ── triage-only ──
  'coverage',
  '.stryker-tmp',
  'reports',
  '__tests__',
  'tests',
  // Python
  'env',
  '.tox',
  'site-packages',
  // PHP / Rust
  'vendor',
  'target',
  // Build output / caches
  'out',
  '.next',
  '.cache',
]);
const TEST_FILE_RE = /(\.test\.|\.spec\.|_test\.(py|rs)$|(^|\/)test_[^/]*\.py$|Test\.php$)/;

/**
 * Normalise a path to forward slashes.
 *
 * {@link TEST_FILE_RE} anchors the `test_*.py` alternative on `(^|/)`, and
 * `walk` builds candidates with `relative()`, which yields BACKslashes on
 * Windows — so `pkg\test_math.py` failed the guard and a pytest test module was
 * audited as if it were source.
 *
 * Backslashes are translated on EVERY platform, not just where `sep` is `\`.
 * A POSIX filename may legally contain a backslash, so this technically
 * misreads `weird\test_x.py` as a directory boundary — an acceptable trade for
 * behaviour that Linux CI can actually verify. A platform-gated version is
 * invisible to this project's CI, which is precisely how the bug survived.
 * Matches the unconditional normalisation already used in engines/php.ts.
 */
function toPosix(path: string): string {
  return sep === '\\' ? path.split(sep).join('/') : path.replace(/\\/g, '/');
}

/** True if a path is a mutation-testable source file (supported ext, not a test). */
export function isSupportedSourceFile(path: string): boolean {
  const normalised = toPosix(path);
  // Extensions are compared case-insensitively: on the case-insensitive
  // filesystems where `Foo.PHP` is an ordinary filename, it is still PHP.
  const lower = normalised.toLowerCase();
  if (!SUPPORTED_EXT.some((ext) => lower.endsWith(ext))) return false;
  if (TEST_FILE_RE.test(normalised)) return false;
  return true;
}

/** Recursively collect supported source files under an absolute directory. */
function walk(absDir: string, workspaceRoot: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      walk(join(absDir, entry.name), workspaceRoot, out);
    } else if (entry.isFile()) {
      const rel = relative(workspaceRoot, join(absDir, entry.name));
      if (isSupportedSourceFile(rel)) out.push(rel);
    }
  }
}

/** Probe whether an absolute path is a directory via readdirSync (throws for files). */
function readdirSyncIsDir(abs: string): boolean {
  try {
    readdirSync(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Expand `paths` (files and/or directories) into workspace-relative supported
 * source files: dedupe, sort, then cap at `maxFiles`.
 */
export function discoverFiles(
  paths: string[],
  workspaceRoot: string,
  maxFiles: number,
): { files: string[]; discovered: number; skipped: number } {
  const collected: string[] = [];
  for (const p of paths) {
    const abs = resolve(workspaceRoot, p);
    if (readdirSyncIsDir(abs)) {
      walk(abs, workspaceRoot, collected);
    } else {
      const rel = relative(workspaceRoot, abs);
      if (isSupportedSourceFile(rel)) collected.push(rel);
    }
  }
  const unique = [...new Set(collected)].sort();
  const discovered = unique.length;
  const files = unique.slice(0, maxFiles);
  return { files, discovered, skipped: discovered - files.length };
}

/**
 * Normalise a caller-supplied path into the workspace-relative, POSIX,
 * no-trailing-slash form that git reports changed files in.
 *
 * `resolve` + `relative` is the same normalisation `discoverFiles` gets for
 * free from the filesystem, and it is what makes "./src", "src/", and "src"
 * one path rather than three. Without it a diff-scoped sweep given
 * `paths: ["./src"]` compared "./src" against "src/foo.ts", matched nothing,
 * and reported "No changed supported source files found" — while the exact same
 * argument worked in the non-diff branch (audit M-diffBase).
 */
function toWorkspaceRelative(p: string, workspaceRoot: string): string {
  return toPosix(relative(workspaceRoot, resolve(workspaceRoot, p))).replace(/\/+$/, '');
}

/**
 * Filter a raw changed-file list (from listChangedFiles) to supported source
 * files, optionally intersecting with `paths` (treated as directory/file
 * prefixes), then sort, dedupe, and cap at `maxFiles`.
 *
 * `workspaceRoot` is what `paths` are normalised against; it defaults to the
 * process cwd, which is the root the handler resolves against anyway.
 */
export function discoverChangedFiles(
  changedFiles: string[],
  paths: string[] | undefined,
  maxFiles: number,
  workspaceRoot: string = process.cwd(),
): { files: string[]; discovered: number; skipped: number } {
  // Both sides are normalised the same way: the caller's paths here, the git
  // paths by `toPosix` below. An empty `paths` still means "match everything".
  const normalisedPaths = (paths ?? []).map((p) => toWorkspaceRelative(p, workspaceRoot));
  const underPaths = (rel: string): boolean => {
    if (normalisedPaths.length === 0) return true;
    const norm = toPosix(rel).replace(/\/+$/, '');
    // An empty normalised path is the workspace root itself — it contains
    // everything, so `paths: ["."]` behaves like no filter at all.
    return normalisedPaths.some((p) => p === '' || norm === p || norm.startsWith(`${p}/`));
  };
  const collected = changedFiles.filter((rel) => isSupportedSourceFile(rel) && underPaths(rel));
  const unique = [...new Set(collected)].sort();
  const discovered = unique.length;
  const files = unique.slice(0, maxFiles);
  return { files, discovered, skipped: discovered - files.length };
}
