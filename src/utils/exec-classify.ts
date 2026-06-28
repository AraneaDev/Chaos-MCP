import { ExecResult, ExecFailureError, runShell } from './exec.js';

/**
 * The mutation tools Chaos-MCP can invoke. Each tool name maps to a CLI
 * install hint surfaced when the binary is missing. Names match the
 * user-facing labels used in docs (e.g. StrykerJS — not `stryker`).
 */
export type ExecutableTool = 'StrykerJS' | 'mutmut' | 'go-mutesting' | 'cargo-mutants';

/**
 * Typed error thrown by {@link invokeMutationTool} when the mutation tool
 * has a startup-class failure that the engine cannot recover from:
 *
 *   - binary missing on PATH (ENOENT)
 *   - process timed out (TIMEOUT)
 *   - process crashed unexpectedly with a signal (e.g. SIGSEGV)
 *
 * Engines that use {@link invokeMutationTool} should treat catching this
 * error as "fail fast" and surface the message to the caller verbatim.
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
  ) {
    super(message);
    this.name = 'MutationToolStartupError';
  }
}

const INSTALL_HINTS: Record<ExecutableTool, string> = {
  StrykerJS: 'npm install --save-dev @stryker-mutator/core',
  mutmut: 'pip install mutmut',
  'go-mutesting': 'go install github.com/zimmski/go-mutesting/cmd/go-mutesting@latest',
  'cargo-mutants': 'cargo install cargo-mutants',
};

/**
 * Wraps {@link runShell} and normalises the three startup-class failures
 * (ENOENT, TIMEOUT, signal crash) into a single {@link MutationToolStartupError}
 * with a clear, per-tool install hint.
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
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  try {
    return await runShell(command, args, options);
  } catch (error: unknown) {
    if (!(error instanceof ExecFailureError)) {
      // Something unexpected (e.g. programmer error). Rethrow untouched.
      throw error;
    }

    if (error.code === 'ENOENT') {
      throw new MutationToolStartupError(
        tool,
        `${tool} is not installed. Install it with: ${INSTALL_HINTS[tool]}`,
      );
    }

    if (error.code === 'TIMEOUT') {
      const ms = options.timeoutMs ?? 300_000;
      throw new MutationToolStartupError(
        tool,
        `${tool} timed out after ${ms}ms. Increase timeoutMs or narrow the target file.`,
      );
    }

    if (error.signal && error.exit === null) {
      throw new MutationToolStartupError(
        tool,
        `${tool} crashed unexpectedly (signal ${error.signal}): ${error.stderr || error.message}`,
      );
    }

    // Non-zero exit (or unmapped error) — rethrow so the engine's
    // per-tool catch block can decide what to do (parse stdout, throw
    // a baseline-failure error, etc.).
    throw error;
  }
}
