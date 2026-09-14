import { describe, it, expect, beforeEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { seedArtefact, harvestArtefact, invalidateArtefact } from '../utils/reuse/store.js';

let store: string;
let sandbox: string;
const key = { workspaceRoot: '/work', engine: 'python', target: 'calc.py', kind: 'session' };

beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), 'reuse-store-'));
  sandbox = mkdtempSync(join(tmpdir(), 'reuse-sbx-'));
});

describe('reuse store', () => {
  it('seeds nothing when the store is empty', () => {
    expect(seedArtefact(key, 'fp1', join(sandbox, 'session.sqlite'), store)).toBe(false);
  });

  it('round-trips a file under a matching fingerprint', () => {
    const src = join(sandbox, 'session.sqlite');
    writeFileSync(src, 'SESSION');
    harvestArtefact(key, 'fp1', src, store);
    const dest = join(sandbox, 'seeded.sqlite');
    expect(seedArtefact(key, 'fp1', dest, store)).toBe(true);
    expect(readFileSync(dest, 'utf-8')).toBe('SESSION');
  });

  it('refuses to seed under a different fingerprint', () => {
    const src = join(sandbox, 'session.sqlite');
    writeFileSync(src, 'SESSION');
    harvestArtefact(key, 'fp1', src, store);
    const dest = join(sandbox, 'seeded.sqlite');
    expect(seedArtefact(key, 'fp2', dest, store)).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });

  it('round-trips a directory artefact', () => {
    const src = join(sandbox, 'coverage');
    mkdirSync(join(src, 'xml'), { recursive: true });
    writeFileSync(join(src, 'junit.xml'), 'JUNIT');
    writeFileSync(join(src, 'xml', 'index.xml'), 'INDEX');
    harvestArtefact({ ...key, engine: 'php', kind: 'coverage' }, 'fp1', src, store);
    const dest = join(sandbox, 'reused');
    expect(seedArtefact({ ...key, engine: 'php', kind: 'coverage' }, 'fp1', dest, store)).toBe(
      true,
    );
    expect(readFileSync(join(dest, 'xml', 'index.xml'), 'utf-8')).toBe('INDEX');
  });

  it('forgets an invalidated entry', () => {
    const src = join(sandbox, 'session.sqlite');
    writeFileSync(src, 'SESSION');
    harvestArtefact(key, 'fp1', src, store);
    invalidateArtefact(key, store);
    expect(seedArtefact(key, 'fp1', join(sandbox, 'x'), store)).toBe(false);
  });

  it('keeps entries for different kinds and targets apart', () => {
    const src = join(sandbox, 'a');
    writeFileSync(src, 'A');
    harvestArtefact(key, 'fp1', src, store);
    expect(seedArtefact({ ...key, target: 'other.py' }, 'fp1', join(sandbox, 'b'), store)).toBe(
      false,
    );
    expect(seedArtefact({ ...key, kind: 'coverage' }, 'fp1', join(sandbox, 'c'), store)).toBe(
      false,
    );
  });

  it('never throws when the source is missing', () => {
    expect(() => harvestArtefact(key, 'fp1', join(sandbox, 'absent'), store)).not.toThrow();
  });

  it('bypasses corrupt metadata', () => {
    const src = join(sandbox, 'session.sqlite');
    writeFileSync(src, 'SESSION');
    harvestArtefact(key, 'fp1', src, store);
    const entry = readdirSync(store)[0];
    const entryPath = join(store, entry);
    const version = readFileSync(join(entryPath, 'current'), 'utf8');
    writeFileSync(join(entryPath, version, 'metadata.json'), '{broken');
    expect(seedArtefact(key, 'fp1', join(sandbox, 'x'), store)).toBe(false);
  });
});
