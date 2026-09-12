/**
 * Caps on the worker pools the mutation tools spawn INSIDE each of their own
 * workers, which nothing bounded before.
 *
 * The layers multiply: fileConcurrency x perFileWorkers x innerPool. Capping
 * any two of the three leaves the product free, which is how a correctly
 * computed cap of 1 still put about 80 node processes on an 8 GB box (see
 * VITEST_SINGLE_WORKER in utils/shell-quote.ts, the same lesson for vitest).
 *
 * TypeScript needs nothing here: StrykerJS forces `singleThread: true` on its
 * vitest runner, and the command runner already carries the flags. Python runs
 * its mutants serially, so it has no pool to cap.
 *
 * Rust is the one engine where `perFileWorkers` itself splits into TWO
 * further layers rather than being restated as the inner pool directly:
 * cargo-mutants' own `-j` (`jobs`, resolved separately by `resolveCargoJobs`
 * and possibly clamped BELOW `perFileWorkers` by the engine's own default) is
 * how many mutants it attempts at once, and EACH of those attempts separately
 * runs `cargo build` (`CARGO_BUILD_JOBS`) and then the resulting test binary
 * (`RUST_TEST_THREADS`). The real concurrent thread count for one file is
 * therefore `jobs x threads`, not `jobs` and `threads` each restated as the
 * WHOLE budget, that was the bug: setting both env vars to `perFileWorkers`
 * while `-j` was ALSO `perFileWorkers` cubed the budget instead of spending
 * it once. `threads` is derived as `perFileWorkers / jobs` (floored, floored
 * to at least 1), so the product of the two layers stays within the
 * budgeted worker count for the file.
 */
import type { SupportedProjectType } from '../utils/project-detector.js';

/**
 * @param perFileWorkers - The total worker budget for one file, before it is
 *   split across cargo's `-j` and its inner build/test thread count.
 * @param jobs - The `-j` value cargo-mutants will ACTUALLY run with (already
 *   clamped to the engine's own default where the caller applies one).
 *   Defaults to `perFileWorkers` for callers with no separate jobs figure
 *   (PHP and TypeScript, and any test exercising Rust without one), which
 *   conservatively spends the whole budget on `-j` and leaves one inner
 *   thread rather than risking a product above the budget.
 */
export function buildInnerEnv(
  projectType: SupportedProjectType,
  perFileWorkers: number,
  jobs: number = perFileWorkers,
): NodeJS.ProcessEnv {
  switch (projectType) {
    case 'rust': {
      const boundedJobs = Math.max(1, Math.floor(jobs));
      const threads = String(Math.max(1, Math.floor(perFileWorkers / boundedJobs)));
      return { RUST_TEST_THREADS: threads, CARGO_BUILD_JOBS: threads };
    }
    case 'php':
      return { CHAOS_PHP_THREADS: String(Math.max(1, Math.floor(perFileWorkers))) };
    default:
      return {};
  }
}
