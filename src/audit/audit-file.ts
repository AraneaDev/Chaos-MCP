/**
 * The audit core: run ONE mutation audit inside an already-provisioned sandbox.
 *
 * Extracted from `handler.ts` (Finding 2). Both entry points share it —
 * `audit_code_resilience` (one file) and `triage_test_coverage` (many files in
 * a bounded-parallel pool) — so it deliberately knows nothing about the MCP
 * protocol: it takes a plain input record and either returns a
 * {@link MutationResult} or throws.
 */
import type { BaseEngine, MutationResult, ReuseKey } from '../engines/base.js';
import { existsSync, readdirSync } from 'node:fs';
import { relative, join } from 'node:path';
import type { EnvironmentInfo } from '../utils/project-detector.js';
import type { ChaosConfig } from '../utils/config-loader.js';
import type { ToolArgs } from '../core/tool-args-validation.js';
import { DEAD_HARNESS_NOTE, looksLikeDeadHarness } from '../core/score-semantics.js';
import {
  createExecutionSession,
  defaultContainerImage,
  type ExecutionSession,
} from '../utils/execution.js';
import { runShell, runShellCommand } from '../utils/exec.js';
import { log, isVerbose } from '../utils/logger.js';
import { findPythonTestSelection, workspaceHasPythonTests } from '../core/test-file.js';
import { buildRunOptions, type ProjectType } from './run-options.js';
import { ENGINE_REGISTRY } from '../engines/registry.js';
import { materialiseDiffScope } from './diff-scope.js';
import type { ResolvedDiffBase } from '../utils/git-diff.js';
import { AuditDeadline } from '../utils/deadline.js';
import { computeFingerprint } from '../utils/reuse/fingerprint.js';

const TOOL_IDENTITY_TIMEOUT_MS = 10_000;

function workspaceFiles(root: string, include: (path: string) => boolean): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'vendor' || entry.name === '.git')
        continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else {
        const relativePath = relative(root, absolute).replaceAll('\\', '/');
        if (include(relativePath)) result.push(relativePath);
      }
    }
  };
  visit(root);
  return result;
}

function existingPaths(root: string, paths: string[]): string[] {
  return paths.filter((path) => existsSync(join(root, path)));
}

function reusePaths(
  projectType: Exclude<ProjectType, 'unsupported'>,
  root: string,
  targetFile: string,
  testSelection: string[] | undefined,
): string[] {
  if (projectType === 'php') {
    return [
      ...workspaceFiles(root, (path) => path.endsWith('.php')),
      ...existingPaths(root, [
        'phpunit.xml',
        'phpunit.xml.dist',
        'phpunit.dist.xml',
        'phpunit.yml',
        'phpunit.yml.dist',
        'phpunit.dist.yml',
        'phpunit.php',
        'composer.json',
        'composer.lock',
        'infection.json',
        'infection.json5',
      ]),
    ];
  }
  if (projectType === 'python') {
    const tests =
      testSelection && testSelection.length > 0
        ? testSelection
        : workspaceFiles(root, (path) => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(path));
    return [
      targetFile,
      ...workspaceFiles(root, (path) => path.endsWith('.py')),
      ...tests,
      ...existingPaths(root, ['pyproject.toml', 'tox.ini', 'pytest.ini', 'setup.cfg']),
      ...workspaceFiles(root, (path) =>
        /(?:^|\/)(?:requirements[^/]*\.txt|poetry\.lock|Pipfile\.lock)$/.test(path),
      ),
    ];
  }
  return [
    targetFile,
    ...workspaceFiles(root, (path) => /\.[cm]?[jt]sx?$/.test(path)),
    ...workspaceFiles(root, (path) =>
      /^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json)$/.test(path),
    ),
  ];
}

export function phpReuseKey(workspaceRoot: string): ReuseKey {
  return { workspaceRoot, engine: 'php', target: 'project', kind: 'coverage' };
}

export async function computePhpReuseFingerprint(
  workspaceRoot: string,
  phpTestFrameworkOptions?: string,
  toolIdentity?: string,
  phpCoverageTestFrameworkOptions?: string,
): Promise<string | undefined> {
  if (!toolIdentity) return undefined;
  return computeFingerprint({
    workspaceRoot,
    paths: reusePaths('php', workspaceRoot, '', undefined),
    extra: {
      tool: toolIdentity,
      coverage: 'project',
      phpTestFrameworkOptions: phpTestFrameworkOptions ?? '',
      coverageTestFrameworkOptions: phpCoverageTestFrameworkOptions ?? '',
    },
  });
}

