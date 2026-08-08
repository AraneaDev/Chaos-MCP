import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
  };
});

vi.mock('../utils/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/exec.js')>();
  return {
    ...actual,
    runShell: vi.fn(),
    runShellCommand: vi.fn(),
  };
});

vi.mock('../utils/logger.js', () => ({ warn: vi.fn() }));

// The process-exit sweep removes containers with `spawnSync` — it runs from an
// `exit` handler, where a promise is never awaited. Partial mock: the reaper
// imports from this module too.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawnSync: vi.fn() };
});

import { spawnSync } from 'child_process';
import { runShell, runShellCommand } from '../utils/exec.js';
import { ExecFailureError } from '../utils/exec-error.js';
import {
  _resetExecutionCaches,
  CONTAINER_IMAGE_VERSION,
  createExecutionSession,
  defaultContainerImage,
  type ExecutionSession,
} from '../utils/execution.js';
import { warn } from '../utils/logger.js';
import type { ContainerConfig } from '../utils/config-loader.js';
import type { SupportedProjectType } from '../utils/project-detector.js';
// Exactly the specifier utils/execution.ts registers through, so the sweep here
// walks the very Map the sessions below write into — see the registry docblock.
import { cleanupAllSandboxes } from '../utils/sandbox/registry.js';

const ok = (stdout = '') => ({ stdout, stderr: '', exit: 0, signal: null }) as const;

/**
 * `createExecutionSession` gained two required parameters — `workspaceRoot`
 * and `dependencyMode` — when the container backend stopped INFERRING the
 * host dependency root from the sandbox's own symlink shape (which broke on
 * npm/pnpm workspaces and a plain `python3 -m venv`'s `lib64 -> lib`) and
 * started being TOLD it instead. Every fixture in this file below either
 * builds a `'share'`-shaped sandbox (`workDir/<dep>` itself a symlink — see
 * "mounts every supported symlinked dependency tree read-only" and its
 * neighbours) or does not touch dependency mounts at all, so `'share'`
 * reproduces this file's pre-existing behaviour byte-for-byte; `workspaceRoot`
 * is unused by that mode and is any placeholder. Tests that specifically cover
 * `'link-entries'`/`'copy'` threading call `createExecutionSession` directly
 * with their own values instead of this helper.
 */
const UNUSED_WORKSPACE_ROOT = '/tmp/chaos-execution-test-unused-workspace-root';

