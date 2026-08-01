import { randomUUID } from 'node:crypto';
import { sep } from 'node:path';
import type { SupportedProjectType } from './project-detector.js';
import type { ContainerConfig } from './config-loader.js';
import { ExecFailureError, type ExecResult } from './exec-error.js';
import { runShell, runShellCommand } from './exec.js';
import { warn } from './logger.js';
import { buildCreateArgs, changedEnvironment } from './container/args.js';

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

export const CONTAINER_IMAGE_VERSION = '1.6.0'; // x-release-please-version

/** @internal Exported for utils/container/doctor.ts and tests. */
export const DEFAULT_IMAGES: Record<SupportedProjectType, string> = {
  typescript: `ghcr.io/araneadev/chaos-mcp-typescript:v${CONTAINER_IMAGE_VERSION}`,
  python: `ghcr.io/araneadev/chaos-mcp-python:v${CONTAINER_IMAGE_VERSION}`,
  rust: `ghcr.io/araneadev/chaos-mcp-rust:v${CONTAINER_IMAGE_VERSION}`,
  php: `ghcr.io/araneadev/chaos-mcp-php:v${CONTAINER_IMAGE_VERSION}`,
};

/**
 * Positive runtime probes, with the time each was taken.
 *
 * A successful probe is cached only briefly. An MCP server outlives the daemon
 * it talks to — Docker gets restarted, a socket goes away — and a permanently
 * cached "yes" makes `mode: 'auto'` keep choosing the container backend and
 * failing at `create`, which is precisely the case the native fallback exists
 * to cover. Negative results are deliberately not cached at all, so recovery is
 * immediate in the other direction.
 */
const availableRuntimes = new Map<string, number>();

/** How long a successful runtime probe is trusted before being re-taken. */
const RUNTIME_PROBE_TTL_MS = 30_000;

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
    return buildCreateArgs(this.name, this.workDir, this.language, this.config, this.image);
  }

  private async ensureStarted(): Promise<void> {
    if (this.containerId) return;
    if (this.startPromise) return this.startPromise;
    // A new provision supersedes any completed teardown: unlatch `dispose()` so
    // the container about to be created can itself be removed later. Teardown
    // stays idempotent for as long as the session has no container.
    this.disposePromise = undefined;
    this.startPromise = (async () => {
      if (this.signal?.aborted) throw new Error('Container execution cancelled before startup.');
      // Arm cancellation BEFORE anything is created, not after `start` returns.
      // `addEventListener('abort', ...)` on an already-aborted signal never
      // fires, so registering at the end left a window — abort landing between
      // `start` resolving and the registration — in which the session owned a
      // RUNNING container and nothing was left that would ever tear it down.
      // (Both current callers also dispose in a `finally`, which masked it; the
      // listener is this class's stated cancellation mechanism and must actually
      // arm.) Registering first is safe because `dispose()` is idempotent — it
      // latches on `disposePromise` — and removes the container by name when
      // `containerId` is not set yet, which is exactly the state an abort during
      // `create` leaves behind.
      this.abortListener = () => void this.dispose();
      this.signal?.addEventListener('abort', this.abortListener, { once: true });
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
      // The listener above may have already fired and disposed a container that
      // `start` then finished bringing up, and an abort that lands in this exact
      // turn has no listener left to fire (it was removed by that dispose). Re-check
      // and tear down explicitly so a cancelled request never leaves the runtime
      // holding a started container.
      if (this.signal?.aborted) {
        await this.dispose();
        throw new Error('Container execution cancelled during startup.');
      }
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
    return this.run('sh', ['-c', command], options);
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
        // Drop the settled startup promise as well. A session survives its own
        // teardown — `run()` disposes the container on TIMEOUT/ABORTED and
        // TypeScriptEngine.runBatched keeps going with the next batch — so the
        // next command must provision a fresh container instead of being handed
        // this already-resolved promise and exec-ing into a removed container.
        // `disposePromise` stays latched (teardown is idempotent);
        // `ensureStarted()` clears it when a new container is provisioned.
        this.startPromise = undefined;
      }
    })();
    return this.disposePromise;
  }
}

async function runtimeAvailable(config: ContainerConfig, signal?: AbortSignal): Promise<boolean> {
  const runtime = config.runtime ?? 'docker';
  const probedAt = availableRuntimes.get(runtime);
  if (probedAt !== undefined && Date.now() - probedAt < RUNTIME_PROBE_TTL_MS) return true;
  try {
    await runShell(runtime, ['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: config.startupTimeoutMs ?? 10_000,
      signal,
      killTree: true,
    });
    availableRuntimes.set(runtime, Date.now());
    return true;
  } catch {
    // Drop any stale positive so the next call re-probes rather than trusting
    // a result the daemon has since invalidated.
    availableRuntimes.delete(runtime);
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
