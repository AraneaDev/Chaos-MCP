import { ExecResult, ExecFailureError } from './exec-error.js';
import { runShell } from './exec.js';
import { DEFAULT_TIMEOUT_MS } from './constants.js';
import type { ExecutionSession } from './execution.js';

/**
 * The mutation tools Chaos-MCP can invoke. Each tool name maps to a CLI
 * install hint surfaced when the binary is missing. Names match the
 * user-facing labels used in docs (e.g. StrykerJS — not `stryker`).
 */
export type ExecutableTool = 'StrykerJS' | 'cosmic-ray' | 'cargo-mutants' | 'Infection';

/**
 * Which startup-class failure produced a {@link MutationToolStartupError}.
 *
 * This is the MACHINE-READABLE discriminator for the four cases the class
 * flattens into one prose message. It exists because callers were forced to
 * treat all four alike: `estimate.ts`'s `computeCount` caught the class and
 * reported *every* member as "(cargo-mutants not installed)" — so a genuine
 * TIMEOUT, and truncated output, were both reported to the caller as a missing
 * binary, with a heuristic estimate returned as if nothing had gone wrong.
 * Only `'NOT_INSTALLED'` is safe to degrade from; the rest must fail the call.
 *
 * `'UNKNOWN'` is the default for an instance constructed without a reason (no
 * production code does; test doubles do). It deliberately does NOT match any
 * "safe to degrade" check, so an unlabelled instance fails loudly rather than
 * silently inheriting the most permissive behaviour.
 *
 * NOTE: `'ABORTED'` is absent on purpose — a deliberate cancellation is no
 * longer wrapped in this class at all (see {@link invokeMutationTool}); it
 * propagates as the raw `ExecFailureError` with `code === 'ABORTED'`, which is
 * what `isCancel` keys on.
 */
export type StartupFailureReason =
  | 'NOT_INSTALLED'
  | 'OUTPUT_TRUNCATED'
  | 'TIMEOUT'
  | 'CRASHED'
  | 'UNKNOWN';

/**
 * Typed error thrown by {@link invokeMutationTool} when the mutation tool
 * has a startup-class failure that the engine cannot recover from:
 *
 *   - binary missing on PATH (ENOENT)            → reason 'NOT_INSTALLED'
 *   - output exceeded the capture cap            → reason 'OUTPUT_TRUNCATED'
 *   - process timed out (TIMEOUT)                → reason 'TIMEOUT'
 *   - process crashed with a signal (e.g. SIGSEGV) → reason 'CRASHED'
 *
 * Engines that use {@link invokeMutationTool} should treat catching this
 * error as "fail fast" and surface the message to the caller verbatim.
 * Callers that want to react differently per case must branch on
 * {@link MutationToolStartupError.reason}, never on the message prose.
 *
 * Non-zero exits that are *part of the tool's expected output*
 * (e.g. Stryker exiting 2 because the mutation threshold wasn't met)
 * are NOT wrapped in this class — they fall through to the engine's
 * per-tool catch for tool-specific handling.
 */
export class MutationToolStartupError extends Error {
  constructor(
    public readonly tool: ExecutableTool,
    message: string,
    /**
     * Optional so existing constructions (engine tests that only assert the
     * message) keep compiling. Defaults to `'UNKNOWN'`, which no caller treats
     * as recoverable.
     */
    public readonly reason: StartupFailureReason = 'UNKNOWN',
  ) {
    super(message);
    this.name = 'MutationToolStartupError';
  }
}

const INSTALL_HINTS: Record<ExecutableTool, string> = {
  StrykerJS: 'npm install --save-dev @stryker-mutator/core',
  'cosmic-ray': 'pipx install cosmic-ray (or: pip install cosmic-ray in a virtualenv)',
  'cargo-mutants': 'cargo install cargo-mutants',
  Infection:
    'composer require --dev infection/infection (also enable a coverage driver: Xdebug or PCOV)',
};

