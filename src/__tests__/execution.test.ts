import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/exec.js')>();
  return {
    ...actual,
    runShell: vi.fn(),
    runShellCommand: vi.fn(),
  };
});

vi.mock('../utils/logger.js', () => ({ warn: vi.fn() }));

import { ExecFailureError, runShell, runShellCommand } from '../utils/exec.js';
import {
  _resetExecutionCaches,
  CONTAINER_IMAGE_VERSION,
  createExecutionSession,
  defaultContainerImage,
  inspectContainerRuntime,
} from '../utils/execution.js';
import { warn } from '../utils/logger.js';

const ok = (stdout = '') => ({ stdout, stderr: '', exit: 0, signal: null }) as const;

function hostUserArgs(): string[] {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid === undefined || gid === undefined ? [] : ['--user', `${uid}:${gid}`];
}

describe('execution sessions', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    _resetExecutionCaches();
    vi.mocked(runShell).mockResolvedValue(ok());
    vi.mocked(runShellCommand).mockResolvedValue(ok());
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps native execution as the default', async () => {
    const session = await createExecutionSession('typescript', '/tmp/work', undefined);
    expect(session.kind).toBe('native');

    await session.run('node', ['--version']);
    await session.runCommand('npm test');

    expect(runShell).toHaveBeenCalledWith(
      'node',
      ['--version'],
      expect.objectContaining({ cwd: '/tmp/work' }),
    );
    expect(runShellCommand).toHaveBeenCalledWith(
      'npm test',
      expect.objectContaining({ cwd: '/tmp/work' }),
    );
    await expect(session.dispose()).resolves.toBeUndefined();
  });

  it('keeps all release-matched default image references exact', () => {
    expect(CONTAINER_IMAGE_VERSION).toBe('1.4.0');
    expect(defaultContainerImage('typescript')).toBe(
      'ghcr.io/araneadev/chaos-mcp-typescript:v1.4.0',
    );
    expect(defaultContainerImage('python')).toBe('ghcr.io/araneadev/chaos-mcp-python:v1.4.0');
    expect(defaultContainerImage('rust')).toBe('ghcr.io/araneadev/chaos-mcp-rust:v1.4.0');
    expect(defaultContainerImage('php')).toBe('ghcr.io/araneadev/chaos-mcp-php:v1.4.0');
  });

  it('falls back to native only when auto mode cannot reach the runtime', async () => {
    vi.mocked(runShell).mockRejectedValueOnce(new Error('missing'));
    const session = await createExecutionSession('python', '/tmp/work', {
      mode: 'auto',
      runtime: 'podman',
    });

    expect(session.kind).toBe('native');
    expect(warn).toHaveBeenCalledWith(
      'Container runtime "podman" unavailable; using native execution.',
    );
  });

  it('fails closed when explicit container mode cannot reach the runtime', async () => {
    vi.mocked(runShell).mockRejectedValueOnce(new Error('missing'));
    await expect(
      createExecutionSession('rust', '/tmp/work', {
        mode: 'container',
        runtime: 'docker',
      }),
    ).rejects.toThrow('Container execution requested, but runtime "docker" is unavailable.');
  });

  it('uses the Docker default in fallback and failure messages', async () => {
    vi.mocked(runShell).mockRejectedValueOnce(new Error('missing'));
    await createExecutionSession('python', '/tmp/work', { mode: 'auto' });
    expect(warn).toHaveBeenCalledWith(
      'Container runtime "docker" unavailable; using native execution.',
    );

    _resetExecutionCaches();
    vi.mocked(runShell).mockRejectedValueOnce(new Error('missing'));
    await expect(
      createExecutionSession('python', '/tmp/work', { mode: 'container' }),
    ).rejects.toThrow('Container execution requested, but runtime "docker" is unavailable.');
  });

  it('caches a successful runtime probe for subsequent audit sessions', async () => {
    vi.mocked(runShell).mockResolvedValue(ok('27.0.0'));

    await createExecutionSession('typescript', '/tmp/one', { mode: 'container' });
    await createExecutionSession('rust', '/tmp/two', { mode: 'container' });

    expect(runShell).toHaveBeenCalledTimes(1);
  });

  it('passes runtime probe overrides through exactly', async () => {
    const controller = new AbortController();
    vi.mocked(runShell).mockResolvedValue(ok('5.4.0'));

    const session = await createExecutionSession(
      'php',
      '/tmp/work',
      {
        mode: 'container',
        runtime: 'podman',
        startupTimeoutMs: 4321,
      },
      controller.signal,
    );

    expect(session.kind).toBe('container');
    expect(vi.mocked(runShell).mock.calls[0]).toEqual([
      'podman',
      ['version', '--format', '{{.Server.Version}}'],
      { timeoutMs: 4321, signal: controller.signal, killTree: true },
    ]);
  });

  it.each(['typescript', 'python', 'rust', 'php'] as const)(
    'starts a hardened %s container and removes it after use',
    async (language) => {
      vi.mocked(runShell)
        .mockResolvedValueOnce(ok('27.0.0'))
        .mockResolvedValueOnce(ok('container-id\n'))
        .mockResolvedValueOnce(ok('container-id\n'))
        .mockResolvedValueOnce(ok('tool output'))
        .mockResolvedValueOnce(ok('container-id\n'));

      const session = await createExecutionSession(language, '/tmp/work', {
        mode: 'container',
        cpus: 2,
        memoryMb: 1024,
        pidsLimit: 128,
        network: 'none',
      });
      const result = await session.run('tool', ['arg']);
      await session.dispose();

      expect(result.stdout).toBe('tool output');
      const createCall = vi.mocked(runShell).mock.calls[1];
      expect(createCall?.[0]).toBe('docker');
      const containerName = createCall?.[1]?.[2];
      expect(containerName).toMatch(/^chaos-mcp-\d+-[0-9a-f-]{12}$/);
      expect(vi.mocked(runShell).mock.calls[0]).toEqual([
        'docker',
        ['version', '--format', '{{.Server.Version}}'],
        { timeoutMs: 10_000, signal: undefined, killTree: true },
      ]);
      expect(createCall).toEqual([
        'docker',
        [
          'create',
          '--name',
          containerName,
          '--label',
          'io.chaos-mcp.runner=true',
          '--label',
          `io.chaos-mcp.language=${language}`,
          '--workdir',
          '/workspace',
          '--mount',
          'type=bind,src=/tmp/work,dst=/workspace',
          '--read-only',
          '--tmpfs',
          '/tmp:rw,exec,nosuid,nodev,size=512m',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--pids-limit',
          '128',
          '--network',
          'none',
          '--cpus',
          '2',
          '--memory',
          '1024m',
          ...hostUserArgs(),
          '--env',
          'HOME=/tmp/chaos-home',
          '--env',
          'XDG_CACHE_HOME=/tmp/chaos-cache',
          defaultContainerImage(language),
          'sh',
          '-c',
          'while :; do sleep 3600; done',
        ],
        { timeoutMs: 60_000, signal: undefined, killTree: true },
      ]);
      expect(vi.mocked(runShell).mock.calls[2]).toEqual([
        'docker',
        ['start', 'container-id'],
        { timeoutMs: 60_000, signal: undefined, killTree: true },
      ]);
      expect(vi.mocked(runShell).mock.calls[3]).toEqual([
        'docker',
        ['exec', '--workdir', '/workspace', 'container-id', 'tool', 'arg'],
        { timeoutMs: undefined, signal: undefined, killTree: true },
      ]);
      expect(vi.mocked(runShell).mock.calls[4]).toEqual([
        'docker',
        ['rm', '-f', 'container-id'],
        { timeoutMs: 15_000, killTree: true },
      ]);
    },
  );

  it('rejects bind-mount paths that the runtime cannot parse safely', async () => {
    vi.mocked(runShell).mockResolvedValueOnce(ok('27.0.0'));
    const session = await createExecutionSession('typescript', '/tmp/work,unsafe', {
      mode: 'container',
    });

    await expect(session.run('stryker', [])).rejects.toThrow('bind-mount paths containing commas');
    expect(vi.mocked(runShell).mock.calls[1]?.[1]?.slice(0, 2)).toEqual(['rm', '-f']);
  });

  it('omits a container user on platforms without POSIX uid and gid APIs', async () => {
    const uidDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
    const gidDescriptor = Object.getOwnPropertyDescriptor(process, 'getgid');
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true });
    Object.defineProperty(process, 'getgid', { value: undefined, configurable: true });
    try {
      vi.mocked(runShell)
        .mockResolvedValueOnce(ok('27.0.0'))
        .mockResolvedValueOnce(ok('cid'))
        .mockResolvedValueOnce(ok())
        .mockResolvedValueOnce(ok())
        .mockResolvedValueOnce(ok());
      const session = await createExecutionSession('typescript', '/tmp/work', {
        mode: 'container',
      });

      await session.run('stryker', []);
      await session.dispose();

      expect(vi.mocked(runShell).mock.calls[1]?.[1]).not.toContain('--user');
    } finally {
      if (uidDescriptor) Object.defineProperty(process, 'getuid', uidDescriptor);
      else delete (process as { getuid?: unknown }).getuid;
      if (gidDescriptor) Object.defineProperty(process, 'getgid', gidDescriptor);
      else delete (process as { getgid?: unknown }).getgid;
    }
  });

  it.each(['getuid', 'getgid'] as const)(
    'omits a container user when only process.%s is unavailable',
    async (missingApi) => {
      const descriptor = Object.getOwnPropertyDescriptor(process, missingApi);
      Object.defineProperty(process, missingApi, { value: undefined, configurable: true });
      try {
        vi.mocked(runShell)
          .mockResolvedValueOnce(ok('27.0.0'))
          .mockResolvedValueOnce(ok('cid'))
          .mockResolvedValueOnce(ok())
          .mockResolvedValueOnce(ok())
          .mockResolvedValueOnce(ok());
        const session = await createExecutionSession('typescript', '/tmp/work', {
          mode: 'container',
        });

        await session.run('stryker', []);
        await session.dispose();

        expect(vi.mocked(runShell).mock.calls[1]?.[1]).not.toContain('--user');
      } finally {
        if (descriptor) Object.defineProperty(process, missingApi, descriptor);
        else if (missingApi === 'getuid') delete (process as { getuid?: unknown }).getuid;
        else delete (process as { getgid?: unknown }).getgid;
      }
    },
  );

  it('executes prebuild shell commands inside the same container', async () => {
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok('built'))
      .mockResolvedValueOnce(ok());
    const session = await createExecutionSession('php', '/tmp/work', {
      mode: 'container',
      images: { php: 'example/php@sha256:abc' },
    });

    await session.runCommand('composer install');
    await session.dispose();

    expect(vi.mocked(runShell).mock.calls[1]?.[1]).toContain('example/php@sha256:abc');
    expect(vi.mocked(runShell).mock.calls[1]?.[1]).toEqual(expect.arrayContaining(['--cpus', '2']));
    expect(vi.mocked(runShell).mock.calls[3]?.[1]).toEqual(
      expect.arrayContaining(['sh', '-lc', 'composer install']),
    );
  });

  it('destroys the whole container when a command times out', async () => {
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok('cid'))
      .mockRejectedValueOnce(
        new ExecFailureError(
          { stdout: '', stderr: '', exit: null, signal: 'SIGKILL', code: 'TIMEOUT' },
          'timeout',
        ),
      )
      .mockResolvedValueOnce(ok());
    const session = await createExecutionSession('rust', '/tmp/work', {
      mode: 'container',
    });

    await expect(session.run('cargo', ['mutants'])).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    expect(vi.mocked(runShell).mock.calls[4]?.[1]).toEqual(['rm', '-f', 'cid']);
  });

  it('destroys the whole container when a command is cancelled', async () => {
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok('cid'))
      .mockRejectedValueOnce(
        new ExecFailureError(
          { stdout: '', stderr: '', exit: null, signal: 'SIGTERM', code: 'ABORTED' },
          'cancelled',
        ),
      )
      .mockResolvedValueOnce(ok());
    const session = await createExecutionSession('typescript', '/tmp/work', {
      mode: 'container',
    });

    await expect(session.run('stryker', [])).rejects.toMatchObject({
      code: 'ABORTED',
    });
    expect(vi.mocked(runShell).mock.calls[4]?.[1]).toEqual(['rm', '-f', 'cid']);
    await session.dispose();
    expect(runShell).toHaveBeenCalledTimes(5);
  });

  it('removes a created container when startup fails', async () => {
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockRejectedValueOnce(new Error('start failed'))
      .mockResolvedValueOnce(ok());
    const session = await createExecutionSession('php', '/tmp/work', {
      mode: 'container',
    });

    await expect(session.run('infection', [])).rejects.toThrow('start failed');

    expect(vi.mocked(runShell).mock.calls[3]?.[1]).toEqual(['rm', '-f', 'cid']);
  });

  it('does not eagerly destroy the container for an ordinary tool failure', async () => {
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok('cid'))
      .mockRejectedValueOnce(new Error('tool failed'))
      .mockResolvedValueOnce(ok());
    const session = await createExecutionSession('php', '/tmp/work', {
      mode: 'container',
    });

    await expect(session.run('infection', [])).rejects.toThrow('tool failed');
    expect(runShell).toHaveBeenCalledTimes(4);
    await session.dispose();
    await session.dispose();

    expect(runShell).toHaveBeenCalledTimes(5);
  });

  it('does not treat a non-timeout ExecFailureError as a container-wide timeout', async () => {
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(
        new ExecFailureError(
          { stdout: '', stderr: 'failed', exit: 1, signal: null, code: 'NONZERO' },
          'failed',
        ),
      )
      .mockResolvedValueOnce(ok());
    const session = await createExecutionSession('php', '/tmp/work', {
      mode: 'container',
    });

    await expect(session.run('infection', [])).rejects.toMatchObject({
      code: 'NONZERO',
    });
    expect(runShell).toHaveBeenCalledTimes(4);
    await session.dispose();
  });

  it('starts a session only once across repeated commands', async () => {
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok('first'))
      .mockResolvedValueOnce(ok('second'))
      .mockResolvedValueOnce(ok());
    const session = await createExecutionSession('typescript', '/tmp/work', {
      mode: 'container',
    });

    expect((await session.run('node', ['one'])).stdout).toBe('first');
    expect((await session.run('node', ['two'])).stdout).toBe('second');
    await session.dispose();

    expect(vi.mocked(runShell).mock.calls.filter((call) => call[1]?.[0] === 'create')).toHaveLength(
      1,
    );
    expect(vi.mocked(runShell).mock.calls.filter((call) => call[1]?.[0] === 'start')).toHaveLength(
      1,
    );
  });

  it('shares an in-flight container startup across concurrent commands', async () => {
    let resolveCreate!: (result: ReturnType<typeof ok>) => void;
    const createPending = new Promise<ReturnType<typeof ok>>((resolve) => {
      resolveCreate = resolve;
    });
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockReturnValueOnce(createPending)
      .mockResolvedValue(ok());
    const session = await createExecutionSession('typescript', '/tmp/work', {
      mode: 'container',
    });

    const first = session.run('node', ['one']);
    await vi.waitFor(() => expect(runShell).toHaveBeenCalledTimes(2));
    const second = session.run('node', ['two']);
    await Promise.resolve();
    expect(vi.mocked(runShell).mock.calls.filter((call) => call[1]?.[0] === 'create')).toHaveLength(
      1,
    );

    resolveCreate(ok('cid'));
    await Promise.all([first, second]);
    await session.dispose();

    expect(vi.mocked(runShell).mock.calls.filter((call) => call[1]?.[0] === 'start')).toHaveLength(
      1,
    );
  });

  it('rejects an already-cancelled session before creating a container', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.mocked(runShell).mockResolvedValueOnce(ok('27.0.0')).mockResolvedValueOnce(ok());
    const session = await createExecutionSession(
      'rust',
      '/tmp/work',
      { mode: 'container' },
      controller.signal,
    );

    await expect(session.run('cargo', ['mutants'])).rejects.toThrow('cancelled before startup');
    expect(vi.mocked(runShell).mock.calls[1]?.[1]?.slice(0, 2)).toEqual(['rm', '-f']);
  });

  it('removes a started container when the session signal is cancelled', async () => {
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    const session = await createExecutionSession(
      'rust',
      '/tmp/work',
      { mode: 'container' },
      controller.signal,
    );
    await session.run('cargo', ['check']);
    expect(addListener).toHaveBeenCalledWith('abort', expect.any(Function), {
      once: true,
    });

    controller.abort();
    await vi.waitFor(() => {
      expect(vi.mocked(runShell).mock.calls[4]?.[1]).toEqual(['rm', '-f', 'cid']);
    });
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('does not forward the host environment wholesale into containers', async () => {
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    const session = await createExecutionSession('php', '/tmp/work', {
      mode: 'container',
    });

    await session.run('infection', [], {
      env: { ...process.env, TMPDIR: '/tmp/work/tmp' },
    });
    await session.dispose();

    const execArgs = vi.mocked(runShell).mock.calls[3]?.[1] ?? [];
    expect(execArgs).toEqual(expect.arrayContaining(['--env', 'TMPDIR=/workspace/tmp']));
    expect(execArgs.some((arg) => arg.startsWith('PATH='))).toBe(false);
  });

  it('forwards neither unchanged nor undefined environment values', async () => {
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    const session = await createExecutionSession('typescript', '/tmp/work', {
      mode: 'container',
    });

    await session.run('stryker', [], {
      env: { PATH: undefined },
    });
    await session.dispose();

    expect(vi.mocked(runShell).mock.calls[3]?.[1]).toEqual([
      'exec',
      '--workdir',
      '/workspace',
      'cid',
      'stryker',
    ]);
  });

  it('translates sandbox-absolute command arguments to the container mount', async () => {
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    const session = await createExecutionSession('python', '/tmp/work', {
      mode: 'container',
    });

    await session.run('cosmic-ray', [
      'init',
      '/tmp/work/config/.chaos.toml',
      '/tmp/work/data/session.sqlite',
    ]);
    await session.dispose();

    expect(vi.mocked(runShell).mock.calls[3]?.[1]).toEqual(
      expect.arrayContaining([
        'cosmic-ray',
        'init',
        '/workspace/config/.chaos.toml',
        '/workspace/data/session.sqlite',
      ]),
    );
  });

  it('translates an explicit sandbox working directory', async () => {
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    const session = await createExecutionSession('rust', '/tmp/work', {
      mode: 'container',
    });

    await session.run('cargo', ['test'], { cwd: '/tmp/work/crate' });
    await session.dispose();

    expect(vi.mocked(runShell).mock.calls[3]?.[1]).toEqual(
      expect.arrayContaining(['exec', '--workdir', '/workspace/crate']),
    );
  });

  it('prefers a command-specific cancellation signal over the session signal', async () => {
    const sessionController = new AbortController();
    const commandController = new AbortController();
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    const session = await createExecutionSession(
      'rust',
      '/tmp/work',
      { mode: 'container' },
      sessionController.signal,
    );

    await session.run('cargo', ['test'], { signal: commandController.signal });
    await session.dispose();

    expect(vi.mocked(runShell).mock.calls[3]?.[2]).toEqual({
      timeoutMs: undefined,
      signal: commandController.signal,
      killTree: true,
    });
  });

  it('mounts every supported symlinked dependency tree read-only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chaos-execution-deps-'));
    const workDir = join(root, 'sandbox');
    tempDirs.push(root);
    mkdirSync(workDir);
    const expectedMounts: string[] = [];
    for (const dependency of ['node_modules', 'venv', 'vendor']) {
      const target = join(root, `project-${dependency}`);
      mkdirSync(target);
      symlinkSync(target, join(workDir, dependency), 'dir');
      expectedMounts.push(`type=bind,src=${target},dst=${target},readonly`);
    }
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    const session = await createExecutionSession('php', workDir, {
      mode: 'container',
    });

    await session.run('infection', []);
    await session.dispose();

    const createArgs = vi.mocked(runShell).mock.calls[1]?.[1] ?? [];
    for (const mount of expectedMounts) expect(createArgs).toContain(mount);
    expect(createArgs.filter((arg) => arg === '--mount')).toHaveLength(4);
    expect(createArgs).toEqual(expect.arrayContaining(['--network', 'bridge', '--cpus', '2']));
    expect(createArgs).toEqual(expect.arrayContaining(['--memory', '4096m']));
    expect(createArgs.some((arg) => arg.startsWith('PATH='))).toBe(false);
  });

  it('does not mount an ordinary dependency directory outside the sandbox', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chaos-execution-directory-'));
    const workDir = join(root, 'sandbox');
    tempDirs.push(root);
    mkdirSync(join(workDir, 'node_modules'), { recursive: true });
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    const session = await createExecutionSession('typescript', workDir, {
      mode: 'container',
    });

    await session.run('stryker', []);
    await session.dispose();

    const createArgs = vi.mocked(runShell).mock.calls[1]?.[1] ?? [];
    expect(createArgs.filter((arg) => arg === '--mount')).toHaveLength(1);
  });

  it('exposes a symlinked Python virtualenv without replacing the pinned interpreter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chaos-execution-'));
    const workDir = join(root, 'sandbox');
    const virtualenv = join(root, 'project-venv');
    tempDirs.push(root);
    mkdirSync(join(workDir), { recursive: true });
    mkdirSync(join(virtualenv, 'lib', 'python3.13', 'site-packages'), { recursive: true });
    mkdirSync(join(virtualenv, 'lib', 'python3.12', 'site-packages'), { recursive: true });
    mkdirSync(join(virtualenv, 'lib', 'not-python', 'site-packages'), { recursive: true });
    writeFileSync(join(virtualenv, 'lib', 'python-file'), '');
    mkdirSync(join(virtualenv, 'bin'), { recursive: true });
    writeFileSync(join(virtualenv, 'bin', 'project-tool'), '');
    symlinkSync(virtualenv, join(workDir, '.venv'), 'dir');
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    const session = await createExecutionSession('python', workDir, {
      mode: 'container',
    });

    await session.run('cosmic-ray', ['baseline']);
    await session.dispose();

    const createArgs = vi.mocked(runShell).mock.calls[1]?.[1] ?? [];
    const pythonPath = `PYTHONPATH=${virtualenv}/lib/python3.12/site-packages:${virtualenv}/lib/python3.13/site-packages`;
    const pythonPathIndex = createArgs.indexOf(pythonPath);
    const pathIndex = createArgs.indexOf(
      `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${virtualenv}/bin`,
    );
    expect(createArgs[pythonPathIndex - 1]).toBe('--env');
    expect(createArgs[pathIndex - 1]).toBe('--env');
    expect(createArgs).toEqual(
      expect.arrayContaining([
        '--mount',
        `type=bind,src=${virtualenv},dst=${virtualenv},readonly`,
        '--env',
        pythonPath,
        '--env',
        `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${virtualenv}/bin`,
      ]),
    );
  });

  it('uses a venv symlink as the Python dependency fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chaos-execution-venv-'));
    const workDir = join(root, 'sandbox');
    const virtualenv = join(root, 'project-venv');
    tempDirs.push(root);
    mkdirSync(workDir);
    mkdirSync(join(virtualenv, 'lib', 'python3.13', 'site-packages'), {
      recursive: true,
    });
    symlinkSync(virtualenv, join(workDir, 'venv'), 'dir');
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    const session = await createExecutionSession('python', workDir, {
      mode: 'container',
    });

    await session.run('cosmic-ray', ['baseline']);
    await session.dispose();

    expect(vi.mocked(runShell).mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(['--env', `PYTHONPATH=${virtualenv}/lib/python3.13/site-packages`]),
    );
  });

  it('omits PYTHONPATH when a virtualenv has no discoverable site-packages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chaos-execution-empty-venv-'));
    const workDir = join(root, 'sandbox');
    const virtualenv = join(root, 'project-venv');
    tempDirs.push(root);
    mkdirSync(workDir);
    mkdirSync(join(virtualenv, 'lib'), { recursive: true });
    symlinkSync(virtualenv, join(workDir, '.venv'), 'dir');
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    const session = await createExecutionSession('python', workDir, {
      mode: 'container',
    });

    await session.run('cosmic-ray', ['baseline']);
    await session.dispose();

    const createArgs = vi.mocked(runShell).mock.calls[1]?.[1] ?? [];
    expect(createArgs.some((arg) => arg.startsWith('PYTHONPATH='))).toBe(false);
    expect(createArgs).toContain(
      `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${virtualenv}/bin`,
    );
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
