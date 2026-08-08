import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import type { SupportedProjectType } from '../project-detector.js';
import type { ContainerConfig, DependencyMode } from '../config-loader.js';
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

/**
 * The one directory inside a read-only `node_modules` that has to be writable.
 *
 * Vite's own path, hardcoded there rather than configurable; a bundler that
 * picks a different scratch location would need its own entry here.
 */
const VITE_TEMP_DIR = '.vite-temp';

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
 * Translate a host path under the sandbox `workDir` to its `/workspace/...`
 * guest equivalent — the SAME rule `ContainerExecutionSession.guestValue`
 * (execution.ts) applies at exec time. Inlined here rather than shared,
 * because the `--env` values this file bakes into the `create` argv are
 * fixed at container-creation time and never pass through `guestValue`
 * (which only rewrites the LATER `exec` argv) — so a path this function
 * hands back has to already be container-valid.
 *
 * A path outside `workDir` is returned unchanged: that is a host dependency
 * root {@link dependencyMountArgs} identity-mounted at its own absolute path
 * (`'share'`/`'link-entries'` below), not something living under `/workspace`.
 *
 * Unlike `guestValue`, this file's two callers (a virtualenv path and a
 * site-packages path under it) are never `workDir` itself — always at least
 * one segment below it — so there is no `hostPath === workDir` case to
 * special-case here the way `guestValue` (called with a bare `cwd`) does.
 */
function toGuestPath(workDir: string, hostPath: string): string {
  const prefix = `${workDir}/`;
  if (!hostPath.startsWith(prefix)) return hostPath;
  return `/workspace/${hostPath.slice(prefix.length)}`;
}

/**
 * `--env` pairs exposing a Python virtualenv to the container, or no
 * arguments when the project has none.
 *
 * `dependencyTargets.get('.venv'|'venv')` is a HOST path either way (see
 * {@link dependencyMountArgs}): under `'share'`/`'link-entries'` it is the
 * real host virtualenv, identity-mounted at that same absolute path, so it is
 * valid unchanged inside the container too. Under `'copy'` it is the
 * sandbox's OWN copy (no separate mount — the whole sandbox is already
 * `/workspace`), so `discoverSitePackages` reads it on the HOST filesystem
 * exactly as before, but the resulting env values must be translated to
 * their `/workspace/...` guest form via {@link toGuestPath} before they are
 * baked into `--env`.
 */
function pythonEnvArgs(workDir: string, dependencyTargets: Map<string, string>): string[] {
  const virtualenv = dependencyTargets.get('.venv') ?? dependencyTargets.get('venv');
  if (!virtualenv) return [];
  const args: string[] = [];
  const sitePackages = discoverSitePackages(virtualenv).map((p) => toGuestPath(workDir, p));
  if (sitePackages.length > 0) {
    args.push('--env', `PYTHONPATH=${sitePackages.sort().join(':')}`);
  }
  // Keep the image's pinned Python and mutation engine ahead of project
  // scripts, while still exposing console scripts installed by the project.
  args.push(
    '--env',
    `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${toGuestPath(workDir, virtualenv)}/bin`,
  );
  return args;
}

