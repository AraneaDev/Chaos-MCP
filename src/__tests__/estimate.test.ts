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
    expect(estimateNeedsSandbox('python', false)).toBe(false);
    expect(estimateNeedsSandbox('php', false)).toBe(false);
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
    // baselineMs = Date.now() - t0 must be a small elapsed duration. A `Date.now() + t0`
    // mutant would yield ~2× the epoch (>1e12); pin it to a sane upper bound.
    expect(r.baselineMs).toBeLessThan(60_000);
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

  it('reports timing unavailable when no baseline command resolves for the project type', async () => {
    // resolveBaselineTestCommand returns undefined for an unrecognized type → the
    // `cmd === undefined` guard appends "(timing unavailable)" and returns without
    // running a baseline. Kills the guard + its block + the note string.
    const r = await estimateAudit({
      absFile: __filename,
      relFile: 'src/x.unknown',
      projectType: 'cobol' as never,
      workDir: '/sandbox',
      withTiming: true,
      env: baseEnv(),
    });
    expect(r.baselineMs).toBeUndefined();
    expect(r.estimatedMs).toBeUndefined();
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

describe('estimateAudit signal forwarding', () => {
  it('forwards signal into invokeMutationTool options on the rust path', async () => {
    mockInvoke.mockResolvedValueOnce({
      stdout: 'src/lib.rs:1:1: replace foo -> bar\n',
      stderr: '',
    } as never);

    const controller = new AbortController();
    await estimateAudit({
      absFile: '/ws/src/lib.rs',
      relFile: 'src/lib.rs',
      projectType: 'rust',
      workDir: '/sandbox',
      signal: controller.signal,
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      'cargo-mutants',
      'cargo',
      ['mutants', '--list', '--file', 'src/lib.rs'],
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('forwards a caller timeoutMs into the cargo-mutants invocation (not the default)', async () => {
    // Kills `opts.timeoutMs ?? ESTIMATE_TIMEOUT_MS → opts.timeoutMs && ESTIMATE_TIMEOUT_MS`,
    // under which a provided timeout would be discarded in favor of the default.
    mockInvoke.mockResolvedValueOnce({
      stdout: 'src/lib.rs:1:1: replace foo -> bar\n',
      stderr: '',
    } as never);
    await estimateAudit({
      absFile: '/ws/src/lib.rs',
      relFile: 'src/lib.rs',
      projectType: 'rust',
      workDir: '/sandbox',
      timeoutMs: 12_345,
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      'cargo-mutants',
      'cargo',
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 12_345 }),
    );
  });

  it('forwards signal into runShell options on the withTiming path', async () => {
    mockRunShell.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exit: 0,
      signal: null,
    } as never);

    const controller = new AbortController();
    await estimateAudit({
      absFile: __filename,
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
      workDir: '/sandbox',
      withTiming: true,
      env: baseEnv(),
      signal: controller.signal,
    });

    expect(mockRunShell).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
