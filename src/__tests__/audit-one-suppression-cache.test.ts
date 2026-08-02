import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { auditTriageFile, type TriageFileDeps } from '../triage/audit-one.js';
import type { AuditDeadline } from '../utils/deadline.js';

/**
 * The suppressions memoization in `triage/audit-one.ts#suppressionsFor`.
 *
 * A sweep audits up to `maxFiles` files, almost always under ONE workspace root.
 * The suppressions file is therefore read once per WORKSPACE, not once per file —
 * that is the entire reason triage does not reuse `audit/suppression-io.ts`, and
 * the module comment says so explicitly.
 *
 * Dropping the memo changes no output at all: every file still gets the same
 * entries and the same row. It only turns one synchronous read-and-parse into N
 * of them, on the hot path of the sweep. Nothing but the call count can observe
 * that, so the call count is what these assert.
 *
 * The engine stack below `suppressionsFor` is stubbed at the sandbox: the memo
 * has already happened by the time provisioning is attempted, so failing there
 * exercises the whole path up to and including the memo without copying a
 * workspace or running a mutation engine.
 */

const loadSuppressionsSpy = vi.hoisted(() => vi.fn());

vi.mock('../utils/suppression.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/suppression.js')>();
  // The spy only RECORDS; the real loader still produces the return value. Note
  // the shape: `loadSuppressionsSpy.mockImplementation(actual.loadSuppressions)`
  // would be undone by this suite's `restoreMocks: true`, and the memo would then
  // cache `undefined` and re-read on every file — the exact behaviour under test.
  return {
    ...actual,
    loadSuppressions: (workspaceRoot: string, configPath?: string) => {
      loadSuppressionsSpy(workspaceRoot, configPath);
      return actual.loadSuppressions(workspaceRoot, configPath);
    },
  };
});

// Provisioning is where these tests stop. Left un-stubbed, `createSandbox`
// would copy a whole workspace per file for a property that is decided long
// before the copy begins.
const createSandboxMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/sandbox.js', () => ({ createSandbox: createSandboxMock }));

let tmpRoot: string;
let onProgress: ReturnType<typeof vi.fn>;

const deadlineWith = (remaining: number): AuditDeadline =>
  ({ remainingMs: () => remaining, expired: () => remaining <= 0 }) as unknown as AuditDeadline;

const deps = (over: Partial<TriageFileDeps> = {}): TriageFileDeps =>
  ({
    rootCwd: tmpRoot,
    cfg: {},
    args: {},
    diffBase: undefined,
    strykerConcurrency: undefined,
    survivorsPerFile: 0,
    suppressionCache: new Map(),
    deadline: deadlineWith(60_000),
    cleanupReserveMs: 5_000,
    onProgress,
    ...over,
  }) as TriageFileDeps;

/**
 * A workspace the root walk will actually stop at: `package.json` is the
 * TypeScript marker, so `detectEnvironment` resolves `env.workspaceRoot` to this
 * directory rather than wandering up to the process cwd. Absolute source paths
 * are used for the same reason — a relative path would be resolved against the
 * real repo and every file would share ITS root, which is the one thing these
 * tests must not accidentally rely on.
 */
const makeWorkspace = (name: string, files: string[]): { root: string; files: string[] } => {
  const root = join(tmpRoot, name);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name }));
  return {
    root,
    files: files.map((f) => {
      const abs = join(root, 'src', f);
      writeFileSync(abs, 'export const x = 1;\n');
      return abs;
    }),
  };
};

/** The workspace roots the loader was asked for, in call order. */
const loadedRoots = (): unknown[] => loadSuppressionsSpy.mock.calls.map((call) => call[0]);

beforeEach(() => {
  onProgress = vi.fn();
  tmpRoot = mkdtempSync(join(tmpdir(), 'chaos-supp-cache-'));
  loadSuppressionsSpy.mockClear();
  createSandboxMock.mockReset();
  createSandboxMock.mockRejectedValue(new Error('sandbox stubbed out'));
});

afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe('auditTriageFile — suppressions are read once per workspace, not once per file', () => {
  it('reads the suppressions file once for two files under the same workspace root', async () => {
    const ws = makeWorkspace('pkg', ['a.ts', 'b.ts']);
    const shared = deps();

    const first = await auditTriageFile(ws.files[0], shared);
    const second = await auditTriageFile(ws.files[1], shared);

    // Both files must genuinely have reached provisioning; otherwise a guard
    // short-circuiting above the memo would make the count below meaningless.
    expect(createSandboxMock).toHaveBeenCalledTimes(2);
    expect(first.error).toBeDefined();
    expect(second.error).toBeDefined();

    // The second file is served from the memo. Two reads here is the whole
    // regression: N synchronous reads and JSON parses per sweep.
    expect(loadSuppressionsSpy).toHaveBeenCalledTimes(1);
  });

  it('does not re-read for a third and fourth file either', async () => {
    // One extra read per file is linear in the sweep, so the property has to
    // hold for the whole file list rather than just the second entry.
    const ws = makeWorkspace('pkg', ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    const shared = deps();

    for (const file of ws.files) await auditTriageFile(file, shared);

    expect(createSandboxMock).toHaveBeenCalledTimes(4);
    expect(loadSuppressionsSpy).toHaveBeenCalledTimes(1);
  });

  it('memoizes against the workspace root, so a second package is still loaded', async () => {
    // The other arm of the memo. A sweep can legitimately span several monorepo
    // package roots, and each has its OWN suppressions file — serving package B
    // from package A's entries would apply the wrong suppressions to it.
    const a = makeWorkspace('pkg-a', ['a.ts']);
    const b = makeWorkspace('pkg-b', ['b.ts']);
    const shared = deps();

    await auditTriageFile(a.files[0], shared);
    await auditTriageFile(b.files[0], shared);

    expect(loadedRoots()).toEqual([a.root, b.root]);
  });

  it('keys the cache by the detected workspace root rather than by rootCwd', async () => {
    // `rootCwd` is the server's cwd and is deliberately NOT the cache key: in a
    // monorepo it differs from the package root the suppressions file lives in.
    const ws = makeWorkspace('pkg', ['a.ts']);
    const cache: TriageFileDeps['suppressionCache'] = new Map();

    await auditTriageFile(ws.files[0], deps({ suppressionCache: cache }));

    expect([...cache.keys()]).toEqual([ws.root]);
    expect(cache.has(tmpRoot)).toBe(false);
  });

  it('stores the loaded entries in the cache so a later file can be served from it', async () => {
    // The write half of the memo. Without it the lookup can never hit, and the
    // read count above is the only thing that would notice.
    const ws = makeWorkspace('pkg', ['a.ts']);
    mkdirSync(join(ws.root, '.chaos-mcp'), { recursive: true });
    writeFileSync(
      join(ws.root, '.chaos-mcp', 'suppressions.json'),
      JSON.stringify({
        version: 2,
        entries: {
          'src/a.ts': [
            { line: 1, mutator: 'ArithmeticOperator', addedAt: 1, fingerprint: 'deadbeef' },
          ],
        },
      }),
    );
    const cache: TriageFileDeps['suppressionCache'] = new Map();

    await auditTriageFile(ws.files[0], deps({ suppressionCache: cache }));

    // Cached value is the parsed entry map, not an empty placeholder: a later
    // file served from an empty cache entry would silently apply no suppressions.
    expect(cache.get(ws.root)?.get('src/a.ts')).toEqual([
      { line: 1, mutator: 'ArithmeticOperator', addedAt: 1, fingerprint: 'deadbeef' },
    ]);
  });

  it('reloads for a fresh sweep, because the memo lives on the deps cache', async () => {
    // Scoped to the passed-in Map, not to the module. A module-level memo would
    // hand a second sweep the suppressions file as it was during the first one.
    const ws = makeWorkspace('pkg', ['a.ts']);

    await auditTriageFile(ws.files[0], deps());
    await auditTriageFile(ws.files[0], deps());

    expect(loadSuppressionsSpy).toHaveBeenCalledTimes(2);
  });
});
