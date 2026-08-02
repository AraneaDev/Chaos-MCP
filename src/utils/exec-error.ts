/**
 * Child-process failure taxonomy.
 *
 * This module owns the SHAPE of a child-process result and the classification
 * ladder that turns a raw Node callback error into an {@link ExecFailureError}.
 * It deliberately knows nothing about spawning or killing processes — see
 * `exec.ts` (spawn) and `process-reaper.ts` (kill) — so the ladder can be unit
 * tested against synthetic error objects without starting a process.
 */

/**
 * Cap on captured stdout/stderr per child process.
 *
 * Node kills the child and errors when a stream exceeds this, handing the
 * callback the TRUNCATED output. Every caller here parses that output as a
 * mutation report, so a truncated stream must never be mistaken for a complete
 * one — see the `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` branches below.
 */
export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * Node's errno code when a child exceeds `maxBuffer`. It arrives as a
 * `RangeError` whose `code` is this STRING and whose `killed`/`signal` are
 * unset, so it falls through every numeric/signal branch and would otherwise be
 * reported as a plain "exited with code null" — with the truncated output
 * attached, ready to be parsed as if the run had completed.
 */
const MAXBUFFER_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

/**
 * Normalized result of a child process execution.
 * Either `exit` is set (process exited normally with a code) or `signal`
 * is set (process was killed by a signal such as SIGTERM/SIGSEGV).
 */
export interface ExecResult {
  /** Captured stdout as a UTF-8 string */
  stdout: string;
  /** Captured stderr as a UTF-8 string */
  stderr: string;
  /** Numeric exit code, or `null` when the process was killed by a signal */
  exit: number | null;
  /** Signal name (e.g. 'SIGTERM') when the process was killed, otherwise `null` */
  signal: NodeJS.Signals | null;
}

/**
 * Normalized error thrown when a child process fails to spawn (ENOENT) or
 * exits with a non-zero code / is killed by a signal.
 *
 * Non-zero exits are represented as a thrown {@link ExecFailureError} so
 * callers can distinguish "expected survivors" (non-zero) from genuine
 * crashes (signal) or missing-binary (code 'ENOENT') conditions.
 */
export class ExecFailureError extends Error {
  /** Same fields as {@link ExecResult}; populated for non-zero exits and signals */
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Node errno code — set to 'ENOENT' when the binary could not be found */
  readonly code: string | undefined;

  constructor(result: ExecResult & { code?: string }, message: string) {
    super(message);
    this.name = 'ExecFailureError';
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.exit = result.exit;
    this.signal = result.signal;
    this.code = result.code;
  }
}

/**
 * The union of everything Node puts on a child-process callback error.
 *
 * `exec` and `execFile` disagree on the type of `code` (numeric exit code vs
 * string errno) and neither declares `killed`/`signal` on the same interface,
 * so the ladder below reads a widened structural shape and gates on `typeof`.
 * (C1 regression: prior versions read `err.status`, which is undefined on the
 * spawn-error object, causing every non-zero exit to be reported as exit=null.
 * Always read `err.code` and gate on its type.)
 */
type ChildProcessError = Error & {
  code?: number | string | null;
  killed?: boolean;
  signal?: NodeJS.Signals | string | null;
};

/** Everything the classifier needs to label a failure without seeing the child. */
export interface ChildErrorContext {
  /**
   * Human-readable subject of every message this classifier produces:
   * 'Command' for `runShell` (execFile), 'Shell command' for `runShellCommand`
   * (exec). These strings are user-facing and asserted in tests.
   */
  label: string;
  /** The command as the caller wrote it, echoed into every message. */
  command: string;
  /** Configured timeout, echoed into the TIMEOUT message. */
  timeoutMs: number;
  /** `signal?.aborted` at the moment the callback fired. */
  aborted: boolean;
  /**
   * Whether a string `code` of 'ENOENT' should be classified as a missing
   * binary. Only `execFile` reports a missing binary that way; `exec` runs
   * through a shell, which reports a missing command as exit code 127 — an
   * ENOENT from `exec` means the CWD did not exist, which has always fallen
   * through to the generic branch. Off by default so the shell path keeps its
   * exact historical message.
   */
  classifyEnoent?: boolean;
}

