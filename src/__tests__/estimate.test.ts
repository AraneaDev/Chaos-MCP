import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/exec-classify.js', () => ({
  invokeMutationTool: vi.fn(),
  MutationToolStartupError: class extends Error {},
}));

import { invokeMutationTool, MutationToolStartupError } from '../utils/exec-classify.js';
import { estimateAudit, estimateNeedsSandbox } from '../estimate.js';

const mockInvoke = vi.mocked(invokeMutationTool);

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
});
