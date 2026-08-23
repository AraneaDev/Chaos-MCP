import { describe, it, expect } from 'vitest';
import {
  classifyChildError,
  shouldKillTreeOnFailure,
  MAX_OUTPUT_BYTES,
  type ChildErrorContext,
} from '../utils/exec-error.js';

/**
 * Direct unit tests for the child-process failure taxonomy.
 *
 * The ladder used to live twice inside the two Promise executors in `exec.ts`,
 * where it could only be reached by spawning a process. Now that it returns the
 * error instead of rejecting, every branch — and, critically, the ORDER of the
 * branches — can be pinned against synthetic error objects.
 *
 * The order is what keeps a truncated stdout from being handed to an engine as
 * a complete mutation report, and a deliberate cancellation from being reported
 * as a tool failure.
 */

/** A raw Node child-process callback error, built field by field. */
function childError(fields: {
  message?: string;
  name?: string;
  code?: number | string;
  killed?: boolean;
  signal?: string;
}): Error {
  const err = new Error(fields.message ?? 'child failed');
  if (fields.name !== undefined) err.name = fields.name;
  return Object.assign(err, {
    ...(fields.code !== undefined ? { code: fields.code } : {}),
    ...(fields.killed !== undefined ? { killed: fields.killed } : {}),
    ...(fields.signal !== undefined ? { signal: fields.signal } : {}),
  });
}

const execFileCtx = (over: Partial<ChildErrorContext> = {}): ChildErrorContext => ({
  label: 'Command',
  command: 'stryker',
  timeoutMs: 1234,
  aborted: false,
  classifyEnoent: true,
  ...over,
});

const shellCtx = (over: Partial<ChildErrorContext> = {}): ChildErrorContext => ({
  label: 'Shell command',
  command: 'npm run build',
  timeoutMs: 1234,
  aborted: false,
  classifyEnoent: false,
  ...over,
});