/**
 * Read-only bind mounts for the host dependency trees the sandbox represents,
 * plus the resolved target of each one so the caller can derive
 * language-specific environment from them.
 *
 * `dependencyMode` is passed in rather than inferred from the shape of
 * `workDir/<dir>` on disk — an earlier version tried to recover the host root
 * by resolving a sandbox entry's symlink with `realpathSync`, which broke on
 * every layout where an entry symlink's ultimate target is not the host
 * directory itself: npm/pnpm workspaces (`web -> ../packages/web` resolves to
 * `<repo>/packages`, not `<repo>/node_modules`), pnpm's own store layout, and
 * a plain `python3 -m venv`'s `lib64 -> lib` on Linux. The CALLER already
 * knows which mode provisioned the sandbox (the same value it passed to
 * `createSandbox`) and the workspace root the sandbox was copied from, so
 * there is nothing left to guess:
 *  - `'share'` — `workDir/<dir>` is ITSELF a symlink to the host tree (the
 *    only shape this function used to handle). Mount its target read-only at
 *    its own path (identity mount).
 *  - `'link-entries'` (the default) — `workDir/<dir>` is a REAL directory
 *    whose entries are individually symlinked to `join(workspaceRoot, dir)`
 *    BY CONSTRUCTION (`linkDependencyEntries` in
 *    utils/sandbox/dependency-link.ts always links to `join(hostDir,
 *    entry.name)`) — so mounting `join(workspaceRoot, dir)` itself, without
 *    looking at a single sandbox entry, makes every one of those symlinks
 *    resolve inside the container, regardless of what THEY point at.
 *  - `'copy'` — `workDir/<dir>` is a real, fully self-contained copy. It is
 *    already inside the read-write `/workspace` bind mount from
 *    {@link buildCreateArgs}, so nothing needs mounting; `targets` records its
 *    own (real, host-readable) sandbox path so `pythonEnvArgs` can still
 *    discover site-packages under it, translating that path to
 *    `/workspace/...` before it reaches `--env`.
 */
function dependencyMountArgs(
  workDir: string,
  workspaceRoot: string,
  dependencyMode: DependencyMode,
): { args: string[]; targets: Map<string, string> } {
  const args: string[] = [];
  const targets = new Map<string, string>();
  for (const dir of SHARED_DEPENDENCY_DIRS) {
    try {
      if (dependencyMode === 'share') {
        const candidate = `${workDir}/${dir}`;
        if (!lstatSync(candidate).isSymbolicLink()) continue;
        const target = realpathSync(candidate);
        targets.set(dir, target);
        args.push('--mount', mountArg(target, target, true));
        if (dir === 'node_modules') {
          args.push('--tmpfs', `${target}/${VITE_TEMP_DIR}:rw,nosuid,nodev,size=16m`);
        }
        continue;
      }
      if (dependencyMode === 'link-entries') {
        const hostDir = `${workspaceRoot}/${dir}`;
        if (!existsSync(hostDir)) continue;
        targets.set(dir, hostDir);
        args.push('--mount', mountArg(hostDir, hostDir, true));
        if (dir === 'node_modules') {
          // Vite writes a bundled copy of the config it is loading to
          // `<node_modules>/.vite-temp/` — for ANY config file, not just a
          // TypeScript one — so a read-only dependency tree makes every
          // vitest project fail its config load, which StrykerJS reports as
          // failed tests in the initial run. Overlay just that directory
          // rather than mounting the tree writable: project test code never
          // gets write access to the host's real dependencies, and the
          // scratch is discarded with the container.
          args.push('--tmpfs', `${hostDir}/${VITE_TEMP_DIR}:rw,nosuid,nodev,size=16m`);
        }
        continue;
      }
      // 'copy': the tree is already inside the sandbox, itself bind-mounted at
      // /workspace — nothing to mount, and no writable-tmpfs workaround needed
      // (that node_modules is already part of the writable /workspace mount).
      const candidate = `${workDir}/${dir}`;
      if (existsSync(candidate)) targets.set(dir, candidate);
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
 * It does still read the host filesystem through {@link dependencyMountArgs} to
 * confirm a dependency directory it was told about actually exists — `workDir`
 * is the sandbox copy, `workspaceRoot` is the ORIGINAL host tree it was copied
 * from, and `dependencyMode` is the same `sandbox.dependencies` value the
 * caller already passed to `createSandbox` for this same audit.
 */
export function buildCreateArgs(
  name: string,
  workDir: string,
  workspaceRoot: string,
  dependencyMode: DependencyMode,
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

  const dependencies = dependencyMountArgs(workDir, workspaceRoot, dependencyMode);
  args.push(...dependencies.args);
  if (language === 'python') args.push(...pythonEnvArgs(workDir, dependencies.targets));

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
