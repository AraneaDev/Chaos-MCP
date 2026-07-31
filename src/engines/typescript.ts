import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  BaseEngine,
  RunOptions,
  MutationResult,
  Vulnerability,
  formatMutationScore,
} from './base.js';
import { ExecFailureError } from '../utils/exec-error.js';
import { invokeMutationTool, MutationToolStartupError } from '../utils/exec-classify.js';
import { log, warn, isVerbose } from '../utils/logger.js';
import { DEFAULT_TIMEOUT_MS } from '../utils/constants.js';
import {
  INCREMENTAL_FILE_NAME,
  harvestIncrementalFile,
  seedIncrementalFile,
} from '../utils/incremental-cache.js';

/**
 * Path (relative to the Stryker working directory) where the JSON reporter
 * writes its output.
 *
 * This is NOT merely where we look — it is pinned into the generated Stryker
 * overlay config as `jsonReporter.fileName` on every run (see
 * {@link writeStrykerRuntimeConfig}). `jsonReporter.fileName` is a first-class,
 * user-settable Stryker option (node_modules/@stryker-mutator/core/dist/src/
 * reporters/json-reporter.js resolves `this.options.jsonReporter.fileName`), and
 * the overlay faithfully carries the project's own config forward — so without
 * the pin a project shipping `jsonReporter: { fileName: 'artifacts/…' }` made a
 * fully successful run report "Stryker JSON report not found at …" (audit E).
 *
 * It cannot be pinned on the CLI: StrykerJS 9.6.1 declares no
 * `--jsonReporter.fileName` option (only `--dashboard.*` is special-cased in
 * stryker-cli.js), and Commander rejects the run outright with
 * `error: unknown option '--jsonReporter.fileName'`. The config overlay is the
 * only mechanism.
 */
const STRIKER_JSON_REPORT = 'reports/mutation/mutation.json';
const CHAOS_STRYKER_CONFIG = '.chaos-mcp.stryker.config.mjs';
const COMMAND_BATCH_LINES = 80;
const COMMAND_BATCH_THRESHOLD_LINES = 120;
const MIN_BATCH_BUDGET_MS = 3_000;

/** Stryker's supported config names, in its own discovery order. */
const STRYKER_CONFIG_NAMES = [
  'stryker.conf.json',
  'stryker.conf.js',
  'stryker.conf.mjs',
  'stryker.conf.cjs',
  'stryker.config.json',
  'stryker.config.js',
  'stryker.config.mjs',
  'stryker.config.cjs',
  '.stryker.conf.json',
  '.stryker.conf.js',
  '.stryker.conf.mjs',
  '.stryker.conf.cjs',
  '.stryker.config.json',
  '.stryker.config.js',
  '.stryker.config.mjs',
  '.stryker.config.cjs',
] as const;

/** Split requested physical line ranges into bounded command-runner batches. */
export function planLineBatches(
  totalLines: number,
  ranges?: { start: number; end: number }[],
): { start: number; end: number }[] {
  // Stryker disable ArrayDeclaration: sentinel array elements are outside the typed input domain.
  const requestedLineCount = (ranges ?? []).reduce(
    (sum, range) => sum + Math.max(0, range.end - range.start + 1),
    0,
  );
  const requested =
    ranges && ranges.length > 0
      ? requestedLineCount > COMMAND_BATCH_LINES
        ? ranges
        : []
      : totalLines > COMMAND_BATCH_THRESHOLD_LINES
        ? [{ start: 1, end: totalLines }]
        : [];
  // Stryker restore ArrayDeclaration
  const batches: { start: number; end: number }[] = [];
  for (const range of requested) {
    for (let start = range.start; start <= range.end; start += COMMAND_BATCH_LINES) {
      batches.push({ start, end: Math.min(range.end, start + COMMAND_BATCH_LINES - 1) });
    }
  }
  return batches;
}

/**
 * Fold the per-batch results of a bounded command-runner run into one result.
 *
 * @param scopeKind — the REQUESTED scope of the whole batched run, not of an
 *   individual batch: every batch is line-scoped by construction, but a run that
 *   plans batches across the entire file is still `'whole-file'`. See the
 *   {@link MutationResult.scopeKind} doc in `engines/base.ts`.
 */
