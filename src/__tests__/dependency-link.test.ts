import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkDependencyEntries, isSymlink } from '../utils/sandbox/dependency-link.js';

describe('linkDependencyEntries', () => {
  let root: string;
  let host: string;
  let sandbox: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chaos-deplink-'));
    host = join(root, 'host');
    sandbox = join(root, 'sandbox', 'node_modules');
    mkdirSync(join(host, 'plain'), { recursive: true });
    mkdirSync(join(host, '@scope', 'pkg'), { recursive: true });
    writeFileSync(join(host, 'plain', 'index.js'), 'plain\n');
    writeFileSync(join(host, '@scope', 'pkg', 'index.js'), 'scoped\n');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('makes the dependency directory itself real, not a symlink', () => {
    linkDependencyEntries(host, sandbox);
    expect(lstatSync(sandbox).isSymbolicLink()).toBe(false);
    expect(lstatSync(sandbox).isDirectory()).toBe(true);
  });

  it('links each top-level entry so packages still resolve', () => {
    linkDependencyEntries(host, sandbox);
    expect(lstatSync(join(sandbox, 'plain')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(sandbox, 'plain', 'index.js'), 'utf8')).toBe('plain\n');
  });

  it('recurses one level into a scope directory so a new scoped package lands locally', () => {
    linkDependencyEntries(host, sandbox);
    expect(lstatSync(join(sandbox, '@scope')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(sandbox, '@scope', 'pkg')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(sandbox, '@scope', 'pkg', 'index.js'), 'utf8')).toBe('scoped\n');
  });

  it('leaves an entry that already exists in the sandbox alone', () => {
    mkdirSync(join(sandbox, 'plain'), { recursive: true });
    writeFileSync(join(sandbox, 'plain', 'index.js'), 'copied\n');
    linkDependencyEntries(host, sandbox);
    expect(lstatSync(join(sandbox, 'plain')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(sandbox, 'plain', 'index.js'), 'utf8')).toBe('copied\n');
  });

  it('is a no-op when the host directory does not exist', () => {
    expect(() => linkDependencyEntries(join(root, 'absent'), sandbox)).not.toThrow();
  });

  it('isSymlink distinguishes a linked entry from a real dir and a missing path', () => {
    linkDependencyEntries(host, sandbox);
    expect(isSymlink(join(sandbox, 'plain'))).toBe(true);
    expect(isSymlink(sandbox)).toBe(false); // real directory, not a symlink
    expect(isSymlink(join(sandbox, 'does-not-exist'))).toBe(false); // lstatSync throws
  });
});
