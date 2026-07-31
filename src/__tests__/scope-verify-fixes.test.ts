/**
 * Scope-resolution fixes: the empty-baseline escalation (High#1), the gate
 * dropped on the no-changes short-circuit (Fix 2), the run-cache workspace
 * binding (M10), and the `git-failed` consumer gap left by the git-diff split.
 *
 * These exercise `computeScope` directly rather than through `handleToolCall`:
 * every one of them is a decision the scope resolver makes BEFORE the sandbox
 * exists, and the handler tests would need a full engine stub to observe them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/git-diff.js', () => ({ computeChangedRanges: vi.fn() }));

import { computeChangedRanges } from '../utils/git-diff.js';
import { computeScope } from '../audit/scope.js';
import { auditFile } from '../audit/audit-file.js';
import { saveRun } from '../utils/run-cache.js';
import type { EnvironmentInfo } from '../utils/project-detector.js';
import type { ToolArgs } from '../tool-args-validation.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const mockDiff = vi.mocked(computeChangedRanges);

const WS = '/ws';
const FILE = 'src/math.ts';

function env(overrides: Partial<EnvironmentInfo> = {}): EnvironmentInfo {
  return {
    projectType: 'typescript',
    testRunner: 'vitest',
    detectedRunner: 'vitest',
    packageManager: '',
    workspaceRoot: WS,
    ...overrides,
  };
}

/** Run the resolver with this suite's defaults. */
function scope(args: ToolArgs, e: EnvironmentInfo = env()) {
  return computeScope(args, FILE, e, 'typescript', {}, FILE);
}

const textOf = (r: CallToolResult): string => (r.content[0] as { text: string }).text;
const structured = (r: CallToolResult): Record<string, unknown> =>
  r.structuredContent as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Fix 4: the `git-failed` variant added by the git-diff split ──────────────
/**
 * `DiffResult` gained `git-failed` (timeout / not-installed / other) and
 * `not-a-repo` narrowed to a genuine non-zero rev-parse exit. The switch here
 * had no default, so the new variant fell straight through with no ranges and
 * no note — a failed git call silently became a whole-file mutation run.
 */
describe('computeScope — git-failed', () => {
  it.each(['timeout', 'not-installed', 'other'] as const)(
    'surfaces a %s git failure as a tool error instead of mutating the whole file',
    async (reason) => {
      mockDiff.mockResolvedValue({ kind: 'git-failed', reason, message: 'git said no' });
      const res = await scope({ diffBase: 'main' });
      expect(res.kind).toBe('result');
      if (res.kind !== 'result') return;
      expect(res.result.isError).toBe(true);
      expect(textOf(res.result)).toContain(reason);
      expect(textOf(res.result)).toContain('git said no');
    },
  );

  it('does NOT blame the workspace for a git failure the way not-a-repo does', async () => {
    mockDiff.mockResolvedValue({ kind: 'git-failed', reason: 'timeout', message: 'timed out' });
    const res = await scope({ diffBase: 'main' });
    if (res.kind !== 'result') throw new Error('expected a short-circuit');
    expect(textOf(res.result)).not.toContain('not a git work tree');
  });
});

// ── Fix 2: minScore must produce a gate on every terminal path ───────────────
describe('computeScope — no-changes short-circuit', () => {
  beforeEach(() => mockDiff.mockResolvedValue({ kind: 'no-changes' }));

  it('attaches the gate when minScore was supplied', async () => {
    // tool-schema documents minScore as "the result reports gate.passed=false
    // (never an error)". This path returned NO gate key at all, so
    // `if (!result.gate.passed)` threw and `result.gate?.passed === true` read
    // an untouched file as a gate FAILURE.
    const res = await scope({ diffBase: 'main', minScore: 80 });
    if (res.kind !== 'result') throw new Error('expected a short-circuit');
    expect(res.result.isError).toBeUndefined();
    expect(structured(res.result).gate).toEqual({ minScore: 80, passed: true });
  });

  it('passes the gate for every valid minScore — the semantics are unchanged', async () => {
    for (const minScore of [0, 100]) {
      const res = await scope({ diffBase: 'main', minScore });
      if (res.kind !== 'result') throw new Error('expected a short-circuit');
      expect(structured(res.result).gate).toEqual({ minScore, passed: true });
    }
  });

  it('omits the gate when minScore was not supplied', async () => {
    const res = await scope({ diffBase: 'main' });
    if (res.kind !== 'result') throw new Error('expected a short-circuit');
    expect(structured(res.result).gate).toBeUndefined();
  });

  it('still reports the unchanged file as a success with a scope note', async () => {
    const res = await scope({ diffBase: 'main' });
    if (res.kind !== 'result') throw new Error('expected a short-circuit');
    expect(res.result.isError).toBeUndefined();
    expect(structured(res.result).scopeNote).toContain('No changed lines');
  });
});

