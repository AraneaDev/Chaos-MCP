// @momus-ignore-file:MOCK-001
// `auditFile`'s container path is pure wiring: the assertions are about the arguments it hands
// `createExecutionSession` and the engine, and about disposing the session on both the success
// and the failure path. Running a real container session here would trade that precision for a
// slow test that cannot pin the argument contract.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseEngine, MutationResult } from '../engines/base.js';
import type { ExecutionSession } from '../utils/execution.js';

vi.mock('../utils/execution.js', () => ({
  createExecutionSession: vi.fn(),
}));

vi.mock('../utils/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/exec.js')>();
  return { ...actual, runShellCommand: vi.fn() };
});

vi.mock('../core/test-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/test-file.js')>();
  return {
    ...actual,
    workspaceHasPythonTests: vi.fn(() => ({ found: true, depthLimited: false })),
    findPythonTestSelection: vi.fn(() => []),
  };
});

import { auditFile } from '../audit/audit-file.js';
import { createExecutionSession } from '../utils/execution.js';
import { runShellCommand } from '../utils/exec.js';

const result: MutationResult = {
  target: 'src/app.ts',
  totalMutants: 0,
  killed: 0,
  survived: 0,
  mutationScore: '100.00%',
  vulnerabilities: [],
};

function fakeSession(): ExecutionSession {
  return {
    kind: 'container',
    workDir: '/tmp/sandbox',
    run: vi.fn(),
    runCommand: vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '',
      exit: 0,
      signal: null,
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

describe('auditFile container execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['typescript', 'src/app.ts'],
    ['python', 'src/app.py'],
    ['rust', 'src/lib.rs'],
    ['php', 'src/App.php'],
  ] as const)(
    'wires the shared container session into the %s engine',
    async (projectType, file) => {
      const session = fakeSession();
      vi.mocked(createExecutionSession).mockResolvedValue(session);
      const run = vi.fn().mockResolvedValue({ ...result, target: file });
      const engine = { run } as unknown as BaseEngine;
      const container = { mode: 'container' as const };

      await auditFile({
        targetFile: file,
        env: {
          projectType,
          testRunner: projectType === 'python' ? 'pytest' : 'command',
          detectedRunner: projectType === 'python' ? 'pytest' : 'unknown',
          packageManager: '',
          workspaceRoot: '/workspace',
        },
        projectType,
        engine,
        args: {},
        config: { container },
        workDir: '/tmp/sandbox',
        prebuildCmd: null,
      });

      expect(createExecutionSession).toHaveBeenCalledWith(
        projectType,
        '/tmp/sandbox',
        '/workspace',
        'link-entries',
        container,
        undefined,
      );
      expect(run).toHaveBeenCalledWith(file, expect.objectContaining({ executor: session }));
      expect(session.dispose).toHaveBeenCalledOnce();
    },
  );

  it('forwards config.sandbox.dependencies into createExecutionSession, not just createSandbox', async () => {
    // The container backend needs the SAME dependency mode the sandbox was
    // provisioned with — a mismatch here (e.g. sandbox 'copy' vs container
    // 'link-entries') would make dependencyMountArgs mount a host tree the
    // sandbox never symlinked to, or vice versa.
    const session = fakeSession();
    vi.mocked(createExecutionSession).mockResolvedValue(session);
    const engine = { run: vi.fn().mockResolvedValue(result) } as unknown as BaseEngine;

    await auditFile({
      targetFile: 'src/app.ts',
      env: {
        projectType: 'typescript',
        testRunner: 'command',
        detectedRunner: 'unknown',
        packageManager: '',
        workspaceRoot: '/my/workspace',
      },
      projectType: 'typescript',
      engine,
      args: {},
      config: { container: { mode: 'container' }, sandbox: { dependencies: 'copy' } },
      workDir: '/tmp/sandbox',
      prebuildCmd: null,
    });

    expect(createExecutionSession).toHaveBeenCalledWith(
      'typescript',
      '/tmp/sandbox',
      '/my/workspace',
      'copy',
      { mode: 'container' },
      undefined,
    );
  });

  it('runs prebuild in the container and disposes after engine failure', async () => {
    const session = fakeSession();
    vi.mocked(createExecutionSession).mockResolvedValue(session);
    const engine = {
      run: vi.fn().mockRejectedValue(new Error('engine failed')),
    } as unknown as BaseEngine;

    await expect(
      auditFile({
        targetFile: 'src/lib.rs',
        env: {
          projectType: 'rust',
          testRunner: 'cargo',
          detectedRunner: 'cargo',
          packageManager: 'cargo',
          workspaceRoot: '/workspace',
        },
        projectType: 'rust',
        engine,
        args: {},
        config: { container: { mode: 'container' } },
        workDir: '/tmp/sandbox',
        prebuildCmd: 'cargo check',
      }),
    ).rejects.toThrow('engine failed');

    expect(session.runCommand).toHaveBeenCalledWith(
      'cargo check',
      expect.objectContaining({ cwd: '/tmp/sandbox', killTree: true }),
    );
    expect(runShellCommand).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it.each([{}, { container: { mode: 'native' as const } }])(
    'preserves the native path when container execution is disabled',
    async (config) => {
      const engine = { run: vi.fn().mockResolvedValue(result) } as unknown as BaseEngine;

      await auditFile({
        targetFile: 'src/app.ts',
        env: {
          projectType: 'typescript',
          testRunner: 'command',
          detectedRunner: 'unknown',
          packageManager: 'npm',
          workspaceRoot: '/workspace',
        },
        projectType: 'typescript',
        engine,
        args: {},
        config,
        workDir: '/tmp/sandbox',
        prebuildCmd: null,
      });

      expect(createExecutionSession).not.toHaveBeenCalled();
      const options = vi.mocked(engine.run).mock.calls[0]?.[1];
      expect(options && Object.hasOwn(options, 'executor')).toBe(false);
    },
  );
});
