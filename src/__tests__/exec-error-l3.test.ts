import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as cpType from 'child_process';

/**
 * `vi.mock` factories are hoisted ABOVE top-level declarations, so any
 * module-scope variable the factory wants to write into must itself be
 * hoisted via `vi.hoisted()`. Otherwise the factory runs while the `let`
 * is in the temporal dead zone and throws "Cannot access X before
 * initialization".
 *
 * `realExecFile` is the underlying real execFile captured BEFORE the
 * vi.mock swap; we re-delegate to it in `beforeEach` so the positive-arm
 * test still spawns a real Node child.
 */
const hoistedRefs = vi.hoisted(() => ({
  realExecFile: null as typeof cpType.execFile | null,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof cpType>();
  hoistedRefs.realExecFile = actual.execFile;
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
  };
});

import { execFile } from 'child_process';
import { runShell, ExecFailureError } from '../utils/exec.js';

/** Same shape as the helper in `exec-error.test.ts`. */
async function expectRejection(fn: () => Promise<unknown>): Promise<ExecFailureError> {
  try {
    await fn();
  } catch (err: unknown) {
    if (err instanceof ExecFailureError) return err;
    throw err;
  }
  throw new Error('expected runShell() to reject, but it resolved');
}

/**
 * Live-audit L3 (`LIVE-AUDIT.md`):
 *   - The pre-fix wrapper classified ANY `signal='SIGTERM' + exit=null` as
 *     TIMEOUT, including external kills (OOM, parent SIGTERM) which have
 *     `killed=false`.
 *   - The fix gates TIMEOUT classification on `killed === true` (set by
 *     execFile's internal child.kill() call when its configured timeout
 *     elapses, NOT set for OS-level external kills).
 *
 * Both arms live here because the wrapper's only consumer is `runShell` —
 * we can't reach `errnoError.killed` from outside without mocking the
 * child_process module entirely. Spy-based approaches (`vi.spyOn`)
 * don't work on ESM module exports ("namespace not configurable"),
 * so vi.mock with vi.importActual is the canonical workaround.
 */
describe('Live-audit L3: runShell TIMEOUT classification', () => {
  beforeEach(() => {
    // mockReset clears any per-test implementation overrides; re-establish
    // the default delegation to the real execFile so the positive arm still
    // spawns an actual Node child.
    vi.mocked(execFile).mockReset();
    const ref = hoistedRefs.realExecFile;
    if (!ref) {
      throw new Error(
        'exec-error-l3 test setup error: vi.mock factory did not capture the real execFile',
      );
    }
    vi.mocked(execFile).mockImplementation(ref);
  });

  it('positive arm: a configured-timeout end is classified as code=TIMEOUT', async () => {
    // Real execFile (delegated) spawns a Node child that runs for 60s.
    // timeoutMs: 200 forces execFile to call child.kill() internally,
    // so the resulting error has killed=true AND signal='SIGTERM'.
    const caught = await expectRejection(() =>
      runShell('node', ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 200 }),
    );
    expect(caught.code).toBe('TIMEOUT');
    expect(caught.exit).toBeNull();
    expect(caught.signal).toBe('SIGTERM');
  });

  it('negative arm: an external SIGTERM (killed=false) is NOT classified as TIMEOUT', async () => {
    // Override the mock for one invocation. We mimic what Node's execFile
    // callback receives for an OS-level kill (OOM killer, parent SIGTERM):
    //   - err.signal = 'SIGTERM'
    //   - err.killed = false  ← decisive signal that is NOT a wrapper timeout
    //   - err.code = null (no numeric exit code)
    // The wrapper's TIMEOUT gate (killed === true && exit === null && signal)
    // does NOT fire, so the error falls through to the signal-crash branch
    // with code = String('SIGNAL').
    vi.mocked(execFile).mockImplementationOnce(((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const err = Object.assign(new Error('Child killed externally'), {
        code: null,
        signal: 'SIGTERM' as NodeJS.Signals,
        killed: false,
      });
      setImmediate(() => cb(err, '', ''));
      // Return a placeholder ChildProcess; the callback form doesn't require
      // the return value to be consumed by the wrapper.
      return {} as cpType.ChildProcess;
    }) as never);

    const caught = await expectRejection(() =>
      runShell('node', ['-e', 'process.exit(0)']),
    );
    expect(caught.code).not.toBe('TIMEOUT');
    expect(caught.signal).toBe('SIGTERM');
    // And not an empty/numeric exit either \u2014 fall-through to signal-crash
    expect(caught.exit).toBeNull();
  });
});
