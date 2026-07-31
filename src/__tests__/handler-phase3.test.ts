import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { firstText } from './helpers/content.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { computeVerifyDelta } from '../verify.js';
import { applySuppressions } from '../audit/apply-suppressions.js';

// ── Mocks (mirror handler.test.ts so handleToolCall can run with a stub engine) ──
vi.mock('../engines/typescript.js', () => ({ TypeScriptEngine: vi.fn() }));
vi.mock('../engines/python.js', () => ({ PythonEngine: vi.fn() }));
vi.mock('../engines/go.js', () => ({ GoEngine: vi.fn() }));
vi.mock('../engines/rust.js', () => ({ RustEngine: vi.fn() }));

vi.mock('../utils/project-detector.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/project-detector.js')>(
    '../utils/project-detector.js',
  );
  return { ...actual, detectEnvironment: vi.fn() };
});

vi.mock('../utils/sandbox.js', () => ({ createSandbox: vi.fn() }));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    realpathSync: vi.fn((p: string) => p),
  };
});

vi.mock('../utils/exec.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/exec.js')>('../utils/exec.js');
  return { ...actual, runShellCommand: vi.fn() };
});

vi.mock('../utils/git-diff.js', () => ({ computeChangedRanges: vi.fn() }));

vi.mock('../utils/logger.js', () => ({
  enableVerbose: vi.fn(),
  isVerbose: vi.fn(() => false),
  log: vi.fn(),
  warn: vi.fn(),
}));

import { handleToolCall } from '../index.js';
import { TypeScriptEngine } from '../engines/typescript.js';
import { detectEnvironment } from '../utils/project-detector.js';
import { createSandbox } from '../utils/sandbox.js';
import { loadRun, saveRun, workspaceFingerprint } from '../utils/run-cache.js';
import { loadSuppressions, addSuppressions, fingerprintSourceLine } from '../utils/suppression.js';
import type { MutationResult } from '../engines/base.js';

const MockTSEngine = vi.mocked(TypeScriptEngine);
const mockDetectEnv = vi.mocked(detectEnvironment);
const mockCreateSandbox = vi.mocked(createSandbox);

// A REAL workspace on disk, not a synthetic '/workspace': suppressions are now
// fingerprinted against the source line they target, so the write path has to be
// able to read src/math.ts to stamp one and the read path has to be able to
// re-read it to confirm the stamp still matches.
const WS = mkdtempSync(join(tmpdir(), 'chaos-ws-'));
const FILE = 'src/math.ts';
mkdirSync(join(WS, 'src'), { recursive: true });
writeFileSync(
  join(WS, FILE),
  [
    'export function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '',
    'export function pick(a: number, b: number): number {',
    '  // line 6',
    '  if (a > b) return a;',
    '  return a - b;',
    '}',
    '',
  ].join('\n'),
  'utf8',
);

function makeRequest(args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name: 'audit_code_resilience', arguments: args } };
}

function stubEngine(result: MutationResult): ReturnType<typeof vi.fn> {
  const run = vi.fn().mockResolvedValue(result);
  MockTSEngine.mockImplementation(() => ({ run }) as unknown as TypeScriptEngine);
  return run;
}

function cleanResult(): MutationResult {
  return {
    target: FILE,
    totalMutants: 4,
    killed: 4,
    survived: 0,
    mutationScore: '100.00%',
    vulnerabilities: [],
  };
}

function resultWithSurvivor(): MutationResult {
  return {
    target: FILE,
    totalMutants: 4,
    killed: 3,
    survived: 1,
    mutationScore: '75.00%',
    vulnerabilities: [
      {
        line: 7,
        mutator: 'ConditionalExpression',
        description: 'Survived: changed condition',
      },
    ],
  };
}