/** Resolve the mutation tool identity from the environment that will execute it. */
export async function resolveMutationToolIdentity(
  projectType: Exclude<ProjectType, 'unsupported' | 'rust'>,
  workDir: string,
  config: ChaosConfig,
  executor: ExecutionSession | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const run = executor
    ? (command: string, args: string[]) =>
        executor.run(command, args, {
          cwd: workDir,
          timeoutMs: TOOL_IDENTITY_TIMEOUT_MS,
          signal,
        })
    : (command: string, args: string[]) =>
        runShell(command, args, {
          cwd: workDir,
          timeoutMs: TOOL_IDENTITY_TIMEOUT_MS,
          signal,
          killTree: true,
        });
  const command =
    projectType === 'php'
      ? existsSync(join(workDir, 'vendor', 'bin', 'infection'))
        ? './vendor/bin/infection'
        : 'infection'
      : projectType === 'typescript'
        ? executor?.kind === 'container'
          ? 'stryker'
          : 'npx'
        : 'cosmic-ray';
  const args =
    projectType === 'typescript' && executor?.kind !== 'container'
      ? ['--no-install', 'stryker', '--version']
      : ['--version'];
  try {
    const result = await run(command, args);
    const version = `${result.stdout}\n${result.stderr}`.trim().replace(/\s+/g, ' ');
    if (!version) return undefined;
    const environment =
      executor?.kind === 'container'
        ? `container:${config.container?.images?.[projectType] ?? defaultContainerImage(projectType)}`
        : 'native';
    return `${environment}:${command}:${version}`;
  } catch {
    return undefined;
  }
}

async function attachReuse(
  runOptions: ReturnType<typeof buildRunOptions>,
  projectType: Exclude<ProjectType, 'unsupported'>,
  workspaceRoot: string,
  targetFile: string,
  toolIdentity: string | undefined,
): Promise<void> {
  if (projectType === 'rust') return;
  const key: ReuseKey =
    projectType === 'php'
      ? phpReuseKey(workspaceRoot)
      : {
          workspaceRoot,
          engine: projectType,
          target: targetFile,
          kind: projectType === 'python' ? 'session' : 'incremental',
        };
  if (!toolIdentity) return;
  const fingerprint =
    projectType === 'php'
      ? await computePhpReuseFingerprint(
          workspaceRoot,
          runOptions.phpTestFrameworkOptions,
          toolIdentity,
          runOptions.phpCoverageTestFrameworkOptions,
        )
      : await computeFingerprint({
          workspaceRoot,
          paths: reusePaths(projectType, workspaceRoot, targetFile, runOptions.pythonTestSelection),
          extra: {
            tool: toolIdentity,
            options: JSON.stringify({
              testRunner: runOptions.testRunner,
              testRunnerTrusted: runOptions.testRunnerTrusted,
              pythonTestSelection: runOptions.pythonTestSelection,
              pythonExcludeOperators: runOptions.pythonExcludeOperators,
              phpThreads: runOptions.phpThreads,
              phpTestFrameworkOptions: runOptions.phpTestFrameworkOptions,
              phpOnlyCoveringTestCases: runOptions.phpOnlyCoveringTestCases,
              diffScope: runOptions.diffScope,
              lineRanges: runOptions.lineRanges,
              lineScope: runOptions.lineScope,
            }),
          },
        });
  if (fingerprint !== undefined) runOptions.reuse = { key, fingerprint };
}

/**
 * Mirrors `MIN_ENGINE_BUDGET_MS` in `handler.ts` and `triage/audit-one.ts`,
 * which apply the same floor at their own phase boundaries: below this, an
 * engine cannot do anything useful before its own process/report overhead
 * eats the budget, so the run is refused here rather than started
 * token-funded (Finding 3).
 */
const MIN_ENGINE_BUDGET_MS = 1_000;

/**
 * The single wording of the "this Python project has no test suite" refusal.
 *
 * The rule has two dispositions — `handleToolCall` returns it as a tool error,
 * {@link auditFile} throws it — and therefore once had two verbatim copies of
 * the wording. This is the shared home they lacked; {@link assertPythonHasTests}
 * is now the single decision both dispositions are built on.
 */
