import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { computeScope } from '../audit/scope.js';
import type { EnvironmentInfo } from '../utils/project-detector.js';
import type { ToolArgs } from '../core/tool-args-validation.js';

/**
 * `audit/scope.ts` decides which scoping mode a request is in — diff, baseline, runId,
 * or none — and had no test file. A mutation audit scored it 80.65% with 30 survivors,
 * and the ones it named were the type guards themselves: every mode works on its happy
 * path, but nothing asserted that a malformed or empty value is REJECTED.
 *
 * These cover the baseline and runId selectors. Each rejection case is chosen so the
 * mutant takes a visibly different path rather than merely computing the same answer
 * twice — a guard forced true only shows up on input it was supposed to turn away.
 *
 * The two SHORT-CIRCUIT paths — a diff-scoped run whose file did not change, and a
 * verify whose baseline recorded nothing — are covered further down. Both answer a
 * request without provisioning a sandbox or running an engine, so their payload IS
 * the whole response the caller ever sees; the assertions there are about the exact
 * keys of that response, not just its `kind`.
 */

const REL = 'src/target.ts';

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'chaos-scope-'));
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, REL), 'export const a = 1;\n');
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

const env = (): EnvironmentInfo => ({
  projectType: 'typescript',
  testRunner: 'vitest',
  detectedRunner: 'vitest',
  packageManager: '',
  workspaceRoot: ws,
});

const scopeFor = (args: ToolArgs) =>
  computeScope(args, join(ws, REL), env(), 'typescript', {}, REL);

describe('computeScope — baseline selector', () => {
  it('parses a well-formed baseline object into mutant keys', () => {
    return scopeFor({
      baseline: { survivors: [{ line: 1, mutators: { ConditionalExpression: 1 } }] },
    }).then((scope) => {
      expect(scope.kind).toBe('scope');
      if (scope.kind !== 'scope') return;
      expect(scope.baselineKeys).toEqual([{ line: 1, mutator: 'ConditionalExpression' }]);
    });
  });

  it('ignores a truthy baseline that is not an object', async () => {
    // The case that separates `&&` from `||` in the guard. A string is truthy, so an
    // `||` would enter the branch and hand a string to parseBaseline; the `&&` chain
    // must fall straight through with no baseline at all.
    const scope = await scopeFor({ baseline: 'not-an-object' as unknown as ToolArgs['baseline'] });

    expect(scope.kind).toBe('scope');
    if (scope.kind !== 'scope') return;
    expect(scope.baselineKeys).toBeUndefined();
  });

  it('ignores an array baseline', async () => {
    // typeof [] === 'object', so only the !Array.isArray arm rejects this one.
    const scope = await scopeFor({ baseline: [] as unknown as ToolArgs['baseline'] });

    expect(scope.kind).toBe('scope');
    if (scope.kind !== 'scope') return;
    expect(scope.baselineKeys).toBeUndefined();
  });

  it('resolves to no scope at all when no mode is requested', async () => {
    const scope = await scopeFor({});

    expect(scope.kind).toBe('scope');
    if (scope.kind !== 'scope') return;
    expect(scope.baselineKeys).toBeUndefined();
    expect(scope.diffRanges).toBeUndefined();
  });
});

describe('computeScope — runId selector', () => {
  it('ignores a runId that is only whitespace', async () => {
    // `runId.trim().length > 0` is doing real work here: without the trim, or with the
    // comparison relaxed to >= 0, a blank string would be treated as a cache lookup and
    // the request would fail with "not found" instead of running a normal audit.
    const scope = await scopeFor({ runId: '   ' });

    expect(scope.kind).toBe('scope');
    if (scope.kind !== 'scope') return;
    expect(scope.baselineKeys).toBeUndefined();
  });

  it('reports a clear error for a runId that is not in the cache', async () => {
    // The other arm: a non-blank runId MUST enter the lookup. If the guard is forced
    // false this falls through to a normal audit and silently ignores what the caller
    // asked for.
    const scope = await scopeFor({ runId: 'deadbeef' });

    expect(scope.kind).toBe('result');
    if (scope.kind !== 'result') return;
    expect((scope.result.content[0] as { text: string }).text).toContain('not found or expired');
  });
});

/** The `structuredContent` of a short-circuit resolution, as a plain object. */
const payloadOf = (scope: Awaited<ReturnType<typeof scopeFor>>): Record<string, unknown> => {
  if (scope.kind !== 'result') throw new Error('expected a short-circuit result');
  return scope.result.structuredContent as Record<string, unknown>;
};

/** The single text block of a short-circuit resolution. */
const textOf = (scope: Awaited<ReturnType<typeof scopeFor>>): string => {
  if (scope.kind !== 'result') throw new Error('expected a short-circuit result');
  return (scope.result.content[0] as { text: string }).text;
};

