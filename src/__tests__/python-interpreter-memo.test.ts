import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The per-instance interpreter probe.
 *
 * `probePythonInterpreter` shells out to find a usable Python, and the engine
 * memoizes the answer so a run does not pay for it repeatedly. Nothing but the
 * CALL COUNT can observe that: the probe is deterministic for a fixed
 * environment, so re-running it returns the same interpreter and every visible
 * output is identical. The count is therefore what this asserts — the same
 * shape as the suppressions-memo tests in `audit-one-suppression-cache.test.ts`.
 *
 * Lives in its own file because it mocks the interpreter module, and
 * `python-engine.test.ts` deliberately exercises the real probe.
 */

vi.mock('../utils/exec.js', () => ({ runShell: vi.fn() }));
vi.mock('../utils/logger.js', () => ({ log: vi.fn(), isVerbose: vi.fn(() => false) }));
vi.mock('node:fs', () => ({ writeFileSync: vi.fn() }));

const probe = vi.hoisted(() => vi.fn(() => '/usr/bin/python3'));
vi.mock('../engines/python/interpreter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engines/python/interpreter.js')>()),
  probePythonInterpreter: probe,
}));

import { writeFileSync } from 'node:fs';
import { runShell } from '../utils/exec.js';
import { ExecFailureError } from '../utils/exec-error.js';
import { PythonEngine } from '../engines/python.js';

const mockRunShell = vi.mocked(runShell);
const mockWriteFileSync = vi.mocked(writeFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  probe.mockReturnValue('/usr/bin/python3');
  // The runs below only need to REACH the probe; how they end is irrelevant.
  mockRunShell.mockRejectedValue(
    new ExecFailureError({ stdout: '', stderr: 'nope', exit: 1, signal: null }, 'nope'),
  );
});

describe('PythonEngine interpreter probe', () => {
  it('probes once per engine instance, not once per run', async () => {
    const engine = new PythonEngine();

    await engine.run('a.py', { workDir: '/tmp/sandbox' }).catch(() => undefined);
    await engine.run('b.py', { workDir: '/tmp/sandbox' }).catch(() => undefined);

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('probes again for a FRESH engine, so the memo is per instance', async () => {
    // The cache is deliberately instance-scoped: a long-lived server auditing
    // several workspaces must not pin the first workspace's interpreter for the
    // life of the process.
    await new PythonEngine().run('a.py', { workDir: '/tmp/sandbox' }).catch(() => undefined);
    await new PythonEngine().run('b.py', { workDir: '/tmp/sandbox' }).catch(() => undefined);

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('falls back to python3 when the probe finds nothing', async () => {
    probe.mockReturnValue(undefined as unknown as string);
    const engine = new PythonEngine();

    await engine.run('a.py', { workDir: '/tmp/sandbox' }).catch(() => undefined);

    // The interpreter is not spawned directly — it is written into the
    // generated cosmic-ray config as the test command's first token, which is
    // where a missing fallback would surface as `undefined ...`.
    const config = String(mockWriteFileSync.mock.calls[0]?.[1] ?? '');
    expect(config).toContain('python3');
    expect(config).not.toContain('undefined');
  });
});