/**
 * Classify a raw child-process callback error into an {@link ExecFailureError}.
 *
 * THE ORDER OF THESE BRANCHES IS SAFETY-CRITICAL. It decides whether truncated
 * stdout reaches an engine that would parse it as a complete mutation report,
 * and whether a deliberate cancellation is reported as a tool failure. Three
 * separate audits (M5, L3, MAXBUFFER) landed here; do not reorder.
 *
 * Returns the error rather than throwing it so the caller keeps ownership of
 * process teardown (see {@link shouldKillTreeOnFailure}) and so the ladder is
 * testable against synthetic error objects.
 */
export function classifyChildError(
  err: Error,
  stdout: string,
  stderr: string,
  ctx: ChildErrorContext,
): ExecFailureError {
  const { label, command, timeoutMs, aborted, classifyEnoent = false } = ctx;
  const childErr = err as ChildProcessError;

  // `exit` = numeric code when the child exited with one; null when killed by a
  // signal OR when the spawn itself failed. `signal` = signal name when killed.
  const exitCode = typeof childErr.code === 'number' ? childErr.code : null;
  const procSignal =
    typeof childErr.signal === 'string' ? (childErr.signal as NodeJS.Signals) : null;

  const result: ExecResult = {
    stdout,
    stderr,
    exit: exitCode,
    signal: procSignal,
  };

  // Cancellation: an aborted child surfaces as an AbortError
  // (`code: 'ABORT_ERR'`), often with killed/signal unset. Classify it
  // explicitly and BEFORE the ENOENT/timeout/signal branches so a deliberate
  // cancel is never mislabelled a tool failure — callers key on
  // `code === 'ABORTED'` to report "Operation cancelled." (audit M5).
  if (childErr.code === 'ABORT_ERR' || childErr.name === 'AbortError' || aborted) {
    return new ExecFailureError(
      { ...result, code: 'ABORTED' },
      `${label} was cancelled: ${command}`,
    );
  }

  // Output overflow: the child wrote more than `maxBuffer`, so `stdout` here is
  // TRUNCATED. Must be classified before the generic non-zero branch so no
  // engine parses a partial mutation report as a complete one — the Rust text
  // parser in particular would lose the authoritative summary line and silently
  // report a 0% score.
  if (childErr.code === MAXBUFFER_CODE) {
    return new ExecFailureError(
      { ...result, code: 'OUTPUT_TRUNCATED' },
      `${label} produced more than ${MAX_OUTPUT_BYTES} bytes of output (truncated, so its results cannot be trusted): ${command}`,
    );
  }

  // ENOENT: binary not found — propagate with a clear code.
  if (classifyEnoent && childErr.code === 'ENOENT') {
    return new ExecFailureError({ ...result, code: 'ENOENT' }, `${label} not found: ${command}`);
  }

  // Timeout: Node internally calls child.kill() when the configured timeout
  // elapses, setting both signal='SIGTERM' AND killed=true. External kills (OOM
  // killer, parent process SIGTERM) typically have signal='SIGTERM' but
  // killed=false. Gating on `killed === true` distinguishes these so an
  // external resource crash isn't misreported as a tool timeout.
  // (Live-audit L3 fix.)
  if (childErr.killed === true && result.exit === null && result.signal) {
    return new ExecFailureError(
      { ...result, code: 'TIMEOUT' },
      `${label} timed out after ${timeoutMs}ms: ${command}`,
    );
  }

  // Non-zero exit or signal — surface as a recoverable failure with captured output.
  return new ExecFailureError(
    { ...result, code: String(result.exit ?? 'SIGNAL') },
    `${label} exited with ${result.signal ? `signal ${result.signal}` : `code ${result.exit}`}: ${command}`,
  );
}

/**
 * Whether a classified failure should be followed by a process-tree kill.
 *
 * Every branch of {@link classifyChildError} except ENOENT (where nothing was
 * ever spawned) tore the tree down; the generic branch only did so when the
 * child died on a signal. Derived from the classified error so the classifier
 * itself stays free of process handles.
 */
export function shouldKillTreeOnFailure(error: ExecFailureError): boolean {
  if (error.code === 'ENOENT') return false;
  if (error.code === 'ABORTED' || error.code === 'OUTPUT_TRUNCATED' || error.code === 'TIMEOUT') {
    return true;
  }
  return error.signal !== null;
}