export function pythonNoTestsMessage(workspaceRoot: string): string {
  return (
    `No Python test files were found in ${workspaceRoot}. ` +
    `Mutation testing needs a test suite to detect surviving mutants. ` +
    `Add tests matching pytest's discovery conventions (test_*.py or *_test.py), ` +
    `then re-run this audit. ` +
    `If the tests live somewhere unconventional, scope the run explicitly ` +
    `via the \`cosmicray.testSelection\` config key.`
  );
}

/**
 * The Python "has this project any tests at all?" rule, in one place.
 *
 * `handleToolCall` runs it as a pre-flight so a testless project backs out
 * cheaply — BEFORE the sandbox copy, which duplicates the whole workspace tree
 * (100+ MB on real repos) only to throw it away. {@link auditFile} runs it
 * again as a last line of defence, because the triage path reaches the engine
 * without that pre-flight.
 *
 * Returns the refusal message, or `null` when the run may proceed; the two call
 * sites differ only in what they do with it (tool error vs. thrown).
 */
export function assertPythonHasTests(env: EnvironmentInfo, config?: ChaosConfig): string | null {
  const explicitSelection = config?.cosmicray?.testSelection;
  if (explicitSelection && explicitSelection.length > 0) return null;
  // A depth-limited scan proves nothing, so only a tree-exhausted miss blocks.
  const scan = workspaceHasPythonTests(env.workspaceRoot);
  if (!scan.found && !scan.depthLimited) return pythonNoTestsMessage(env.workspaceRoot);
  return null;
}

export interface AuditFileInput {
  targetFile: string;
  env: EnvironmentInfo;
  projectType: Exclude<ProjectType, 'unsupported'>;
  engine: BaseEngine;
  args: ToolArgs;
  config: ChaosConfig;
  workDir: string;
  prebuildCmd: string | null;
  lineRanges?: { start: number; end: number }[];
  /**
   * The base `lineRanges` was resolved against, already resolved ONCE by the
   * caller (`handler.ts`'s `computeScope`, or `triage/audit-one.ts`'s own
   * `resolveDiffScope`), never re-derived here. Both callers already run
   * `computeChangedRanges` (utils/git-diff.ts) to get `lineRanges`; handing
   * its `resolvedBase` straight through is what keeps this and that ONE
   * resolution rather than two that can disagree on a diverged branch.
   * Absent whenever `lineRanges` is, and gates materialisation exactly the
   * way `lineRanges.length > 0` does.
   */
  resolvedDiffBase?: ResolvedDiffBase;
  /** Abort signal forwarded from the MCP request context; kills in-flight subprocesses. */
  signal?: AbortSignal;
  /** True when this is a verify run against a stored baseline. */
  verify?: boolean;
}

/**
 * Run a single mutation audit inside an ALREADY-PROVISIONED sandbox `workDir`:
 * build run options, run the (already-resolved/gated) prebuild command, then
 * run the engine. The caller owns the sandbox lifecycle (provision + cleanup).
 * Throws `Prebuild command failed in sandbox: …` if the prebuild fails; engine
 * errors propagate from `engine.run`.
 */
