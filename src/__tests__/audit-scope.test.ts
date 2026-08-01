import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
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