export function mergeBatchResults(
  filePath: string,
  results: MutationResult[],
  planned: number,
  complete: boolean,
  scopeKind: 'whole-file' | 'scoped' = 'whole-file',
): MutationResult {
  const totalMutants = results.reduce((sum, result) => sum + result.totalMutants, 0);
  const killed = results.reduce((sum, result) => sum + result.killed, 0);
  const survived = results.reduce((sum, result) => sum + result.survived, 0);
  const incompetent = results.reduce((sum, result) => sum + (result.incompetent ?? 0), 0);
  const score = formatMutationScore(killed, totalMutants);
  return {
    target: filePath,
    totalMutants,
    killed,
    survived,
    mutationScore: score,
    vulnerabilities: results.flatMap((result) => result.vulnerabilities),
    incompetent: incompetent > 0 ? incompetent : undefined,
    complete,
    batchesCompleted: results.length,
    batchesPlanned: planned,
    stoppedReason: complete ? undefined : 'time_budget_exhausted',
    scopeKind,
    scopeNote: complete
      ? `Completed ${planned} bounded mutation batches.`
      : `Partial audit: completed ${results.length} of ${planned} bounded mutation batches before the time budget was exhausted.`,
  };
}

/**
 * A StrykerJS invocation that exceeded its own time budget.
 *
 * `invokeMutationTool` classifies the raw `ExecFailureError` (`code === 'TIMEOUT'`)
 * into a {@link MutationToolStartupError}, but that class carries only `tool` and
 * a message — the machine-readable code is dropped. {@link TypeScriptEngine.runOnce}
 * re-establishes the discriminator here, so {@link TypeScriptEngine.runBatched}
 * can recognise a genuine timeout by TYPE rather than by sniffing prose. That
 * matters because `runOnce` also throws
 * `StrykerJS configuration or internal error (exit 1): <stderr>`, and Stryker's
 * stderr routinely contains test-runner text such as `Test timed out in 5000ms`;
 * a substring match on "timed out" silently dropped those real config failures
 * and reported the run as `time_budget_exhausted`.
 */
export class StrykerTimeoutError extends Error {
  readonly code = 'TIMEOUT';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StrykerTimeoutError';
  }
}

/**
 * Structured JSON produced by the Stryker JSON reporter.
 */
interface StrykerJsonReport {
  files: Record<
    string,
    {
      source: string;
      mutants: StrykerMutantRecord[];
    }
  >;
}

interface StrykerMutantRecord {
  id: string;
  mutatorName: string;
  replacement: string;
  location: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  /**
   * Deliberately `string`, not a closed union of the statuses we know about.
   * `parseReport` reaches this shape through an UNCHECKED `JSON.parse(...) as
   * StrykerJsonReport` cast of a file produced by a separately-versioned schema
   * package (mutation-testing-report-schema), so a union here would be a
   * compile-time fiction. `mutation-testing-report-schema@3.7.3` already
   * declares a `"Pending"` status this engine has never handled. The three sets
   * below are the real classifier, and anything they do not recognise is
   * reported rather than silently absorbed.
   */
  status: string;
  statusReason?: string;
}

/**
 * Mutant statuses that are SCORED: they form the denominator, and
 * `Killed`/`Timeout` also form the numerator (a timeout means the mutant was
 * detected — it made the suite hang).
 *
 * This is an ALLOW-list on purpose. It used to be a deny-list (`status !==
 * 'CompileError' && !== 'RuntimeError' && !== 'Ignored'`), which meant any status
 * Stryker's schema gains later — `Pending` exists in the schema package today —
 * would land in the denominator as "valid but neither killed nor survived",
 * inflating it and silently lowering every score with no warning at all.
 */
const SCORED_STATUSES: ReadonlySet<string> = new Set([
  'Killed',
  'Survived',
  'NoCoverage',
  'Timeout',
]);

/**
 * Statuses where the mutated code never produced a real pass/fail: it failed to
 * compile, or blew up before the suite could judge it. Excluded from the
 * denominator (they would penalise a score for a fault of the mutant, not the
 * tests) but counted into `MutationResult.incompetent`, which `engines/base.ts`
 * documents as covering exactly "Stryker compile errors". Without that count a
 * file where 40 of 100 mutants fail to compile reported a total of 60 with no
 * explanation of where the other 40 went (gap audit I3).
 */
const INCOMPETENT_STATUSES: ReadonlySet<string> = new Set(['CompileError', 'RuntimeError']);

/**
 * Statuses excluded on purpose by configuration (`mutator.excludedMutations`,
 * `// Stryker disable` comments). Kept SEPARATE from `incompetent`: nothing
 * failed, the operator asked for these not to run, so reporting them as
 * unscoreable failures would be misleading. They are silently dropped.
 */
const EXCLUDED_STATUSES: ReadonlySet<string> = new Set(['Ignored']);

/**
 * Slice the original source span a mutant replaced, from the report's embedded
 * file source. 1-based lines/columns, exclusive end column. Returns undefined
 * (never throws) when the location falls outside the source.
 */