function createTestSession(
  language: SupportedProjectType,
  workDir: string,
  config?: ContainerConfig,
  signal?: AbortSignal,
): Promise<ExecutionSession> {
  return createExecutionSession(language, workDir, UNUSED_WORKSPACE_ROOT, 'share', config, signal);
}

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
    const session = await createTestSession('typescript', '/tmp/work', undefined);
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
    expect(defaultContainerImage('typescript')).toBe(
      `ghcr.io/araneadev/chaos-mcp-typescript:v${CONTAINER_IMAGE_VERSION}`,
    );
    expect(defaultContainerImage('python')).toBe(
      `ghcr.io/araneadev/chaos-mcp-python:v${CONTAINER_IMAGE_VERSION}`,
    );
    expect(defaultContainerImage('rust')).toBe(
      `ghcr.io/araneadev/chaos-mcp-rust:v${CONTAINER_IMAGE_VERSION}`,
    );
    expect(defaultContainerImage('php')).toBe(
      `ghcr.io/araneadev/chaos-mcp-php:v${CONTAINER_IMAGE_VERSION}`,
    );
  });

  it('lets one language stay native while the rest run in containers', async () => {
    // Each image carries exactly one runtime, so a suite that crosses languages
    // cannot run in any of them: Knossos-MCP's PHPUnit tests spawn its Node and
    // Python scanner workers as subprocesses, which the PHP-only image has no
    // way to start. Before per-language modes the choice was all or nothing —
    // containers fixed that project's TypeScript audit and broke its PHP one.
    vi.mocked(runShell).mockResolvedValue(ok('27.0.0'));
    const config = { mode: 'container', modes: { php: 'native' } } as const;

    const php = await createTestSession('php', '/tmp/work', config);
    const typescript = await createTestSession('typescript', '/tmp/work', config);

    expect(php.kind).toBe('native');
    expect(typescript.kind).toBe('container');
  });

  it('falls back to native only when auto mode cannot reach the runtime', async () => {
    vi.mocked(runShell).mockRejectedValueOnce(new Error('missing'));
    const session = await createTestSession('python', '/tmp/work', {
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
      createTestSession('rust', '/tmp/work', {
        mode: 'container',
        runtime: 'docker',
      }),
    ).rejects.toThrow('Container execution requested, but runtime "docker" is unavailable.');
  });

  it('uses the Docker default in fallback and failure messages', async () => {
    vi.mocked(runShell).mockRejectedValueOnce(new Error('missing'));
    await createTestSession('python', '/tmp/work', { mode: 'auto' });
    expect(warn).toHaveBeenCalledWith(
      'Container runtime "docker" unavailable; using native execution.',
    );

    _resetExecutionCaches();
    vi.mocked(runShell).mockRejectedValueOnce(new Error('missing'));
    await expect(createTestSession('python', '/tmp/work', { mode: 'container' })).rejects.toThrow(
      'Container execution requested, but runtime "docker" is unavailable.',
    );
  });

  it('caches a successful runtime probe for subsequent audit sessions', async () => {
    vi.mocked(runShell).mockResolvedValue(ok('27.0.0'));

    await createTestSession('typescript', '/tmp/one', { mode: 'container' });
    await createTestSession('rust', '/tmp/two', { mode: 'container' });

    expect(runShell).toHaveBeenCalledTimes(1);
  });

  it('re-probes the runtime once the cached result has expired', async () => {
    // The cache exists so a triage sweep does not run `docker version` per file,
    // but a daemon that dies mid-sweep must not stay "available" forever. With
    // the age check forced true, a single early success would be trusted for the
    // rest of the process's life.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000_000));
      vi.mocked(runShell).mockResolvedValue(ok('27.0.0'));

      await createTestSession('typescript', '/tmp/one', { mode: 'container' });
      expect(runShell).toHaveBeenCalledTimes(1);

      // Still inside the 30s window: served from cache.
      vi.setSystemTime(new Date(1_000_000 + 29_999));
      await createTestSession('typescript', '/tmp/two', { mode: 'container' });
      expect(runShell).toHaveBeenCalledTimes(1);

      // Exactly ON the TTL the entry is stale — the comparison is `<`, not `<=`.
      vi.setSystemTime(new Date(1_000_000 + 30_000));
      await createTestSession('typescript', '/tmp/three', { mode: 'container' });
      expect(runShell).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('provisions a fresh container for a command issued after a dispose', async () => {
    // `dispose()` removes the container, so the id it used is gone — and so is
    // the container itself. A session that is used again must create a new one:
    // exec-ing against the removed container (or against the session name, which
    // now resolves to nothing) fails with a bare exit 1 that the engines
    // misreport as a mutation-tool configuration error.
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('container-id\n'))
      .mockResolvedValueOnce(ok('container-id\n'))
      .mockResolvedValueOnce(ok('first'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok('second-id\n'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok('later'))
      .mockResolvedValue(ok());

    const session = await createTestSession('typescript', '/tmp/work', {
      mode: 'container',
    });
    await session.run('tool', ['arg']);
    await session.dispose();

    expect((await session.run('tool', ['again'])).stdout).toBe('later');
    await session.dispose();

    const calls = vi.mocked(runShell).mock.calls;
    expect(calls.map((call) => call[1]?.[0])).toEqual([
      'version',
      'create',
      'start',
      'exec',
      'rm',
      'create',
      'start',
      'exec',
      'rm',
    ]);
    // The replacement exec targets the new container, never the removed one.
    expect(calls[7]?.[1]).toEqual([
      'exec',
      '--workdir',
      '/workspace',
      'second-id',
      'tool',
      'again',
    ]);
    // And the restarted session is itself disposable again.
    expect(calls[8]?.[1]).toEqual(['rm', '-f', 'second-id']);
    expect(calls.slice(5).every((call) => !(call[1] ?? []).includes('container-id'))).toBe(true);
  });

  it('re-provisions after a timed-out command destroys the container', async () => {
    // The reachable path: `run()` disposes on TIMEOUT, and
    // TypeScriptEngine.runBatched swallows that timeout and runs the next batch
    // through the very same session.
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(
        new ExecFailureError(
          { stdout: '', stderr: '', exit: null, signal: 'SIGKILL', code: 'TIMEOUT' },
          'timeout',
        ),
      )
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok('cid-2'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok('batch two'));
    const session = await createTestSession('typescript', '/tmp/work', {
      mode: 'container',
    });

    await expect(session.run('stryker', ['batch-one'])).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    expect(vi.mocked(runShell).mock.calls[4]?.[1]).toEqual(['rm', '-f', 'cid']);

    expect((await session.run('stryker', ['batch-two'])).stdout).toBe('batch two');
    expect(vi.mocked(runShell).mock.calls[5]?.[1]?.[0]).toBe('create');
    expect(vi.mocked(runShell).mock.calls[7]?.[1]).toEqual([
      'exec',
      '--workdir',
      '/workspace',
      'cid-2',
      'stryker',
      'batch-two',
    ]);
  });

  it('does not leak the old abort listener across a dispose and restart', async () => {
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok('cid-2'))
      .mockResolvedValue(ok());
    const session = await createTestSession(
      'rust',
      '/tmp/work',
      { mode: 'container' },
      controller.signal,
    );

    await session.run('cargo', ['check']);
    await session.dispose();
    expect(removeListener).toHaveBeenCalledTimes(1);
    await session.run('cargo', ['test']);

    // Exactly one listener per provisioned container — the disposed one was
    // removed, so the abort below tears down only the current container.
    expect(addListener).toHaveBeenCalledTimes(2);
    controller.abort();
    await vi.waitFor(() => {
      expect(vi.mocked(runShell).mock.calls.filter((call) => call[1]?.[0] === 'rm')).toHaveLength(
        2,
      );
    });
    const removals = vi.mocked(runShell).mock.calls.filter((call) => call[1]?.[0] === 'rm');
    expect(removals.map((call) => call[1]?.[2])).toEqual(['cid', 'cid-2']);
  });

  it('refuses to re-provision a container once the session signal is aborted', async () => {
    const controller = new AbortController();
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValue(ok());
    const session = await createTestSession(
      'rust',
      '/tmp/work',
      { mode: 'container' },
      controller.signal,
    );

    await session.run('cargo', ['check']);
    controller.abort();
    await vi.waitFor(() => {
      expect(vi.mocked(runShell).mock.calls.some((call) => call[1]?.[0] === 'rm')).toBe(true);
    });

    await expect(session.run('cargo', ['test'])).rejects.toThrow('cancelled before startup');
    expect(vi.mocked(runShell).mock.calls.filter((call) => call[1]?.[0] === 'create')).toHaveLength(
      1,
    );
  });

  it('passes runtime probe overrides through exactly', async () => {
    const controller = new AbortController();
    vi.mocked(runShell).mockResolvedValue(ok('5.4.0'));

    const session = await createTestSession(
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

      const session = await createTestSession(language, '/tmp/work', {
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
          // /tmp is the only writable space under the read-only rootfs, so it
          // has to hold the whole toolchain's scratch (Cargo registry, npm
          // cache, per-mutant files) — 512 MiB was not enough for a Cargo
          // registry download. Configurable via container.tmpfsSizeMb.
          '/tmp:rw,exec,nosuid,nodev,size=2048m',
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
          // Every toolchain cache is redirected onto the writable tmpfs: the
          // rootfs is read-only and the host dependency trees are mounted
          // read-only, so a tool writing to its default cache cannot start.
          // The rust image pins CARGO_HOME=/usr/local/cargo, which is on that
          // read-only root, and cargo must write its registry and lock there.
          '--env',
          'CARGO_HOME=/tmp/chaos-cargo',
          '--env',
          'npm_config_cache=/tmp/chaos-npm',
          '--env',
          'COMPOSER_HOME=/tmp/chaos-composer-home',
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
        // `cwd` is the HOST directory the exec CLIENT runs in — the sandbox, so
        // the reaper's per-sandbox sweep can reach it (the guest working
        // directory is the `--workdir` above).
        { timeoutMs: undefined, signal: undefined, killTree: true, cwd: '/tmp/work' },
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
    const session = await createTestSession('typescript', '/tmp/work,unsafe', {
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
      const session = await createTestSession('typescript', '/tmp/work', {
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
        const session = await createTestSession('typescript', '/tmp/work', {
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
    const session = await createTestSession('php', '/tmp/work', {
      mode: 'container',
      images: { php: 'example/php@sha256:abc' },
    });

    await session.runCommand('composer install');
    await session.dispose();

    expect(vi.mocked(runShell).mock.calls[1]?.[1]).toContain('example/php@sha256:abc');
    expect(vi.mocked(runShell).mock.calls[1]?.[1]).toEqual(expect.arrayContaining(['--cpus', '2']));
    expect(vi.mocked(runShell).mock.calls[3]?.[1]).toEqual(
      expect.arrayContaining(['sh', '-c', 'composer install']),
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
    const session = await createTestSession('rust', '/tmp/work', {
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
    const session = await createTestSession('typescript', '/tmp/work', {
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
    const session = await createTestSession('php', '/tmp/work', {
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
    const session = await createTestSession('php', '/tmp/work', {
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
    const session = await createTestSession('php', '/tmp/work', {
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
    const session = await createTestSession('typescript', '/tmp/work', {
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
    const session = await createTestSession('typescript', '/tmp/work', {
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
    const session = await createTestSession(
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
    const session = await createTestSession(
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

  it('arms the abort listener BEFORE the container is created', async () => {
    // `addEventListener('abort', ...)` on an already-aborted signal never fires,
    // so a listener registered at the END of startup covers none of startup —
    // and startup is where the container comes into existence.
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    let armedBeforeCreate = false;
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockImplementationOnce(async () => {
        armedBeforeCreate = addListener.mock.calls.length > 0;
        return ok('cid');
      })
      .mockResolvedValue(ok());
    const session = await createTestSession(
      'rust',
      '/tmp/work',
      { mode: 'container' },
      controller.signal,
    );

    await session.run('cargo', ['check']);

    expect(armedBeforeCreate).toBe(true);
    // Still exactly one listener for the one container that was provisioned.
    expect(addListener).toHaveBeenCalledTimes(1);
  });

  it('removes the container when the abort lands as `start` resolves', async () => {
    // The window the late registration left open: the request is cancelled
    // after `start` returns but before anything is listening. The listener that
    // was supposed to tear the container down was attached to a signal that had
    // already fired, so it never ran and the session held a RUNNING container
    // with no remaining teardown path of its own. The post-start re-check closes
    // it.
    const controller = new AbortController();
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockImplementationOnce(async () => {
        controller.abort();
        return ok();
      })
      .mockResolvedValue(ok());
    const session = await createTestSession(
      'rust',
      '/tmp/work',
      { mode: 'container' },
      controller.signal,
    );

    await expect(session.run('cargo', ['check'])).rejects.toThrow('cancelled during startup');

    const removals = vi.mocked(runShell).mock.calls.filter((call) => call[1]?.[0] === 'rm');
    expect(removals.map((call) => call[1])).toEqual([['rm', '-f', 'cid']]);
    // Cancelled during startup means no work was ever dispatched into it.
    expect(vi.mocked(runShell).mock.calls.some((call) => call[1]?.[0] === 'exec')).toBe(false);
  });

  it('re-issues the removal when the abort lands DURING `create`', async () => {
    // The ordering no other case covers: the cancellation arrives while the
    // container is still being created, so the listener's `rm -f` races the
    // daemon and loses, and the daemon then finishes creating the container.
    // Teardown that latched its first settled promise made every later attempt
    // a no-op and leaked that container for the lifetime of the process.
    const controller = new AbortController();
    const rmTargets: string[] = [];
    vi.mocked(runShell).mockImplementation(async (_command, args) => {
      const argv = args;
      if (argv[0] === 'version') return ok('27.0.0');
      if (argv[0] === 'create') {
        controller.abort();
        throw new ExecFailureError(
          { stdout: '', stderr: '', exit: null, signal: 'SIGTERM', code: 'ABORTED' },
          'cancelled',
        );
      }
      if (argv[0] === 'rm') {
        rmTargets.push(String(argv[2]));
        // First attempt: the daemon has not registered the container yet.
        if (rmTargets.length === 1) throw new Error('No such container');
        return ok();
      }
      return ok();
    });
    const session = await createTestSession(
      'rust',
      '/tmp/work',
      { mode: 'container' },
      controller.signal,
    );

    await expect(session.run('cargo', ['check'])).rejects.toMatchObject({ code: 'ABORTED' });

    // Two attempts at the SAME container, addressed by name because `create`
    // never returned an id.
    expect(rmTargets).toHaveLength(2);
    expect(new Set(rmTargets).size).toBe(1);
    expect(rmTargets[0]).toMatch(/^chaos-mcp-\d+-[0-9a-f-]{12}$/);
  });

  it('removes a still-running container from the process-exit sweep', async () => {
    // On SIGINT the server calls process.exit() from a `.finally()`, so the
    // request's own `finally { dispose() }` never runs. The container's
    // entrypoint is an infinite sleep, so nothing else would ever stop it.
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValue(ok());
    const session = await createTestSession('typescript', '/tmp/work', {
      mode: 'container',
      runtime: 'podman',
    });
    await session.run('stryker', []);
    const containerName = vi.mocked(runShell).mock.calls[1]?.[1]?.[2];

    cleanupAllSandboxes();

    // Synchronous, because an `exit` handler cannot await anything.
    expect(spawnSync).toHaveBeenCalledWith(
      'podman',
      ['rm', '-f', containerName],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );

    // …and the sweep is idempotent: a second signal removes nothing again.
    vi.mocked(spawnSync).mockClear();
    cleanupAllSandboxes();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('leaves nothing for the exit sweep once the session has disposed', async () => {
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('disposed-cid'))
      .mockResolvedValue(ok());
    // Two sessions, one torn down normally and one still holding its container,
    // so the assertion below cannot pass merely because the sweep did nothing.
    const disposed = await createTestSession('typescript', '/tmp/work', {
      mode: 'container',
      runtime: 'podman',
    });
    await disposed.run('stryker', []);
    await disposed.dispose();
    const live = await createTestSession('typescript', '/tmp/work', {
      mode: 'container',
      runtime: 'podman',
    });
    await live.run('stryker', []);
    const calls = vi.mocked(runShell).mock.calls;
    const disposedName = calls[1]?.[1]?.[2];
    const liveName = calls.filter((call) => call[1]?.[0] === 'create')[1]?.[1]?.[2];

    cleanupAllSandboxes();

    expect(spawnSync).toHaveBeenCalledWith(
      'podman',
      ['rm', '-f', liveName],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    // The disposed session's container is already gone; sweeping it again would
    // misreport what this process still owns.
    const swept = vi.mocked(spawnSync).mock.calls.flatMap((call) => [...(call[1] ?? [])]);
    expect(swept).not.toContain(disposedName);
  });

  it('runs the exec client itself inside the sandbox directory', async () => {
    // `--workdir` is the GUEST path; the exec client is a host process, and the
    // reaper indexes host processes by cwd. Left at process.cwd(), every
    // `docker exec` this session started was invisible to
    // killProcessesUnder(sandboxDir) — the sandbox's only reaping path.
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValue(ok());
    const session = await createTestSession('typescript', '/tmp/sandbox-abc', {
      mode: 'container',
    });

    await session.run('stryker', ['run'], { cwd: '/tmp/sandbox-abc/src' });
    await session.dispose();

    expect(vi.mocked(runShell).mock.calls[3]?.[1]?.slice(0, 3)).toEqual([
      'exec',
      '--workdir',
      '/workspace/src',
    ]);
    expect(vi.mocked(runShell).mock.calls[3]?.[2]).toMatchObject({ cwd: '/tmp/sandbox-abc' });
  });

  it('does not forward the host environment wholesale into containers', async () => {
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    const session = await createTestSession('php', '/tmp/work', {
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
    const session = await createTestSession('typescript', '/tmp/work', {
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
    const session = await createTestSession('python', '/tmp/work', {
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
    const session = await createTestSession('rust', '/tmp/work', {
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
    const session = await createTestSession(
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
      cwd: '/tmp/work',
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
    const session = await createTestSession('php', workDir, {
      mode: 'container',
    });

    await session.run('infection', []);
    await session.dispose();

    const createArgs = vi.mocked(runShell).mock.calls[1]?.[1] ?? [];
    for (const mount of expectedMounts) expect(createArgs).toContain(mount);
    // Dependency mounts are emitted in SHARED_DEPENDENCY_DIRS order, so pin the
    // argv ORDER too — not just membership.
    expect(createArgs.filter((arg) => expectedMounts.includes(arg))).toEqual(expectedMounts);
    expect(createArgs.filter((arg) => arg === '--mount')).toHaveLength(4);
    expect(createArgs).toEqual(expect.arrayContaining(['--network', 'bridge', '--cpus', '2']));
    expect(createArgs).toEqual(expect.arrayContaining(['--memory', '4096m']));
    expect(createArgs.some((arg) => arg.startsWith('PATH='))).toBe(false);
  });

  it('gives Vite a writable scratch inside the read-only node_modules mount', async () => {
    // Vite writes `<node_modules>/.vite-temp/<config>.timestamp-*.mjs` to load
    // ANY config file, so a read-only dependency tree fails the config load
    // outright: every test errors and StrykerJS reports "There were failed tests
    // in the initial test run" before a mutant runs. Auditing a vitest project
    // in a container was impossible. A tmpfs over just that directory keeps the
    // tree read-only and discards the scratch with the container.
    const root = mkdtempSync(join(tmpdir(), 'chaos-execution-vite-'));
    const workDir = join(root, 'sandbox');
    tempDirs.push(root);
    mkdirSync(workDir);
    const target = join(root, 'project-node_modules');
    mkdirSync(target);
    symlinkSync(target, join(workDir, 'node_modules'), 'dir');
    const venv = join(root, 'project-venv');
    mkdirSync(venv);
    symlinkSync(venv, join(workDir, 'venv'), 'dir');
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    const session = await createTestSession('typescript', workDir, { mode: 'container' });

    await session.run('stryker', []);
    await session.dispose();

    const createArgs = vi.mocked(runShell).mock.calls[1]?.[1] ?? [];
    expect(createArgs).toContain(`${target}/.vite-temp:rw,nosuid,nodev,size=16m`);
    // The tree itself stays read-only — only the scratch directory is writable.
    expect(createArgs).toContain(`type=bind,src=${target},dst=${target},readonly`);
    // No other dependency tree gets one: the path is Vite's, not a general
    // "make dependencies writable" hole.
    expect(createArgs.some((arg) => arg.startsWith(`${venv}/`))).toBe(false);
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
    const session = await createTestSession('typescript', workDir, {
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
    // Partial dirents — only `name`/`isDirectory` are read. Cast through the
    // mocked function's own return type so this tracks whichever readdirSync
    // overload vi.mocked resolves to.
    vi.mocked(readdirSync).mockReturnValueOnce([
      { name: 'python3.13', isDirectory: () => true },
      { name: 'python3.12', isDirectory: () => true },
      { name: 'not-python', isDirectory: () => true },
      { name: 'python-file', isDirectory: () => false },
    ] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(runShell)
      .mockResolvedValueOnce(ok('27.0.0'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok('cid'))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    const session = await createTestSession('python', workDir, {
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
    const session = await createTestSession('python', workDir, {
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
    const session = await createTestSession('python', workDir, {
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
});
