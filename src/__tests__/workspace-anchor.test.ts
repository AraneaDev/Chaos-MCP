import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * `anchorToWorkspace` returns two values that look alike and must NOT be alike:
 *
 * - `relFromRoot` is a KEY (run cache, suppressions file). The suppressions
 *   file is documented as portable/committable, so the key has to be identical
 *   on every machine — it is normalised to POSIX separators.
 * - `targetFile` is a real filesystem PATH handed to the sandbox and
 *   interpolated into engine CLI arguments. It keeps the platform separator.
 *
 * Neither half is observable on Linux CI on its own — `sep` is already `/`, so
 * the normalisation is an identity there and the Windows regression it fixes
 * cannot reproduce. These tests therefore swap `node:path` for `path.win32` /
 * `path.posix` and re-import the module, which is the only way to actually
 * execute the Windows branch on the platform this project's CI runs.
 */
async function loadAnchor(platform: 'posix' | 'win32') {
  vi.resetModules();
  vi.doMock('node:path', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:path')>();
    const impl = actual[platform];
    return { ...impl, default: impl, win32: actual.win32, posix: actual.posix };
  });
  return (await import('../utils/workspace-anchor.js')).anchorToWorkspace;
}

afterEach(() => {
  vi.doUnmock('node:path');
  vi.resetModules();
});

describe('anchorToWorkspace on Windows (path.win32)', () => {
  it('returns a POSIX key but a native-separator target', async () => {
    const anchorToWorkspace = await loadAnchor('win32');
    const anchor = anchorToWorkspace(
      'C:\\repo',
      'C:\\repo\\src\\utils\\foo.ts',
      'src/utils/foo.ts',
    );
    // The regression: this used to be `src\utils\foo.ts`, which a Linux CI run
    // would never look up — and the miss is silent, because an absent key
    // yields an empty verdict (0 applied, 0 drifted, 0 unverified).
    expect(anchor.relFromRoot).toBe('src/utils/foo.ts');
    // ...while the engine/sandbox path stays exactly what `relative()` produced.
    expect(anchor.targetFile).toBe('src\\utils\\foo.ts');
  });

  it('decides the containment guard on the RAW relative path, not the normalised one', async () => {
    const anchorToWorkspace = await loadAnchor('win32');
    // `..\a.ts` escapes the root, so `targetFile` falls back to the caller's
    // original path. The key is still normalised so the two never disagree
    // about which characters separate segments.
    const anchor = anchorToWorkspace('C:\\repo\\deep\\nested', 'C:\\repo\\a.ts', 'a.ts');
    expect(anchor.targetFile).toBe('a.ts');
    expect(anchor.relFromRoot).toBe('../../a.ts');
  });

  it('falls back when the file IS the root (empty relative path)', async () => {
    const anchorToWorkspace = await loadAnchor('win32');
    const anchor = anchorToWorkspace('C:\\repo\\a.ts', 'C:\\repo\\a.ts', 'a.ts');
    expect(anchor.relFromRoot).toBe('');
    expect(anchor.targetFile).toBe('a.ts');
  });

  it('falls back when the file sits on a different drive (absolute relative result)', async () => {
    const anchorToWorkspace = await loadAnchor('win32');
    const anchor = anchorToWorkspace('C:\\repo', 'D:\\other\\a.ts', 'D:\\other\\a.ts');
    expect(anchor.targetFile).toBe('D:\\other\\a.ts');
  });
});

describe('anchorToWorkspace on POSIX (path.posix)', () => {
  it('is an identity for the key — normalisation must not disturb the common case', async () => {
    const anchorToWorkspace = await loadAnchor('posix');
    const anchor = anchorToWorkspace('/repo', '/repo/src/utils/foo.ts', 'src/utils/foo.ts');
    expect(anchor.relFromRoot).toBe('src/utils/foo.ts');
    expect(anchor.targetFile).toBe('src/utils/foo.ts');
    // Key and target agree here, which is exactly why the Windows divergence
    // went unnoticed for so long.
    expect(anchor.relFromRoot).toBe(anchor.targetFile);
  });

  it('does not mangle a POSIX filename that legitimately contains a backslash', async () => {
    const anchorToWorkspace = await loadAnchor('posix');
    // Splitting on `sep` (rather than replacing backslashes unconditionally) is
    // what buys this: `weird\name.ts` is one segment on POSIX and stays one.
    const anchor = anchorToWorkspace('/repo', '/repo/src/weird\\name.ts', 'src/weird\\name.ts');
    expect(anchor.relFromRoot).toBe('src/weird\\name.ts');
    expect(anchor.targetFile).toBe('src/weird\\name.ts');
  });

  it('falls back to the caller path on a `..` escape', async () => {
    const anchorToWorkspace = await loadAnchor('posix');
    const anchor = anchorToWorkspace('/repo/deep', '/repo/a.ts', 'a.ts');
    expect(anchor.targetFile).toBe('a.ts');
    expect(anchor.relFromRoot).toBe('../a.ts');
  });
});