describe('classifyChildError', () => {
  it('does NOT classify ENOENT specially when classifyEnoent is omitted', () => {
    // Every other case in this file passes `classifyEnoent` explicitly, so the
    // DEFAULT was never exercised. The mutation sweep reported it as having no
    // coverage at all. The default is `false` on purpose: through a shell, an
    // ENOENT is the SHELL reporting that something inside the command line is
    // missing, not that the command itself could not be spawned, so reporting
    // "not found: <command>" would name the wrong thing.
    const ctx = {
      label: 'Shell command',
      command: 'npm run build',
      timeoutMs: 1234,
      aborted: false,
    } as ChildErrorContext;

    const failure = classifyChildError(childError({ code: 'ENOENT' }), '', '', ctx);

    expect(failure.code).not.toBe('ENOENT');
    expect(failure.message).not.toContain('not found');
  });

  it('classifies ABORT_ERR as ABORTED', () => {
    const failure = classifyChildError(childError({ code: 'ABORT_ERR' }), '', '', execFileCtx());
    expect(failure.code).toBe('ABORTED');
    expect(failure.message).toBe('Command was cancelled: stryker');
  });

  it('classifies an AbortError by name as ABORTED', () => {
    const failure = classifyChildError(
      childError({ name: 'AbortError' }),
      '',
      '',
      shellCtx({ command: 'sleep 10' }),
    );
    expect(failure.code).toBe('ABORTED');
    expect(failure.message).toBe('Shell command was cancelled: sleep 10');
  });

  it('classifies an already-aborted signal as ABORTED even when the error looks like a timeout', () => {
    // Precedence guard (audit M5): a cancel that reaches the child as SIGTERM
    // must not be reported as a tool timeout.
    const failure = classifyChildError(
      childError({ killed: true, signal: 'SIGTERM' }),
      '',
      '',
      execFileCtx({ aborted: true }),
    );
    expect(failure.code).toBe('ABORTED');
  });

  it('classifies a maxBuffer overflow as OUTPUT_TRUNCATED and keeps the partial output', () => {
    const failure = classifyChildError(
      childError({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
      'partial report',
      '',
      execFileCtx(),
    );
    expect(failure.code).toBe('OUTPUT_TRUNCATED');
    expect(failure.stdout).toBe('partial report');
    expect(failure.message).toBe(
      `Command produced more than ${MAX_OUTPUT_BYTES} bytes of output (truncated, so its results cannot be trusted): stryker`,
    );
  });

  it('classifies a string ENOENT as a missing binary when the caller spawns directly', () => {
    const failure = classifyChildError(
      childError({ code: 'ENOENT' }),
      '',
      '',
      execFileCtx({ command: 'ghost-bin' }),
    );
    expect(failure.code).toBe('ENOENT');
    expect(failure.exit).toBeNull();
    expect(failure.message).toBe('Command not found: ghost-bin');
  });

  it('leaves ENOENT to the generic branch for the shell path', () => {
    // `exec` reports a missing command as exit code 127; an ENOENT from it means
    // the CWD was gone, which has always been reported generically.
    const failure = classifyChildError(childError({ code: 'ENOENT' }), '', '', shellCtx());
    expect(failure.code).toBe('SIGNAL');
    expect(failure.message).toBe('Shell command exited with code null: npm run build');
  });

  it('classifies killed + signal + no exit code as TIMEOUT', () => {
    const failure = classifyChildError(
      childError({ killed: true, signal: 'SIGTERM' }),
      '',
      '',
      execFileCtx({ command: 'slow' }),
    );
    expect(failure.code).toBe('TIMEOUT');
    expect(failure.message).toBe('Command timed out after 1234ms: slow');
  });

  it('does not call an external kill a timeout (killed=false)', () => {
    // Live-audit L3: an OOM kill has signal=SIGTERM but killed=false.
    const failure = classifyChildError(
      childError({ killed: false, signal: 'SIGTERM' }),
      '',
      '',
      execFileCtx({ command: 'node' }),
    );
    expect(failure.code).toBe('SIGNAL');
    expect(failure.signal).toBe('SIGTERM');
    expect(failure.message).toBe('Command exited with signal SIGTERM: node');
  });

  it('reads a numeric code as the exit code', () => {
    const failure = classifyChildError(
      childError({ code: 7 }),
      'out',
      'err',
      execFileCtx({ command: 'node' }),
    );
    expect(failure.exit).toBe(7);
    expect(failure.code).toBe('7');
    expect(failure.stdout).toBe('out');
    expect(failure.stderr).toBe('err');
    expect(failure.message).toBe('Command exited with code 7: node');
  });
});

describe('shouldKillTreeOnFailure', () => {
  it('tears the tree down for ABORTED, OUTPUT_TRUNCATED and TIMEOUT', () => {
    const codes = [
      classifyChildError(childError({ code: 'ABORT_ERR' }), '', '', execFileCtx()),
      classifyChildError(
        childError({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
        '',
        '',
        execFileCtx(),
      ),
      classifyChildError(childError({ killed: true, signal: 'SIGTERM' }), '', '', execFileCtx()),
    ];
    expect(codes.map(shouldKillTreeOnFailure)).toEqual([true, true, true]);
  });

  it('leaves a missing binary alone — nothing was ever spawned', () => {
    const failure = classifyChildError(childError({ code: 'ENOENT' }), '', '', execFileCtx());
    expect(shouldKillTreeOnFailure(failure)).toBe(false);
  });

  it('tears the tree down on a generic signal death but not on a plain non-zero exit', () => {
    const signalled = classifyChildError(
      childError({ killed: false, signal: 'SIGSEGV' }),
      '',
      '',
      execFileCtx(),
    );
    const nonZero = classifyChildError(childError({ code: 2 }), '', '', execFileCtx());
    expect(shouldKillTreeOnFailure(signalled)).toBe(true);
    expect(shouldKillTreeOnFailure(nonZero)).toBe(false);
  });
});
