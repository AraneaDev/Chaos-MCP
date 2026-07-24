import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import type { SupportedProjectType } from '../engines/registry.js';
import type { ContainerConfig } from './config-loader.js';
import { ExecFailureError, type ExecResult, runShell, runShellCommand } from './exec.js';
import { warn } from './logger.js';

export type ExecutionMode = 'native' | 'container' | 'auto';

export interface ExecuteOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  killTree?: boolean;
}

/** Per-audit command boundary shared by native and container execution. */
export interface ExecutionSession {
  readonly kind: 'native' | 'container';
  readonly workDir: string;
  run(command: string, args: string[], options?: ExecuteOptions): Promise<ExecResult>;
  runCommand(command: string, options?: ExecuteOptions): Promise<ExecResult>;
  dispose(): Promise<void>;
}

export const CONTAINER_IMAGE_VERSION = '1.4.0'; // x-release-please-version

const DEFAULT_IMAGES: Record<SupportedProjectType, string> = {
  typescript: `ghcr.io/araneadev/chaos-mcp-typescript:v${CONTAINER_IMAGE_VERSION}`,
  python: `ghcr.io/araneadev/chaos-mcp-python:v${CONTAINER_IMAGE_VERSION}`,
  rust: `ghcr.io/araneadev/chaos-mcp-rust:v${CONTAINER_IMAGE_VERSION}`,
  php: `ghcr.io/araneadev/chaos-mcp-php:v${CONTAINER_IMAGE_VERSION}`,
};

/** Host dependency trees that the sandbox may represent as symlinks. */
const SHARED_DEPENDENCY_DIRS = ['node_modules', '.venv', 'venv', 'vendor'];
const availableRuntimes = new Set<string>();

class NativeExecutionSession implements ExecutionSession {
  readonly kind = 'native' as const;

  constructor(readonly workDir: string) {}

  run(command: string, args: string[], options: ExecuteOptions = {}): Promise<ExecResult> {
    return runShell(command, args, {
      ...options,
      cwd: options.cwd ?? this.workDir,
    });
  }

  runCommand(command: string, options: ExecuteOptions = {}): Promise<ExecResult> {
    return runShellCommand(command, {
      ...options,
      cwd: options.cwd ?? this.workDir,
    });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

function changedEnvironment(env: NodeJS.ProcessEnv | undefined): [string, string][] {
  if (!env) return [];
  const result: [string, string][] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== process.env[key]) result.push([key, value]);
  }
  return result;
}

function mountArg(source: string, target: string, readonly = false): string {
  if (source.includes(',') || target.includes(',')) {
    throw new Error('Container execution does not support bind-mount paths containing commas.');
  }
  return `type=bind,src=${source},dst=${target}${readonly ? ',readonly' : ''}`;
}

class ContainerExecutionSession implements ExecutionSession {
  readonly kind = 'container' as const;
  private readonly name = `chaos-mcp-${process.pid}-${randomUUID().slice(0, 12)}`;
  private containerId: string | undefined;
  private startPromise: Promise<void> | undefined;
  private disposePromise: Promise<void> | undefined;
  private abortListener: (() => void) | undefined;

  constructor(
    readonly workDir: string,
    private readonly language: SupportedProjectType,
    private readonly config: ContainerConfig,
    private readonly signal?: AbortSignal,
  ) {}

  private get runtime(): string {
    return this.config.runtime ?? 'docker';
  }

  private get image(): string {
    return this.config.images?.[this.language] ?? DEFAULT_IMAGES[this.language];
  }

  private createArgs(): string[] {
    const args = [
      'create',
      '--name',
      this.name,
      '--label',
      'io.chaos-mcp.runner=true',
      '--label',
      `io.chaos-mcp.language=${this.language}`,
      '--workdir',
      '/workspace',
      '--mount',
      mountArg(this.workDir, '/workspace'),
      '--read-only',
      '--tmpfs',
      '/tmp:rw,exec,nosuid,nodev,size=512m',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      String(this.config.pidsLimit ?? 512),
      '--network',
      this.config.network ?? 'bridge',
    ];

    args.push('--cpus', String(this.config.cpus ?? 2));
    args.push('--memory', `${this.config.memoryMb ?? 4096}m`);
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid !== undefined && gid !== undefined) args.push('--user', `${uid}:${gid}`);

