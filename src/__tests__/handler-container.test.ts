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

vi.mock('../test-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../test-file.js')>();
  return {
    ...actual,
    workspaceHasPythonTests: vi.fn(() => ({ found: true, depthLimited: false })),
    findPythonTestSelection: vi.fn(() => []),
  };
});

import { auditFile } from '../handler.js';
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
        container,
        undefined,
      );
      expect(run).toHaveBeenCalledWith(file, expect.objectContaining({ executor: session }));
      expect(session.dispose).toHaveBeenCalledOnce();
    },
  );

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
