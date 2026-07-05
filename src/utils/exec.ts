import { execFile, exec } from 'child_process';
import { log, isVerbose } from './logger.js';
import { DEFAULT_TIMEOUT_MS } from './constants.js';

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
 * Run a shell command string (e.g. "npm run build", "go build ./...") inside
 * a child process with `shell: true`, capturing stdout and stderr.
 *
 * This is the shell-mode counterpart of {@link runShell}, which uses `execFile`
 * with an explicit argument array (no shell interpolation). Use this when the
 * command needs shell features like glob expansion, pipes, or PATH resolution.
 *
 * Resolves with an {@link ExecResult} when the shell exits with code 0.
 * Rejects with an {@link ExecFailureError} when the shell exits non-zero,
 * is killed by a signal, or times out.
 *
 * @param command - Full shell command string (e.g. "npm run build").
 * @param options - cwd and timeoutMs.
 */
export function runShellCommand(
  command: string,
  options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  const { cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;

  if (isVerbose()) {
    log(`exec-shell: ${command}  (cwd=${cwd}, timeout=${timeoutMs}ms)`);
  }

  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd,
        timeout: timeoutMs,
        signal,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10 MB stdout/stderr cap
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const stdoutStr = stdout ?? '';
        const stderrStr = stderr ?? '';

        if (err) {
          // child_process.exec error shape: code (number|null), killed (boolean),
          // signal (string|null). Unlike execFile, `code` is always the numeric
          // exit code on non-zero exit (never 'ENOENT' — that surfaces as a
          // thrown error before the callback).
          const execErr = err as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: NodeJS.Signals | string;
          };

          const exitCode = typeof execErr.code === 'number' ? execErr.code : null;
          const procSignal =
            typeof execErr.signal === 'string' ? (execErr.signal as NodeJS.Signals) : null;

          const result: ExecResult = {
            stdout: stdoutStr,
            stderr: stderrStr,
            exit: exitCode,
            signal: procSignal,
          };

          // Cancellation: an aborted child surfaces as an AbortError
          // (`code: 'ABORT_ERR'`), often with killed/signal unset. Classify it
          // explicitly and BEFORE the timeout/signal branches so a deliberate
          // cancel is never mislabelled a tool failure — callers key on
          // `code === 'ABORTED'` to report "Operation cancelled." (audit M5).
          if (execErr.code === 'ABORT_ERR' || execErr.name === 'AbortError' || signal?.aborted) {
            reject(
              new ExecFailureError(
                { ...result, code: 'ABORTED' },
                `Shell command was cancelled: ${command}`,
              ),
            );
            return;
          }

          // Timeout detection: Node sets killed=true + signal when the timeout
          // elapses. Gating on `killed === true` (not just `signal`) distinguishes
          // internal timeouts from external kills (OOM, SIGTERM from parent).
          if (execErr.killed === true && result.exit === null && result.signal) {
            reject(
              new ExecFailureError(
                { ...result, code: 'TIMEOUT' },
                `Shell command timed out after ${timeoutMs}ms: ${command}`,
              ),
            );
            return;
          }

          // Non-zero exit — surface with captured output.
          reject(
            new ExecFailureError(
              { ...result, code: String(result.exit ?? 'SIGNAL') },
              `Shell command exited with ${result.signal ? `signal ${result.signal}` : `code ${result.exit}`}: ${command}`,
            ),
          );
          return;
        }

        resolve({ stdout: stdoutStr, stderr: stderrStr, exit: 0, signal: null });
      },
    );
  });
}

/**
 * Run a child process asynchronously, capturing stdout and stderr.
 *
 * Resolves with an {@link ExecResult} when the process exits with code 0.
 * Rejects with an {@link ExecFailureError} when:
 *  - the binary cannot be found (ENOENT) — `error.code === 'ENOENT'`
 *  - the process is killed by a signal — `error.signal` is set
 *  - the process exits with a non-zero code — `error.exit` is set
 *
 * On non-zero exits the captured stdout/stderr are available on the error
 * so callers can still parse partial output (e.g. mutation reports).
 *
 * @param command - Executable to run (no shell, no shell interpolation).
 * @param args - Argument list, passed verbatim to the child (no shell quoting needed).
 * @param options - cwd, timeoutMs, and an optional env.
 */