function sliceSource(source: string, loc: StrykerMutantRecord['location']): string | undefined {
  const lines = source.split('\n');
  const { start, end } = loc;
  if (
    start.line < 1 ||
    end.line < 1 ||
    start.line > lines.length ||
    end.line > lines.length ||
    start.column < 1 ||
    end.column < 1
  ) {
    return undefined;
  }
  if (start.line === end.line) {
    return lines[start.line - 1].slice(start.column - 1, end.column - 1);
  }
  const parts: string[] = [lines[start.line - 1].slice(start.column - 1)];
  for (let ln = start.line + 1; ln < end.line; ln++) {
    parts.push(lines[ln - 1]);
  }
  parts.push(lines[end.line - 1].slice(0, end.column - 1));
  return parts.join('\n');
}

/**
 * Build the `--mutate` argument for Stryker, optionally scoped to one or more
 * 1-based inclusive line ranges. Stryker accepts a comma-separated list where
 * each entry may carry a `:startLine-endLine` suffix:
 *   "src/file.ts:1-5,src/file.ts:20-25"
 */
function buildMutateArg(filePath: string, ranges?: { start: number; end: number }[]): string {
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
 * Write the Stryker overlay config every run is launched with.
 *
 * The overlay inlines (for JSON) or imports (for the JS family) the project's
 * own config and layers Chaos-MCP's runtime-only settings on top. It is written
 * solely inside the disposable outer sandbox and selected explicitly as
 * Stryker's `configFile` argument, so the user's real config is never modified.
 *
 * ── Why the overlay is now UNCONDITIONAL ──
 * It used to be written only for scoped command-runner runs; a denylist-only run
 * instead merged `mutator.excludedMutations` in place into `stryker.config.json`.
 * Two verified defects came out of that (both against @stryker-mutator/core@9.6.1):
 *
 *  1. **The denylist landed in a file Stryker never read.** `SUPPORTED_CONFIG_FILE_NAMES`
 *     (config/config-file-formats.js) is ordered `stryker.conf.json`,
 *     `stryker.conf.js`, `stryker.conf.mjs`, `stryker.conf.cjs`,
 *     `stryker.config.json`, … and `ConfigReader.findConfigFile` returns the
 *     FIRST that exists. `stryker.config.json` is 5th — so a project shipping the
 *     (very common) `stryker.conf.json` or `stryker.conf.mjs` had every
 *     denylisted mutator run anyway, silently. A JS-family config also cannot be
 *     merged into textually at all; only the overlay can express it.
 *  2. **The JSON report path was not pinned.** See {@link STRIKER_JSON_REPORT}.
 *
 * Both are structural properties of "the config Stryker actually loads", so the
 * fix is to stop guessing and always hand Stryker a config we composed from the
 * one it *would* have discovered — {@link STRYKER_CONFIG_NAMES} is that same
 * ordered list.
 *
 * ── Mutator denylist semantics ──
 * StrykerJS v9 removed the v8 `--mutators` CLI flag; exclusions are expressed
 * only as `mutator.excludedMutations` (an array of PascalCase mutator names,
 * validated by Stryker at runtime). There is NO top-level `mutators` option —
 * earlier Chaos-MCP versions wrote a `mutators: { Name: false }` map that Stryker
 * silently ignored, so any such legacy map found in the project's config is
 * migrated into `excludedMutations` and the invalid key dropped. An allowlist is
 * not expressible; see {@link prepareStrykerConfig}.
 *
 * @param command — the command-runner command for a scoped `command`-runner run.
 *   `undefined` for every other run, which leaves the project's own
 *   `testRunner`/`coverageAnalysis`/`commandRunner` settings untouched — an
 *   overlay written for a native runner (vitest, jest, …) must not force the
 *   command runner on it.
 * @returns the overlay filename, to be passed as Stryker's `configFile` argument.
 */
export function writeStrykerRuntimeConfig(
  cwd: string,
  command: string | undefined,
  denylist: string[],
): string {
  const existingName = STRYKER_CONFIG_NAMES.find((name) => existsSync(join(cwd, name)));
  let baseDeclaration = 'const base = {};';
  if (existingName?.endsWith('.json')) {
    try {
      const parsed = JSON.parse(readFileSync(join(cwd, existingName), 'utf-8')) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        baseDeclaration = `const base = ${JSON.stringify(parsed)};`;
      }
    } catch {
      // Match the legacy denylist behavior: an invalid JSON config degrades to
      // an empty base and Stryker validates the generated overlay.
    }
  } else if (existingName) {
    baseDeclaration =
      `import importedConfig from ${JSON.stringify(`./${existingName}`)};\n` +
      'const base = importedConfig ?? {};';
  }

  // Only a scoped command-runner run overrides the runner. Emitting these for a
  // native-runner run would silently switch the project onto `command` (and turn
  // coverage analysis off) with no command to run.
  const commandRunnerSection =
    command === undefined
      ? ''
      : `  testRunner: 'command',
  coverageAnalysis: 'off',
  commandRunner: { ...(base.commandRunner ?? {}), command: ${JSON.stringify(command)} },
`;

  const source = `${baseDeclaration}
const legacyExcluded = Object.entries(base.mutators ?? {})
  .filter(([, enabled]) => enabled === false)
  .map(([name]) => name);
const existingExcluded = Array.isArray(base.mutator?.excludedMutations)
  ? base.mutator.excludedMutations.filter((name) => typeof name === 'string')
  : [];
const { mutators: _legacyMutators, ...withoutLegacyMutators } = base;
export default {
  ...withoutLegacyMutators,
${commandRunnerSection}  jsonReporter: { ...(base.jsonReporter ?? {}), fileName: ${JSON.stringify(STRIKER_JSON_REPORT)} },
  mutator: {
    ...(base.mutator ?? {}),
    excludedMutations: [...new Set([
      ...existingExcluded,
      ...legacyExcluded,
      ...${JSON.stringify(denylist)},
    ])],
  },
};
`;
  writeFileSync(join(cwd, CHAOS_STRYKER_CONFIG), source, 'utf-8');
  return CHAOS_STRYKER_CONFIG;
}