/**
 * Wraps {@link runShell} and normalises the four startup-class failures
 * (ENOENT, OUTPUT_TRUNCATED, TIMEOUT, signal crash) into a single
 * {@link MutationToolStartupError} carrying a clear, per-tool message and a
 * machine-readable {@link MutationToolStartupError.reason}.
 *
 * A deliberate CANCELLATION (`code === 'ABORTED'`) is explicitly NOT one of
 * them: it is rethrown untouched so `isCancel` still recognises it.
 *
 * Any other failure (in particular, a normal non-zero exit) is rethrown
 * untouched, so the engine can apply per-tool exit-code logic to the raw
 * {@link ExecFailureError}.
 *
 * Engines no longer need to repeat bootstrap-time error handling.
 */
export async function invokeMutationTool(
  tool: ExecutableTool,
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    executor?: ExecutionSession;
  } = {},
): Promise<ExecResult> {
  try {
    const { executor, ...execOptions } = options;
    return executor
      ? await executor.run(command, args, { ...execOptions, killTree: true })
      : await runShell(command, args, { ...execOptions, killTree: true });
  } catch (error: unknown) {
    if (!(error instanceof ExecFailureError)) {
      // Something unexpected (e.g. programmer error). Rethrow untouched.
      throw error;
    }

    // Cancellation FIRST — before every classification below.
    //
    // `classifyChildError` (utils/exec-error.ts) deliberately labels a
    // deliberate abort `code: 'ABORTED'` ahead of its own ENOENT/timeout/signal
    // branches, and documents that "callers key on `code === 'ABORTED'`"
    // (audit M5). This ladder then destroyed that marker: an aborted child is
    // killed by a signal, so it arrives with `signal` set and `exit === null`
    // and fell into the signal branch below, coming back out as
    // `MutationToolStartupError('<tool> crashed unexpectedly (signal SIGKILL)')`.
    //
    // Most call sites were accidentally rescued because `isCancel(error, ctx)`
    // short-circuits on `ctx.signal.aborted` — but `computeCount` in
    // estimate.ts has no request context, so a CANCELLED `estimate_audit` on a
    // .rs file came back as a successful heuristic estimate. Rethrow the
    // classified error untouched so the code (and `isCancel`) survive.
    if (error.code === 'ABORTED') throw error;

    if (error.code === 'ENOENT') {
      throw new MutationToolStartupError(
        tool,
        `${tool} is not installed. Install it with: ${INSTALL_HINTS[tool]}`,
        'NOT_INSTALLED',
      );
    }

    // The tool outran the output cap, so the captured stream is truncated.
    // This MUST fail the run rather than fall through: every engine's parser
    // reads that stream as a complete report, and a truncated one yields a
    // confident wrong score (cargo-mutants loses its authoritative summary
    // line and the text parser then reports 0%) instead of an error.
    if (error.code === 'OUTPUT_TRUNCATED') {
      throw new MutationToolStartupError(
        tool,
        `${tool} produced more output than Chaos-MCP can capture, so its results were truncated and cannot be scored. ` +
          `Narrow the run (lineScope/diffBase, or a smaller target file) and re-audit.`,
        'OUTPUT_TRUNCATED',
      );
    }

    if (error.code === 'TIMEOUT') {
      const ms = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      throw new MutationToolStartupError(
        tool,
        `${tool} timed out after ${ms}ms. Increase timeoutMs or narrow the target file.`,
        'TIMEOUT',
      );
    }

    if (error.signal && error.exit === null) {
      throw new MutationToolStartupError(
        tool,
        `${tool} crashed unexpectedly (signal ${error.signal}): ${error.stderr || error.message}`,
        'CRASHED',
      );
    }

    // Non-zero exit (or unmapped error) — rethrow so the engine's
    // per-tool catch block can decide what to do (parse stdout, throw
    // a baseline-failure error, etc.).
    throw error;
  }
}
