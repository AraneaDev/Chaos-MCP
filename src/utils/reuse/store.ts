import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
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

function currentPath(entry: string): string {
  return join(entry, 'current');
}

function copyArtefact(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
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
}

/** Forget an entry. */
export function invalidateArtefact(key: ReuseKey, dir?: string): void {
  try {
    rmSync(currentPath(entryDir(key, dir)), { force: true });
  } catch {
    // A missing or corrupt entry is already an invalidated entry.
  }
}
