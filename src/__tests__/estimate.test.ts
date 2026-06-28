import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/exec-classify.js', () => ({
  invokeMutationTool: vi.fn(),
  MutationToolStartupError: class extends Error {},
}));

vi.mock('../utils/exec.js', () => ({
  runShell: vi.fn(),
}));

import { invokeMutationTool, MutationToolStartupError } from '../utils/exec-classify.js';
import { runShell } from '../utils/exec.js';
import { estimateAudit, estimateNeedsSandbox } from '../estimate.js';
import type { EnvironmentInfo } from '../utils/project-detector.js';

const mockInvoke = vi.mocked(invokeMutationTool);
const mockRunShell = vi.mocked(runShell);

const baseEnv = (): EnvironmentInfo => ({
  projectType: 'typescript',
  testRunner: 'vitest',
  detectedRunner: 'npm',
  packageManager: 'npm',
  workspaceRoot: '/ws',
});

describe('estimateNeedsSandbox', () => {
  it('needs a sandbox for rust or when timing', () => {
    expect(estimateNeedsSandbox('rust', false)).toBe(true);
    expect(estimateNeedsSandbox('typescript', true)).toBe(true);
    expect(estimateNeedsSandbox('typescript', false)).toBe(false);
    expect(estimateNeedsSandbox('go', false)).toBe(false);
  });
});

describe('estimateAudit', () => {
  it('uses the heuristic for typescript (approx)', async () => {
    const r = await estimateAudit({
      absFile: __filename, // this test file — has plenty of constructs
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
    });
    expect(r.fidelity).toBe('approx');
    expect(r.language).toBe('typescript');
    expect(r.mutants).toBeGreaterThan(0);
    expect(r.basis).toMatch(/heuristic/);
  });

  it('uses cargo-mutants --list for rust (exact)', async () => {
    mockInvoke.mockResolvedValueOnce({
      stdout: 'src/lib.rs:1:1: replace foo -> bar\nsrc/lib.rs:2:3: replace a + b with a - b\n',
      stderr: '',
    } as never);
    const r = await estimateAudit({
      absFile: '/ws/src/lib.rs',
      relFile: 'src/lib.rs',
      projectType: 'rust',
      workDir: '/sandbox',
    });
    expect(r.fidelity).toBe('exact');
    expect(r.mutants).toBe(2);
    expect(r.basis).toMatch(/cargo-mutants/);
  });

  it('falls back to heuristic when cargo-mutants is missing', async () => {
    // Real constructor: (tool: ExecutableTool, message: string)
    mockInvoke.mockRejectedValueOnce(
      new MutationToolStartupError('cargo-mutants' as never, 'cargo-mutants not found'),
    );
    const r = await estimateAudit({
      absFile: __filename,
      relFile: 'src/x.rs',
      projectType: 'rust',
      workDir: '/sandbox',
    });
    expect(r.fidelity).toBe('approx');
    expect(r.basis).toMatch(/not installed|heuristic/);
  });

  it('falls back to heuristic when rust has no workDir (defensive path)', async () => {
    const r = await estimateAudit({
      absFile: __filename,
      relFile: 'src/x.rs',
      projectType: 'rust',
      // no workDir
    });
    expect(r.fidelity).toBe('approx');
    expect(r.basis).toContain('no sandbox');
  });

  it('rethrows non-startup errors from invokeMutationTool', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('boom'));
    await expect(
      estimateAudit({
        absFile: __filename,
        relFile: 'src/x.rs',
        projectType: 'rust',
        workDir: '/sandbox',
      }),
    ).rejects.toThrow('boom');
  });

  it('excludes summary lines when counting cargo-mutants output (Fix 1)', async () => {
    mockInvoke.mockResolvedValueOnce({
      stdout:
        'src/lib.rs:1:1: replace foo -> bar\nsrc/lib.rs:2:3: replace a + b with a - b\nFound 2 mutants in 1 file.\n',
      stderr: '',
    } as never);
    const r = await estimateAudit({
      absFile: '/ws/src/lib.rs',
      relFile: 'src/lib.rs',
      projectType: 'rust',
      workDir: '/sandbox',
    });
    expect(r.fidelity).toBe('exact');
    expect(r.mutants).toBe(2);
  });

  it('falls back to all non-empty lines when no :n:n: entries match', async () => {
    mockInvoke.mockResolvedValueOnce({
      stdout: 'some line\nanother line\n',
      stderr: '',
    } as never);
    const r = await estimateAudit({
      absFile: '/ws/src/lib.rs',
      relFile: 'src/lib.rs',
      projectType: 'rust',
      workDir: '/sandbox',
    });
    expect(r.fidelity).toBe('exact');
    expect(r.mutants).toBe(2);
  });
});

