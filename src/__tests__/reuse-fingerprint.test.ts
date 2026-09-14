import { describe, it, expect, vi } from 'vitest';
import { computeFingerprint } from '../utils/reuse/fingerprint.js';
import { computePhpReuseFingerprint, resolveMutationToolIdentity } from '../audit/audit-file.js';

function gitStub(opts: { lsFiles: string; status?: string; failing?: boolean }) {
  return async (args: string[]) => {
    if (opts.failing) throw new Error('fatal: not a git repository');
    if (args[0] === 'ls-files') return { stdout: opts.lsFiles };
    if (args[0] === 'status') return { stdout: opts.status ?? '' };
    return { stdout: '' };
  };
}

const base = {
  workspaceRoot: '/work',
  paths: ['src/calc.py', 'tests/test_calc.py'],
  extra: { tool: 'cosmic-ray 8.7.0' },
};

const clean = '100644 aaaa 0\tsrc/calc.py\n100644 bbbb 0\ttests/test_calc.py\n';

describe('computeFingerprint', () => {
  it('is stable when nothing covered has changed', async () => {
    const a = await computeFingerprint({ ...base, run: gitStub({ lsFiles: clean }) });
    const b = await computeFingerprint({ ...base, run: gitStub({ lsFiles: clean }) });
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it('changes when a TEST file changes', async () => {
    const before = await computeFingerprint({ ...base, run: gitStub({ lsFiles: clean }) });
    const after = await computeFingerprint({
      ...base,
      run: gitStub({ lsFiles: '100644 aaaa 0\tsrc/calc.py\n100644 cccc 0\ttests/test_calc.py\n' }),
    });
    expect(after).not.toBe(before);
  });

  it('changes when an uncommitted edit touches a covered file', async () => {
    const before = await computeFingerprint({ ...base, run: gitStub({ lsFiles: clean }) });
    const after = await computeFingerprint({
      ...base,
      run: gitStub({ lsFiles: clean, status: ' M tests/test_calc.py\n' }),
      readFile: () => 'edited content',
    });
    expect(after).not.toBe(before);
  });

  it('changes when the diff scope changes, even with identical files', async () => {
    const a = await computeFingerprint({
      ...base,
      extra: { ...base.extra, diffScope: '10-14' },
      run: gitStub({ lsFiles: clean }),
    });
    const b = await computeFingerprint({
      ...base,
      extra: { ...base.extra, diffScope: '20-24' },
      run: gitStub({ lsFiles: clean }),
    });
    expect(a).not.toBe(b);
  });

  it('ignores a change to a file it does not cover', async () => {
    const a = await computeFingerprint({ ...base, run: gitStub({ lsFiles: clean }) });
    const b = await computeFingerprint({
      ...base,
      run: gitStub({ lsFiles: clean, status: ' M README.md\n' }),
      readFile: () => 'unrelated',
    });
    expect(a).toBe(b);
  });

  it('returns undefined outside a git repository, so nothing is reused', async () => {
    const fp = await computeFingerprint({ ...base, run: gitStub({ lsFiles: '', failing: true }) });
    expect(fp).toBeUndefined();
  });

  it('returns undefined when a covered path is untracked and unreadable', async () => {
    const fp = await computeFingerprint({
      ...base,
      run: gitStub({ lsFiles: '100644 aaaa 0\tsrc/calc.py\n' }),
      readFile: () => undefined,
    });
    expect(fp).toBeUndefined();
  });
});

describe('reuse identity and PHP fingerprint inputs', () => {
  it('uses the selected native tool command output as its identity', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: 'StrykerJS 10.4.0', stderr: '' });
    const identity = await resolveMutationToolIdentity(
      'typescript',
      '/work',
      {},
      { kind: 'native', workDir: '/work', run, runCommand: vi.fn(), dispose: vi.fn() },
    );

    expect(identity).toBe('native:npx:StrykerJS 10.4.0');
    expect(run).toHaveBeenCalledWith(
      'npx',
      ['--no-install', 'stryker', '--version'],
      expect.objectContaining({ cwd: '/work' }),
    );
  });

  it('changes the PHP fingerprint when the test framework options change', async () => {
    const unit = await computePhpReuseFingerprint(
      process.cwd(),
      '--testsuite=unit',
      'native:infection:Infection 0.34.0',
    );
    const integration = await computePhpReuseFingerprint(
      process.cwd(),
      '--testsuite=integration',
      'native:infection:Infection 0.34.0',
    );

    expect(unit).toBeDefined();
    expect(integration).toBeDefined();
    expect(integration).not.toBe(unit);
  });
});