export function runShell(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  const { cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS, env, signal } = options;

  if (isVerbose()) {
    log(`exec: ${command} ${args.join(' ')}  (cwd=${cwd}, timeout=${timeoutMs}ms)`);
  }

  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        timeout: timeoutMs,
        env,
        signal,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10 MB stdout/stderr cap
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const stdoutStr = stdout ?? '';
        const stderrStr = stderr ?? '';

        if (err) {
          // Node's child_process.spawn error object has additional fields beyond
          // ErrnoException (which only declares `errno`, `code`, `path`, `syscall`).
          // Cast to the full child-process error shape so we can read `signal`.
          const errnoError = err as NodeJS.ErrnoException & {
            signal?: NodeJS.Signals;
            killed?: boolean;
          };

          // Node's child_process.execFile callback sets the following on the
          // error object:
          //   - `err.code`:  numeric exit code on a non-zero exit,
          //                  string errno (e.g. 'ENOENT') when spawn fails,
          //                  signal name (e.g. 'SIGTERM') when killed,
          //                  or undefined on success.
          //   - `err.signal`: signal name (e.g. 'SIGTERM') when killed.
          //
          // We classify the result into ExecResult:
          //   - `exit` = numeric code when the child exited with one,
          //   - `exit` = null when killed by signal OR spawn failure.
          //   - `signal` = signal name when killed, otherwise null.
          //
          // (C1 regression: prior versions read `err.status` which is undefined
          // on the spawn-error object, causing every non-zero exit to be
          // reported as exit=null. Always read `err.code` and gate on its type.)
          const exitCode = typeof errnoError.code === 'number' ? errnoError.code : null;
          const procSignal =
            typeof errnoError.signal === 'string' ? (errnoError.signal as NodeJS.Signals) : null;

          const result: ExecResult = {
            stdout: stdoutStr,
            stderr: stderrStr,
            exit: exitCode,
            signal: procSignal,
          };

          // Cancellation: an aborted child surfaces as an AbortError
          // (`code: 'ABORT_ERR'`), often with killed/signal unset. Classify it
          // explicitly and BEFORE the ENOENT/timeout/signal branches so a
          // deliberate cancel is never mislabelled a tool failure — callers key
          // on `code === 'ABORTED'` to report "Operation cancelled." (audit M5).
          if (
            errnoError.code === 'ABORT_ERR' ||
            errnoError.name === 'AbortError' ||
            signal?.aborted
          ) {
            reject(
              new ExecFailureError(
                { ...result, code: 'ABORTED' },
                `Command was cancelled: ${command}`,
              ),
            );
            return;
          }

          // ENOENT: binary not found — propagate with a clear code.
          if (errnoError.code === 'ENOENT') {
            reject(
              new ExecFailureError({ ...result, code: 'ENOENT' }, `Command not found: ${command}`),
            );
            return;
          }

          // Timeout: execFile internally calls child.kill() when the configured
          // timeout elapses, setting both signal='SIGTERM' AND killed=true.
          // External kills (OOM killer, parent process SIGTERM) typically have
          // signal='SIGTERM' but killed=false. Gating on `killed === true`
          // distinguishes these so an external resource crash isn't misreported
          // as a tool timeout. (Live-audit L3 fix.)
          if (errnoError.killed === true && result.exit === null && result.signal) {
            reject(
              new ExecFailureError(
                { ...result, code: 'TIMEOUT' },
                `Command timed out after ${timeoutMs}ms: ${command}`,
              ),
            );
            return;
          }

          // Non-zero exit or signal — surface as a recoverable failure with captured output.
          reject(
            new ExecFailureError(
              { ...result, code: String(result.exit ?? 'SIGNAL') },
              `Command exited with ${result.signal ? `signal ${result.signal}` : `code ${result.exit}`}: ${command}`,
            ),
          );
          return;
        }

        resolve({ stdout: stdoutStr, stderr: stderrStr, exit: 0, signal: null });
      },
    );
  });
}
