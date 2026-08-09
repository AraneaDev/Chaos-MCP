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
import { AuditDeadline } from '../utils/deadline.js';
import { saveRun } from '../utils/run-cache.js';
import type { EnvironmentInfo } from '../utils/project-detector.js';
import type { ToolArgs } from '../core/tool-args-validation.js';
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

  // ── Fix 20: the gate must appear in the TEXT projection too ──
  it('renders the gate verdict in text output, not only in structuredContent', async () => {
    // This call passed no options to `formatResultAsText`, so a verdict that
    // existed in the payload was invisible to a caller reading only the text
    // block — the exact divergence the normal path threads the gate to avoid.
    const res = await scope({ diffBase: 'main', minScore: 80, outputFormat: 'text' });
    if (res.kind !== 'result') throw new Error('expected a short-circuit');
    const text = textOf(res.result);
    expect(text).toContain('Gate: passed (minScore 80)');
    // The SAME verdict the payload carries, not a second evaluation.
    expect(structured(res.result).gate).toEqual({ minScore: 80, passed: true });
  });

  it('keeps the text report coherent with the "n/a" score from Fix 7', async () => {
    // A run that generated no mutants has no percentage to report, and the gate
    // line quotes the DISPLAYED score. The two must not contradict each other.
    const res = await scope({ diffBase: 'main', minScore: 80, outputFormat: 'text' });
    if (res.kind !== 'result') throw new Error('expected a short-circuit');
    const text = textOf(res.result);
    expect(text).toContain('Mutation score: n/a (0/0 killed, 0 survived)');
    expect(text).toContain('Gate: passed (minScore 80)');
    expect(text).toContain('No mutants were run, so this result is not a measurement');
  });

  it('renders no gate line in text when no minScore was supplied', async () => {
    const res = await scope({ diffBase: 'main', outputFormat: 'text' });
    if (res.kind !== 'result') throw new Error('expected a short-circuit');
    expect(textOf(res.result)).not.toContain('Gate:');
  });
});