/**
 * Resolve the effective StrykerJS test runner for a run.
 *
 * The `?? 'command'` default is consulted from three places (`run`, `runOnce`
 * and {@link prepareStrykerConfig}), and they must agree — the config-writing
 * branch and the `--testRunner` argument are keyed off the same value.
 */
function resolveRunner(options?: RunOptions): string {
  return options?.testRunner ?? 'command';
}

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
 * Materialise the Stryker configuration a run needs, inside the sandbox `cwd`.
 *
 * ALWAYS returns an overlay filename: Stryker must never be left to its own
 * config discovery, because two settings Chaos-MCP depends on are otherwise at
 * the audited project's mercy — where the JSON report is written
 * (`jsonReporter.fileName`) and whether the mutator denylist is honoured at all
 * (which of the sixteen `stryker.conf|config.{json,js,mjs,cjs}` names Stryker
 * picks). See {@link writeStrykerRuntimeConfig} for the verified evidence.
 *
 * The overlay is composed FROM the project's own config, so this pins those two
 * settings without discarding anything the project configured.
 *
 * @returns the runtime-config filename to pass as Stryker's `configFile` argument.
 * @throws when a `mutatorAllowlist` is requested — v9 cannot express one.
 */
export function prepareStrykerConfig(cwd: string, options?: RunOptions): string {
  // The config model can only EXCLUDE mutators; there is no way to express
  // "only these N" without enumerating every mutator name Stryker ships. Fail
  // loudly rather than running an unrestricted mutation set the caller did not ask for.
  if (options?.mutatorAllowlist && options.mutatorAllowlist.length > 0) {
    throw new Error(
      'mutatorAllowlist is not supported in StrykerJS v9. ' +
        'Use mutatorDenylist instead, or create a stryker.config.json with explicit mutator settings. ' +
        `Requested allowlist: ${options.mutatorAllowlist.join(', ')}`,
    );
  }
  // Only a scoped command-runner run overrides the runner; every other run keeps
  // the project's own (see the `command` parameter of writeStrykerRuntimeConfig).
  const command =
    resolveRunner(options) === 'command' && options?.commandRunnerCommand
      ? options.commandRunnerCommand
      : undefined;
  return writeStrykerRuntimeConfig(cwd, command, options?.mutatorDenylist ?? []);
}

/**
 * Build the full StrykerJS argv (launcher included at index 0).
 *
 * Pure: no filesystem access, no environment reads — every decision comes from
 * the arguments, so the whole matrix of flags is assertable as a string array.
 *
 * @param resolvedRunner — see {@link resolveRunner}.
 * @param mutateArg — the `--mutate` value from {@link buildMutateArg}.
 * @param runtimeConfig — the overlay config filename from
 *   {@link prepareStrykerConfig}. Every real run now passes one; `undefined`
 *   (falling back to Stryker's own config discovery) remains accepted so the
 *   argv matrix stays assertable in isolation.
 *
 * NOTE there is deliberately no `--jsonReporter.fileName` here even though the
 * report path must be pinned: StrykerJS 9.6.1 declares no such CLI option
 * (stryker-cli.js special-cases only `--dashboard.*`) and Commander aborts the
 * run with `error: unknown option '--jsonReporter.fileName'`. It is pinned in
 * the overlay config instead — see {@link STRIKER_JSON_REPORT}.
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

  // dryRun mode (StrykerJS v9: renamed --dryRun to --dryRunOnly)
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

/**
 * Interpret a failed StrykerJS invocation.
 *
 * Returns normally for the recoverable cases — a non-zero exit where the JSON
 * report was still written and the caller should go on and parse it. Every other
 * case throws.
 *
 * The branches are ordered most-specific-first and that order is load-bearing:
 * it decides which message a user sees.
 *
 * @param reportExists — whether this run's JSON report is on disk. The caller
 *   computes it (so this function stays free of filesystem access and its whole
 *   decision matrix is assertable from plain arguments), and it is only sound
 *   because `runOnce` deletes any pre-existing report BEFORE launching Stryker —
 *   otherwise a stale report from a previous batch would make a genuine config
 *   error look recoverable.
 */
