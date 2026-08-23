/**
 * StrykerJS argv construction.
 *
 * Pure by design: no filesystem access and no environment reads, so the whole
 * matrix of flags is assertable as a plain string array.
 */
import type { RunOptions } from '../base.js';
import { INCREMENTAL_FILE_NAME } from '../../utils/incremental-cache.js';

/**
 * StrykerJS test-runner plugin packages, keyed by the resolved runner name.
 *
 * Under pnpm's non-hoisted node_modules layout, StrykerJS's default plugin
 * glob (`["@stryker-mutator/*"]`) fails to resolve the runner plugin in the
 * spawned *child* test-runner process — the run dies with
 * `Could not inject [class ChildProcessTestRunnerWorker]. Cause: Cannot find
 * TestRunner plugin "<runner>". In fact, no TestRunner plugins were loaded.`
 * even though the plugin is installed and resolvable from the project root.
 * Passing the plugin package explicitly on the CLI forces the child to load
 * it. We keep the `@stryker-mutator/*` wildcard alongside it so reporter/other
 * plugins the project relies on are still discovered.
 *
 * The `command` runner is built into @stryker-mutator/core (no separate
 * plugin), so it is intentionally absent — it needs no `--plugins` entry and
 * works under the default discovery. Unknown/custom runner names are likewise
 * absent so we never inject a non-existent plugin package.
 */
const STRYKER_RUNNER_PLUGINS: Record<string, string> = {
  vitest: '@stryker-mutator/vitest-runner',
  jest: '@stryker-mutator/jest-runner',
  mocha: '@stryker-mutator/mocha-runner',
  jasmine: '@stryker-mutator/jasmine-runner',
  karma: '@stryker-mutator/karma-runner',
};

/**
 * Build the `--mutate` argument for Stryker, optionally scoped to one or more
 * 1-based inclusive line ranges. Stryker accepts a comma-separated list where
 * each entry may carry a `:startLine-endLine` suffix:
 *   "src/file.ts:1-5,src/file.ts:20-25"
 */
export function buildMutateArg(
  filePath: string,
  ranges?: { start: number; end: number }[],
): string {
  // No shell quoting — args are passed directly to execFile, not through a shell.
  // Fail closed on invalid scope: the handler validates args before they reach
  // here, but this is defense-in-depth against silent full-file mutation
  // (audit M12). Each range is validated independently.
  if (ranges && ranges.length > 0) {
    return ranges
      .map((r) => {
        if (!Number.isInteger(r.start) || r.start < 1) {
          throw new Error(`lineScope.start must be an integer >= 1, got ${r.start}`);
        }
        if (!Number.isInteger(r.end) || r.end < r.start) {
          throw new Error(`lineScope.end must be an integer >= start (${r.start}), got ${r.end}`);
        }
        return `${filePath}:${r.start}-${r.end}`;
      })
      .join(',');
  }
  return filePath;
}

/**
 * Build the full StrykerJS argv (launcher included at index 0).
 *
 * @param resolvedRunner — see `resolveRunner` in ./config.js.
 * @param mutateArg — the `--mutate` value from {@link buildMutateArg}.
 * @param runtimeConfig — the overlay config filename from `prepareStrykerConfig`.
 *   Every real run now passes one; `undefined` (falling back to Stryker's own
 *   config discovery) remains accepted so the argv matrix stays assertable in
 *   isolation.
 *
 * NOTE there is deliberately no `--jsonReporter.fileName` here even though the
 * report path must be pinned: StrykerJS declares no such CLI option
 * (stryker-cli.js special-cases only `--dashboard.*`) and Commander aborts the
 * run with `error: unknown option '--jsonReporter.fileName'`. It is pinned in
 * the overlay config instead — see `STRIKER_JSON_REPORT`.
 */
export function buildStrykerArgs(
  resolvedRunner: string,
  mutateArg: string,
  runtimeConfig: string | undefined,
  options?: RunOptions,
): string[] {
  // Use --concurrency when provided; omit to let Stryker auto-detect CPU cores.
  const args = [
    ...(options?.executor?.kind === 'container' ? ['stryker'] : ['npx', '--no-install', 'stryker']),
    'run',
    ...(runtimeConfig ? [runtimeConfig] : []),
    '--mutate',
    mutateArg,
    '--testRunner',
    resolvedRunner,
    '--reporters',
    'json',
    '--logLevel',
    'off',
    '--cleanTempDir',
    'true',
    '--tempDirName',
    '.stryker-tmp',
  ];

  // ── Ensure the test-runner plugin resolves under pnpm ──
  // StrykerJS's default `@stryker-mutator/*` plugin glob fails to load the
  // runner plugin in the spawned child process under pnpm's symlinked layout,
  // aborting the run with "no TestRunner plugins were loaded". Pass the plugin
  // explicitly (keeping the wildcard so other plugins are still discovered).
  // Own-property guard: a runner name that collides with an inherited
  // Object.prototype member (e.g. "constructor", "toString") must NOT resolve
  // to a function via the prototype chain — that would push a garbage
  // stringified value as --plugins. Only real, declared runners map to a plugin.
  const runnerPlugin = Object.hasOwn(STRYKER_RUNNER_PLUGINS, resolvedRunner)
    ? STRYKER_RUNNER_PLUGINS[resolvedRunner]
    : undefined;
  if (runnerPlugin) {
    args.push('--plugins', '@stryker-mutator/*', '--plugins', runnerPlugin);
  }

  if (typeof options?.concurrency === 'number' && options.concurrency > 0) {
    args.push('--concurrency', String(options.concurrency));
  }

  // No denylist args to add — denylist is now expressed via stryker.config.json

  // dryRun mode (StrykerJS renamed --dryRun to --dryRunOnly)
  if (options?.dryRun) {
    args.push('--dryRunOnly');
  }

  // incremental mode: reuse results from a previous run to skip unchanged
  // mutants. The file is named sandbox-relative (so it resolves inside a
  // container too); the host-side seed/harvest around the run lives in
  // `runOnce` because it touches the filesystem. See utils/incremental-cache.ts.
  if (options?.incremental) {
    args.push('--incremental');
    args.push('--incrementalFile', INCREMENTAL_FILE_NAME);
  }

  // per-mutant timeout: how long an individual mutant's test is allowed to run
  if (typeof options?.perMutantTimeoutMs === 'number' && options.perMutantTimeoutMs > 0) {
    args.push('--timeoutMs', String(options.perMutantTimeoutMs));
  }

  return args;
}
