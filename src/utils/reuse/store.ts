import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ReuseKey {
  workspaceRoot: string;
  engine: string;
  target: string;
  /** Which artefact: coverage, session, or incremental. */
  kind: string;
}

function storeRoot(dir?: string): string {
  return dir ?? join(tmpdir(), 'chaos-mcp-reuse');
}

function entryDir(key: ReuseKey, dir?: string): string {
  const id = createHash('sha256')
    .update(`${key.workspaceRoot}\0${key.engine}\0${key.target}\0${key.kind}`)
    .digest('hex');
  return join(storeRoot(dir), id);
}

function entryId(key: ReuseKey): string {
  return createHash('sha256')
    .update(`${key.workspaceRoot}\0${key.engine}\0${key.target}\0${key.kind}`)
    .digest('hex');
}

function lockDir(key: ReuseKey, dir?: string): string {
  return join(storeRoot(dir), `${entryId(key)}.lock`);
}

function sleepBriefly(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}

function withEntryLock(key: ReuseKey, dir: string | undefined, fn: () => void): void {
  const root = storeRoot(dir);
  const lock = lockDir(key, dir);
  const started = Date.now();
  mkdirSync(root, { recursive: true });
  while (true) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner'), `${process.pid}\n${Date.now()}`, 'utf8');
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10 * 60 * 1000) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > 30_000) return;
      sleepBriefly();
    }
  }
  try {
    fn();
  } finally {
    try {
      rmSync(lock, { recursive: true, force: true });
    } catch {
      // A failed unlock is harmless to the current operation; stale-lock
      // recovery lets a later operation reclaim it.
    }
  }
}

function currentPath(entry: string): string {
  return join(entry, 'current');
}

function copyArtefact(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
  try {
    cpSync(source, destination, { recursive: true });
  } catch (error) {
    try {
      rmSync(destination, { recursive: true, force: true });
    } catch {
      // A failed cleanup must not hide the original copy error.
    }
    throw error;
  }
}

/** Copy a stored artefact into the sandbox only if its fingerprint matches. */
export function seedArtefact(
  key: ReuseKey,
  fingerprint: string,
  destPath: string,
  dir?: string,
): boolean {
  try {
    const entry = entryDir(key, dir);
    const version = readFileSync(currentPath(entry), 'utf8').trim();
    if (!/^[0-9a-f-]{36}$/.test(version)) return false;
    const versionDir = join(entry, version);
    const metadata = JSON.parse(readFileSync(join(versionDir, 'metadata.json'), 'utf8')) as {
      fingerprint?: unknown;
    };
    if (metadata.fingerprint !== fingerprint) return false;
    const source = join(versionDir, 'artefact');
    if (!existsSync(source)) return false;
    copyArtefact(source, destPath);
    return true;
  } catch {
    return false;
  }
}

/** Store an artefact under a fingerprint, atomically. */
export function harvestArtefact(
  key: ReuseKey,
  fingerprint: string,
  srcPath: string,
  dir?: string,
): void {
  withEntryLock(key, dir, () => {
    const entry = entryDir(key, dir);
    const id = randomUUID();
    const scratch = join(entry, `${id}.tmp`);
    const pointerScratch = join(entry, `current.${id}.tmp`);
    try {
      if (!existsSync(srcPath)) return;
      mkdirSync(entry, { recursive: true });
      mkdirSync(scratch, { recursive: true });
      cpSync(srcPath, join(scratch, 'artefact'), { recursive: true });
      writeFileSync(join(scratch, 'metadata.json'), JSON.stringify({ fingerprint }), 'utf8');
      renameSync(scratch, join(entry, id));
      writeFileSync(pointerScratch, id, 'utf8');
      renameSync(pointerScratch, currentPath(entry));
      const current = readFileSync(currentPath(entry), 'utf8').trim();
      for (const name of readdirSync(entry)) {
        if (name !== current && /^[0-9a-f-]{36}$/.test(name)) {
          rmSync(join(entry, name), { recursive: true, force: true });
        }
      }
    } catch {
      // Reuse is an optimisation. A failed harvest must not fail the audit.
    } finally {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        // best effort
      }
      try {
        rmSync(pointerScratch, { force: true });
      } catch {
        // best effort
      }
    }
  });
}

/** Forget an entry. */
export function invalidateArtefact(key: ReuseKey, dir?: string): void {
  withEntryLock(key, dir, () => {
    try {
      rmSync(entryDir(key, dir), { recursive: true, force: true });
    } catch {
      // A missing or corrupt entry is already an invalidated entry.
    }
  });
}