export function classifyStrykerFailure(
  error: unknown,
  filePath: string,
  reportExists: boolean,
): void {
  // Startup-class failures (not-installed / timeout / signal crash) are
  // wrapped in MutationToolStartupError by the helper. Surface verbatim.
  if (error instanceof MutationToolStartupError) {
    // Re-establish the TIMEOUT discriminator that the wrapper drops. This is
    // the only point where a timeout is still distinguishable: the messages
    // MutationToolStartupError can carry are a CLOSED set authored in
    // exec-classify.ts, and only the TIMEOUT branch renders
    // `${tool} timed out after ${ms}ms.`. The other three begin with
    // "<tool> is not installed", "<tool> produced more output" and
    // "<tool> crashed unexpectedly" — so tool-controlled text (stderr, which
    // only ever appears *after* the crash prefix) cannot forge this.
    // runBatched keys on the resulting type, never on the prose.
    if (error.message.startsWith(`${error.tool} timed out after `)) {
      throw new StrykerTimeoutError(error.message, { cause: error });
    }
    throw new Error(error.message);
  }

  // Per-tool exit-code logic. The shared helper has already classified
  // the standard startup failures; anything reaching here is a non-zero
  // exit code that Stryker-specific behaviour must interpret.
  if (!(error instanceof ExecFailureError)) {
    if (error instanceof Error) throw error;
    throw new Error(`Stryker execution failed: ${String(error)}`);
  }

  // ── Stryker exit-code semantics, verified against @stryker-mutator/core@9.6.1 ──
  // Exit code 1 is OVERLOADED. It is both the generic failure code AND the code
  // Stryker deliberately sets for "mutation score below thresholds.break":
  // `MutationTestReportHelper.determineExitCode()` calls `objectUtils.setExitCode(1)`
  // on that branch (dist/src/reporters/mutation-test-report-helper.js:114-122),
  // and `grep -rn "setExitCode" dist/src/` has exactly that one call site.
  //
  // There is NO exit code 2 anywhere in Stryker. This code used to comment that
  // "2 = threshold not reached" and treat every exit 1 as a config error, so any
  // audited project with the standard CI gate `thresholds: { break: 80 }` had a
  // completely successful run reported as
  // `StrykerJS configuration or internal error (exit 1):` with an EMPTY message
  // (`--logLevel off` leaves stderr blank) and its whole survivor report thrown away.
  //
  // The report's presence is what separates the two meanings, and the ordering
  // makes that safe: `reportAll` calls `onMutationTestReportReady` (:105) before
  // `determineExitCode` (:112), and `JsonReporter.wrapUp()` awaits the file
  // write — so on the threshold-break path the JSON report IS already on disk.
  if (error.exit === 1) {
    // Checked FIRST: a dry run that executes zero tests is almost always
    // "nothing covers this file", not a broken config — say so instead of
    // dumping the raw Stryker stack trace. This is a real failure even though a
    // report from an earlier phase could conceivably exist.
    if (error.stderr?.includes('No tests were executed')) {
      throw new Error(
        `StrykerJS ran zero tests in its dry run — no tests in this project appear to cover ${filePath}. ` +
          'Add a test file exercising it, or check the test runner configuration if tests exist.',
      );
    }
    if (!reportExists) {
      throw new Error(
        `StrykerJS configuration or internal error (exit 1): ${error.stderr?.slice(0, 500) || error.message}`,
      );
    }
    // Report on disk → the run completed and exit 1 means the score is under the
    // project's own `thresholds.break`. Fall through to parseReport.
  }

  // Recoverable non-zero exit → parse the report.
  // Capture stderr for diagnostics in case the report is missing after all.
  if (isVerbose() && error.stderr) {
    log(`StrykerJS exited ${error.exit} (expected): ${error.stderr.slice(0, 500)}`);
  }
}

/**
 * The result of a `--dryRunOnly` run.
 *
 * StrykerJS performs only the initial test run and never generates mutants or
 * writes reports/mutation/mutation.json, so this shape is deliberately distinct
 * from a scored run: no mutants, and a non-numeric `mutationScore`.
 *
 * `scopeKind` is deliberately LEFT UNSET. The field answers "does
 * `totalMutants === 0` prove this file has no mutable logic?", and a dry run
 * never asked the question — it enumerated nothing anywhere. `undefined` is the
 * honest third state; consumers must not read a zero here as proven coverage.
 */
