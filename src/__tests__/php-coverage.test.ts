import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

vi.mock('../utils/exec-classify.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/exec-classify.js')>(
    '../utils/exec-classify.js',
  );
  return { ...actual, invokeMutationTool: vi.fn() };
});

vi.mock('../utils/reuse/store.js', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/reuse/store.js')>('../utils/reuse/store.js');
  return { ...actual, harvestArtefact: vi.fn() };
});

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { invokeMutationTool } from '../utils/exec-classify.js';
import { harvestArtefact, type ReuseKey } from '../utils/reuse/store.js';
import { parsePhpCoverageSelection } from '../engines/php/coverage-selection.js';
import { producePhpCoverage } from '../engines/php/coverage.js';

const mockExists = vi.mocked(existsSync);
const mockRead = vi.mocked(readFileSync);
const mockRm = vi.mocked(rmSync);
const mockInvoke = vi.mocked(invokeMutationTool);
const mockHarvest = vi.mocked(harvestArtefact);

const key: ReuseKey = {
  workspaceRoot: '/project',
  engine: 'php',
  target: '.',
  kind: 'coverage',
};

describe('producePhpCoverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExists.mockReturnValue(false);
    mockRead.mockReturnValue('<testsuites tests="1"><testsuite tests="1"/></testsuites>');
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });
  });

  it('passes mutation options first and selected PHPUnit controls as separate arguments', async () => {
    const result = await producePhpCoverage({
      workDir: '/sb',
      key,
      fingerprint: 'fp',
      timeoutMs: 1_000,
      testFrameworkOptions: '--configuration phpunit.xml --colors=never',
      coverageSelection: parsePhpCoverageSelection(
        '--testsuite unit --filter "CalculatorTest with data set"',
      ),
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      'Infection',
      'phpunit',
      [
        '--exclude-source-from-xml-coverage',
        '--coverage-xml=/sb/.chaos-infection-coverage/coverage-xml',
        '--log-junit=/sb/.chaos-infection-coverage/junit.xml',
        '--configuration',
        'phpunit.xml',
        '--colors=never',
        '--testsuite',
        'unit',
        '--filter',
        'CalculatorTest with data set',
      ],
      expect.objectContaining({
        cwd: '/sb',
        timeoutMs: 1_000,
        env: expect.objectContaining({
          TMPDIR: '/sb/.chaos-infection-tmp',
          TMP: '/sb/.chaos-infection-tmp',
          TEMP: '/sb/.chaos-infection-tmp',
        }),
      }),
    );
    expect(result).toEqual({ generated: true, scope: 'selected' });
    expect(mockHarvest).toHaveBeenCalledWith(key, 'fp', '/sb/.chaos-infection-coverage');
  });

  it('rejects an execution failure when selected coverage was explicitly configured', async () => {
    mockInvoke.mockRejectedValue(new Error('PHPUnit exited 2'));

    await expect(
      producePhpCoverage({
        workDir: '/sb',
        timeoutMs: 1_000,
        coverageSelection: parsePhpCoverageSelection('--testsuite=unit'),
      }),
    ).rejects.toThrow(
      'PHP coverage selection failed for coverageTestFrameworkOptions: PHPUnit exited 2',
    );
    expect(mockRm).toHaveBeenCalledWith('/sb/.chaos-infection-coverage', {
      recursive: true,
      force: true,
    });
    expect(mockHarvest).not.toHaveBeenCalled();
  });

  it('rejects selected coverage when PHPUnit reports zero collected tests', async () => {
    mockRead.mockReturnValue(
      '<testsuites tests="0"><testsuite name="unit" tests="0"/></testsuites>',
    );

    const run = producePhpCoverage({
      workDir: '/sb',
      key,
      fingerprint: 'fp',
      timeoutMs: 1_000,
      coverageSelection: parsePhpCoverageSelection('--testsuite=missing'),
    });

    await expect(run).rejects.toThrow(/coverageTestFrameworkOptions.*zero tests/i);
    await expect(run).rejects.not.toThrow(/widen/i);
    expect(mockHarvest).not.toHaveBeenCalled();
  });

  it('does not treat an empty nested suite as zero selected tests', async () => {
    mockRead.mockReturnValue(
      '<testsuites tests="1"><testsuite name="empty" tests="0"/><testsuite name="unit" tests="1"/></testsuites>',
    );

    await expect(
      producePhpCoverage({
        workDir: '/sb',
        key,
        fingerprint: 'fp',
        timeoutMs: 1_000,
        coverageSelection: parsePhpCoverageSelection('--testsuite=unit'),
      }),
    ).resolves.toEqual({ generated: true, scope: 'selected' });
    expect(mockHarvest).toHaveBeenCalledWith(key, 'fp', '/sb/.chaos-infection-coverage');
  });

  it('keeps unconfigured producer failures best-effort and project-scoped', async () => {
    mockInvoke.mockRejectedValue(new Error('coverage driver unavailable'));

    await expect(
      producePhpCoverage({
        workDir: '/sb',
        key,
        fingerprint: 'fp',
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ generated: false, scope: 'project' });
    expect(mockHarvest).not.toHaveBeenCalled();
  });

  it('generates selected coverage without harvesting when no reusable identity exists', async () => {
    await expect(
      producePhpCoverage({
        workDir: '/sb',
        timeoutMs: 1_000,
        coverageSelection: parsePhpCoverageSelection('--group fast'),
      }),
    ).resolves.toEqual({ generated: true, scope: 'selected' });
    expect(mockHarvest).not.toHaveBeenCalled();
  });
});