function resultWithTwoSurvivors(): MutationResult {
  return {
    target: FILE,
    totalMutants: 5,
    killed: 3,
    survived: 2,
    mutationScore: '60.00%',
    vulnerabilities: [
      {
        line: 7,
        mutator: 'ConditionalExpression',
        description: 'Survived: changed condition',
      },
      {
        line: 8,
        mutator: 'ArithmeticOperator',
        description: 'Survived: arithmetic operator change',
      },
    ],
  };
}

describe('phase3 run-cache integration seam', () => {
  it('a saved run is retrievable by the id it returns', () => {
    const id = saveRun({
      file: 'src/x.ts',
      projectType: 'typescript',
      survivors: [{ line: 3, mutators: { Cond: 1 } }],
      noCoverage: [],
    });
    const got = loadRun(id);
    expect(got?.survivors[0].line).toBe(3);
  });
});

describe('handleToolCall phase3 wiring', () => {
  // `restoreMocks: true` un-installs this spy before every test, so it has to be
  // re-installed per test rather than once at describe-collection time.
  let cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(WS);
  afterAll(() => cwdSpy.mockRestore());

  let supPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(WS);
    mockCreateSandbox.mockResolvedValue({
      workDir: '/tmp/chaos-mcp-sandbox',
      targetFile: '',
      cleanup: vi.fn(),
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: WS,
    });
    // Isolate suppression writes to a throwaway absolute file per test.
    supPath = join(mkdtempSync(join(tmpdir(), 'chaos-sup-')), 'suppressions.json');
  });

  it('mints a runId on a non-verify run and the cache round-trips the survivors', async () => {
    stubEngine(resultWithSurvivor());
    // Pin an isolated suppressions path: with the default, this would read
    // <workspaceRoot>/.chaos-mcp on machines where the mocked /workspace exists,
    // letting stray suppressions filter out the survivor under test.
    const res = await handleToolCall(makeRequest({ filePath: FILE }), {
      suppressionsPath: supPath,
    });
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    const runId = sc.runId as string;
    expect(typeof runId).toBe('string');
    const cached = loadRun(runId);
    // Keyed by the workspace-relative path (relative(workspaceRoot, resolvedFile)),
    // which equals FILE here since cwd === workspaceRoot.
    expect(cached?.file).toBe(FILE);
    expect(cached?.survivors[0]).toMatchObject({ line: 7 });
  });

  it('keys the run-cache by the workspace-relative path when cwd differs from workspaceRoot', async () => {
    // workspaceRoot is a subdir of cwd (monorepo). The cached `file` must be
    // relative to workspaceRoot, NOT the absolute resolvedFile — this is where
    // the absolute-vs-relative bug manifested (and where triage keys must agree).
    const subRoot = `${WS}/packages/app`;
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: subRoot,
    });
    stubEngine(resultWithSurvivor());
    const res = await handleToolCall(makeRequest({ filePath: 'packages/app/src/math.ts' }), {
      suppressionsPath: supPath,
    });
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    const cached = loadRun(sc.runId as string);
    expect(cached?.file).toBe('src/math.ts');
  });

  /**
   * Audit M10, mint side. `relFromRoot` is a workspace-RELATIVE key, so without
   * a workspace fingerprint on the entry a runId minted for workspace A's
   * `src/math.ts` satisfied the verify path's `cached.file === relFile` check
   * while pointed at workspace B's `src/math.ts` — a different file — and the
   * verify reported B's code as "still surviving / now killed" against A's
   * mutants. `handleToolCall` now passes `env.workspaceRoot` to `mintRunId`.
   */
  it('stamps the minted entry with the audited workspace', async () => {
    stubEngine(resultWithSurvivor());
    const res = await handleToolCall(makeRequest({ filePath: FILE }), {
      suppressionsPath: supPath,
    });
    const sc = res.structuredContent as Record<string, unknown>;
    const cached = loadRun(sc.runId as string);
    expect(cached?.workspaceHash).toBe(workspaceFingerprint(WS));
  });

  it('accepts its own minted runId back for a verify in the same workspace', async () => {
    // The round trip the whole feature exists for: mint → verify by id. It has
    // to pass the file, workspace and projectType gates in one go.
    stubEngine(resultWithSurvivor());
    const minted = await handleToolCall(makeRequest({ filePath: FILE }), {
      suppressionsPath: supPath,
    });
    const runId = (minted.structuredContent as Record<string, unknown>).runId as string;

    const run = stubEngine(resultWithSurvivor());
    const verified = await handleToolCall(makeRequest({ filePath: FILE, runId }), {
      suppressionsPath: supPath,
    });
    expect(verified.isError).toBeUndefined();
    expect(verified.structuredContent).toMatchObject({ mode: 'verify' });
    expect(run).toHaveBeenCalledWith(
      FILE,
      expect.objectContaining({ lineRanges: [{ start: 7, end: 7 }] }),
    );
  });

  it('refuses a runId minted in a DIFFERENT workspace for the same relative path', async () => {
    // Both workspaces contain `src/math.ts`, so `cached.file === relFile` alone
    // was satisfied and the verify graded the wrong file's code.
    const otherWs = mkdtempSync(join(tmpdir(), 'chaos-other-ws-'));
    const runId = saveRun(
      {
        file: FILE,
        projectType: 'typescript',
        survivors: [{ line: 7, mutators: { ConditionalExpression: 1 } }],
        noCoverage: [],
      },
      { workspaceRoot: otherWs },
    );
    stubEngine(resultWithSurvivor());
    const res = await handleToolCall(makeRequest({ filePath: FILE, runId }));
    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain('different workspace');
    rmSync(otherWs, { recursive: true, force: true });
  });

  it('refuses a runId that carries no workspace identity at all', async () => {
    // A leftover from a pre-M10 server still sitting in the temp directory.
    // Costs exactly one re-run, and that re-run now mints a stamped entry.
    const runId = saveRun({
      file: FILE,
      projectType: 'typescript',
      survivors: [{ line: 7, mutators: { ConditionalExpression: 1 } }],
      noCoverage: [],
    });
    stubEngine(resultWithSurvivor());
    const res = await handleToolCall(makeRequest({ filePath: FILE, runId }));
    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain('without a workspace identity');
  });

  it('does NOT mint a runId on a verify-by-runId run', async () => {
    const runId = saveRun(
      {
        file: FILE, // workspace-relative key (matches relative(workspaceRoot, resolvedFile))
        projectType: 'typescript',
        survivors: [{ line: 7, mutators: { ConditionalExpression: 1 } }],
        noCoverage: [],
      },
      // Stamps the workspace fingerprint, exactly as handleToolCall's own mint
      // site now does (audit M10). An entry with no workspace identity is
      // refused by computeScope, so a hand-built one has to carry it too.
      { workspaceRoot: WS },
    );
    const run = stubEngine(resultWithSurvivor());
    const res = await handleToolCall(makeRequest({ filePath: FILE, runId }));
    expect(res.isError).toBeUndefined();
    // Verify mode now carries structuredContent matching the outputSchema's
    // verify-delta variant (audit H3).
    expect(res.structuredContent).toMatchObject({ mode: 'verify', target: FILE });
    // Scope was derived from the baseline lines (TS supports line scope).
    expect(run).toHaveBeenCalledWith(
      FILE,
      expect.objectContaining({ lineRanges: [{ start: 7, end: 7 }] }),
    );
  });

  it('rejects an unknown runId with a clear error', async () => {
    stubEngine(cleanResult());
    const res = await handleToolCall(makeRequest({ filePath: FILE, runId: 'deadbeef' }));
    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain('not found or expired');
  });

  it('rejects a runId whose cached file does not match the target', async () => {
    const runId = saveRun(
      {
        file: 'src/other.ts', // a different workspace-relative file than the target
        projectType: 'typescript',
        survivors: [{ line: 1, mutators: { Cond: 1 } }],
        noCoverage: [],
      },
      // Right workspace, wrong file — so the file check is the one under test.
      { workspaceRoot: WS },
    );
    stubEngine(cleanResult());
    const res = await handleToolCall(makeRequest({ filePath: FILE, runId }));
    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain('was recorded for a different file');
    // The cached file name is deliberately NOT echoed: it is content read from
    // a path derived from a caller-supplied id, so reflecting it would turn
    // this error message into a file-read primitive.
    expect(firstText(res)).not.toContain('src/other.ts');
  });

  it('filters suppressed mutants out of the result and reports suppressedCount', async () => {
    // Awaited: the entry has to be on disk (and fingerprint-stamped) before the
    // audit reads it back.
    await addSuppressions(WS, FILE, [{ line: 7, mutator: 'ConditionalExpression' }], supPath);
    stubEngine(resultWithSurvivor());
    const res = await handleToolCall(makeRequest({ filePath: FILE }), {
      suppressionsPath: supPath,
    });
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.suppressedCount).toBe(1);
    expect(sc.survivors).toEqual([]);
  });

  it('writes a suppression on suppress and applies it within the same call', async () => {
    stubEngine(resultWithSurvivor());
    const res = await handleToolCall(
      makeRequest({
        filePath: FILE,
        suppress: [{ line: 7, mutator: 'ConditionalExpression', reason: 'equivalent' }],
      }),
      { suppressionsPath: supPath },
    );
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.suppressedCount).toBe(1);
    const persisted = loadSuppressions(WS, supPath).get(FILE);
    const stored = persisted?.find((e) => e.line === 7 && e.mutator === 'ConditionalExpression');
    expect(stored).toBeDefined();
    // The write stamped a content fingerprint — that is what let the same call
    // apply it (an unstamped entry would have come back as `unverified`).
    expect(stored?.fingerprint).toBe(fingerprintSourceLine(WS, FILE, 7));
    expect(sc.unverifiedSuppressions).toBeUndefined();
  });

  it('a suppression whose source line changed is reported as drifted, not applied', async () => {
    await addSuppressions(WS, FILE, [{ line: 7, mutator: 'ConditionalExpression' }], supPath);
    // Rewrite line 7 into genuinely different code. The stored fingerprint no
    // longer matches, so the suppression must NOT be applied — the survivor
    // comes back and the response says why.
    const original = readFileSync(join(WS, FILE), 'utf8');
    const lines = original.split('\n');
    lines[6] = '  if (a >= b) return b;';
    writeFileSync(join(WS, FILE), lines.join('\n'), 'utf8');
    try {
      stubEngine(resultWithSurvivor());
      const res = await handleToolCall(makeRequest({ filePath: FILE }), {
        suppressionsPath: supPath,
      });
      const sc = res.structuredContent as Record<string, unknown>;
      expect(sc.suppressedCount).toBeUndefined();
      expect(sc.driftedSuppressions).toBe(1);
      expect((sc.survivors as unknown[]).length).toBe(1);
      expect(sc.note).toContain('no longer match the code they were recorded against');
    } finally {
      writeFileSync(join(WS, FILE), original, 'utf8');
    }
  });

  it('a v1 (unfingerprinted) entry is reported as unverified and is not applied', async () => {
    // The migration case: a suppressions file written before fingerprinting.
    mkdirSync(dirname(supPath), { recursive: true });
    writeFileSync(
      supPath,
      JSON.stringify({
        version: 1,
        entries: {
          [FILE]: [
            { line: 7, mutator: 'ConditionalExpression', reason: 'legacy', addedAt: 1700000000000 },
          ],
        },
      }),
      'utf8',
    );
    stubEngine(resultWithSurvivor());
    const res = await handleToolCall(makeRequest({ filePath: FILE }), {
      suppressionsPath: supPath,
    });
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.suppressedCount).toBeUndefined();
    expect(sc.unverifiedSuppressions).toBe(1);
    expect(sc.note).toContain('predate content fingerprinting');
    // ...and re-issuing the same suppress argument promotes it: the reason is
    // kept, a fingerprint is stamped, and it applies in that very call.
    const again = await handleToolCall(
      makeRequest({
        filePath: FILE,
        suppress: [{ line: 7, mutator: 'ConditionalExpression' }],
      }),
      { suppressionsPath: supPath },
    );
    const sc2 = again.structuredContent as Record<string, unknown>;
    expect(sc2.suppressedCount).toBe(1);
    expect(sc2.unverifiedSuppressions).toBeUndefined();
    const stored = loadSuppressions(WS, supPath).get(FILE)?.[0];
    expect(stored?.reason).toBe('legacy'); // hand-written argument survives
    expect(stored?.addedAt).toBe(1700000000000); // original provenance survives
    expect(stored?.fingerprint).toBe(fingerprintSourceLine(WS, FILE, 7));
  });

  it('suppressed mutants are excluded from verify-mode delta (not stillSurviving nor nowKilled)', async () => {
    // Task 9: a suppression for the same (line, mutator) that the baseline tracks
    // must cause that mutant to vanish from the delta entirely — neither reported as
    // stillSurviving nor nowKilled. Both the baseline keys and the re-run are
    // filtered by the suppression set before computeVerifyDelta (A9).
    // Strengthened: include a non-suppressed mutant to ensure filtering doesn't corrupt
    // the entire result — this catches misimplementations that filter neither, only
    // baseline, or only re-run.
    await addSuppressions(WS, FILE, [{ line: 7, mutator: 'ConditionalExpression' }], supPath);
    const runId = saveRun(
      {
        file: FILE,
        projectType: 'typescript',
        survivors: [
          { line: 7, mutators: { ConditionalExpression: 1 } },
          { line: 8, mutators: { ArithmeticOperator: 1 } },
        ],
        noCoverage: [],
      },
      { workspaceRoot: WS }, // stamped, as the real mint site now does (M10)
    );
    stubEngine(resultWithTwoSurvivors()); // re-run still surfaces both survivors
    const res = await handleToolCall(makeRequest({ filePath: FILE, runId }), {
      suppressionsPath: supPath,
    });
    expect(res.isError).toBeUndefined();
    // Verify mode now emits structuredContent alongside its text formatter (H3).
    expect(res.structuredContent).toMatchObject({ mode: 'verify' });
    const delta = JSON.parse(firstText(res)) as {
      killedCount: number;
      stillSurviving: { line: number; mutator: string }[];
      nowKilled: { line: number; mutator: string }[];
    };
    // Suppressed (line 7) → excluded from both stillSurviving and nowKilled.
    // Non-suppressed (line 8) → retained in stillSurviving.
    expect(delta.killedCount).toBe(0);
    expect(delta.stillSurviving).toEqual([{ line: 8, mutator: 'ArithmeticOperator' }]);
    expect(delta.nowKilled).toEqual([]);
  });
});

// ── Task 9: composition unit test — codifies applySuppressions + computeVerifyDelta ──
describe('task-9 verify-mode suppression composition', () => {
  it('suppressed mutants are excluded from verify "still surviving"', () => {
    const baseline = [
      { line: 1, mutator: 'A' },
      { line: 2, mutator: 'B' },
    ];
    const rerun = {
      target: 'a.ts',
      totalMutants: 2,
      killed: 0,
      survived: 2,
      mutationScore: '0.00%',
      vulnerabilities: [
        { line: 1, mutator: 'A', description: 'x' },
        { line: 2, mutator: 'B', description: 'x' },
      ],
    };
    // Suppress "1 A": it should not count as still-surviving.
    const filtered = applySuppressions(rerun, new Set(['1 A']));
    const delta = computeVerifyDelta(
      baseline.filter((k) => `${k.line} ${k.mutator}` !== '1 A'),
      filtered.result,
    );
    expect(delta.stillSurviving.find((k) => k.line === 1)).toBeUndefined();
    expect(delta.stillSurviving.find((k) => k.line === 2)).toBeDefined();
  });
});