export async function auditFile(input: AuditFileInput): Promise<MutationResult> {
  const {
    targetFile,
    env,
    projectType,
    engine,
    args,
    config,
    workDir,
    prebuildCmd,
    lineRanges,
    resolvedDiffBase,
  } = input;
  const runOptions = buildRunOptions(args, config, env, workDir, projectType, targetFile);
  if (
    input.verify &&
    projectType === 'typescript' &&
    args.incremental === undefined &&
    config.stryker?.incremental === undefined
  ) {
    runOptions.incremental = true;
  }
  // `length > 0`, not just truthiness: an EMPTY array is truthy, and every
  // consumer downstream reads "no ranges" as "the whole file" — StrykerJS's
  // `buildMutateArg` drops the `:start-end` suffix and hands the engine the
  // bare path, and `planLineBatches` falls back to one batch spanning the file.
  // A scoped run whose scope resolved to nothing (a verify against a baseline
  // with zero survivors) therefore escalated into a WHOLE-FILE mutation run:
  // the most expensive possible answer to "re-check these specific mutants",
  // and one that reports unrelated survivors as if they were in scope. `??`
  // cannot fix this at the call site — `[] ?? x` is `[]` — so the emptiness has
  // to be decided here (audit High#1 / Fix 1).
  if (lineRanges && lineRanges.length > 0) runOptions.lineRanges = lineRanges;
  // Turn the already-computed diff ranges into whatever the target engine
  // needs INSIDE the sandbox to act on them. StrykerJS already consumed
  // `lineRanges` directly above, so `materialiseDiffScope` has nothing to do
  // for TypeScript; it exists for the engines that need a patch file or a
  // throwaway git repository built inside `workDir` first (see
  // `audit/diff-scope.ts`). A materialisation failure never blocks the run:
  // it comes back as a `note` that joins the run's scope note below rather
  // than a `diffScope`, so the engine falls back to mutating the whole file.
  //
  // Gated on `resolvedDiffBase`, a value the CALLER already resolved via
  // `computeChangedRanges` (whichever produced `lineRanges`), not on
  // `args.diffBase`. Re-reading the raw string here would either duplicate
  // that resolution (the exact bug that let a diverged branch's Rust patch
  // and PHP base come from two different commits) or, for the triage sweep,
  // simply never fire: `triage/audit-one.ts` builds a fresh, minimal
  // `ToolArgs` per file that has never carried `diffBase`, so gating on it
  // left every triage sweep materialising nothing for Python, Rust and PHP
  // while `resolveDiffScope` still stamped their rows "scored on changed
  // lines".
  let diffScopeNote: string | undefined;
  if (
    lineRanges &&
    lineRanges.length > 0 &&
    resolvedDiffBase &&
    ENGINE_REGISTRY[projectType].supportsDiffScope
  ) {
    // Charge materialisation against the SAME budget the engine is about to
    // run under (Finding 3): left unmeasured, a slow or timed-out git
    // sequence here spent real wall-clock time while `runOptions.timeoutMs`
    // stayed untouched, so a whole-file fallback run then started with the
    // FULL budget on top of what materialisation already used, promising the
    // engine time the caller's deadline no longer has. `AuditDeadline` is the
    // same elapsed-time primitive `handler.ts` and `triage/audit-one.ts`
    // already deadline the surrounding phases with, reused here rather than a
    // second hand-rolled `Date.now()` diff.
    const materialiseDeadline =
      typeof runOptions.timeoutMs === 'number'
        ? new AuditDeadline(runOptions.timeoutMs)
        : undefined;
    const materialised = await materialiseDiffScope({
      projectType,
      relFile: targetFile,
      workspaceRoot: env.workspaceRoot,
      sandboxDir: workDir,
      resolvedBase: resolvedDiffBase,
      ranges: lineRanges,
      signal: input.signal,
      timeoutMs: runOptions.timeoutMs,
    });
    if (materialised.diffScope) runOptions.diffScope = materialised.diffScope;
    diffScopeNote = materialised.note;
    if (materialiseDeadline) {
      const remaining = materialiseDeadline.remainingMs();
      if (remaining < MIN_ENGINE_BUDGET_MS) {
        // Same wording family as `handler.ts`'s `reserveEngineBudget`
        // ("Audit time budget exhausted <phase> after <n>ms.") so both
        // callers recognise it as the SAME kind of exhaustion their own
        // phase-boundary checks already produce, rather than a generic
        // engine failure: `handler.ts` turns it into the identical tool
        // error, and the triage sweep folds it into the `unaudited` bucket
        // instead of a per-file error row.
        throw new Error(
          `Audit time budget exhausted during diff-scope materialisation after ` +
            `${materialiseDeadline.elapsedMs()}ms.`,
        );
      }
      runOptions.timeoutMs = remaining;
    }
  }
  // Python only: when neither the tool args nor the config scoped the suite,
  // default to the target file's own test module(s). cosmic-ray otherwise runs
  // the WHOLE suite per mutant — impractical on real projects, and a single
  // unrelated failing/slow test breaks the baseline. Discovery is best-effort;
  // an empty result leaves the whole-suite default untouched.
  if (
    projectType === 'python' &&
    (!runOptions.pythonTestSelection || runOptions.pythonTestSelection.length === 0)
  ) {
    // Mutation testing is meaningless without tests, and cosmic-ray's baseline
    // failure would otherwise be reported as "the test suite fails" — pytest
    // exits 5 for "no tests collected", which is a different problem entirely.
    //
    // Delegated to the shared rule rather than re-deriving it from
    // `workspaceHasPythonTests` here: the pre-flight in `handleToolCall` and
    // this guard are the SAME check with two dispositions (it returns a tool
    // error, this throws), and two copies of a scan/depth-limit rule is how
    // they drift. Its own `cosmicray.testSelection` gate is a no-op at this
    // call site — reaching here means `pythonTestSelection` is empty, and that
    // field is populated from exactly that config key.
    const refusal = assertPythonHasTests(env, config);
    if (refusal !== null) throw new Error(refusal);
    const auto = findPythonTestSelection(targetFile, env.workspaceRoot);
    if (auto.length > 0) {
      runOptions.pythonTestSelection = auto;
      if (isVerbose()) log(`PythonEngine: auto-scoped test-command to ${auto.join(' ')}`);
    }
  }
  // Thread the abort signal from the MCP request context into the engine run so
  // in-flight subprocesses are killed when the caller cancels.
  if (input.signal) runOptions.signal = input.signal;

  const configuredContainerMode =
    config.container?.modes?.[projectType] ?? config.container?.mode ?? 'native';
  const executor =
    configuredContainerMode === 'native'
      ? undefined
      : await createExecutionSession(
          projectType,
          workDir,
          env.workspaceRoot,
          config.sandbox?.dependencies ?? 'link-entries',
          config.container,
          input.signal,
        );
  if (executor) runOptions.executor = executor;
  const toolIdentity =
    projectType === 'rust'
      ? undefined
      : await resolveMutationToolIdentity(projectType, workDir, config, executor, input.signal);
  await attachReuse(runOptions, projectType, env.workspaceRoot, targetFile, toolIdentity);

  try {
    if (prebuildCmd !== null) {
      if (isVerbose()) {
        const prebuildExplicit =
          typeof args.prebuildCommand === 'string' && args.prebuildCommand.trim().length > 0;
        const autoLabel =
          env.packageManager && env.packageManager !== 'pip' ? env.packageManager : projectType;
        const source = prebuildExplicit ? 'explicit' : `auto (${autoLabel})`;
        log(`Running prebuild command in sandbox [${source}]: ${prebuildCmd}`);
      }
      const prebuildStart = Date.now();
      try {
        const prebuildOptions = {
          cwd: workDir,
          timeoutMs: runOptions.timeoutMs,
          signal: input.signal,
          killTree: true,
          // Same inner-pool caps the mutation tool itself receives
          // (runOptions.innerEnv, built by buildInnerEnv from the resolved
          // Budget), merged the same way engines/rust.ts merges them: shell
          // spawning replaces the whole child environment when `env` is set
          // rather than merging it with process.env, so a bare innerEnv would
          // strip PATH and the prebuild would fail to launch at all. Without
          // this, an engine prebuild could run ungoverned inside the governed
          // window, uncapped by the same watchdog that may then stop the run it
          // just paid for.
          env: runOptions.innerEnv ? { ...process.env, ...runOptions.innerEnv } : undefined,
        };
        if (executor) await executor.runCommand(prebuildCmd, prebuildOptions);
        else await runShellCommand(prebuildCmd, prebuildOptions);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Prebuild command failed in sandbox: ${message}`);
      }
      if (isVerbose()) log('Prebuild command completed successfully');
      // Deduct prebuild time so timeoutMs bounds the whole run (audit Med#3).
      if (typeof runOptions.timeoutMs === 'number') {
        const remaining = runOptions.timeoutMs - (Date.now() - prebuildStart);
        runOptions.timeoutMs = remaining > 0 ? remaining : 1;
      }
    }

    const result = await engine.run(targetFile, runOptions);
    // Append rather than replace: the engine may already have set a scope note
    // of its own (e.g. a batched run's "Completed N bounded mutation
    // batches."), and overwriting it would silently drop that fact from the
    // one field the text output prints.
    if (diffScopeNote) {
      result.scopeNote = result.scopeNote ? `${result.scopeNote} ${diffScopeNote}` : diffScopeNote;
    }
    // Applied HERE, after the engine and once, rather than in each engine: the
    // silent-harness failure is a property of the numbers every engine already
    // reports, not of any one tool's output format, and four copies of the rule
    // is how they drift apart. Composed rather than assigned, so an engine that
    // set its own advisory (PHP's WARNING_FIDELITY_NOTE) keeps it — both facts
    // are true at once and the caller needs both.
    if (looksLikeDeadHarness(result)) {
      result.fidelityNote =
        result.fidelityNote === undefined
          ? DEAD_HARNESS_NOTE
          : `${result.fidelityNote} ${DEAD_HARNESS_NOTE}`;
    }
    return result;
  } finally {
    await executor?.dispose();
  }
}
