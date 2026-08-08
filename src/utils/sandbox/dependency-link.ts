/**
 * Materialising a host dependency directory inside the sandbox.
 *
 * The sandbox used to symlink the whole directory — `sandbox/node_modules` →
 * `<workspace>/node_modules` — which made every write a test process performed
 * under that path land in the user's real tree. The container backend already
 * guarded against exactly this (`utils/container/args.ts` mounts the host trees
 * `readonly` and overlays a tmpfs on `node_modules/.vite-temp`, because Vite
 * writes a bundled copy of the config it loads there for ANY config file);
 * native execution had no equivalent.
 *
 * Entry-level linking keeps the cheap sharing and takes the directory back: the
 * sandbox owns a real `node_modules/`, and each installed package is a symlink
 * inside it. A tool creating a NEW path — `.vite-temp`, `.vite`, `.cache`, a
 * lockfile — creates it in the sandbox. Resolution is unchanged: Node realpaths
 * through a symlinked package exactly as it did through a symlinked directory
 * (`--preserve-symlinks` is off by default), so `__dirname` inside a dependency
 * still points at the host copy either way.
 *
 * A write THROUGH an existing entry still reaches the host. That residue is why
 * `SandboxConfig.dependencies` offers a `copy` mode; see utils/sandbox.ts.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, symlinkSync } from 'fs';
import { join, sep } from 'path';
import { warn } from '../logger.js';

/** Check whether the current platform is Windows. */
function isWindows(): boolean {
  return sep === '\\';
}

/**
 * Create a symlink (or junction on Windows) from `target` to `path`.
 *
 * `type` must match what `target` actually is: entry-level linking (see
 * {@link linkDependencyEntries}) reaches plain FILES — `.venv/pyvenv.cfg`,
 * `node_modules/.package-lock.json` — not just directories. On Linux/macOS the
 * argument is ignored, but on Windows a `'dir'` symlink to a file does not
 * resolve as a file, and the junction fallback below cannot target a file at
 * all (junctions are directories-only), so a mismatched type either produces a
 * broken link or — after the rethrow — a silently dropped entry. Defaults to
 * `'dir'` so the whole-directory caller (Task 3's `share` mode) keeps working
 * unchanged.
 *
 * On Windows, regular symlinks require Administrator privileges. Junctions do
 * not, and work for directories. We try `type` first, then fall back to
 * 'junction' on Windows if symlinkSync throws EPERM.
 *
 * Moved here from `utils/sandbox.ts` so the whole-directory and entry-level
 * link paths cannot drift on the fallback.
 */
export function safeSymlink(target: string, path: string, type: 'dir' | 'file' = 'dir'): void {
  try {
    symlinkSync(target, path, type);
  } catch (error: unknown) {
    // On Windows: EPERM means regular symlinks need Administrator privileges.
    // Retry with junction (directory hard-link) which doesn't require admin.
    // On non-Windows: EPERM is a genuine filesystem error (e.g. NFS root_squash)
    // — rethrow it directly; junction fallback does not exist on Linux/macOS.
    if (isWindows()) {
      try {
        // Junctions are directories-only: a file `target` always fails here
        // and falls through to the rethrow below, which is correct — there is
        // no junction equivalent for a file.
        symlinkSync(target, path, 'junction');
        return;
      } catch {
        // Junction also failed — rethrow original error
      }
    }
    throw error;
  }
}

/**
 * npm/pnpm scope directories are containers, not packages: a new scoped install
 * would otherwise land in the host tree through the scope's own symlink. One
 * level of recursion covers every real layout; nothing nests scopes.
 */
function isScopeDir(name: string): boolean {
  return name.startsWith('@');
}

/**
 * Whether `src` behaves as a directory — resolving THROUGH a symlink, unlike
 * `Dirent.isDirectory()`.
 *
 * `readdirSync(..., { withFileTypes: true })` fills each `Dirent` from an
 * `lstat`, so a `node_modules` entry that is itself a symlink to a package
 * directory reports `isDirectory() === false`. Under pnpm EVERY entry has that
 * shape, and under npm workspaces the first-party packages do — so the link
 * type handed to {@link safeSymlink} was `'file'` for all of them. POSIX
 * ignores the argument, which is why CI never saw it; on Windows with
 * Developer Mode enabled (no `EPERM`, so the junction fallback never fires)
 * `symlinkSync(dir, dst, 'file')` produces a file-symlink pointing at a
 * directory, which does not resolve as one and breaks module resolution
 * through it.
 *
 * A `statSync` failure (a dangling entry symlink — pnpm leaves these behind
 * after a partial install) falls back to the `Dirent`'s own answer rather than
 * dropping the entry: linking a dangling link with the wrong type is no worse
 * than the dangling link itself.
 */
function resolvesToDirectory(src: string, entry: { isDirectory(): boolean }): boolean {
  try {
    return statSync(src).isDirectory();
  } catch {
    return entry.isDirectory();
  }
}

/**
 * Make `sandboxDir` a real directory holding one symlink per entry of
 * `hostDir`. A destination that already exists is left alone — the copy filter
 * force-includes the audited file's ancestors, so a target living inside a
 * dependency directory is materialised for real and must not be relinked.
 *
 * Best-effort per entry: an unreadable host directory, or an entry that cannot
 * be linked, leaves that one package absent rather than failing provisioning
 * outright — a single broken package must not sink the whole audit. But
 * best-effort must not mean silent: a directory that fails to read, or where
 * every entry fails to link (an NFS `root_squash` workspace, a permission-
 * denied `node_modules`), leaves the sandbox copy empty while `createSandbox`
 * still resolves normally. Without a warning, the engine's own "module not
 * found" failure then gets reported as a bug in the audited code, when it is
 * really a sandbox provisioning failure — so both cases `warn()` loudly enough
 * to correct that diagnosis before it happens.
 */
export function linkDependencyEntries(hostDir: string, sandboxDir: string): void {
  let entries;
  try {
    entries = readdirSync(hostDir, { withFileTypes: true });
  } catch (error: unknown) {
    warn(
      `Could not read dependency directory "${hostDir}" while provisioning the sandbox ` +
        `(${error instanceof Error ? error.message : String(error)}). It will be missing from ` +
        `the sandbox — a failure the engine reports next is a provisioning problem, not a bug ` +
        `in the audited code.`,
    );
    return;
  }
  mkdirSync(sandboxDir, { recursive: true });
  let linked = 0;
  let failed = 0;
  for (const entry of entries) {
    const src = join(hostDir, entry.name);
    const dst = join(sandboxDir, entry.name);
    if (existsSync(dst)) continue;
    const isDir = resolvesToDirectory(src, entry);
    if (isDir && isScopeDir(entry.name)) {
      linkDependencyEntries(src, dst);
      continue;
    }
    try {
      safeSymlink(src, dst, isDir ? 'dir' : 'file');
      linked++;
    } catch {
      // One unlinkable entry must not fail the whole provision — counted and
      // reported below instead.
      failed++;
    }
  }
  if (failed > 0) {
    warn(
      `Linked ${linked} of ${linked + failed} ${linked + failed === 1 ? 'entry' : 'entries'} from ` +
        `"${hostDir}" into the sandbox (${failed} failed).` +
        (linked === 0
          ? ` The sandbox copy of "${hostDir}" is empty — a failure the engine reports next is a ` +
            `provisioning problem, not a bug in the audited code.`
          : ''),
    );
  }
}

/** True when `path` exists and is a symlink — used by the sandbox's own tests. */
export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
