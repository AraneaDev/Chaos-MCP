import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/exec.js')>();
  return {
    ...actual,
    runShell: vi.fn(),
    runShellCommand: vi.fn(),
  };
});

import { runShell } from '../utils/exec.js';
import { inspectContainerRuntime } from '../utils/container/doctor.js';
import { defaultContainerImage } from '../utils/execution.js';

const ok = (stdout = '') => ({ stdout, stderr: '', exit: 0, signal: null }) as const;

describe('inspectContainerRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runShell).mockResolvedValue(ok());
  });

  it('reports runtime and all four local image states without pulling', async () => {
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0\n'))
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(new Error('python image missing'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    const report = await inspectContainerRuntime({
      mode: 'container',
      images: { python: 'custom/python:test' },
    });

    expect(report).toMatchObject({
      runtime: 'docker',
      available: true,
      serverVersion: '27.0.0',
      mode: 'container',
    });
    expect(report.images.typescript.present).toBe(true);
    expect(report.images.python).toEqual({
      image: 'custom/python:test',
      present: false,
    });
    expect(report.images.rust.present).toBe(true);
    expect(report.images.php.present).toBe(true);
    expect(vi.mocked(runShell).mock.calls.some((call) => call[1]?.[0] === 'pull')).toBe(false);
    expect(
      vi
        .mocked(runShell)
        .mock.calls.slice(1)
        .map((call) => call[1]),
    ).toEqual([
      ['image', 'inspect', defaultContainerImage('typescript')],
      ['image', 'inspect', 'custom/python:test'],
      ['image', 'inspect', defaultContainerImage('rust')],
      ['image', 'inspect', defaultContainerImage('php')],
    ]);
    for (const call of vi.mocked(runShell).mock.calls.slice(1)) {
      expect(call[2]).toEqual({ timeoutMs: 10_000, killTree: true });
    }
  });

  it('reports defaults when the runtime is available without explicit config', async () => {
    vi.mocked(runShell).mockResolvedValue(ok('27.0.0'));

    const report = await inspectContainerRuntime(undefined);

    expect(report.mode).toBe('native');
    expect(report.runtime).toBe('docker');
    expect(Object.values(report.images).every((image) => image.present)).toBe(true);
  });

  it('reports an unavailable runtime without inspecting images', async () => {
    vi.mocked(runShell).mockRejectedValueOnce(new Error('daemon unavailable'));

    const report = await inspectContainerRuntime(undefined);

    expect(report).toEqual({
      runtime: 'docker',
      available: false,
      mode: 'native',
      images: {
        typescript: {
          image: defaultContainerImage('typescript'),
          present: false,
        },
        python: { image: defaultContainerImage('python'), present: false },
        rust: { image: defaultContainerImage('rust'), present: false },
        php: { image: defaultContainerImage('php'), present: false },
      },
    });
    expect(vi.mocked(runShell).mock.calls[0]).toEqual([
      'docker',
      ['version', '--format', '{{.Server.Version}}'],
      { timeoutMs: 10_000, killTree: true },
    ]);
    expect(runShell).toHaveBeenCalledTimes(1);
  });
});
