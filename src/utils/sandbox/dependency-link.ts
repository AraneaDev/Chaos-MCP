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
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync } from 'fs';
import { join, sep } from 'path';

/** Check whether the current platform is Windows. */
function isWindows(): boolean {
  return sep === '\\';
}

/**
 * Create a symlink (or junction on Windows) from `target` to `path`.
 *
 * On Windows, regular symlinks require Administrator privileges. Junctions do
 * not, and work for directories. We try 'dir' first, then fall back to
 * 'junction' on Windows if symlinkSync throws EPERM.
 *
 * Moved here from `utils/sandbox.ts` so the whole-directory and entry-level
 * link paths cannot drift on the fallback.
 */
export function safeSymlink(target: string, path: string): void {
  try {
    symlinkSync(target, path, 'dir');
  } catch (error: unknown) {
    // On Windows: EPERM means regular symlinks need Administrator privileges.
    // Retry with junction (directory hard-link) which doesn't require admin.
    // On non-Windows: EPERM is a genuine filesystem error (e.g. NFS root_squash)
    // — rethrow it directly; junction fallback does not exist on Linux/macOS.
    if (isWindows()) {
      try {
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
 * Make `sandboxDir` a real directory holding one symlink per entry of
 * `hostDir`. A destination that already exists is left alone — the copy filter
 * force-includes the audited file's ancestors, so a target living inside a
 * dependency directory is materialised for real and must not be relinked.
 *
 * Best-effort per entry: an unreadable host directory, or an entry that cannot
 * be linked, leaves that one package absent rather than failing provisioning.
 * The engine surfaces a missing dependency through its normal error path.
 */
export function linkDependencyEntries(hostDir: string, sandboxDir: string): void {
  let entries;
  try {
    entries = readdirSync(hostDir, { withFileTypes: true });
  } catch {
    return;
  }
  mkdirSync(sandboxDir, { recursive: true });
  for (const entry of entries) {
    const src = join(hostDir, entry.name);
    const dst = join(sandboxDir, entry.name);
    if (existsSync(dst)) continue;
    if (entry.isDirectory() && isScopeDir(entry.name)) {
      linkDependencyEntries(src, dst);
      continue;
    }
    try {
      safeSymlink(src, dst);
    } catch {
      // One unlinkable entry must not fail the whole provision.
    }
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
