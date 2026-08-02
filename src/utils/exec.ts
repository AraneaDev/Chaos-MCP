import { execFile, exec, type ChildProcess } from 'child_process';
import { log, isVerbose } from './logger.js';
import { DEFAULT_TIMEOUT_MS } from './constants.js';
import { MAX_OUTPUT_BYTES, classifyChildError, shouldKillTreeOnFailure } from './exec-error.js';
import type { ExecResult } from './exec-error.js';
import {
  installProcessTreeCleanup,
  killProcessTree,
  trackProcessGroup,
  untrackProcessGroup,
} from './process-reaper.js';

/**
 * Spawning of child processes.
 *
 * Failure classification lives in `exec-error.ts` and process termination in
 * `process-reaper.ts`; this module only knows how to start a child and wire the
 * two together.
 */

/** The `(err, stdout, stderr)` shape both `exec` and `execFile` call back with. */
type ChildDoneCallback = (err: Error | null, stdout: string, stderr: string) => void;

/** Everything `runChild` needs that it cannot read off the child itself. */
interface RunChildOptions {
  /** Message subject: 'Command' (execFile) or 'Shell command' (exec). */
  label: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  killTree: boolean;
  /** See {@link classifyChildError} — only the execFile path reports ENOENT. */
  classifyEnoent: boolean;
}

/**
 * Own the lifetime of one child process: run it, classify any failure, and make
 * sure nothing it spawned outlives it.
 *
 * `spawnChild` is handed the completion callback and must return the started
 * child, so the two spawn front-ends below differ only in which Node API they
 * call and which options they pass.
 */
function runChild(
  spawnChild: (done: ChildDoneCallback) => ChildProcess,
  options: RunChildOptions,
): Promise<ExecResult> {
  const { label, command, cwd, timeoutMs, signal, killTree, classifyEnoent } = options;

  return new Promise((resolveResult, reject) => {
    const childRef: { current?: ChildProcess } = {};
    let completed = false;
    let stopTreeCleanup: () => void = () => undefined;
    childRef.current = spawnChild((err, stdout, stderr) => {
      completed = true;
      stopTreeCleanup();
      untrackProcessGroup(childRef.current);
      const stdoutStr = stdout ?? '';
      const stderrStr = stderr ?? '';

      if (err) {
        const failure = classifyChildError(err, stdoutStr, stderrStr, {
          label,
          command,
          timeoutMs,
          aborted: signal?.aborted === true,
          classifyEnoent,
        });
        // Kill BEFORE rejecting: the awaiting caller may tear the sandbox down
        // the moment it sees the rejection.
        if (shouldKillTreeOnFailure(failure)) killProcessTree(childRef.current, killTree);
        reject(failure);
        return;
      }

      resolveResult({ stdout: stdoutStr, stderr: stderrStr, exit: 0, signal: null });
    });
    if (!completed) {
      // `killTree` is the caller asking for tree semantics; see
      // ACTIVE_PROCESS_GROUPS in process-reaper.ts for why grandchildren need
      // this at all.
      //
      // Tracked on EVERY platform. This used to be gated on
      // `platform !== 'win32'` by analogy with the `detached` option below —
      // but `detached` is a spawn flag (on Windows it opens a new console),
      // whereas tracking is just a registry entry. Gating it left the registry
      // permanently empty on Windows, so sandbox teardown's "kill first, delete
      // second" invariant and the shutdown-time sweep both reaped nothing there.
      // `killGroup` reaps Windows pids with `taskkill /T`.
      if (killTree) trackProcessGroup(childRef.current, cwd);
      stopTreeCleanup = installProcessTreeCleanup(childRef.current, killTree, timeoutMs, signal);
    }
  });
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
  options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; killTree?: boolean } = {},
): Promise<ExecResult> {
  const { cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS, signal, killTree = false } = options;

  if (isVerbose()) {
    log(`exec-shell: ${command}  (cwd=${cwd}, timeout=${timeoutMs}ms)`);
  }

  return runChild(
    (done) =>
      exec(
        command,
        {
          cwd,
          timeout: timeoutMs,
          signal,
          encoding: 'utf-8',
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          ...(killTree && process.platform !== 'win32' ? { detached: true } : {}),
        },
        (err, stdout, stderr) => done(err, stdout, stderr),
      ),
    {
      label: 'Shell command',
      command,
      cwd,
      timeoutMs,
      signal,
      killTree,
      // child_process.exec error shape: code (number|null), killed (boolean),
      // signal (string|null). Unlike execFile, `code` is the numeric exit code
      // on a non-zero exit; a missing command comes back through the shell as
      // exit code 127, never as ENOENT.
      classifyEnoent: false,
    },
  );
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
  options: {
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    killTree?: boolean;
  } = {},
): Promise<ExecResult> {
  const {
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env,
    signal,
    killTree = false,
  } = options;

  if (isVerbose()) {
    log(`exec: ${command} ${args.join(' ')}  (cwd=${cwd}, timeout=${timeoutMs}ms)`);
  }

  return runChild(
    (done) =>
      execFile(
        command,
        args,
        {
          cwd,
          timeout: timeoutMs,
          env,
          signal,
          encoding: 'utf-8',
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          ...(killTree && process.platform !== 'win32' ? { detached: true } : {}),
        },
        (err, stdout, stderr) => done(err, stdout, stderr),
      ),
    {
      label: 'Command',
      command,
      cwd,
      timeoutMs,
      signal,
      killTree,
      // execFile spawns the binary directly, so a missing binary arrives as a
      // string errno of 'ENOENT' on the callback error.
      classifyEnoent: true,
    },
  );
}