export function dryRunResult(filePath: string): MutationResult {
  return {
    target: filePath,
    totalMutants: 0,
    killed: 0,
    survived: 0,
    mutationScore: 'n/a (dry run)',
    vulnerabilities: [],
    scopeNote:
      'Dry run only: the test suite executed successfully against the sandboxed file. ' +
      'No mutants were generated — re-run without dryRun to score coverage.',
  };
}

/**
 * Flatten a Stryker JSON report into a mutant list plus each mutant's file
 * source (needed to slice the original span it replaced).
 *
 * Defence-in-depth: this walk is external data, and it runs OUTSIDE the parse
 * `try` in {@link TypeScriptEngine.parseReport}. Stryker's own schema always
 * carries `mutants[].location.start`, but a null file entry or a location-less
 * mutant in a truncated/foreign report must not escape as a raw
 * `Cannot read properties of undefined` TypeError.
 */
function collectMutants(raw: StrykerJsonReport): {
  mutants: StrykerMutantRecord[];
  sourceById: Map<string, string>;
} {
  const mutants: StrykerMutantRecord[] = [];
  const sourceById = new Map<string, string>();
  if (raw?.files) {
    for (const fileData of Object.values(raw.files)) {
      if (!Array.isArray(fileData?.mutants)) continue;
      for (const m of fileData.mutants) {
        if (typeof m?.location?.start?.line !== 'number') continue;
        mutants.push(m);
        if (typeof fileData.source === 'string') sourceById.set(m.id, fileData.source);
      }
    }
  }
  return { mutants, sourceById };
}

/**
 * Describe one uncaught mutant (Survived or NoCoverage) as a {@link Vulnerability}.
 *
 * @param source — the mutant's file source from {@link collectMutants}, used
 *   best-effort to recover the original span; absent when the report carried none.
 */
function toVulnerability(m: StrykerMutantRecord, source: string | undefined): Vulnerability {
  const vuln: Vulnerability = {
    line: m.location.start.line,
    mutator: m.mutatorName,
    // Carry Stryker's own status forward as structured data. The
    // description below says the same thing in prose for humans, but the
    // pipeline reads this field.
    kind: m.status === 'NoCoverage' ? 'noCoverage' : 'survived',
    description:
      m.status === 'NoCoverage'
        ? `No test reached this line (NoCoverage). Consider adding tests covering this branch.`
        : `Logical mutation via [${m.mutatorName}] survived. Your tests did not catch this change.`,
  };
  if (m.replacement) vuln.mutated = m.replacement;
  if (source !== undefined) {
    try {
      const original = sliceSource(source, m.location);
      if (original) vuln.original = original;
    } catch {
      // best-effort — leave original unset
    }
  }
  return vuln;
}

/**
 * Mutation testing engine for TypeScript/JavaScript files.
 *
 * Invokes the StrykerJS CLI (via `npx stryker run`) inside the sandbox
 * working directory so the real workspace tree is never touched.
 */
export class TypeScriptEngine extends BaseEngine {
  async run(filePath: string, options?: RunOptions): Promise<MutationResult> {
    const resolvedRunner = resolveRunner(options);
    if (resolvedRunner === 'command' && !options?.dryRun) {
      let totalLines = 0;
      try {
        totalLines = readFileSync(join(options?.workDir ?? process.cwd(), filePath), 'utf-8').split(
          '\n',
        ).length;
      } catch {
        // Keep the zero default and fall back to a single run.
      }
      const requestedRanges =
        options?.lineRanges ?? (options?.lineScope ? [options.lineScope] : undefined);
      const batches = planLineBatches(totalLines, requestedRanges);
      // Stryker disable next-line EqualityOperator: the planner invariant returns either zero or at least two batches.
      if (batches.length > 1) return this.runBatched(filePath, batches, options ?? {});
    }
    return this.runOnce(filePath, options);
  }

