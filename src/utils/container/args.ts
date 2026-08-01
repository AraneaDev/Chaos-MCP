import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import type { SupportedProjectType } from '../project-detector.js';
import type { ContainerConfig } from '../config-loader.js';
import { ALL_DEPENDENCY_DIRS } from '../dependency-dirs.js';

/**
 * Host dependency trees that the sandbox may represent as symlinks.
 *
 * Derived from {@link ALL_DEPENDENCY_DIRS} rather than hand-written, so this and
 * `SYMLINK_DIRS` in utils/sandbox.ts cannot drift: a language whose descriptor
 * gains a dependency directory automatically gets its bind-mount here. Both the
 * CONTENTS and the ORDER matter — this list fixes the order of the generated
 * `--mount` argv — so container-args.test.ts pins the derived value against the
 * registry's own `dependencyDirectories()` the way sandbox.test.ts does.
 *
 * @internal Exported for testing only.
 */
export const SHARED_DEPENDENCY_DIRS: readonly string[] = ALL_DEPENDENCY_DIRS;

export function changedEnvironment(env: NodeJS.ProcessEnv | undefined): [string, string][] {
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

/**
 * Every `<virtualenv>/lib/python*` site-packages directory, in the order the
 * filesystem yields them. An unreadable or absent `lib` yields no paths: the
 * engine surfaces missing project dependencies through its normal error path
 * rather than failing container creation here.
 *
 * Exported for tests.
 */
export function discoverSitePackages(virtualenvPath: string): string[] {
  const sitePackages: string[] = [];
  try {
    for (const entry of readdirSync(`${virtualenvPath}/lib`, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('python')) continue;
      sitePackages.push(`${virtualenvPath}/lib/${entry.name}/site-packages`);
    }
  } catch {
    // The engine will surface missing project dependencies normally.
  }
  return sitePackages;
}

/**
 * `--env` pairs exposing a symlinked Python virtualenv to the container, or no
 * arguments when the project has none.
 */
function pythonEnvArgs(dependencyTargets: Map<string, string>): string[] {
  const virtualenv = dependencyTargets.get('.venv') ?? dependencyTargets.get('venv');
  if (!virtualenv) return [];
  const args: string[] = [];
  const sitePackages = discoverSitePackages(virtualenv);
  if (sitePackages.length > 0) {
    args.push('--env', `PYTHONPATH=${sitePackages.sort().join(':')}`);
  }
  // Keep the image's pinned Python and mutation engine ahead of project
  // scripts, while still exposing console scripts installed by the project.
  args.push(
    '--env',
    `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${virtualenv}/bin`,
  );
  return args;
}

/**
 * Read-only bind mounts for the host dependency trees the sandbox represents as
 * symlinks, plus the resolved target of each one so the caller can derive
 * language-specific environment from them.
 */
function dependencyMountArgs(workDir: string): { args: string[]; targets: Map<string, string> } {
  const args: string[] = [];
  const targets = new Map<string, string>();
  for (const dir of SHARED_DEPENDENCY_DIRS) {
    try {
      const candidate = `${workDir}/${dir}`;
      if (!lstatSync(candidate).isSymbolicLink()) continue;
      const target = realpathSync(candidate);
      targets.set(dir, target);
      args.push('--mount', mountArg(target, target, true));
    } catch {
      // Missing or unreadable dependency directories remain absent in the
      // container; the engine will surface its normal dependency error.
    }
  }
  return { args, targets };
}

/**
 * The full `create` argv for a session's container.
 *
 * Pure: everything it needs is a parameter, so the argv (mount ordering, tmpfs
 * size, uid/gid, python PATH) can be unit-tested without provisioning anything.
 * It does still read the host filesystem through {@link dependencyMountArgs},
 * which is what decides whether a dependency directory is a symlink worth
 * bind-mounting.
 */
export function buildCreateArgs(
  name: string,
  workDir: string,
  language: SupportedProjectType,
  config: ContainerConfig,
  image: string,
): string[] {
  const args = [
    'create',
    '--name',
    name,
    '--label',
    'io.chaos-mcp.runner=true',
    '--label',
    `io.chaos-mcp.language=${language}`,
    '--workdir',
    '/workspace',
    '--mount',
    mountArg(workDir, '/workspace'),
    '--read-only',
    // With a read-only root filesystem, /tmp is the ONLY writable scratch the
    // whole toolchain has: Cargo's registry, npm's cache, Infection's temp
    // dir, and every per-mutant working file land here. 512 MiB was too tight
    // for a Cargo registry download, so the size is a configurable default.
    '--tmpfs',
    `/tmp:rw,exec,nosuid,nodev,size=${config.tmpfsSizeMb ?? 2048}m`,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(config.pidsLimit ?? 512),
    '--network',
    config.network ?? 'bridge',
  ];

  args.push('--cpus', String(config.cpus ?? 2));
  args.push('--memory', `${config.memoryMb ?? 4096}m`);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== undefined && gid !== undefined) args.push('--user', `${uid}:${gid}`);

  const dependencies = dependencyMountArgs(workDir);
  args.push(...dependencies.args);
  if (language === 'python') args.push(...pythonEnvArgs(dependencies.targets));

  args.push(
    '--env',
    'HOME=/tmp/chaos-home',
    '--env',
    'XDG_CACHE_HOME=/tmp/chaos-cache',
    // Redirect every toolchain cache onto the writable tmpfs. The root
    // filesystem is read-only and the host dependency trees are mounted
    // read-only, so a tool that writes to its default cache location fails to
    // start: the rust image pins CARGO_HOME=/usr/local/cargo (read-only root)
    // and cargo needs to write its registry and .package-cache lock, and npm
    // and Composer are the same story one directory over.
    '--env',
    'CARGO_HOME=/tmp/chaos-cargo',
    '--env',
    'npm_config_cache=/tmp/chaos-npm',
    '--env',
    'COMPOSER_HOME=/tmp/chaos-composer-home',
    image,
    'sh',
    '-c',
    'while :; do sleep 3600; done',
  );
  return args;
}
