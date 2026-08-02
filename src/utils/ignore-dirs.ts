/**
 * The directory names EVERY tree-walking consumer skips — the ONE place the
 * shared core of "don't go in there" is written down.
 *
 * This is data, not behaviour: plain bare directory NAMES, matched by each
 * consumer against a single path segment / `Dirent.name`. It deliberately
 * carries no matching logic and no `Set`, because the consumers do not all
 * decide the same way — `utils/sandbox.ts` tests the basename of an absolute
 * path (and its own list also carries FILE names), `test-file.ts`'s Python walk
 * additionally drops every dotted entry, and each one composes a different set
 * of extras. Sharing the names while leaving each consumer its own predicate is
 * the only way to dedupe without changing anyone's effective behaviour.
 *
 * It lives in its own import-free leaf module — the same reasoning as
 * `utils/dependency-dirs.ts` — because its consumers sit on opposite sides of
 * the dependency graph and none of them may import another:
 *
 *   - `utils/sandbox.ts`   → `ALWAYS_EXCLUDE`          (copy filter)
 *   - `triage/discover-files.ts` → `IGNORE_DIRS`        (discovery walker)
 *   - `test-file.ts`       → `TEST_SEARCH_SKIP`        (test-file finder)
 *   - `test-file.ts`       → `PYTHON_TEST_IGNORE_DIRS` (pytest presence scan)
 *
 * `utils/` is a leaf (`utils-is-a-leaf` in knossos.json), so sandbox.ts can
 * never reach up to `triage/discover-files.ts` or `test-file.ts`; hoisting just the DATA into a
 * module that imports nothing is what lets all four share one definition.
 *
 * The four lists drifted for real, twice, and both regressions reached
 * production:
 *
 *   1. `IGNORE_DIRS` was JS-only while triage already audited `.py`/`.rs`/`.php`,
 *      so a Python `.venv/` was walked as caller code. Discovery sorts
 *      lexicographically before `slice(0, maxFiles)` and `.venv/...` sorts before
 *      `src/...`, so a sweep spent its entire budget on third-party files and
 *      ranked none of the user's (see the note above `IGNORE_DIRS` in triage/discover-files.ts).
 *   2. `vendor` was in `SYMLINK_DIRS` but missing from `ALWAYS_EXCLUDE`, so the
 *      copy materialised it and Step 2's symlink hit `EEXIST` — every PHP
 *      (Composer) project failed provisioning (see `CopyPolicyInput.symlinkDirs`
 *      in sandbox.ts).
 *
 * SCOPE: this is the INTERSECTION of the four lists as they stand, not their
 * union. Widening any consumer is a behaviour change, not a refactor —
 * `TEST_SEARCH_SKIP` genuinely lacks `.tox`, `out`, `.next`, `.cache`,
 * `reports` and `site-packages`, and adding them would change which test files
 * are discovered. Each consumer therefore spells out its own remaining extras
 * next to this constant, which is what makes the residual drift visible.
 *
 * Adding an entry here changes ALL FOUR consumers at once. That is the point,
 * but it means a new entry must be one that every walker genuinely wants;
 * anything narrower belongs in the consumer's own extras list.
 * `src/__tests__/ignore-dirs.test.ts` pins each consumer's effective set
 * byte-for-byte, so any such edit shows up as an explicit test change.
 */
export const COMMON_IGNORE_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  // Python
  '.venv',
  'venv',
  '__pycache__',
];