    const dependencyTargets = new Map<string, string>();
    for (const dir of SHARED_DEPENDENCY_DIRS) {
      try {
        const candidate = `${this.workDir}/${dir}`;
        if (!lstatSync(candidate).isSymbolicLink()) continue;
        const target = realpathSync(candidate);
        dependencyTargets.set(dir, target);
        args.push('--mount', mountArg(target, target, true));
      } catch {
        // Missing or unreadable dependency directories remain absent in the
        // container; the engine will surface its normal dependency error.
      }
    }

    if (this.language === 'python') {
      const virtualenv = dependencyTargets.get('.venv') ?? dependencyTargets.get('venv');
      if (virtualenv) {
        const sitePackages: string[] = [];
        try {
          for (const entry of readdirSync(`${virtualenv}/lib`, { withFileTypes: true })) {
            if (!entry.isDirectory() || !entry.name.startsWith('python')) continue;
            sitePackages.push(`${virtualenv}/lib/${entry.name}/site-packages`);
          }
        } catch {
          // The engine will surface missing project dependencies normally.
        }
        if (sitePackages.length > 0) {
          args.push('--env', `PYTHONPATH=${sitePackages.join(':')}`);
        }
        // Keep the image's pinned Python and mutation engine ahead of project
        // scripts, while still exposing console scripts installed by the project.
        args.push(
          '--env',
          `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${virtualenv}/bin`,
        );
      }
    }

    args.push(
      '--env',
      'HOME=/tmp/chaos-home',
      '--env',
      'XDG_CACHE_HOME=/tmp/chaos-cache',
      this.image,
      'sh',
      '-c',
      'while :; do sleep 3600; done',
    );
    return args;
  }

  private async ensureStarted(): Promise<void> {
    if (this.containerId) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      if (this.signal?.aborted) throw new Error('Container execution cancelled before startup.');
      const created = await runShell(this.runtime, this.createArgs(), {
        timeoutMs: this.config.startupTimeoutMs ?? 60_000,
        signal: this.signal,
        killTree: true,
      });
      this.containerId = created.stdout.trim() || this.name;
      await runShell(this.runtime, ['start', this.containerId], {
        timeoutMs: this.config.startupTimeoutMs ?? 60_000,
        signal: this.signal,
        killTree: true,
      });
      this.abortListener = () => void this.dispose();
      this.signal?.addEventListener('abort', this.abortListener, { once: true });
    })();
    try {
      await this.startPromise;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  private guestValue(value: string): string {
    if (value === this.workDir) return '/workspace';
    const prefix = this.workDir.endsWith(sep) ? this.workDir : `${this.workDir}${sep}`;
    if (!value.startsWith(prefix)) return value;
    return `/workspace/${value.slice(prefix.length).split(sep).join('/')}`;
  }

  async run(command: string, args: string[], options: ExecuteOptions = {}): Promise<ExecResult> {
    await this.ensureStarted();
    const execArgs = ['exec', '--workdir', this.guestValue(options.cwd ?? this.workDir)];
    for (const [key, value] of changedEnvironment(options.env)) {
      execArgs.push('--env', `${key}=${this.guestValue(value)}`);
    }
    execArgs.push(
      this.containerId ?? this.name,
      this.guestValue(command),
      ...args.map((arg) => this.guestValue(arg)),
    );
    try {
      return await runShell(this.runtime, execArgs, {
        timeoutMs: options.timeoutMs,
        signal: options.signal ?? this.signal,
        killTree: true,
      });
    } catch (error) {
      if (
        error instanceof ExecFailureError &&
        (error.code === 'TIMEOUT' || error.code === 'ABORTED')
      ) {
        await this.dispose();
      }
      throw error;
    }
  }

  runCommand(command: string, options: ExecuteOptions = {}): Promise<ExecResult> {
    return this.run('sh', ['-lc', command], options);
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = (async () => {
      if (this.abortListener) {
        this.signal?.removeEventListener('abort', this.abortListener);
        this.abortListener = undefined;
      }
      try {
        await runShell(this.runtime, ['rm', '-f', this.containerId ?? this.name], {
          timeoutMs: 15_000,
          killTree: true,
        });
      } catch {
        // Best effort: the container may not have been created, or Docker may
        // already have removed it after a daemon-side failure.
      } finally {
        this.containerId = undefined;
      }
    })();
    return this.disposePromise;
  }
}