// ── High#1: an empty baseline must not escalate into a whole-file run ────────
describe('computeScope — empty baseline', () => {
  it('short-circuits an explicit baseline with no recorded mutants', async () => {
    // Pre-fix this returned { kind: 'scope', diffRanges: [] }, and an EMPTY
    // array is truthy: auditFile set `lineRanges = []`, Stryker got the bare
    // file path, and the "verify" mutated the whole file.
    const res = await scope({ baseline: { survivors: [], noCoverage: [] } });
    expect(res.kind).toBe('result');
    if (res.kind !== 'result') return;
    expect(res.result.isError).toBeUndefined();
    expect(structured(res.result).scopeNote).toContain('nothing to verify');
  });

  it('short-circuits a cached run that recorded no survivors', async () => {
    // `mintRunId` runs for every non-verify audit INCLUDING a clean file, and
    // the harden_file prompt tells the agent to loop on that runId — so a
    // zero-survivor baseline is the documented happy path.
    // `workspaceRoot` mirrors what the real mint sites now pass; without it the
    // entry carries no workspace identity and the verify path refuses it (M10).
    const runId = saveRun(
      {
        file: FILE,
        projectType: 'typescript',
        survivors: [],
        noCoverage: [],
      },
      { workspaceRoot: WS },
    );
    const res = await scope({ runId });
    expect(res.kind).toBe('result');
    if (res.kind !== 'result') return;
    expect(res.result.isError).toBeUndefined();
    expect(textOf(res.result)).toContain('nothing to verify');
  });

  it('gates the nothing-to-verify short-circuit too', async () => {
    const runId = saveRun(
      { file: FILE, projectType: 'typescript', survivors: [], noCoverage: [] },
      { workspaceRoot: WS },
    );
    const res = await scope({ runId, minScore: 90 });
    if (res.kind !== 'result') throw new Error('expected a short-circuit');
    expect(structured(res.result).gate).toEqual({ minScore: 90, passed: true });
  });

  // These three previously asserted `diffRanges: [{ start: N, end: N }]` — one
  // single-line range per baseline line. That scoping was the bug: Stryker only
  // generates a mutant whose ENTIRE span fits inside the range, so every
  // multi-line mutant was excluded from the re-run and `computeVerifyDelta`,
  // which infers "killed" from absence, reported it as `nowKilled`. Verify now
  // re-runs whole-file and filters by baseline key, so `diffRanges` must stay
  // undefined while `baselineKeys` still carries what to filter by.
  it('does NOT line-scope a NON-empty baseline, but still carries its keys', async () => {
    const res = await scope({ baseline: { survivors: [{ line: 7, mutators: { Cond: 1 } }] } });
    expect(res).toMatchObject({
      kind: 'scope',
      diffRanges: undefined,
      baselineKeys: [{ line: 7, mutator: 'Cond' }],
    });
  });

  it('does NOT line-scope a NON-empty cached run either', async () => {
    const runId = saveRun(
      {
        file: FILE,
        projectType: 'typescript',
        survivors: [{ line: 12, mutators: { Cond: 1 } }],
        noCoverage: [],
      },
      { workspaceRoot: WS },
    );
    const res = await scope({ runId });
    expect(res).toMatchObject({
      kind: 'scope',
      diffRanges: undefined,
      baselineKeys: [{ line: 12, mutator: 'Cond' }],
    });
  });
});

