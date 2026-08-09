import { randomUUID } from 'node:crypto';
import { sep } from 'node:path';
import type { SupportedProjectType } from './project-detector.js';
import type { ContainerConfig, DependencyMode } from './config-loader.js';
import { ExecFailureError, type ExecResult } from './exec-error.js';
import { runShell, runShellCommand } from './exec.js';
import { warn } from './logger.js';
import { buildCreateArgs, changedEnvironment } from './container/args.js';
// Exactly one specifier for the process-lifetime registry — see the docblock in
// ./sandbox/registry.ts for why a second copy of that module would be silent.
import { registerContainer, unregisterContainer } from './sandbox/registry.js';

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

export const CONTAINER_IMAGE_VERSION = '1.8.0'; // x-release-please-version

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
  /** In-flight teardown, for de-duplicating CONCURRENT callers only. */
  private disposePromise: Promise<void> | undefined;
  /**
   * Whether a teardown has actually removed this session's container.
   *
   * Set only when `rm -f` SUCCEEDS, and cleared whenever a new container is
   * provisioned. A failed removal deliberately leaves it false so the next
   * {@link dispose} retries — see that method for the leak that caused.
   */
  private removed = false;
  private abortListener: (() => void) | undefined;

  constructor(
    readonly workDir: string,
    /**
     * The audited workspace root the sandbox at `workDir` was provisioned
     * from — NOT the same path as `workDir` itself. `dependencyMountArgs`
     * (utils/container/args.ts) needs it under `'link-entries'` mode: every
     * sandbox dependency-directory entry is symlinked to
     * `join(workspaceRoot, dir)` by construction, so mounting THAT directory
     * (not anything resolved from a sandbox entry) is what makes those
     * symlinks resolve inside the container.
     */
    private readonly workspaceRoot: string,
    /** The `sandbox.dependencies` mode that provisioned `workDir` — same value the caller passed to `createSandbox`. */
    private readonly dependencyMode: DependencyMode,
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
    return buildCreateArgs(
      this.name,
      this.workDir,
      this.workspaceRoot,
      this.dependencyMode,
      this.language,
      this.config,
      this.image,
    );
  }

  private async ensureStarted(): Promise<void> {
    if (this.containerId) return;
    if (this.startPromise) return this.startPromise;
    // A new provision supersedes any completed teardown: the container about to
    // be created has not been removed, whatever happened to its predecessor.
    this.removed = false;
    this.startPromise = (async () => {
      if (this.signal?.aborted) throw new Error('Container execution cancelled before startup.');
      // Arm cancellation BEFORE anything is created, not after `start` returns.
      // `addEventListener('abort', ...)` on an already-aborted signal never
      // fires, so registering at the end left a window — abort landing between
      // `start` resolving and the registration — in which the session owned a
      // RUNNING container and nothing was left that would ever tear it down.
      // (Both current callers also dispose in a `finally`, which masked it; the
      // listener is this class's stated cancellation mechanism and must actually
      // arm.) Registering first is safe because `dispose()` de-duplicates
      // concurrent callers and removes the container by name when `containerId`
      // is not set yet, which is exactly the state an abort during `create`
      // leaves behind.
      //
      // RESIDUAL RACE, by design: an abort landing mid-`create` runs `rm -f`
      // against a container the daemon may not have registered yet, and that
      // removal simply fails. Deferring the removal until `create` settles was
      // considered and rejected — every deferral scheme reopens a window
      // between the last in-flight check and the flag being cleared. Recovery
      // is what covers it instead: teardown is RETRYABLE (see `dispose`), so
      // the `catch` below issues a second `rm`, and the process-exit sweep
      // removes whatever still survives that.
      this.abortListener = () => void this.dispose();
      this.signal?.addEventListener('abort', this.abortListener, { once: true });
      // Process-lifetime ownership, taken BEFORE `create` is issued: from here
      // on a SIGINT/SIGTERM removes this container even though `process.exit()`
      // abandons the request's own `finally { dispose() }`.
      registerContainer(this.name, this.runtime);
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
        // The HOST cwd of the `docker exec` client (the guest working directory
        // is the `--workdir` above). Without it the client is tracked under
        // `process.cwd()`, so `killProcessesUnder(sandboxDir)` — how a sandbox
        // teardown reaps the engines still running in it — matches nothing in
        // container mode and every exec client survives the sandbox.
        cwd: this.workDir,
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

  /**
   * Remove this session's container. Safe to call repeatedly and from several
   * places at once; never throws.
   *
   * De-duplicates CONCURRENT callers through {@link disposePromise}, but does
   * NOT latch that promise once it settles: teardown has to stay RETRYABLE.
   * The sequence that made a permanent latch a leak: an abort lands while
   * `create` is in flight, the abort listener's `dispose()` runs `rm -f`
   * against a container the daemon has not registered yet, that removal fails
   * and is swallowed, the daemon then finishes creating the container, and
   * `ensureStarted`'s `catch { await this.dispose(); }` returned the already
   * settled promise instead of issuing a second `rm` — leaking the container
   * for the lifetime of the process.
   *
   * What DOES latch is {@link removed}, and only on a successful removal, so a
   * repeat call for a container that is already gone stays a cheap no-op.
   */
  async dispose(): Promise<void> {
    // Two passes at most: one to wait out a teardown already in flight (so two
    // callers never `rm` the same container concurrently), one to re-issue the
    // removal if that teardown did not actually get rid of it.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.removed) return;
      const inFlight = this.disposePromise;
      if (!inFlight) {
        await (this.disposePromise = this.removeContainer());
        return;
      }
      await inFlight;
    }
  }

  /** One `rm -f` attempt. Never throws; see {@link dispose} for the retry rule. */
  private removeContainer(): Promise<void> {
    return (async () => {
      if (this.abortListener) {
        this.signal?.removeEventListener('abort', this.abortListener);
        this.abortListener = undefined;
      }
      try {
        await runShell(this.runtime, ['rm', '-f', this.containerId ?? this.name], {
          timeoutMs: 15_000,
          killTree: true,
        });
        this.removed = true;
      } catch {
        // Best effort: the container may not have been created, or Docker may
        // already have removed it after a daemon-side failure. `removed` stays
        // false so a later dispose() — and, failing that, the process-exit
        // sweep over ACTIVE_CONTAINERS — tries again.
      } finally {
        this.containerId = undefined;
        // Drop the settled startup promise as well. A session survives its own
        // teardown — `run()` disposes the container on TIMEOUT/ABORTED and
        // TypeScriptEngine.runBatched keeps going with the next batch — so the
        // next command must provision a fresh container instead of being handed
        // this already-resolved promise and exec-ing into a removed container.
        this.startPromise = undefined;
        // Release the shutdown registry only for a container that is genuinely
        // gone; one whose removal failed must stay registered so the exit sweep
        // still reaches it.
        if (this.removed) unregisterContainer(this.name);
        // Clear the concurrency guard last: a dispose that starts AFTER this one
        // settles must be able to issue its own `rm`.
        this.disposePromise = undefined;
      }
    })();
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
 *
 * A per-language entry in `modes` wins over the global `mode`, so a project
 * whose suite crosses languages can keep the one language its images cannot
 * serve on native execution without giving up containers for the others.
 */
export async function createExecutionSession(
  language: SupportedProjectType,
  workDir: string,
  /** The audited workspace root the sandbox at `workDir` was provisioned from. See `ContainerExecutionSession`'s constructor doc for why the container backend needs it. */
  workspaceRoot: string,
  /** The `sandbox.dependencies` mode used to provision `workDir` — the same value the caller passed to `createSandbox`. */
  dependencyMode: DependencyMode,
  config: ContainerConfig | undefined,
  signal?: AbortSignal,
): Promise<ExecutionSession> {
  const mode = config?.modes?.[language] ?? config?.mode ?? 'native';
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
  return new ContainerExecutionSession(
    workDir,
    workspaceRoot,
    dependencyMode,
    language,
    config ?? {},
    signal,
  );
}

export function defaultContainerImage(language: SupportedProjectType): string {
  return DEFAULT_IMAGES[language];
}