describe('computeScope — empty-baseline verify short-circuit', () => {
  // A baseline that recorded nothing is the DOCUMENTED happy path (`harden_file`
  // loops on a runId that is minted even for a clean file), and it answers in the
  // verify shape rather than the audit one. Nothing pinned that shape, so every
  // decision inside `nothingToVerifyResult` — whether a gate is attached at all,
  // whether the text projection carries the same verdict as the structured one —
  // was free to flip without a test noticing.
  const emptyBaseline = { survivors: [], noCoverage: [] };

  it('answers in the verify shape and attaches NO gate when minScore was not asked for', async () => {
    const scope = await scopeFor({ baseline: emptyBaseline });
    const payload = payloadOf(scope);

    expect(scope.kind).toBe('result');
    expect(payload.mode).toBe('verify');
    expect(payload.target).toBe(join(ws, REL));
    expect(payload.baselineTotal).toBe(0);
    expect(payload.killedCount).toBe(0);
    // Three empty lists, asserted individually: each is a separate literal in the
    // payload, and a client reading `stillSurviving.length === 0` is the reason
    // this branch exists at all.
    expect(payload.nowKilled).toEqual([]);
    expect(payload.stillSurviving).toEqual([]);
    expect(payload.newSurvivors).toEqual([]);
    expect(payload.note).toContain('recorded no uncaught mutants');
    // `gate` must be ABSENT, not present-and-undefined: a consumer written
    // `'gate' in result` reads the key itself as the promise `minScore` makes.
    // Assigning it unconditionally, or grading with an undefined threshold,
    // both show up here and nowhere else.
    expect(Object.keys(payload)).not.toContain('gate');
  });

  it('serialises the verify short-circuit as JSON unless text was requested', async () => {
    // The default projection. If the format check is forced the other way this
    // returns the human-readable report to a caller parsing JSON.
    const text = textOf(await scopeFor({ baseline: emptyBaseline }));

    expect(JSON.parse(text)).toMatchObject({ mode: 'verify', baselineTotal: 0 });
  });

  it('grades an empty baseline as passing when minScore was supplied', async () => {
    // The other arm of the same guard: nothing outstanding and nothing new, so
    // the verify gate passes — but only if the two lists it reads are actually
    // handed over empty.
    const payload = payloadOf(await scopeFor({ baseline: emptyBaseline, minScore: 80 }));

    expect(payload.gate).toEqual({ minScore: 80, passed: true });
  });

  it('renders the gate verdict on its own line of the text projection', async () => {
    const lines = textOf(
      await scopeFor({ baseline: emptyBaseline, minScore: 80, outputFormat: 'text' }),
    ).split('\n');

    // Exactly three lines, each checked in place. The count is the assertion that
    // catches a blanked join — one run-together line still "contains" every
    // fragment below, so `toContain` alone would not notice.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`Chaos-MCP Verify Report: ${join(ws, REL)}`);
    expect(lines[1]).toBe('Gate: passed (minScore 80)');
    expect(lines[2]).toContain('nothing to verify');
  });

  it('omits the gate line from text when no minScore was supplied', async () => {
    // The verdict line is conditional on the gate EXISTING. Pushing it
    // unconditionally formats an undefined gate; dropping it always loses the
    // verdict for the test above.
    const lines = textOf(await scopeFor({ baseline: emptyBaseline, outputFormat: 'text' })).split(
      '\n',
    );

    expect(lines).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith('Gate:'))).toEqual([]);
  });
});

describe('computeScope — diffBase selector', () => {
  it('ignores a diffBase that is not a string', async () => {
    // The type guard, not the truthiness check below it: a number is truthy, so
    // relaxing `typeof … === 'string'` hands `123` to git as a ref and turns a
    // plain audit into a diff error. `ws` is not a repository, which makes the
    // difference unmissable — the mutant cannot reach `{ kind: 'scope' }` at all.
    const scope = await scopeFor({ diffBase: 123 });

    expect(scope.kind).toBe('scope');
    if (scope.kind !== 'scope') return;
    expect(scope.diffRanges).toBeUndefined();
    expect(scope.scopeNote).toBeUndefined();
  });

  it('errors when diffBase is used outside a git work tree', async () => {
    const scope = await scopeFor({ diffBase: 'HEAD' });

    expect(scope.kind).toBe('result');
    expect(textOf(scope)).toContain('diffBase requires a git work tree');
  });
});

/**
 * The diff path is the largest untested region of this module, and all of it sits
 * behind a real repository: the no-changes SHORT-CIRCUIT (which returns a complete
 * audit payload without running an engine), the line-scoped ranges path, and the
 * two whole-file fallbacks. Mocking git would pin the argv and say nothing about
 * which branch a real `DiffResult` lands in, so these build a repository on disk.
 */