  private async runBatched(
    filePath: string,
    batches: { start: number; end: number }[],
    options: RunOptions,
  ): Promise<MutationResult> {
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const completed: MutationResult[] = [];
    let firstTimeout: Error | undefined;

    for (let index = 0; index < batches.length; index++) {
      const remaining = deadline - Date.now();
      const batchesLeft = batches.length - index;
      const batchBudget = Math.floor(remaining / batchesLeft);
      if (batchBudget < MIN_BATCH_BUDGET_MS) break;
      try {
        completed.push(
          await this.runOnce(filePath, {
            ...options,
            lineScope: undefined,
            lineRanges: [batches[index]],
            timeoutMs: batchBudget,
          }),
        );
      } catch (error: unknown) {
        // Only a genuine, typed timeout may be swallowed to keep batching.
        // Matching on the words "timed out" anywhere in the message also caught
        // Stryker exit-1 configuration errors whose stderr happens to mention a
        // test-runner timeout, silently discarding that batch and blaming the
        // time budget for a config bug that raising timeoutMs will never fix.
        if (!(error instanceof StrykerTimeoutError)) throw error;
        firstTimeout ??= error;
      }
    }

    if (completed.length === 0 && firstTimeout) throw firstTimeout;
    // A run that measured NOTHING has no score to report. `mergeBatchResults`
    // reduces over an empty array to totalMutants 0 / killed 0, and
    // `formatMutationScore(0, 0)` is '100.00%' by the documented
    // zero-denominator convention — so returning here reported a flawless audit
    // for a run in which not one mutant was ever generated.
    //
    // This is reachable without any timeout at all: `reserveEngineBudget`
    // (handler.ts) admits any remaining budget >= 1000ms, so with >= 2 batches
    // and ~1s left the very first `batchBudget` is ~500ms, below
    // MIN_BATCH_BUDGET_MS, and the loop breaks before invoking Stryker once —
    // leaving `firstTimeout` undefined and the guard above unarmed.
    if (completed.length === 0) {
      throw new Error(
        `Time budget exhausted before any mutation batch could run for ${filePath} ` +
          `(0 of ${batches.length} planned batches completed). No mutants were generated, so there is no ` +
          'score to report — raise timeoutMs or narrow the audit scope.',
      );
    }
    return mergeBatchResults(
      filePath,
      completed,
      batches.length,
      completed.length === batches.length,
      // The batches together span whatever was REQUESTED: the whole file when no
      // line scope was given, otherwise only the caller's ranges. Each individual
      // batch is line-scoped, but that is an implementation detail of batching
      // and must not make a whole-file audit look like a partial one.
      options.lineRanges?.length || options.lineScope ? 'scoped' : 'whole-file',
    );
  }

  private async runOnce(filePath: string, options?: RunOptions): Promise<MutationResult> {
    const resolvedRunner = resolveRunner(options);
    const cwd = options?.workDir ?? process.cwd();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const effectiveRanges =
      options?.lineRanges ?? (options?.lineScope ? [options.lineScope] : undefined);
    const mutateArg = buildMutateArg(filePath, effectiveRanges);
    const runtimeConfig = prepareStrykerConfig(cwd, options);
    const args = buildStrykerArgs(resolvedRunner, mutateArg, runtimeConfig, options);

    // ── Reset the JSON report so a read below can only be THIS invocation's ──
    // The report path is fixed, and `parseReport` guards it with nothing but
    // `existsSync`, which cannot tell this run's output from:
    //   * the previous BATCH's output — `runBatched` calls `runOnce` N times
    //     against the same cwd, so a batch that exits without rewriting the file
    //     would have the prior batch's report re-parsed, and `mergeBatchResults`
    //     SUMS totals and CONCATENATES vulnerabilities: double-counted mutants
    //     and duplicate (line, mutator) entries that then collide as
    //     suppression/verify keys; or
    //   * a report the audited workspace shipped — `ALWAYS_EXCLUDE`
    //     (utils/sandbox.ts) does not exclude `reports/`, so a project that has
    //     run Stryker itself copies its own mutation.json into the sandbox.
    // Deleting first makes a missing report afterwards an honest error.
    // The PHP engine defends against exactly this (engines/php.ts, `rmSync` of
    // the Infection log before the run).
    const reportPath = join(cwd, STRIKER_JSON_REPORT);
    try {
      rmSync(reportPath, { force: true });
    } catch {
      // Best-effort: an undeletable stale report is no worse than today's
      // behaviour, and every other guard here still applies.
    }

    // Incremental state is seeded from / harvested to a host-side cache around
    // the run — without that the sandbox teardown discards Stryker's
    // incremental file and the whole option is a no-op. See
    // utils/incremental-cache.ts.
    const incrementalCachePath = options?.incremental ? options.incrementalCachePath : undefined;
    if (incrementalCachePath) seedIncrementalFile(incrementalCachePath, cwd);

    if (isVerbose()) {
      log(`TypeScriptEngine: ${args.join(' ')}`);
    }

    try {
      await invokeMutationTool('StrykerJS', args[0], args.slice(1), {
        cwd,
        timeoutMs,
        signal: options?.signal,
        executor: options?.executor,
      });
    } catch (error: unknown) {
      // Throws for every failure except the recoverable non-zero exits (mutants
      // survived / score under `thresholds.break`), which fall through to
      // parseReport. The report-existence check is sound only because the stale
      // report was removed above, before Stryker was launched.
      classifyStrykerFailure(error, filePath, existsSync(reportPath));
    }

    // Preserve the incremental state before the caller tears the sandbox down.
    // Reached on both terminal paths that produced a run (clean exit and the
    // expected non-zero "mutants survived" exit); a run that threw above has no
    // state worth keeping.
    if (incrementalCachePath) harvestIncrementalFile(incrementalCachePath, cwd);

    // ── Dry run: nothing to parse ──
    // Reaching this point without a startup error means the suite ran clean,
    // so report that instead of trying (and failing) to parse a report.
    if (options?.dryRun) return dryRunResult(filePath);

    // ── Parse the JSON report ──
    return this.parseReport(cwd, filePath, effectiveRanges ? 'scoped' : 'whole-file');
  }