// ── M10: the cached run must be bound to the workspace that minted it ────────
describe('computeScope — runId workspace binding', () => {
  it('refuses a runId minted in a different workspace', async () => {
    const runId = saveRun(
      {
        file: FILE,
        projectType: 'typescript',
        survivors: [{ line: 1, mutators: { C: 1 } }],
        noCoverage: [],
      },
      { workspaceRoot: '/some/other/workspace' },
    );
    const res = await scope({ runId });
    if (res.kind !== 'result') throw new Error('expected a short-circuit');
    expect(res.result.isError).toBe(true);
    expect(textOf(res.result)).toContain('different workspace');
  });

  it('accepts a runId minted in THIS workspace', async () => {
    const runId = saveRun(
      {
        file: FILE,
        projectType: 'typescript',
        survivors: [{ line: 3, mutators: { C: 1 } }],
        noCoverage: [],
      },
      { workspaceRoot: WS },
    );
    const res = await scope({ runId });
    // The workspace gate is what this test is about; the scope it returns is
    // whole-file (diffRanges undefined) with the baseline carried for filtering.
    expect(res).toMatchObject({
      kind: 'scope',
      diffRanges: undefined,
      baselineKeys: [{ line: 3, mutator: 'C' }],
    });
  });

  it('refuses an entry that carries NO workspace hash', async () => {
    // UPDATED (was: "accepts an entry that carries no workspace hash"). That
    // acceptance was an explicitly temporary bridge: while the mint sites still
    // omitted `workspaceRoot`, rejecting a hash-less entry would have broken
    // verify-by-runId permanently — the re-run the error asked for would have
    // minted another hash-less entry and failed identically. Both mint sites
    // (handler.ts and triage/audit-one.ts) now stamp the root, so an entry with
    // no workspace identity can only be a pre-fix leftover in the temp
    // directory, and "unknown workspace" must never be read as "any workspace".
    const runId = saveRun({
      file: FILE,
      projectType: 'typescript',
      survivors: [{ line: 5, mutators: { C: 1 } }],
      noCoverage: [],
    });
    const res = await scope({ runId });
    if (res.kind !== 'result') throw new Error('expected a short-circuit');
    expect(res.result.isError).toBe(true);
    expect(textOf(res.result)).toContain('without a workspace identity');
    // Actionable: the fix is a fresh audit, which now mints a stamped entry.
    expect(textOf(res.result)).toContain('re-run the audit here');
  });

  it('does not echo the cached entry when refusing a hash-less runId', async () => {
    // Same disclosure rule as the file / projectType mismatches: the entry is
    // read from a path derived from a CALLER-SUPPLIED id, so reflecting its
    // contents would make the error message a file-read primitive.
    const runId = saveRun({
      file: 'src/somewhere/else.ts',
      projectType: 'python',
      survivors: [{ line: 5, mutators: { C: 1 } }],
      noCoverage: [],
    });
    const res = await scope({ runId });
    if (res.kind !== 'result') throw new Error('expected a short-circuit');
    // `file` is checked first, so this is the file-mismatch message — but either
    // way nothing from the entry may appear.
    expect(textOf(res.result)).not.toContain('somewhere/else.ts');
    expect(textOf(res.result)).not.toContain('python');
  });

  it('refuses a runId recorded for a different project type', async () => {
    // Written onto every entry since the cache existed, never read. Mutator
    // names are engine-specific, so a cosmic-ray baseline verified through
    // StrykerJS reports every mutant as "now killed".
    // Stamped for THIS workspace so the workspace check (which runs first) is
    // satisfied and the projectType check is the one under test.
    const runId = saveRun(
      {
        file: FILE,
        projectType: 'python',
        survivors: [{ line: 1, mutators: { C: 1 } }],
        noCoverage: [],
      },
      { workspaceRoot: WS },
    );
    const res = await scope({ runId });
    if (res.kind !== 'result') throw new Error('expected a short-circuit');
    expect(res.result.isError).toBe(true);
    expect(textOf(res.result)).toContain('different project type');
    // The CACHED type is not echoed — it is content read from a path derived
    // from a caller-supplied id (same reasoning as the file-name check).
    expect(textOf(res.result)).not.toContain('python');
  });

  it('reports a corrupt cache entry as a miss, not as an engine crash', async () => {
    // A truncated/hand-edited entry whose survivors contain a null used to
    // throw a raw TypeError out of parseBaseline, surfacing as "Chaos Engine
    // Halted: Cannot read properties of null".
    const runId = saveRun(
      {
        file: FILE,
        projectType: 'typescript',
        survivors: [null as unknown as { line: number; mutators: Record<string, number> }],
        noCoverage: [],
      },
      { workspaceRoot: WS },
    );
    const res = await scope({ runId });
    if (res.kind !== 'result') throw new Error('expected a short-circuit');
    expect(res.result.isError).toBe(true);
    expect(textOf(res.result)).toContain('not found or expired');
  });
});

// ── High#1, consumer side: [] must not reach the engine as "no scope" ────────
describe('auditFile — empty lineRanges', () => {
  const baseInput = {
    targetFile: 'src/x.ts',
    env: env(),
    projectType: 'typescript' as const,
    args: {},
    config: {},
    workDir: '/tmp/sandbox',
    prebuildCmd: null,
  };

  it('does not forward an EMPTY range list to the engine', async () => {
    const run = vi.fn().mockResolvedValue({
      target: 'src/x.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });
    await auditFile({ ...baseInput, engine: { run } as never, lineRanges: [] });
    const opts = run.mock.calls[0][1] as { lineRanges?: unknown };
    // `[]` is truthy, so the old `if (lineRanges)` set it — and every consumer
    // reads "no ranges" as the whole file (buildMutateArg drops the :start-end
    // suffix; planLineBatches plans one batch over the file).
    expect(opts.lineRanges).toBeUndefined();
  });

  it('still forwards a NON-empty range list', async () => {
    const run = vi.fn().mockResolvedValue({
      target: 'src/x.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });
    await auditFile({ ...baseInput, engine: { run } as never, lineRanges: [{ start: 2, end: 4 }] });
    const opts = run.mock.calls[0][1] as { lineRanges?: unknown };
    expect(opts.lineRanges).toEqual([{ start: 2, end: 4 }]);
  });
});