async function runtimeAvailable(config: ContainerConfig, signal?: AbortSignal): Promise<boolean> {
  const runtime = config.runtime ?? 'docker';
  if (availableRuntimes.has(runtime)) return true;
  try {
    await runShell(runtime, ['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: config.startupTimeoutMs ?? 10_000,
      signal,
      killTree: true,
    });
    availableRuntimes.add(runtime);
    return true;
  } catch {
    return false;
  }
}

/** Reset process-lifetime runtime capability caching. Exported for tests only. */
export function _resetExecutionCaches(): void {
  availableRuntimes.clear();
}

/**
 * Resolve the configured execution backend. `auto` is deliberately conservative:
 * it falls back to native only when the container runtime itself is unavailable;
 * image or project failures after selection remain visible instead of silently
 * producing results under a different environment.
 */
export async function createExecutionSession(
  language: SupportedProjectType,
  workDir: string,
  config: ContainerConfig | undefined,
  signal?: AbortSignal,
): Promise<ExecutionSession> {
  const mode = config?.mode ?? 'native';
  if (mode === 'native') return new NativeExecutionSession(workDir);
  const available = await runtimeAvailable(config ?? {}, signal);
  if (!available) {
    if (mode === 'auto') {
      warn(
        `Container runtime "${config?.runtime ?? 'docker'}" unavailable; using native execution.`,
      );
      return new NativeExecutionSession(workDir);
    }
    throw new Error(
      `Container execution requested, but runtime "${config?.runtime ?? 'docker'}" is unavailable.`,
    );
  }
  return new ContainerExecutionSession(workDir, language, config ?? {}, signal);
}

export function defaultContainerImage(language: SupportedProjectType): string {
  return DEFAULT_IMAGES[language];
}

export interface ContainerDoctorReport {
  runtime: string;
  available: boolean;
  serverVersion?: string;
  mode: ExecutionMode;
  images: Record<SupportedProjectType, { image: string; present: boolean }>;
}

/** Read-only runtime/image diagnostics used by the CLI doctor command. */
export async function inspectContainerRuntime(
  config: ContainerConfig | undefined,
): Promise<ContainerDoctorReport> {
  const runtime = config?.runtime ?? 'docker';
  const images = Object.fromEntries(
    (Object.keys(DEFAULT_IMAGES) as SupportedProjectType[]).map((language) => [
      language,
      {
        image: config?.images?.[language] ?? DEFAULT_IMAGES[language],
        present: false,
      },
    ]),
  ) as ContainerDoctorReport['images'];
  let version: ExecResult;
  try {
    version = await runShell(runtime, ['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: config?.startupTimeoutMs ?? 10_000,
      killTree: true,
    });
  } catch {
    return { runtime, available: false, mode: config?.mode ?? 'native', images };
  }
  for (const language of Object.keys(images) as SupportedProjectType[]) {
    try {
      await runShell(runtime, ['image', 'inspect', images[language].image], {
        timeoutMs: config?.startupTimeoutMs ?? 10_000,
        killTree: true,
      });
      images[language].present = true;
    } catch {
      // Missing images are reported, not pulled or treated as a doctor crash.
    }
  }
  return {
    runtime,
    available: true,
    serverVersion: version.stdout.trim(),
    mode: config?.mode ?? 'native',
    images,
  };
}