// ── High#1: an empty baseline must not escalate into a whole-file run ────────
describe('computeScope — empty baseline', () => {
  // REWRITTEN (Finding 12): the last assertion used to read
  // `structured(res.result).scopeNote`, i.e. it pinned the STANDARD AUDIT
  // payload for a call the client made in VERIFY mode. The tool's outputSchema
  // discriminates the two shapes with a `oneOf`, and a client written
  // `result.stillSurviving.length === 0` threw a TypeError here — on the most
  // common verify call there is. The short-circuit itself (what this test is
  // really about) is unchanged and still asserted; only the shape it answers in
  // is now the verify one, and the explanation moved from `scopeNote` to the
  // verify payload's `note`.
  it('short-circuits an explicit baseline with no recorded mutants, in the VERIFY shape', async () => {
    // Pre-fix this returned { kind: 'scope', diffRanges: [] }, and an EMPTY
    // array is truthy: auditFile set `lineRanges = []`, Stryker got the bare
    // file path, and the "verify" mutated the whole file.
    const res = await scope({ baseline: { survivors: [], noCoverage: [] } });
    expect(res.kind).toBe('result');
    if (res.kind !== 'result') return;
    expect(res.result.isError).toBeUndefined();
    const sc = structured(res.result);
    expect(sc.mode).toBe('verify');
    expect(sc.baselineTotal).toBe(0);
    expect(sc.killedCount).toBe(0);
    expect(sc.nowKilled).toEqual([]);
    expect(sc.stillSurviving).toEqual([]);
    expect(sc.newSurvivors).toEqual([]);
    expect(sc.note).toContain('nothing to verify');
    // …and NOT the standard audit report: those keys are what a verify client
    // must not have to defend against.
    expect(sc.mutationScore).toBeUndefined();
    expect(sc.summary).toBeUndefined();
    expect(sc.survivors).toBeUndefined();
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
    // Finding 12: the cached-runId route answers in the verify shape too — it
    // is the one the `harden_file` prompt loops on.
    expect(structured(res.result).mode).toBe('verify');
    expect(structured(res.result).stillSurviving).toEqual([]);
  });

  it('renders the clean-baseline verify as a Verify Report in text mode', async () => {
    // Finding 12: `outputFormat: 'text'` must be honoured on this path too, and
    // the header must say Verify, not Audit — a caller reading only the text
    // block otherwise cannot tell which question was answered.
    const runId = saveRun(
      { file: FILE, projectType: 'typescript', survivors: [], noCoverage: [] },
      { workspaceRoot: WS },
    );
    const res = await scope({ runId, outputFormat: 'text' });
    if (res.kind !== 'result') throw new Error('expected a short-circuit');
    const text = textOf(res.result);
    expect(text.startsWith('{')).toBe(false);
    expect(text).toContain(`Chaos-MCP Verify Report: ${FILE}`);
    expect(text).toContain('nothing to verify');
    expect(text).not.toContain('Chaos-MCP Audit Report');
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
  // ── Finding 4: a truncated/filtered response must not become a baseline ──
  describe('incomplete client-supplied baseline', () => {
    const groups = { survivors: [{ line: 7, mutators: { Cond: 1 } }] };

    it.each([
      'survivorsTruncated',
      'noCoverageTruncated',
      'survivorsFiltered',
      'noCoverageFiltered',
    ])('refuses a baseline whose response reported %s', async (counter) => {
      // Verify infers "killed" from ABSENCE, so a capped/filtered list reports
      // every group it omits as fixed — the same failure `mintRunId` documents
      // and guards against on the runId path.
      const res = await scope({ baseline: { ...groups, [counter]: 3 } });
      if (res.kind !== 'result') throw new Error('expected a refusal');
      expect(res.result.isError).toBe(true);
      expect(textOf(res.result)).toContain(counter);
      // Actionable: it names the uncapped alternative the caller already has.
      expect(textOf(res.result)).toContain('`runId`');
      expect(textOf(res.result)).toContain('maxSurvivors');
    });

    it('accepts a complete baseline exactly as before', async () => {
      // The documented workflow must be untouched — only the unsound variant is
      // refused. Zero counters are as good as absent ones.
      for (const b of [
        groups,
        { ...groups, survivorsTruncated: 0, noCoverageFiltered: 0 },
      ] as const) {
        const res = await scope({ baseline: b });
        expect(res).toMatchObject({
          kind: 'scope',
          baselineKeys: [{ line: 7, mutator: 'Cond' }],
        });
      }
    });

    it('is not fooled by a non-numeric counter', async () => {
      // The counters are read off a caller-supplied object; a string "3" is not
      // evidence of anything and must not error out a legitimate baseline.
      const res = await scope({
        baseline: { ...groups, survivorsTruncated: '3' } as unknown as Record<string, unknown>,
      });
      expect(res.kind).toBe('scope');
    });
  });

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

// ── The caller's controls reach the git subprocess ───────────────────────────
/**
 * `resolveDiffScope` builds one `GitOptions` object — `{ signal, timeoutMs }` —
 * and that is the ONLY channel by which a cancel reaches the git child process
 * and by which the audit's remaining wall-clock budget bounds it. Nothing read
 * the object back, so emptying it changed no answer: git calls would have
 * ignored a cancel and taken a fresh full timeout each.
 *
 * Asserted against the mocked `computeChangedRanges` rather than real git,
 * because the alternative — grading a 1ms budget by whether git actually timed
 * out — races a process that usually beats the timer.
 */
describe('computeScope — GitOptions threading', () => {
  const optionsOf = () => mockDiff.mock.calls[0][3] as { signal?: AbortSignal; timeoutMs?: number };

  beforeEach(() => mockDiff.mockResolvedValue({ kind: 'no-changes' }));

  it('forwards the caller signal and what remains of the deadline', async () => {
    const signal = new AbortController().signal;
    const deadline = new AuditDeadline(60_000);

    await computeScope({ diffBase: 'main' }, FILE, env(), 'typescript', {}, FILE, {
      signal,
      deadline,
    });

    const opts = optionsOf();
    expect(opts.signal).toBe(signal);
    // The remaining budget, not the configured one: discovery and sandboxing
    // spend from the same clock before the diff runs.
    expect(opts.timeoutMs).toBeGreaterThan(0);
    expect(opts.timeoutMs).toBeLessThanOrEqual(60_000);
  });

  it('leaves the timeout unset when the caller passes no deadline', async () => {
    // `gitCtx.deadline` is optional — the cancel-only context is a real call
    // shape — and `gitRunner` reads an undefined timeout as "use the default".
    // Without the second optional link this throws before git is ever reached.
    await computeScope({ diffBase: 'main' }, FILE, env(), 'typescript', {}, FILE, {
      signal: new AbortController().signal,
    });

    expect(optionsOf().timeoutMs).toBeUndefined();
  });

  it('passes an options object even when no context was supplied at all', async () => {
    await computeScope({ diffBase: 'main' }, FILE, env(), 'typescript', {}, FILE);

    expect(optionsOf()).toEqual({ signal: undefined, timeoutMs: undefined });
  });
});