describe('computeScope — diff path against a real repository', () => {
  let repo: string;

  /** Fixture-only git, never the code under test. */
  const setupGit = (args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' });

  const scopeIn = (args: ToolArgs, projectType: 'typescript' | 'python' = 'typescript') =>
    computeScope(
      args,
      join(repo, REL),
      {
        projectType,
        testRunner: 'vitest',
        detectedRunner: 'vitest',
        packageManager: '',
        workspaceRoot: repo,
      },
      projectType,
      {},
      REL,
    );

  beforeEach(() => {
    // realpath: `tmpdir()` is a symlink on some platforms and git reports the
    // resolved path, which would put the pathspec outside the work tree.
    repo = mkdtempSync(join(realpathSync(tmpdir()), 'chaos-scope-repo-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    setupGit(['init', '-q', '-b', 'main', '.']);
    setupGit(['config', 'user.email', 'test@example.com']);
    setupGit(['config', 'user.name', 'Chaos Test']);
    setupGit(['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(repo, REL), 'export const a = 1;\nexport const b = 2;\n');
    setupGit(['add', '-A']);
    setupGit(['commit', '-qm', 'init']);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('short-circuits with a full audit payload when the file has not changed', async () => {
    // Nothing was touched since the commit, so no sandbox and no engine should be
    // provisioned — and the caller still gets the standard audit shape, because
    // they asked what the state of the file is, not whether a baseline still holds.
    const scope = await scopeIn({ diffBase: 'HEAD' });
    const payload = payloadOf(scope);

    expect(scope.kind).toBe('result');
    expect(payload.target).toBe(join(repo, REL));
    // "n/a", not "100%": a run that enumerated no mutants has no percentage, and
    // reporting one would read as proven coverage.
    expect(payload.mutationScore).toBe('n/a');
    expect(payload.summary).toEqual({ total: 0, killed: 0, survived: 0 });
    expect(payload.survivors).toEqual([]);
    expect(payload.scopeNote).toBe(
      `No changed lines in ${join(repo, REL)} vs HEAD; nothing to mutate.`,
    );
    // Same rule as the verify short-circuit: no minScore, no `gate` key.
    expect(Object.keys(payload)).not.toContain('gate');
    // And the default projection is JSON, not the text report.
    expect(JSON.parse(textOf(scope))).toMatchObject({ mutationScore: 'n/a' });
  });

  it('attaches a passing gate to the no-changes short-circuit when minScore is set', async () => {
    // The documented contract for minScore is "the result reports gate.passed,
    // never an error" — including on the path that never ran anything.
    const payload = payloadOf(await scopeIn({ diffBase: 'HEAD', minScore: 80 }));

    expect(payload.gate).toEqual({ minScore: 80, passed: true });
  });

  it('renders the no-changes short-circuit as text when text was requested', async () => {
    const text = textOf(await scopeIn({ diffBase: 'HEAD', minScore: 80, outputFormat: 'text' }));

    expect(text.startsWith(`Chaos-MCP Audit Report: ${join(repo, REL)}`)).toBe(true);
    expect(text).toContain('Gate: passed (minScore 80)');
  });

  it('line-scopes the run to the hunks that changed since the base', async () => {
    writeFileSync(
      join(repo, REL),
      'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
    );

    const scope = await scopeIn({ diffBase: 'HEAD' });

    // One appended line → one single-line hunk on the new side.
    //
    // Asserted STRICTLY, as the whole resolution: `computeScope` copies the diff
    // arm's fields into its own object and carries on, so the returned value
    // always declares all four keys. Handing the inner resolution straight back
    // instead — which is what treating every diff outcome as a short-circuit
    // would do — produces an object with only `kind` and `diffRanges`, and
    // nothing but key presence tells the two apart.
    expect(scope).toStrictEqual({
      kind: 'scope',
      diffRanges: [{ start: 3, end: 3 }],
      scopeNote: undefined,
      baselineKeys: undefined,
    });
  });

  it('mutates the whole file, with a note, when the engine cannot line-scope', async () => {
    // cosmic-ray takes no line ranges, so the same `ranges` DiffResult must come
    // back as a whole-file run that SAYS it was not scoped. Dropping the
    // capability check hands Python an unusable range list instead.
    writeFileSync(
      join(repo, REL),
      'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
    );

    const scope = await scopeIn({ diffBase: 'HEAD' }, 'python');

    expect(scope.kind).toBe('scope');
    if (scope.kind !== 'scope') return;
    expect(scope.diffRanges).toBeUndefined();
    expect(scope.scopeNote).toContain('diffBase scoping is not supported for python');
  });

  it('mutates the whole file, with a note, when the target is untracked', async () => {
    const untracked = 'src/brand-new.ts';
    writeFileSync(join(repo, untracked), 'export const n = 1;\n');

    const scope = await computeScope(
      { diffBase: 'HEAD' },
      join(repo, untracked),
      {
        projectType: 'typescript',
        testRunner: 'vitest',
        detectedRunner: 'vitest',
        packageManager: '',
        workspaceRoot: repo,
      },
      'typescript',
      {},
      untracked,
    );

    expect(scope.kind).toBe('scope');
    if (scope.kind !== 'scope') return;
    expect(scope.diffRanges).toBeUndefined();
    expect(scope.scopeNote).toContain('is untracked in git vs HEAD');
  });

  it('errors for a diffBase that git cannot resolve', async () => {
    // A repository, a tracked file, but no such ref — the one failure that must
    // NOT be reported as "not a git work tree".
    const scope = await scopeIn({ diffBase: 'no-such-ref' });

    expect(scope.kind).toBe('result');
    expect(textOf(scope)).toContain(
      'diffBase "no-such-ref" could not be resolved as a git ref (merge-base failed).',
    );
  });
});
