import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeFingerprint } from '../utils/reuse/fingerprint.js';
import { computePhpReuseFingerprint, resolveMutationToolIdentity } from '../audit/audit-file.js';

function gitStub(opts: { lsFiles: string; modified?: string; failing?: boolean }) {
  return async (args: string[]) => {
    if (opts.failing) throw new Error('fatal: not a git repository');
    if (args[0] === 'ls-files' && args[1] === '-m') return { stdout: opts.modified ?? '' };
    if (args[0] === 'ls-files') return { stdout: opts.lsFiles };
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
      run: gitStub({ lsFiles: clean, modified: 'tests/test_calc.py\n' }),
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
      run: gitStub({ lsFiles: clean, modified: 'README.md\n' }),
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

describe('computeFingerprint against a real git repository', () => {
  let repo: string;

  function git(...args: string[]) {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'chaos-fingerprint-'));
    git('init', '-q');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(repo, 'sub'));
    writeFileSync(join(repo, 'sub', 'a.py'), 'x = 1\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const inSub = () => ({ workspaceRoot: join(repo, 'sub'), paths: ['a.py'], extra: {} });

  it('changes when a tracked file is edited in a workspace below the repo root', async () => {
    const before = await computeFingerprint(inSub());
    writeFileSync(join(repo, 'sub', 'a.py'), 'x = 2\n');
    const after = await computeFingerprint(inSub());
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  it('changes when an edit is staged but not committed', async () => {
    const before = await computeFingerprint(inSub());
    writeFileSync(join(repo, 'sub', 'a.py'), 'x = 2\n');
    git('add', 'sub/a.py');
    const after = await computeFingerprint(inSub());
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  it('hashes an untracked file by its content', async () => {
    writeFileSync(join(repo, 'sub', 'b.py'), 'y = 1\n');
    const input = { workspaceRoot: join(repo, 'sub'), paths: ['b.py'], extra: {} };
    const before = await computeFingerprint(input);
    writeFileSync(join(repo, 'sub', 'b.py'), 'y = 2\n');
    const after = await computeFingerprint(input);
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  it('returns undefined when a covered tracked file has been deleted', async () => {
    rmSync(join(repo, 'sub', 'a.py'));
    expect(await computeFingerprint(inSub())).toBeUndefined();
  });

  it('changes when a tracked file is edited in a workspace at the repo root', async () => {
    const input = { workspaceRoot: repo, paths: ['sub/a.py'], extra: {} };
    const before = await computeFingerprint(input);
    const unchanged = await computeFingerprint(input);
    writeFileSync(join(repo, 'sub', 'a.py'), 'x = 2\n');
    const after = await computeFingerprint(input);
    expect(before).toBeDefined();
    expect(unchanged).toBe(before);
    expect(after).not.toBe(before);
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

  it('changes the PHP fingerprint when the coverage selector changes', async () => {
    const project = await computePhpReuseFingerprint(
      process.cwd(),
      undefined,
      'native:infection:Infection 0.34.0',
    );
    const selected = await computePhpReuseFingerprint(
      process.cwd(),
      undefined,
      'native:infection:Infection 0.34.0',
      '--testsuite=unit',
    );

    expect(project).toBeDefined();
    expect(selected).toBeDefined();
    expect(selected).not.toBe(project);
  });
});
