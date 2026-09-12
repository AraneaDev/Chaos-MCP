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
 */
import type { SupportedProjectType } from '../utils/project-detector.js';

export function buildInnerEnv(
  projectType: SupportedProjectType,
  perFileWorkers: number,
): NodeJS.ProcessEnv {
  const workers = String(Math.max(1, Math.floor(perFileWorkers)));
  switch (projectType) {
    case 'rust':
      return { RUST_TEST_THREADS: workers, CARGO_BUILD_JOBS: workers };
    case 'php':
      return { CHAOS_PHP_THREADS: workers };
    default:
      return {};
  }
}