describe('estimateAudit withTiming', () => {
  it('runs baseline and sets estimatedMs + concurrency when withTiming=true', async () => {
    mockRunShell.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exit: 0,
      signal: null,
    } as never);

    const r = await estimateAudit({
      absFile: __filename,
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
      workDir: '/sandbox',
      withTiming: true,
      env: baseEnv(),
      concurrency: 2,
    });

    expect(r.fidelity).toBe('approx');
    expect(r.mutants).toBeGreaterThan(0);
    expect(r.baselineMs).toBeTypeOf('number');
    expect(r.concurrency).toBe(2);
    expect(r.estimatedMs).toBeTypeOf('number');
    // estimatedMs = ceil(mutants * baselineMs / 2)
    expect(r.estimatedMs).toBe(Math.ceil((r.mutants * (r.baselineMs ?? 0)) / 2));
  });

  it('omits timing fields and appends note when runShell throws', async () => {
    mockRunShell.mockRejectedValueOnce(new Error('test suite failed'));

    const r = await estimateAudit({
      absFile: __filename,
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
      workDir: '/sandbox',
      withTiming: true,
      env: baseEnv(),
    });

    expect(r.fidelity).toBe('approx');
    expect(r.mutants).toBeGreaterThan(0);
    expect(r.baselineMs).toBeUndefined();
    expect(r.estimatedMs).toBeUndefined();
    expect(r.concurrency).toBeUndefined();
    expect(r.note).toContain('timing unavailable');
  });

  it('omits timing when withTiming=true but env is missing', async () => {
    const r = await estimateAudit({
      absFile: __filename,
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
      workDir: '/sandbox',
      withTiming: true,
      // no env
    });
    expect(r.baselineMs).toBeUndefined();
  });

  it('omits timing when withTiming=true but workDir is missing', async () => {
    const r = await estimateAudit({
      absFile: __filename,
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
      withTiming: true,
      env: baseEnv(),
      // no workDir
    });
    expect(r.baselineMs).toBeUndefined();
  });

  it('rust + withTiming: sets timing fields when runShell resolves', async () => {
    mockInvoke.mockResolvedValueOnce({
      stdout: 'src/lib.rs:1:1: replace foo -> bar\nsrc/lib.rs:2:3: replace a + b with a - b\n',
      stderr: '',
    } as never);
    mockRunShell.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exit: 0,
      signal: null,
    } as never);

    const r = await estimateAudit({
      absFile: '/ws/src/lib.rs',
      relFile: 'src/lib.rs',
      projectType: 'rust',
      workDir: '/sandbox',
      withTiming: true,
      env: baseEnv(),
      concurrency: 2,
    });

    expect(r.fidelity).toBe('exact');
    expect(r.mutants).toBe(2);
    expect(r.baselineMs).toBeTypeOf('number');
    expect(r.concurrency).toBe(2);
    expect(r.estimatedMs).toBeTypeOf('number');
  });

  it('rust + withTiming: returns exact count with timing unavailable note when runShell rejects', async () => {
    mockInvoke.mockResolvedValueOnce({
      stdout: 'src/lib.rs:1:1: replace foo -> bar\n',
      stderr: '',
    } as never);
    mockRunShell.mockRejectedValueOnce(new Error('test suite failed'));

    const r = await estimateAudit({
      absFile: '/ws/src/lib.rs',
      relFile: 'src/lib.rs',
      projectType: 'rust',
      workDir: '/sandbox',
      withTiming: true,
      env: baseEnv(),
    });

    expect(r.fidelity).toBe('exact');
    expect(r.mutants).toBe(1);
    expect(r.baselineMs).toBeUndefined();
    expect(r.estimatedMs).toBeUndefined();
    expect(r.note).toContain('timing unavailable');
  });
});