  /**
   * Read and parse the Stryker JSON report from the filesystem.
   * Extracted as a separate method for testability.
   *
   * @param scopeKind — whether the run this report came from enumerated the
   *   whole file or only the caller's line ranges. Defaults to `'whole-file'`,
   *   which is what a bare `parseReport(workDir, filePath)` describes.
   * @internal
   */
  parseReport(
    workDir: string,
    filePath: string,
    scopeKind: 'whole-file' | 'scoped' = 'whole-file',
  ): MutationResult {
    const reportPath = join(workDir, STRIKER_JSON_REPORT);
    if (!existsSync(reportPath)) {
      throw new Error(
        `Stryker JSON report not found at ${reportPath}. The mutation run may have failed before the report was written.`,
      );
    }

    let raw: StrykerJsonReport;
    try {
      const jsonText = readFileSync(reportPath, 'utf-8');
      raw = JSON.parse(jsonText) as StrykerJsonReport;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse Stryker JSON report: ${message}`);
    }

    // Collect all mutants across all files, keeping each mutant's file source
    // so we can slice the original span it replaced.
    const { mutants, sourceById } = collectMutants(raw);

    // ── Classify every mutant by an ALLOW-list of statuses ──
    // Scored mutants form the denominator; CompileError/RuntimeError become
    // `incompetent`; `Ignored` is dropped silently; anything else is schema
    // drift and is reported rather than quietly inflating the denominator.
    // See SCORED_STATUSES / INCOMPETENT_STATUSES / EXCLUDED_STATUSES above.
    const validMutants = mutants.filter((m) => SCORED_STATUSES.has(m.status));
    const incompetent = mutants.filter((m) => INCOMPETENT_STATUSES.has(m.status)).length;

    const unrecognised = new Map<string, number>();
    for (const m of mutants) {
      if (
        SCORED_STATUSES.has(m.status) ||
        INCOMPETENT_STATUSES.has(m.status) ||
        EXCLUDED_STATUSES.has(m.status)
      ) {
        continue;
      }
      unrecognised.set(m.status, (unrecognised.get(m.status) ?? 0) + 1);
    }
    if (unrecognised.size > 0) {
      // Warned unconditionally (not behind isVerbose): an unhandled status means
      // this engine's view of the report schema has drifted from the tool's, and
      // the resulting score silently omits those mutants. Once per run, naming
      // each status and its count.
      const summary = [...unrecognised].map(([status, count]) => `${status} (${count})`).join(', ');
      warn(
        `parseReport: ${unrecognised.size} unrecognised Stryker mutant status(es) in the report for ` +
          `${filePath}: ${summary}. They are excluded from the mutation score — this engine's status ` +
          'list may be out of date with the installed StrykerJS.',
      );
    }

    const totalMutants = validMutants.length;
    // Timeouts count as killed — the mutant was detected by causing the test suite to hang.
    const killed = validMutants.filter(
      (m) => m.status === 'Killed' || m.status === 'Timeout',
    ).length;
    const survived = validMutants.filter((m) => m.status === 'Survived').length;
    const mutationScore = formatMutationScore(killed, totalMutants);

    // Vulnerabilities include Survived AND NoCoverage mutants — NoCoverage
    // means no test reached that code path and is therefore an actionable hole.
    const vulnerabilities: Vulnerability[] = validMutants
      .filter((m) => m.status === 'Survived' || m.status === 'NoCoverage')
      .map((m) => toVulnerability(m, sourceById.get(m.id)));

    // Log a heads-up when NoCoverage mutants are present (these lower the score
    // and now show up as explicit vulnerabilities — previously they were silent).
    const noCoverage = validMutants.filter((m) => m.status === 'NoCoverage').length;
    if (noCoverage > 0 && isVerbose()) {
      log(`parseReport: ${noCoverage} NoCoverage mutant(s) reported as vulnerabilities`);
    }

    return {
      target: filePath,
      totalMutants,
      killed,
      survived,
      mutationScore,
      vulnerabilities,
      incompetent: incompetent > 0 ? incompetent : undefined,
      scopeKind,
    };
  }
}
