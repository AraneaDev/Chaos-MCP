/**
 * The audit core: run ONE mutation audit inside an already-provisioned sandbox.
 *
 * Extracted from `handler.ts` (Finding 2). Both entry points share it —
 * `audit_code_resilience` (one file) and `triage_test_coverage` (many files in
 * a bounded-parallel pool) — so it deliberately knows nothing about the MCP
 * protocol: it takes a plain input record and either returns a
 * {@link MutationResult} or throws.
 */
import type { BaseEngine, MutationResult } from '../engines/base.js';
import type { EnvironmentInfo } from '../utils/project-detector.js';
import type { ChaosConfig } from '../utils/config-loader.js';
import type { ToolArgs } from '../tool-args-validation.js';
import { createExecutionSession } from '../utils/execution.js';
import { runShellCommand } from '../utils/exec.js';
import { log, isVerbose } from '../utils/logger.js';
import { findPythonTestSelection, workspaceHasPythonTests } from '../test-file.js';
import { buildRunOptions, type ProjectType } from './run-options.js';

/**
 * The single wording of the "this Python project has no test suite" refusal.
 *
 * The rule has two dispositions and therefore had two verbatim copies: the
 * pre-flight in `handleToolCall` returns it as a tool error (bailing out BEFORE
 * the sandbox copy), while the guard inside {@link auditFile} throws it (the
 * triage path reaches the engine without that pre-flight). One string, two
 * call sites — the copies could drift, and this is the shared home they lacked.
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
 * Python pre-flight for the callers that can still back out cheaply: a project
 * with no test suite can never produce a meaningful mutation run, so bail out
 * BEFORE the sandbox copy — provisioning copies the whole workspace tree
 * (100+ MB on real repos) only to throw it away. Mirrors the guard in
 * {@link auditFile}, including its "no explicit test selection" gate.
 *
 * Returns the refusal message, or `null` when the run may proceed.
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
  /** Abort signal forwarded from the MCP request context; kills in-flight subprocesses. */
  signal?: AbortSignal;
}

/**
 * Run a single mutation audit inside an ALREADY-PROVISIONED sandbox `workDir`:
 * build run options, run the (already-resolved/gated) prebuild command, then
 * run the engine. The caller owns the sandbox lifecycle (provision + cleanup).
 * Throws `Prebuild command failed in sandbox: …` if the prebuild fails; engine
 * errors propagate from `engine.run`.
 */
export async function auditFile(input: AuditFileInput): Promise<MutationResult> {
  const { targetFile, env, projectType, engine, args, config, workDir, prebuildCmd, lineRanges } =
    input;
  const runOptions = buildRunOptions(args, config, env, workDir, projectType, targetFile);
  if (lineRanges) runOptions.lineRanges = lineRanges;
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
    // A depth-limited scan proves nothing, so only a tree-exhausted miss blocks.
    const scan = workspaceHasPythonTests(env.workspaceRoot);
    if (!scan.found && !scan.depthLimited) {
      throw new Error(pythonNoTestsMessage(env.workspaceRoot));
    }
    const auto = findPythonTestSelection(targetFile, env.workspaceRoot);
    if (auto.length > 0) {
      runOptions.pythonTestSelection = auto;
      if (isVerbose()) log(`PythonEngine: auto-scoped test-command to ${auto.join(' ')}`);
    }
  }
  // Thread the abort signal from the MCP request context into the engine run so
  // in-flight subprocesses are killed when the caller cancels.
  if (input.signal) runOptions.signal = input.signal;

  const containerMode = config.container?.mode;
  const executor =
    containerMode && containerMode !== 'native'
      ? await createExecutionSession(projectType, workDir, config.container, input.signal)
      : undefined;
  if (executor) runOptions.executor = executor;

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

    return await engine.run(targetFile, runOptions);
  } finally {
    await executor?.dispose();
  }
}
