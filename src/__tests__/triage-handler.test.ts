import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dirname, basename, join, resolve } from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { MutationResult } from '../engines/base.js';
// `resolveStrykerConcurrency` moved out of triage-handler.ts with the argument
// prelude it belongs to (Finding 3 decomposition); the import follows it there.
import { resolveStrykerConcurrency } from '../core/triage-args-validation.js';
import type { TriageRow } from '../core/triage.js';
import type { TriageAuditOutcome } from '../triage/audit-one.js';
import { ALLOWED_ROOTS_ENV } from '../utils/path-safety.js';
import { ExecFailureError } from '../utils/exec-error.js';

// Discovery moved out of triage.ts into `triage/discover-files.ts` (Finding 5
// decomposition); the stub follows it to the module `discover-targets.ts` now
// imports from.
vi.mock('../triage/discover-files.js', async () => {
  const actual = await vi.importActual<typeof import('../triage/discover-files.js')>(
    '../triage/discover-files.js',
  );
  return { ...actual, discoverFiles: vi.fn(), discoverChangedFiles: vi.fn() };
});
vi.mock('../utils/git-diff.js', () => ({
  listChangedFiles: vi.fn(),
  computeChangedRanges: vi.fn(),
}));
const { cleanupSpy } = vi.hoisted(() => ({ cleanupSpy: vi.fn() }));
vi.mock('../utils/sandbox.js', () => ({
  createSandbox: vi.fn(() => ({ workDir: '/tmp/s', targetFile: '', cleanup: cleanupSpy })),
}));
vi.mock('../utils/project-detector.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/project-detector.js')>(
    '../utils/project-detector.js',
  );
  return { ...actual, detectEnvironment: vi.fn() };
});
vi.mock('../audit/audit-file.js', async () => {
  const actual =
    await vi.importActual<typeof import('../audit/audit-file.js')>('../audit/audit-file.js');
  return { ...actual, auditFile: vi.fn() };
});
// `makeEngine` moved out of handler.ts into the engine registry it was already
// a one-line lookup into; the stub follows it there.
vi.mock('../engines/registry.js', async () => {
  const actual =
    await vi.importActual<typeof import('../engines/registry.js')>('../engines/registry.js');
  return { ...actual, makeEngine: vi.fn(() => ({ run: vi.fn() })) };
});
// The row's runId now comes from the shared `mintRunId` in run-cache.ts (both
// audit and triage mint it identically). Stubbing `saveRun` no longer reaches
// triage — mintRunId calls it module-internally — so the spy follows the seam
// the handler actually imports.
vi.mock('../utils/run-cache.js', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/run-cache.js')>('../utils/run-cache.js');
  return { ...actual, mintRunId: vi.fn(actual.mintRunId) };
});
vi.mock('../utils/suppression.js', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/suppression.js')>('../utils/suppression.js');
  return { ...actual, loadSuppressions: vi.fn(() => new Map()) };
});

import { discoverFiles, discoverChangedFiles } from '../triage/discover-files.js';
import { detectEnvironment } from '../utils/project-detector.js';
import { auditFile } from '../audit/audit-file.js';
import { listChangedFiles, computeChangedRanges } from '../utils/git-diff.js';
import { loadSuppressions, fingerprintSourceLine, type StoredEntry } from '../utils/suppression.js';
import { mintRunId, loadRun, workspaceFingerprint } from '../utils/run-cache.js';
import { computeScope } from '../audit/scope.js';
import { createSandbox } from '../utils/sandbox.js';
import { handleTriageCall, partitionOutcomes } from '../triage-handler.js';

const mockDiscover = vi.mocked(discoverFiles);
const mockDiscoverChanged = vi.mocked(discoverChangedFiles);
const mockDetectEnv = vi.mocked(detectEnvironment);
const mockAuditFile = vi.mocked(auditFile);
const mockListChangedFiles = vi.mocked(listChangedFiles);
const mockComputeChangedRanges = vi.mocked(computeChangedRanges);
const mockLoadSuppressions = vi.mocked(loadSuppressions);
const mockMintRunId = vi.mocked(mintRunId);
const mockCreateSandbox = vi.mocked(createSandbox);

const req = (args: Record<string, unknown>): CallToolRequest =>
  ({
    method: 'tools/call',
    params: { name: 'triage_test_coverage', arguments: args },
  }) as CallToolRequest;

const txt = (res: { content: unknown[] }): string => (res.content[0] as { text: string }).text;

const tsEnv = {
  projectType: 'typescript' as const,
  testRunner: 'vitest',
  detectedRunner: 'vitest',
  packageManager: '',
  workspaceRoot: process.cwd(),
};
const mrOf = (over: Record<string, unknown>) => ({
  target: 'f',
  totalMutants: 10,
  killed: 8,
  survived: 2,
  mutationScore: '80.00%',
  vulnerabilities: [],
  ...over,
});

describe('handleTriageCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectEnv.mockReturnValue(tsEnv);
  });

  it('rejects missing/empty/non-array paths (when no diffBase) with the paths-or-diffBase message', async () => {
    const expected =
      'Provide "paths" (array of workspace-relative files/dirs) or "diffBase" (a git ref) — at least one is required.';
    for (const bad of [{}, { paths: [] }, { paths: 'src' }]) {
      const res = await handleTriageCall(req(bad));
      expect(res.isError).toBe(true);
      // Pins the triageError content shape and the paths-or-diffBase message.
      expect(res.content[0]).toEqual({ type: 'text', text: expected });
    }
  });

  it('rejects a paths array containing a non-string element', async () => {
    // Kills `typeof p !== 'string'`→false on line 37 (a non-string slips through
    // and `.trim()` would throw, so the validation must reject it up front).
    const res = await handleTriageCall(req({ paths: [123] }));
    expect(res.isError).toBe(true);
  });

  it('rejects when ANY path is blank, not only when all are (some vs every)', async () => {
    // Kills `.some(...)`→`.every(...)` on line 37: a mix of valid + blank must reject.
    const res = await handleTriageCall(req({ paths: ['ok.ts', '   '] }));
    expect(res.isError).toBe(true);
  });

  it('rejects a non-integer maxFiles with the exact message', async () => {
    const res = await handleTriageCall(req({ paths: ['src'], maxFiles: 0 }));
    expect(res.isError).toBe(true);
    expect(res.content[0]).toEqual({ type: 'text', text: 'maxFiles must be an integer >= 1.' });
  });

  it('rejects a fractional maxFiles (number but not an integer)', async () => {
    // 2.5 passes the `typeof === number` and `>= 1` checks but fails Number.isInteger.
    // Kills `||`→`&&` on line 48: with `&&`, the isInteger arm would be gated away.
    const res = await handleTriageCall(req({ paths: ['src'], maxFiles: 2.5 }));
    expect(res.isError).toBe(true);
    expect(res.content[0]).toEqual({ type: 'text', text: 'maxFiles must be an integer >= 1.' });
  });

  describe('argument validation boundaries', () => {
    /** The rejection message for these args, or null when they are accepted. */
    const rejection = async (args: Record<string, unknown>): Promise<string | null> => {
      mockDiscover.mockReturnValue({ files: [], discovered: 0, skipped: 0 });
      const res = await handleTriageCall(req({ paths: ['src'], ...args }));
      return res.isError === true ? (res.content[0] as { text: string }).text : null;
    };

    it('requires diffBase to be a non-empty string', async () => {
      // Reached only when `paths` is also given: with paths absent, an empty
      // diffBase falls to the paths-or-diffBase message instead, so this guard
      // has its own arm that nothing else exercises.
      const message = 'diffBase must be a non-empty string: "HEAD", "staged", or a git ref.';
      expect(await rejection({ diffBase: '' })).toBe(message);
      expect(await rejection({ diffBase: '   ' })).toBe(message);
      expect(await rejection({ diffBase: 123 })).toBe(message);
      expect(await rejection({ diffBase: null })).toBe(message);
    });

    it('rejects an option-like diffBase separately from a malformed one', async () => {
      expect(await rejection({ diffBase: '--upload-pack=evil' })).toBe(
        'diffBase must not start with "-" (it would be mistaken for a git option).',
      );
    });

    it('requires survivorsPerFile to be an integer >= 0, accepting exactly 0', async () => {
      // 0 is the DEFAULT (scores-only leaderboard), so the boundary must be
      // inclusive — `< 0`, not `<= 0`.
      const message = 'survivorsPerFile must be an integer >= 0.';
      expect(await rejection({ survivorsPerFile: -1 })).toBe(message);
      expect(await rejection({ survivorsPerFile: 1.5 })).toBe(message);
      expect(await rejection({ survivorsPerFile: '3' })).toBe(message);
      expect(await rejection({ survivorsPerFile: Number.NaN })).toBe(message);
      expect(await rejection({ survivorsPerFile: 0 })).toBeNull();
      expect(await rejection({ survivorsPerFile: 5 })).toBeNull();
    });

    it('bounds fileConcurrency to 1..64 inclusive at both ends', async () => {
      const message = 'fileConcurrency must be an integer between 1 and 64.';
      expect(await rejection({ fileConcurrency: 0 })).toBe(message);
      expect(await rejection({ fileConcurrency: 65 })).toBe(message);
      expect(await rejection({ fileConcurrency: 1.5 })).toBe(message);
      expect(await rejection({ fileConcurrency: '4' })).toBe(message);
      expect(await rejection({ fileConcurrency: 1 })).toBeNull();
      expect(await rejection({ fileConcurrency: 64 })).toBeNull();
    });

    it('requires totalTimeoutMs to be a positive number', async () => {
      const message = 'totalTimeoutMs must be a positive number. Example: 900000.';
      expect(await rejection({ totalTimeoutMs: 0 })).toBe(message);
      expect(await rejection({ totalTimeoutMs: -1 })).toBe(message);
      expect(await rejection({ totalTimeoutMs: '900000' })).toBe(message);
      // Fractional milliseconds are fine — positivity is the only rule.
      expect(await rejection({ totalTimeoutMs: 0.5 })).toBeNull();
    });

    it('requires timeoutMs to be a positive number, with its own message', async () => {
      // Distinct wording from totalTimeoutMs: they are different budgets and a
      // caller has to know which one they got wrong.
      const message = 'timeoutMs must be a positive number. Example: 300000.';
      expect(await rejection({ timeoutMs: 0 })).toBe(message);
      expect(await rejection({ timeoutMs: -1 })).toBe(message);
      expect(await rejection({ timeoutMs: '300000' })).toBe(message);
      expect(await rejection({ timeoutMs: 0.5 })).toBeNull();
    });

    it('rejects a blank entry anywhere in paths, whitespace included', async () => {
      const message = 'paths must be an array of non-empty workspace-relative strings.';
      expect(await rejection({ paths: ['ok.ts', ''] })).toBe(message);
      expect(await rejection({ paths: ['ok.ts', '\t\n'] })).toBe(message);
      expect(await rejection({ paths: ['ok.ts', 42] })).toBe(message);
    });
  });

  it('accepts a path under a CHAOS_ALLOWED_ROOTS entry', async () => {
    // The opt-in exists so a server started in project A can triage project B.
    // Clamping this guard to cwd rejected every such call before discovery ran.
    const allowed = resolve(process.cwd(), '..', 'allowed-project');
    const previous = process.env[ALLOWED_ROOTS_ENV];
    process.env[ALLOWED_ROOTS_ENV] = allowed;
    mockDiscover.mockReturnValue({ files: [], discovered: 0, skipped: 0 });
    try {
      const res = await handleTriageCall(req({ paths: [join(allowed, 'src')] }));
      expect(res.isError).toBeUndefined();
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, ALLOWED_ROOTS_ENV);
      else process.env[ALLOWED_ROOTS_ENV] = previous;
    }
  });

  it('rejects a path that resolves outside the workspace', async () => {
    // Exercises the path-containment guard (lines 58-64), which no other test
    // reaches — kills the ConditionalExpression/BlockStatement/StringLiteral there.
    const res = await handleTriageCall(req({ paths: ['../escape'] }));
    expect(res.isError).toBe(true);
    expect(txt(res)).toContain('must resolve within the workspace');
    expect(txt(res)).toContain('../escape');
  });

  it('returns a clean empty result when nothing is discovered', async () => {
    mockDiscover.mockReturnValue({ files: [], discovered: 0, skipped: 0 });
    const res = await handleTriageCall(req({ paths: ['src'] }));
    expect(res.isError).toBeUndefined();
    const json = JSON.parse((res.content[0] as { text: string }).text);
    expect(json.mode).toBe('triage');
    expect(json.ranking).toEqual([]);
    // Pin errors=[] too: the second `[]` arg on the empty-discovery JSON path (line 74).
    expect(json.errors).toEqual([]);
    expect(json.note).toContain('No supported source files');
    // Pin the MCP content envelope `type: 'text'` (line 75 StringLiteral).
    expect(res.content[0]).toMatchObject({ type: 'text' });
  });

  it('renders the empty result as text when outputFormat=text', async () => {
    // Exercises the text branch of the empty-discovery path (lines 72-75).
    mockDiscover.mockReturnValue({ files: [], discovered: 0, skipped: 0 });
    const res = await handleTriageCall(req({ paths: ['src'], outputFormat: 'text' }));
    expect(res.isError).toBeUndefined();
    expect(txt(res)).toContain('Chaos-MCP Triage: 0 of 0 files audited');
    expect(txt(res)).toContain('No supported source files');
    // Empty discovery has no errors → no Errors: section (kills errors `[]`→junk, line 73).
    expect(txt(res)).not.toContain('Errors:');
    expect(() => JSON.parse(txt(res))).toThrow(); // proves it is text, not JSON
  });

  it('renders ranked results as text when outputFormat=text', async () => {
    // Exercises the text branch of the final result format (lines 128-131) and the
    // outputFormat==='text' detection (line 67).
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
    mockAuditFile.mockResolvedValue(mrOf({ mutationScore: '50.00%', survived: 5 }));
    const res = await handleTriageCall(req({ paths: ['src'], outputFormat: 'text' }));
    expect(txt(res)).toContain('Chaos-MCP Triage: 1 of 1 files audited');
    expect(txt(res)).toContain('Weakest first');
    expect(txt(res)).toContain('a.ts');
    expect(() => JSON.parse(txt(res))).toThrow();
    // Pin the MCP content envelope `type: 'text'` on the non-empty return (line 131).
    expect(res.content[0]).toMatchObject({ type: 'text' });
  });

  it('uses config.defaultMaxFiles when no maxFiles arg is given', async () => {
    // Kills `cfg.defaultMaxFiles ?? DEFAULT_MAX_FILES`→`&&` (line 45): with `&&`,
    // a truthy 7 would yield DEFAULT_MAX_FILES (25), not 7.
    mockDiscover.mockReturnValue({ files: [], discovered: 0, skipped: 0 });
    await handleTriageCall(req({ paths: ['src'] }), { defaultMaxFiles: 7 });
    expect(mockDiscover).toHaveBeenCalledWith(['src'], expect.any(String), 7);
  });

  it('falls back to the built-in default (25) when neither arg nor config sets it', async () => {
    // Kills `?? DEFAULT_MAX_FILES`→`&&` for the undefined case (`undefined && 25` = undefined).
    mockDiscover.mockReturnValue({ files: [], discovered: 0, skipped: 0 });
    await handleTriageCall(req({ paths: ['src'] }));
    expect(mockDiscover).toHaveBeenCalledWith(['src'], expect.any(String), 25);
  });

  it('forwards config.sandbox.dependencies into createSandbox options for each file', async () => {
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
    mockAuditFile.mockResolvedValue(mrOf({}));
    await handleTriageCall(req({ paths: ['src'] }), { sandbox: { dependencies: 'copy' } });
    expect(mockCreateSandbox).toHaveBeenCalledWith(
      'a.ts',
      expect.any(String),
      undefined,
      expect.objectContaining({ dependencies: 'copy' }),
    );
  });

  it('passes timeoutMs/mutatorDenylist through to auditFile and forwards the full audit context', async () => {
    // Kills the perFileArgs ObjectLiteral (line 98) and the auditFile call ObjectLiteral (line 106).
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
    mockAuditFile.mockResolvedValue(mrOf({}));
    await handleTriageCall(
      req({ paths: ['src'], timeoutMs: 1234, mutatorDenylist: ['StringLiteral'] }),
    );
    expect(mockAuditFile).toHaveBeenCalledWith(
      expect.objectContaining({
        targetFile: 'a.ts',
        env: tsEnv,
        projectType: 'typescript',
        config: {},
        workDir: '/tmp/s',
        args: expect.objectContaining({
          timeoutMs: 1234,
          mutatorDenylist: ['StringLiteral'],
        }),
      }),
    );
  });

  describe('option resolution and per-file budgeting', () => {
    it('treats a blank diffBase with no paths as "neither was given"', async () => {
      // `hasDiffBase` requires a TRIMMED non-empty string. Drop the trim (or the
      // length check) and a blank diffBase counts as supplied, so the caller is
      // told their git ref is malformed rather than that they gave no target
      // at all — two different fixes.
      const expected =
        'Provide "paths" (array of workspace-relative files/dirs) or "diffBase" (a git ref) — at least one is required.';
      for (const args of [{ diffBase: '' }, { diffBase: '   ' }, { diffBase: '\t\n' }]) {
        const res = await handleTriageCall(req(args));
        expect(res.content[0]).toEqual({ type: 'text', text: expected });
      }
    });

    it("caps each file's timeout by what is left of the total budget", async () => {
      // `Math.min(args.timeoutMs, fileBudgetMs)` — a per-file timeout larger
      // than the remaining sweep budget must not let one file eat the time the
      // rest need.
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(mrOf({}));

      await handleTriageCall(req({ paths: ['src'], timeoutMs: 999_999, totalTimeoutMs: 10_000 }));

      const passed = mockAuditFile.mock.calls[0][0].args.timeoutMs as number;
      expect(passed).toBeLessThanOrEqual(10_000);
      expect(passed).toBeGreaterThan(0);
    });

    it('gives a file the whole remaining budget when no per-file timeout is set', async () => {
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(mrOf({}));

      await handleTriageCall(req({ paths: ['src'], totalTimeoutMs: 20_000 }));

      const passed = mockAuditFile.mock.calls[0][0].args.timeoutMs as number;
      expect(passed).toBeGreaterThan(10_000);
      expect(passed).toBeLessThanOrEqual(20_000);
    });

    it('leaves files unaudited once the total budget is spent, rather than skipping them silently', async () => {
      // A 1ms budget is exhausted by the reserve before the first file starts.
      // The result must SAY so — an empty ranking with no explanation reads as
      // "these files are fine".
      mockDiscover.mockReturnValue({ files: ['a.ts', 'b.ts'], discovered: 2, skipped: 0 });
      mockAuditFile.mockResolvedValue(mrOf({}));

      const res = await handleTriageCall(req({ paths: ['src'], totalTimeoutMs: 1 }));
      const payload = JSON.parse(txt(res)) as {
        unaudited?: string[];
        stoppedReason?: string;
        note: string;
      };

      expect(payload.unaudited).toEqual(['a.ts', 'b.ts']);
      expect(payload.stoppedReason).toBe('time_budget_exhausted');
      expect(payload.note).toContain('not audited before the time budget ran out');
      expect(mockAuditFile).not.toHaveBeenCalled();
    });

    it('passes a Stryker worker cap only for TypeScript files, and only with a real pool', async () => {
      // The cap exists so N parallel StrykerJS runs do not oversubscribe the
      // box. A single-file pool has nothing to divide, and non-TS engines take
      // their worker count elsewhere.
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(mrOf({}));

      await handleTriageCall(req({ paths: ['src'], fileConcurrency: 1 }));
      expect(mockAuditFile.mock.calls[0][0].args.concurrency).toBeUndefined();

      mockAuditFile.mockClear();
      await handleTriageCall(req({ paths: ['src'], fileConcurrency: 4 }));
      expect(mockAuditFile.mock.calls[0][0].args.concurrency).toBeTypeOf('number');
    });

    it('does not pass a Stryker worker cap to a non-TypeScript engine', async () => {
      mockDiscover.mockReturnValue({ files: ['a.py'], discovered: 1, skipped: 0 });
      mockDetectEnv.mockReturnValue({ ...tsEnv, projectType: 'python' });
      mockAuditFile.mockResolvedValue(mrOf({}));

      await handleTriageCall(req({ paths: ['src'], fileConcurrency: 4 }));

      expect(mockAuditFile.mock.calls[0][0].args.concurrency).toBeUndefined();
    });

    it('ignores a non-integer fileConcurrency when sizing the pool', async () => {
      // 2.5 is rejected by validation, but `null` reaches the pool sizer and
      // must fall through to the default rather than becoming the pool size.
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(mrOf({}));

      await handleTriageCall(req({ paths: ['src'] }));

      // Default pool on this machine is min(4, cpus-1) — at least 1 either way,
      // so the observable is simply that the sweep ran.
      expect(mockAuditFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('diff-scoped rows', () => {
    it('marks a row when the language cannot be line-scoped', async () => {
      // cargo-mutants/cosmic-ray/Infection run whole-file, so a diff-scoped
      // triage must say the score covers more than the diff — otherwise the
      // number reads as "your changed lines are 60% covered".
      mockListChangedFiles.mockResolvedValue({ kind: 'files', files: ['a.py'] });
      mockDiscoverChanged.mockReturnValue({ files: ['a.py'], discovered: 1, skipped: 0 });
      mockDetectEnv.mockReturnValue({ ...tsEnv, projectType: 'python' });
      mockAuditFile.mockResolvedValue(mrOf({}));

      const res = await handleTriageCall(req({ diffBase: 'HEAD' }));
      const payload = JSON.parse(txt(res)) as { ranking: { scopeNote?: string }[] };

      expect(payload.ranking[0].scopeNote).toBe(
        'diff scoping unsupported for this language; whole file',
      );
      expect(mockComputeChangedRanges).not.toHaveBeenCalled();
    });

    it('marks an untracked file as whole-file rather than leaving it unlabelled', async () => {
      mockListChangedFiles.mockResolvedValue({ kind: 'files', files: ['a.ts'] });
      mockDiscoverChanged.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockComputeChangedRanges.mockResolvedValue({ kind: 'untracked' });
      mockAuditFile.mockResolvedValue(mrOf({}));

      const res = await handleTriageCall(req({ diffBase: 'HEAD' }));
      const payload = JSON.parse(txt(res)) as { ranking: { scopeNote?: string }[] };

      expect(payload.ranking[0].scopeNote).toBe('untracked; whole file');
    });

    it('leaves a row unlabelled when the diff yields no usable ranges', async () => {
      // no-changes / bad-ref / not-a-repo for an individual file: the file was
      // selected, so this is rare — and must not invent a scope note.
      mockListChangedFiles.mockResolvedValue({ kind: 'files', files: ['a.ts'] });
      mockDiscoverChanged.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockComputeChangedRanges.mockResolvedValue({ kind: 'not-a-repo' });
      mockAuditFile.mockResolvedValue(mrOf({}));

      const res = await handleTriageCall(req({ diffBase: 'HEAD' }));
      const payload = JSON.parse(txt(res)) as { ranking: Record<string, unknown>[] };

      expect(Object.keys(payload.ranking[0])).not.toContain('scopeNote');
    });

    /**
     * `DiffResult` gained `git-failed` (timeout / not-installed / other) when
     * `not-a-repo` was narrowed to a genuine non-zero rev-parse exit. The
     * per-file switch here had no case for it and no default, so a timed-out or
     * missing git fell straight through to `{}` — the file was mutated
     * WHOLE-FILE and its score was presented as if the sweep had never been
     * diff-scoped. Quieter than the old "not a git work tree" lie, still wrong.
     */
    it.each(['timeout', 'not-installed', 'other'] as const)(
      'labels the row when git could not scope the file (%s) instead of silently going whole-file',
      async (reason) => {
        mockListChangedFiles.mockResolvedValue({ kind: 'files', files: ['a.ts'] });
        mockDiscoverChanged.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
        mockComputeChangedRanges.mockResolvedValue({
          kind: 'git-failed',
          reason,
          message: 'git said no',
        });
        mockAuditFile.mockResolvedValue(mrOf({}));

        const res = await handleTriageCall(req({ diffBase: 'HEAD' }));
        const payload = JSON.parse(txt(res)) as { ranking: { scopeNote?: string }[] };

        expect(payload.ranking[0].scopeNote).toBe(
          `git could not scope this file (${reason}); whole file`,
        );
      },
    );

    it('still scores the file — a git failure degrades the row, it does not error it', async () => {
      // Deliberately unlike the single-file audit path (audit/scope.ts), which
      // returns a tool error. A sweep has other files to get through, the file
      // set was already chosen by a `listChangedFiles` that SUCCEEDED, and the
      // dominant cause is our own shrinking per-file clamp — so erroring the row
      // would turn "running low on budget" into a run of empty error entries.
      mockListChangedFiles.mockResolvedValue({ kind: 'files', files: ['a.ts', 'b.ts'] });
      mockDiscoverChanged.mockReturnValue({ files: ['a.ts', 'b.ts'], discovered: 2, skipped: 0 });
      mockComputeChangedRanges.mockResolvedValue({
        kind: 'git-failed',
        reason: 'timeout',
        message: 'git said no',
      });
      mockAuditFile.mockResolvedValue(mrOf({}));

      const res = await handleTriageCall(req({ diffBase: 'HEAD' }));
      const payload = JSON.parse(txt(res)) as {
        ranking: { mutationScore: string }[];
        errors?: unknown[];
      };

      expect(res.isError).toBeUndefined();
      expect(payload.ranking).toHaveLength(2);
      expect(payload.ranking[0].mutationScore).toBe('80.00%');
      expect(payload.errors ?? []).toEqual([]);
      // Whole-file: no line scope reached the engine.
      expect(mockAuditFile.mock.calls[0][0].lineRanges).toBeUndefined();
    });

    it('reports a diffBase that git cannot resolve', async () => {
      mockListChangedFiles.mockResolvedValue({ kind: 'bad-ref', ref: 'nope' });

      const res = await handleTriageCall(req({ diffBase: 'nope' }));

      expect(res.isError).toBe(true);
      expect(txt(res)).toBe('diffBase "nope" could not be resolved as a git ref.');
    });
  });

  describe('a git call that never answered', () => {
    /**
     * `listChangedFiles` re-throws timeout / ENOENT / other failures instead of
     * flattening them into `not-a-repo`. Nothing in the sweep may escape as a
     * raw rejection: the MCP SDK would turn it into a JSON-RPC protocol error
     * rather than the `isError` tool result every other failure here uses.
     */
    const failWith = (code: string, message: string) =>
      new ExecFailureError({ stdout: '', stderr: '', exit: null, signal: null, code }, message);

    it('reports a missing git binary as a tool error, not a protocol error', async () => {
      mockListChangedFiles.mockRejectedValue(failWith('ENOENT', 'Command not found: git'));

      const res = await handleTriageCall(req({ diffBase: 'main' }));

      expect(res.isError).toBe(true);
      expect(txt(res)).toContain('(not-installed)');
      expect(txt(res)).toContain('Command not found: git');
      expect(mockAuditFile).not.toHaveBeenCalled();
    });

    it('reports a git timeout as a timeout rather than a broken workspace', async () => {
      mockListChangedFiles.mockRejectedValue(
        failWith('TIMEOUT', 'Command timed out after 15000ms: git'),
      );

      const res = await handleTriageCall(req({ diffBase: 'main' }));

      expect(res.isError).toBe(true);
      expect(txt(res)).toContain('(timeout)');
      expect(txt(res)).not.toContain('not a git work tree');
    });

    it('reports a cancel landing mid-git as "Operation cancelled."', async () => {
      // The cancel is re-thrown all the way out of `listChangedFiles`; the
      // handler's catch is the only thing between it and the SDK.
      const controller = new AbortController();
      mockListChangedFiles.mockImplementation(() => {
        controller.abort();
        return Promise.reject(failWith('ABORTED', 'Command was cancelled: git'));
      });

      const res = await handleTriageCall(req({ diffBase: 'main' }), undefined, {
        signal: controller.signal,
      });

      expect(res.isError).toBe(true);
      expect(txt(res)).toBe('Operation cancelled.');
    });

    it('wraps any other escaped failure in the shared halted message', async () => {
      // Target selection is not the only thing that can throw; the handler-wide
      // catch is what stops ANY of it reaching the SDK as a protocol error.
      mockListChangedFiles.mockResolvedValue({ kind: 'files', files: ['a.ts'] });
      mockDiscoverChanged.mockImplementation(() => {
        throw new Error('boom');
      });

      const res = await handleTriageCall(req({ diffBase: 'main' }));

      expect(res.isError).toBe(true);
      expect(txt(res)).toBe('Chaos Engine Halted: boom');
      expect(res.content).toHaveLength(1);
    });
  });

  describe('row assembly', () => {
    it('derives noCoverage from vulnerabilities beyond the survivor count, never negative', async () => {
      // `vulnerabilities.length - survived` — swapped to `+` the row claims more
      // uncovered mutants than the file has; clamped with min instead of max it
      // would go negative when the engine reports fewer vulns than survivors.
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(
        mrOf({
          survived: 1,
          vulnerabilities: [
            { line: 1, mutator: 'A', description: 'survived' },
            { line: 2, mutator: 'B', description: 'no test reached this mutant' },
            { line: 3, mutator: 'C', description: 'no test reached this mutant' },
          ],
        }),
      );

      const res = await handleTriageCall(req({ paths: ['src'] }));
      const payload = JSON.parse(txt(res)) as { ranking: { noCoverage: number }[] };

      expect(payload.ranking[0].noCoverage).toBe(2);
    });

    it('clamps noCoverage at zero when the engine reports fewer vulnerabilities than survivors', async () => {
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(mrOf({ survived: 5, vulnerabilities: [] }));

      const res = await handleTriageCall(req({ paths: ['src'] }));
      const payload = JSON.parse(txt(res)) as { ranking: { noCoverage: number }[] };

      expect(payload.ranking[0].noCoverage).toBe(0);
    });

    it('flags a logic-free file rather than ranking it as the safest', async () => {
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(
        mrOf({ totalMutants: 0, killed: 0, survived: 0, mutationScore: '100.00%' }),
      );

      const res = await handleTriageCall(req({ paths: ['src'] }));
      const payload = JSON.parse(txt(res)) as {
        ranking: { noMutableLogic?: boolean; mutationScore: string }[];
      };

      expect(payload.ranking[0].noMutableLogic).toBe(true);
      expect(payload.ranking[0].mutationScore).toBe('n/a');
    });

    it('omits the logic-free flag for an ordinary file', async () => {
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(mrOf({}));

      const res = await handleTriageCall(req({ paths: ['src'] }));
      const payload = JSON.parse(txt(res)) as { ranking: Record<string, unknown>[] };

      expect(Object.keys(payload.ranking[0])).not.toContain('noMutableLogic');
    });

    it('carries partial-audit state, with its batch counts, onto the row', async () => {
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(
        mrOf({ complete: false, batchesCompleted: 2, batchesPlanned: 5 }),
      );

      const res = await handleTriageCall(req({ paths: ['src'] }));
      const payload = JSON.parse(txt(res)) as {
        ranking: { complete?: boolean; batchesCompleted?: number; batchesPlanned?: number }[];
      };

      expect(payload.ranking[0].complete).toBe(false);
      expect(payload.ranking[0].batchesCompleted).toBe(2);
      expect(payload.ranking[0].batchesPlanned).toBe(5);
    });

    it('leaves the partial-audit fields off a complete row entirely', async () => {
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(mrOf({}));

      const res = await handleTriageCall(req({ paths: ['src'] }));
      const keys = Object.keys(
        (JSON.parse(txt(res)) as { ranking: Record<string, unknown>[] }).ranking[0],
      );

      expect(keys).not.toContain('complete');
      expect(keys).not.toContain('batchesCompleted');
      expect(keys).not.toContain('batchesPlanned');
    });

    it('omits suppressedCount when nothing was suppressed', async () => {
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(mrOf({}));

      const res = await handleTriageCall(req({ paths: ['src'] }));
      const keys = Object.keys(
        (JSON.parse(txt(res)) as { ranking: Record<string, unknown>[] }).ranking[0],
      );

      expect(keys).not.toContain('suppressedCount');
    });
  });

  describe('cancellation', () => {
    it('stops starting new files when the signal trips between them', async () => {
      // The per-file pre-check exists so a cancelled sweep stops starting NEW
      // files instead of running the queue to completion — hence auditFile runs
      // exactly once. Serial pool so the second file is guaranteed to see the
      // abort.
      //
      // What the CALLER sees is now the post-pool check (Finding 6): a sweep
      // abandoned mid-pool reports the cancel, where it used to render b.ts's
      // per-file `{ error: 'Operation cancelled.' }` inside a success-shaped
      // leaderboard. The per-file outcome is still produced; it is simply no
      // longer what gets returned.
      const controller = new AbortController();
      mockDiscover.mockReturnValue({ files: ['a.ts', 'b.ts'], discovered: 2, skipped: 0 });
      mockAuditFile.mockImplementationOnce(() => {
        controller.abort();
        return Promise.resolve(mrOf({}));
      });
      mockAuditFile.mockResolvedValue(mrOf({}));

      const res = await handleTriageCall(req({ paths: ['src'], fileConcurrency: 1 }), undefined, {
        signal: controller.signal,
      });

      expect(res.isError).toBe(true);
      expect(txt(res)).toBe('Operation cancelled.');
      expect(mockAuditFile).toHaveBeenCalledTimes(1);
    });

    it('returns a cancel, not a partial ranking, when the signal trips DURING the pool', async () => {
      // The one cancel window the handler's catch can NEVER see: `mapPool` does
      // not reject (a throw is stored in the result slot) and `auditTriageFile`
      // does not throw, so nothing routes a mid-pool abort to `mapHandlerFailure`.
      // Without the post-pool check the sweep fell through to the ranking and
      // returned a NON-isError leaderboard — `gate.passed` included — computed
      // over only the files that finished before the stop (Finding 6).
      const controller = new AbortController();
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockImplementation(() => {
        controller.abort();
        return Promise.resolve(mrOf({ mutationScore: '50.00%', survived: 5 }));
      });

      const res = await handleTriageCall(req({ paths: ['src'], minScore: 80 }), undefined, {
        signal: controller.signal,
      });

      // The file WAS audited — the abort landed while the pool was running.
      expect(mockAuditFile).toHaveBeenCalledTimes(1);
      expect(res.isError).toBe(true);
      expect(txt(res)).toBe('Operation cancelled.');
      // No ranking, and above all no gate verdict over a partial file set.
      expect(res.structuredContent).toBeUndefined();
      expect(txt(res)).not.toContain('gate');
    });

    it('reports no further progress once the request is abandoned', async () => {
      // Every file still runs `onProgress` in a `finally` — including the ones
      // the abort check skips — so an ungated callback kept pushing
      // `audited N/3` notifications at a caller that had already walked away.
      // Serial pool: a.ts completes normally (1 report), b.ts aborts mid-audit,
      // c.ts is skipped; neither of the last two may report.
      const controller = new AbortController();
      mockDiscover.mockReturnValue({ files: ['a.ts', 'b.ts', 'c.ts'], discovered: 3, skipped: 0 });
      mockAuditFile.mockResolvedValueOnce(mrOf({}));
      mockAuditFile.mockImplementationOnce(() => {
        controller.abort();
        return Promise.resolve(mrOf({}));
      });
      mockAuditFile.mockResolvedValue(mrOf({}));
      const ctx = { signal: controller.signal, reportProgress: vi.fn() };

      await handleTriageCall(req({ paths: ['src'], fileConcurrency: 1 }), undefined, ctx);

      expect(ctx.reportProgress).toHaveBeenCalledTimes(1);
      expect(ctx.reportProgress).toHaveBeenCalledWith(1, 3, 'audited 1/3');
    });

    it('reports a cancelled sandbox as a cancel, not a provisioning failure', async () => {
      // The two are fixed differently: one means "you stopped it", the other
      // means the workspace is broken.
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockCreateSandbox.mockRejectedValueOnce(
        Object.assign(new Error('aborted'), { name: 'AbortError' }),
      );

      const res = await handleTriageCall(req({ paths: ['src'] }));
      const payload = JSON.parse(txt(res)) as { errors: { file: string; error: string }[] };

      expect(payload.errors).toEqual([{ file: 'a.ts', error: 'Operation cancelled.' }]);
    });

    it('reports a genuine sandbox failure with the halted message', async () => {
      // The other arm of the same branch.
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockCreateSandbox.mockRejectedValueOnce(new Error('disk full'));

      const res = await handleTriageCall(req({ paths: ['src'] }));
      const payload = JSON.parse(txt(res)) as { errors: { file: string; error: string }[] };

      expect(payload.errors[0].error).toContain('Failed to provision sandbox isolation for a.ts');
      expect(payload.errors[0].error).toContain('disk full');
    });

    it('reports a cancelled AUDIT as a cancel rather than raw engine stderr', async () => {
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockRejectedValueOnce(
        Object.assign(new Error('ABORT_ERR: killed'), { name: 'AbortError' }),
      );

      const res = await handleTriageCall(req({ paths: ['src'] }));
      const payload = JSON.parse(txt(res)) as { errors: { file: string; error: string }[] };

      expect(payload.errors).toEqual([{ file: 'a.ts', error: 'Operation cancelled.' }]);
    });

    it('abandons the sweep when the signal trips during discovery', async () => {
      // The second abort check, after discovery and before the pool. Only a
      // cancel that lands DURING discovery can reach it.
      const controller = new AbortController();
      mockDiscover.mockImplementation(() => {
        controller.abort();
        return { files: ['a.ts'], discovered: 1, skipped: 0 };
      });

      const res = await handleTriageCall(req({ paths: ['src'] }), undefined, {
        signal: controller.signal,
      });

      expect(res.isError).toBe(true);
      expect(txt(res)).toBe('Operation cancelled.');
      expect(mockAuditFile).not.toHaveBeenCalled();
    });
  });

  describe('row enrichment', () => {
    it('reads the real source so inlined survivors carry context lines', async () => {
      // The source read is what turns a bare line number into something a
      // reader can act on. Point at a file that genuinely exists — this asserts
      // against the real tree, so moving the target file breaks it (as the
      // src/core/ move did).
      mockDiscover.mockReturnValue({ files: ['src/core/gate.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(
        mrOf({
          vulnerabilities: [{ line: 3, mutator: 'ConditionalExpression', description: 'survived' }],
        }),
      );

      const res = await handleTriageCall(req({ paths: ['src'], survivorsPerFile: 3 }));
      const payload = JSON.parse(txt(res)) as {
        ranking: { survivors?: { context?: string[] }[] }[];
      };

      expect(payload.ranking[0].survivors?.[0].context?.length).toBeGreaterThan(0);
    });

    it('still inlines survivors when the source cannot be read', async () => {
      // A file that vanished between discovery and reporting must not take the
      // whole triage down — the row just loses its context snippet.
      mockDiscover.mockReturnValue({ files: ['does/not/exist.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(
        mrOf({
          vulnerabilities: [{ line: 3, mutator: 'ConditionalExpression', description: 'survived' }],
        }),
      );

      const res = await handleTriageCall(req({ paths: ['src'], survivorsPerFile: 3 }));
      const payload = JSON.parse(txt(res)) as {
        ranking: { survivors?: { context?: string[] }[] }[];
      };

      expect(payload.ranking[0].survivors).toHaveLength(1);
      expect(payload.ranking[0].survivors?.[0].context).toBeUndefined();
    });

    it('inlines no-coverage groups and the worst severity separately from survivors', async () => {
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(
        mrOf({
          survived: 0,
          vulnerabilities: [
            {
              line: 7,
              mutator: 'ConditionalExpression',
              description: 'no test reached this mutant',
            },
          ],
        }),
      );

      const res = await handleTriageCall(req({ paths: ['src'], survivorsPerFile: 3 }));
      const row = (
        JSON.parse(txt(res)) as {
          ranking: Record<string, unknown>[];
        }
      ).ranking[0];

      expect(row.noCoverageGroups).toHaveLength(1);
      expect(row.worstSeverity).toBe('high');
      expect(Object.keys(row)).not.toContain('survivors');
    });

    it('omits the inline groups entirely when there is nothing to inline', async () => {
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(mrOf({ survived: 0, vulnerabilities: [] }));

      const res = await handleTriageCall(req({ paths: ['src'], survivorsPerFile: 3 }));
      const keys = Object.keys(
        (JSON.parse(txt(res)) as { ranking: Record<string, unknown>[] }).ranking[0],
      );

      expect(keys).not.toContain('survivors');
      expect(keys).not.toContain('noCoverageGroups');
      expect(keys).not.toContain('worstSeverity');
    });

    it('drops the row runId rather than failing the sweep when the cache cannot be written', async () => {
      // The runId is a convenience for a follow-up verify. Losing it must not
      // cost the caller the leaderboard they asked for. `mintRunId` swallows the
      // cache failure itself (see run-cache.test.ts) and returns undefined.
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(mrOf({}));
      mockMintRunId.mockReturnValueOnce(undefined);

      const res = await handleTriageCall(req({ paths: ['src'] }));
      const row = (JSON.parse(txt(res)) as { ranking: Record<string, unknown>[] }).ranking[0];

      expect(res.isError).toBeUndefined();
      expect(Object.keys(row)).not.toContain('runId');
    });

    it('mints a row runId on the happy path', async () => {
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(mrOf({}));

      const res = await handleTriageCall(req({ paths: ['src'] }));
      const row = (JSON.parse(txt(res)) as { ranking: { runId?: string }[] }).ranking[0];

      expect(row.runId).toMatch(/^[0-9a-f]{8}$/);
    });

    // ── Finding 3: a SCOPED row must not hand back a verify baseline ──
    it('withholds the row runId when the row was scored on changed lines only', async () => {
      // `triage_test_coverage { diffBase }` scores each file on its changed
      // lines. Verify re-runs the WHOLE file and reports every fresh survivor
      // outside the baseline as a `newSurvivor` — "your change introduced these
      // uncaught mutants" — so a line-scoped baseline libels every pre-existing
      // survivor on an unchanged line as a regression the caller just caused.
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(mrOf({ scopeKind: 'scoped' }));

      const res = await handleTriageCall(req({ paths: ['src'] }));
      const row = (JSON.parse(txt(res)) as { ranking: Record<string, unknown>[] }).ranking[0];

      expect(res.isError).toBeUndefined();
      expect(Object.keys(row)).not.toContain('runId');
      expect(mockMintRunId).not.toHaveBeenCalled();
      // The row itself is unaffected — only the verify token is withheld.
      expect(row.mutationScore).toBe('80.00%');
    });

    it('still mints for a BATCHED whole-file row, whose batches are an implementation detail', async () => {
      // `engines/typescript/batches.ts` reports the REQUESTED scope, so a large
      // file covered in several batches is `'whole-file'` and its baseline is
      // a sound one to verify against. Pins the guard to `=== 'scoped'`.
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(
        mrOf({ scopeKind: 'whole-file', scopeNote: 'Completed 4 bounded mutation batches.' }),
      );

      const res = await handleTriageCall(req({ paths: ['src'] }));
      const row = (JSON.parse(txt(res)) as { ranking: { runId?: string }[] }).ranking[0];

      expect(row.runId).toMatch(/^[0-9a-f]{8}$/);
    });

    /**
     * Audit M10, triage mint side. The row's key is `relFromRoot` — a
     * workspace-RELATIVE path — so an unstamped triage entry for workspace A's
     * `a.ts` verified happily against workspace B's `a.ts`. The sweep resolves
     * `env` PER FILE, so the root has to travel with the row (RowInput), not
     * with the sweep.
     */
    it('stamps the row entry with the workspace the file was audited in', async () => {
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(mrOf({}));

      const res = await handleTriageCall(req({ paths: ['src'] }));
      const row = (JSON.parse(txt(res)) as { ranking: { runId: string }[] }).ranking[0];

      expect(loadRun(row.runId)?.workspaceHash).toBe(workspaceFingerprint(tsEnv.workspaceRoot));
    });

    it('mints a row runId the AUDIT tool will accept (the documented cross-tool flow)', async () => {
      // `harden_file` hands a triage row's runId straight to
      // `audit_code_resilience`, so the entry has to satisfy that tool's three
      // gates at once: same relative file, same project type, and — since this
      // change — a workspace fingerprint that is present AND matches. Exercised
      // through `computeScope`, which is the gate itself; going through
      // handleToolCall would need a second engine stub to observe the same fact.
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(
        mrOf({
          survived: 1,
          vulnerabilities: [{ line: 4, mutator: 'ConditionalExpression', description: 'x' }],
        }),
      );

      const res = await handleTriageCall(req({ paths: ['src'] }));
      const row = (JSON.parse(txt(res)) as { ranking: { runId: string }[] }).ranking[0];

      const resolved = await computeScope(
        { runId: row.runId },
        'a.ts',
        tsEnv,
        'typescript',
        {},
        'a.ts',
      );
      // The point of this test is the cross-tool handshake: a triage-minted
      // runId resolves under the audit tool's own gate. The scope it yields is
      // whole-file (verify no longer line-scopes), with the baseline carried
      // for post-run filtering.
      expect(resolved).toMatchObject({
        kind: 'scope',
        diffRanges: undefined,
        baselineKeys: [{ line: 4, mutator: 'ConditionalExpression' }],
      });
    });

    it('stamps the FILE’s workspace root, not the sweep’s working directory', async () => {
      // Why the root travels on `RowInput` rather than on `TriageFileDeps`: the
      // sweep resolves `detectEnvironment` PER FILE, so one sweep launched from
      // a monorepo root can legitimately span several package roots. Hoisting it
      // onto the sweep would stamp every row with rootCwd, and every one of
      // those ids would then be refused by a verify run in the package it
      // actually audited.
      const pkgRoot = join(process.cwd(), 'packages', 'app');
      mockDetectEnv.mockReturnValue({ ...tsEnv, workspaceRoot: pkgRoot });
      mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
      mockAuditFile.mockResolvedValue(mrOf({}));

      const res = await handleTriageCall(req({ paths: ['src'] }));
      const row = (JSON.parse(txt(res)) as { ranking: { runId: string }[] }).ranking[0];

      expect(loadRun(row.runId)?.workspaceHash).toBe(workspaceFingerprint(pkgRoot));
      expect(loadRun(row.runId)?.workspaceHash).not.toBe(workspaceFingerprint(process.cwd()));
    });
  });

  it('cleans up the sandbox after auditing each file', async () => {
    // Kills the `{ sandbox.cleanup(); }`→`{}` BlockStatement on line 117.
    mockDiscover.mockReturnValue({ files: ['a.ts', 'b.ts'], discovered: 2, skipped: 0 });
    mockAuditFile.mockResolvedValue(mrOf({}));
    await handleTriageCall(req({ paths: ['src'] }));
    expect(cleanupSpy).toHaveBeenCalledTimes(2);
  });

  it('cleans up the sandbox even when auditing throws', async () => {
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
    mockAuditFile.mockRejectedValue(new Error('boom'));
    await handleTriageCall(req({ paths: ['src'] }));
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('passes the workspace-relative targetFile to auditFile when the file sits under the workspace root', async () => {
    // workspaceRoot = parent of cwd → relFromRoot is "<cwd-name>/a.ts", a clean
    // relative path, so the ternary on line 94 keeps relFromRoot (not `file`).
    const parent = dirname(process.cwd());
    const base = basename(process.cwd());
    mockDetectEnv.mockReturnValue({ ...tsEnv, workspaceRoot: parent });
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
    mockAuditFile.mockResolvedValue(mrOf({}));
    await handleTriageCall(req({ paths: ['src'] }));
    expect(mockAuditFile).toHaveBeenCalledWith(
      expect.objectContaining({ targetFile: join(base, 'a.ts') }),
    );
  });

  it('falls back to the original file path when the relative path escapes the workspace root', async () => {
    // workspaceRoot = a deep subdir of cwd → relFromRoot starts with ".." so the
    // line-94 guard is false and `file` is used. Kills the ConditionalExpression→true
    // and the `&&`→`||` LogicalOperator mutants there.
    mockDetectEnv.mockReturnValue({ ...tsEnv, workspaceRoot: join(process.cwd(), 'deep', 'sub') });
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
    mockAuditFile.mockResolvedValue(mrOf({}));
    await handleTriageCall(req({ paths: ['src'] }));
    expect(mockAuditFile).toHaveBeenCalledWith(expect.objectContaining({ targetFile: 'a.ts' }));
  });

  it('falls back to the original path when the file resolves exactly to the workspace root', async () => {
    // workspaceRoot === the resolved file → relFromRoot is '' (length 0). The
    // `relFromRoot.length > 0` guard on line 94 must reject the empty path and keep
    // `file`. Kills both ConditionalExpression→true and `> 0`→`>= 0`.
    mockDetectEnv.mockReturnValue({ ...tsEnv, workspaceRoot: join(process.cwd(), 'a.ts') });
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
    mockAuditFile.mockResolvedValue(mrOf({}));
    await handleTriageCall(req({ paths: ['src'] }));
    expect(mockAuditFile).toHaveBeenCalledWith(expect.objectContaining({ targetFile: 'a.ts' }));
  });

  it('audits discovered files and ranks them weakest-first', async () => {
    mockDiscover.mockReturnValue({ files: ['a.ts', 'b.ts'], discovered: 2, skipped: 0 });
    mockAuditFile
      .mockResolvedValueOnce(mrOf({ mutationScore: '90.00%', survived: 1 }))
      .mockResolvedValueOnce(mrOf({ mutationScore: '40.00%', survived: 6 }));
    const res = await handleTriageCall(req({ paths: ['src'] }));
    const json = JSON.parse((res.content[0] as { text: string }).text);
    expect(json.summary.filesAudited).toBe(2);
    expect(json.ranking.map((r: { file: string }) => r.file)).toEqual(['b.ts', 'a.ts']);
  });

  it('records a per-file failure in errors[] and continues', async () => {
    mockDiscover.mockReturnValue({ files: ['ok.ts', 'bad.ts'], discovered: 2, skipped: 0 });
    mockAuditFile
      .mockResolvedValueOnce(mrOf({}))
      .mockRejectedValueOnce(new Error('StrykerJS is not installed'));
    const res = await handleTriageCall(req({ paths: ['src'] }));
    const json = JSON.parse((res.content[0] as { text: string }).text);
    expect(json.summary.filesAudited).toBe(1);
    expect(json.summary.filesErrored).toBe(1);
    expect(json.errors[0]).toEqual({ file: 'bad.ts', error: 'StrykerJS is not installed' });
  });

  it('reflects maxFiles truncation in the summary and passes maxFiles to discovery', async () => {
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 5, skipped: 4 });
    mockAuditFile.mockResolvedValue(mrOf({}));
    const res = await handleTriageCall(req({ paths: ['src'], maxFiles: 1 }));
    const json = JSON.parse((res.content[0] as { text: string }).text);
    expect(json.summary).toMatchObject({ filesDiscovered: 5, filesAudited: 1, filesSkipped: 4 });
    expect(mockDiscover).toHaveBeenCalledWith(['src'], expect.any(String), 1);
  });

  it('rejects a paths array containing a blank string', async () => {
    expect((await handleTriageCall(req({ paths: ['   '] }))).isError).toBe(true);
  });

  it('records an unsupported file type in errors[] and still audits the rest', async () => {
    // discoverFiles is mocked, so it can return an unsupported extension here;
    // detectProjectType runs for real → 'unsupported' for weird.txt.
    mockDiscover.mockReturnValue({ files: ['weird.txt', 'a.ts'], discovered: 2, skipped: 0 });
    mockAuditFile.mockResolvedValue(mrOf({}));
    const res = await handleTriageCall(req({ paths: ['src'] }));
    const json = JSON.parse((res.content[0] as { text: string }).text);
    expect(json.summary.filesAudited).toBe(1);
    expect(json.summary.filesErrored).toBe(1);
    expect(json.errors[0].file).toBe('weird.txt');
    expect(json.errors[0].error).toMatch(/unsupported/i);
  });

  it('returns structuredContent matching the JSON text block', async () => {
    // Verifies that (a) structuredContent is present on the result and
    // (b) the JSON text block and structuredContent are deeply equal, i.e.
    // buildTriagePayload drives both representations.
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
    mockAuditFile.mockResolvedValue(mrOf({ mutationScore: '80.00%', survived: 2 }));
    const res = await handleTriageCall(req({ paths: ['src'] }));
    expect(res.structuredContent).toBeDefined();
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed).toEqual(res.structuredContent);
  });

  it('errors when neither paths nor diffBase is given', async () => {
    const res = await handleTriageCall(req({}));
    expect(res.isError).toBe(true);
    expect(txt(res)).toMatch(/paths.*diffBase|diffBase.*paths/);
  });

  it('rejects a "-"-prefixed diffBase', async () => {
    const res = await handleTriageCall(req({ diffBase: '-x' }));
    expect(res.isError).toBe(true);
    expect(txt(res)).toContain('diffBase');
  });

  it('rejects a negative survivorsPerFile', async () => {
    const res = await handleTriageCall(req({ paths: ['src'], survivorsPerFile: -1 }));
    expect(res.isError).toBe(true);
    expect(txt(res)).toContain('survivorsPerFile');
  });

  it('rejects an out-of-range fileConcurrency', async () => {
    const res = await handleTriageCall(req({ paths: ['src'], fileConcurrency: 0 }));
    expect(res.isError).toBe(true);
    expect(txt(res)).toContain('fileConcurrency');
  });

  it('selects changed files via diffBase and reports not-a-repo', async () => {
    mockListChangedFiles.mockResolvedValue({ kind: 'not-a-repo' });
    const res = await handleTriageCall(req({ diffBase: 'main' }));
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/git work tree|not a git/i);
  });

  it('diffBase with no changed supported files returns an empty leaderboard', async () => {
    mockListChangedFiles.mockResolvedValue({ kind: 'files', files: ['README.md'] });
    mockDiscoverChanged.mockReturnValue({ files: [], discovered: 0, skipped: 0 });
    const res = await handleTriageCall(req({ diffBase: 'main' }));
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.ranking).toEqual([]);
    expect(parsed.scopeNote).toBeDefined();
  });

  it('diffBase: silently excludes a file whose resolved path escapes the workspace root', async () => {
    // Defense-in-depth (C2 parity): git shouldn't produce out-of-root paths, but
    // if discoverChangedFiles returns one, the boundary filter must drop it so the
    // audit never runs on a file outside the workspace.
    // `resolve(cwd, '../outside.ts')` escapes the cwd, so isRealPathInside → false.
    mockListChangedFiles.mockResolvedValue({ kind: 'files', files: ['../outside.ts'] });
    mockDiscoverChanged.mockReturnValue({ files: ['../outside.ts'], discovered: 1, skipped: 0 });
    const res = await handleTriageCall(req({ diffBase: 'main' }));
    // The out-of-root file is filtered → audit never invoked → empty ranking.
    expect(mockAuditFile).not.toHaveBeenCalled();
    const parsed = JSON.parse(txt(res));
    expect(parsed.ranking).toEqual([]);
    expect(res.isError).toBeUndefined();
  });

  it('diffBase with a changed TS file passes lineRanges to auditFile and marks the row', async () => {
    mockListChangedFiles.mockResolvedValue({ kind: 'files', files: ['src/foo.ts'] });
    mockDiscoverChanged.mockReturnValue({ files: ['src/foo.ts'], discovered: 1, skipped: 0 });
    mockComputeChangedRanges.mockResolvedValue({
      kind: 'ranges',
      ranges: [{ start: 1, end: 10 }],
    });
    mockAuditFile.mockResolvedValue(mrOf({ mutationScore: '60.00%', survived: 4 }));
    const res = await handleTriageCall(req({ diffBase: 'main' }));
    expect(mockComputeChangedRanges).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'main',
      // The git call is cancellable and charged against the sweep's budget.
      expect.objectContaining({ timeoutMs: expect.any(Number) as number }),
    );
    expect(mockAuditFile).toHaveBeenCalledWith(
      expect.objectContaining({ lineRanges: [{ start: 1, end: 10 }] }),
    );
    const parsed = JSON.parse(txt(res));
    expect(parsed.ranking[0].scopeNote).toBe('scored on changed lines');
  });

  it('inlines top survivors per file when survivorsPerFile > 0', async () => {
    const mrWithSurvivor = {
      target: 'src/foo.ts',
      totalMutants: 5,
      killed: 4,
      survived: 1,
      mutationScore: '80.00%',
      vulnerabilities: [
        { line: 10, mutator: 'ConditionalExpression', description: 'a conditional' },
      ],
    };
    mockDiscover.mockReturnValue({ files: ['src/foo.ts'], discovered: 1, skipped: 0 });
    mockAuditFile.mockResolvedValue(mrWithSurvivor);
    const res = await handleTriageCall(req({ paths: ['src/foo.ts'], survivorsPerFile: 3 }));
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    const row = parsed.ranking[0];
    expect(row.survivors.length).toBeGreaterThan(0);
    expect(row.worstSeverity).toBe('high');
  });

  it('does not inline survivors when survivorsPerFile is 0 (default)', async () => {
    const mrWithSurvivor = {
      target: 'src/foo.ts',
      totalMutants: 5,
      killed: 4,
      survived: 1,
      mutationScore: '80.00%',
      vulnerabilities: [
        { line: 10, mutator: 'ConditionalExpression', description: 'a conditional' },
      ],
    };
    mockDiscover.mockReturnValue({ files: ['src/foo.ts'], discovered: 1, skipped: 0 });
    mockAuditFile.mockResolvedValue(mrWithSurvivor);
    const res = await handleTriageCall(req({ paths: ['src/foo.ts'] }));
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    const row = parsed.ranking[0];
    expect(row.survivors).toBeUndefined();
    expect(row.worstSeverity).toBeUndefined();
  });

  // A REAL file under the mocked workspaceRoot (= process.cwd()). Suppressions
  // are fingerprinted against their source line, so the sweep must be able to
  // read the file to confirm the stamp — a synthetic 'src/foo.ts' could only
  // ever come back as drifted.
  const REAL_FILE = 'src/utils/no-coverage.ts';
  const REAL_LINE = 10;

  function survivorAt(file: string, line: number): MutationResult {
    return {
      target: file,
      totalMutants: 5,
      killed: 4,
      survived: 1,
      mutationScore: '80.00%',
      vulnerabilities: [{ line, mutator: 'ConditionalExpression', description: 'a conditional' }],
    };
  }

  function stubStored(fingerprint: string | undefined): void {
    const entry: StoredEntry = {
      line: REAL_LINE,
      mutator: 'ConditionalExpression',
      addedAt: 1,
    };
    if (fingerprint !== undefined) entry.fingerprint = fingerprint;
    mockLoadSuppressions.mockReturnValueOnce(new Map([[REAL_FILE, [entry]]]));
  }

  it('filters suppressed mutants and reflects suppressedCount in the row', async () => {
    // Validates the load→verify→filter seam: a suppression entry whose fingerprint
    // still matches the source line must be removed from the result and reflected
    // in row.suppressedCount.
    mockDiscover.mockReturnValue({ files: [REAL_FILE], discovered: 1, skipped: 0 });
    mockAuditFile.mockResolvedValue(survivorAt(REAL_FILE, REAL_LINE));
    stubStored(fingerprintSourceLine(tsEnv.workspaceRoot, REAL_FILE, REAL_LINE));

    const res = await handleTriageCall(req({ paths: [REAL_FILE], survivorsPerFile: 10 }));
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    const row = parsed.ranking[0];

    // The suppressed mutant must be counted and the survivor absent from the row.
    expect(row.suppressedCount).toBe(1);
    // survived drops to 0 after suppression, so survivorsPerFile enrichment has
    // nothing to inline — row.survivors must be absent.
    expect(row.survivors).toBeUndefined();
    expect(row.driftedSuppressions).toBeUndefined();
    expect(row.unverifiedSuppressions).toBeUndefined();
    // loadSuppressions was called with the per-file workspaceRoot, not rootCwd.
    expect(mockLoadSuppressions).toHaveBeenCalledWith(tsEnv.workspaceRoot, undefined);
  });

  it('does NOT apply a suppression whose fingerprint no longer matches, and says so', async () => {
    mockDiscover.mockReturnValue({ files: [REAL_FILE], discovered: 1, skipped: 0 });
    mockAuditFile.mockResolvedValue(survivorAt(REAL_FILE, REAL_LINE));
    stubStored('deadbeefcafe'); // a fingerprint the current line cannot produce

    const res = await handleTriageCall(req({ paths: [REAL_FILE], survivorsPerFile: 10 }));
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    const row = parsed.ranking[0];

    expect(row.suppressedCount).toBeUndefined();
    expect(row.driftedSuppressions).toBe(1);
    expect(row.survived).toBe(1); // the survivor is still counted against the score
    expect(parsed.note).toContain('no longer match the code they were recorded against');
  });

  it('does NOT apply a v1 entry with no fingerprint, and reports it as unverified', async () => {
    mockDiscover.mockReturnValue({ files: [REAL_FILE], discovered: 1, skipped: 0 });
    mockAuditFile.mockResolvedValue(survivorAt(REAL_FILE, REAL_LINE));
    stubStored(undefined); // v1 shape: no fingerprint at all

    const res = await handleTriageCall(req({ paths: [REAL_FILE], survivorsPerFile: 10 }));
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    const row = parsed.ranking[0];

    expect(row.suppressedCount).toBeUndefined();
    expect(row.unverifiedSuppressions).toBe(1);
    expect(parsed.note).toContain('predate content fingerprinting');
  });

  it('reports an applied suppression whose (line, mutator) matched no mutant as orphaned', async () => {
    // The stored entry's fingerprint matches the current source line (so it is
    // NOT drifted), but the audited result carries no mutant at that
    // line/mutator at all — the whole-file run enumerated the file and simply
    // found nothing there for the suppression to filter.
    mockDiscover.mockReturnValue({ files: [REAL_FILE], discovered: 1, skipped: 0 });
    mockAuditFile.mockResolvedValue({
      target: REAL_FILE,
      totalMutants: 4,
      killed: 4,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });
    stubStored(fingerprintSourceLine(tsEnv.workspaceRoot, REAL_FILE, REAL_LINE));

    const res = await handleTriageCall(req({ paths: [REAL_FILE] }));
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    const row = parsed.ranking[0];

    expect(row.orphanedSuppressions).toBe(1);
    expect(parsed.note).toContain('matched no mutant in this run');
  });
});

describe('handleTriageCall minScore gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectEnv.mockReturnValue(tsEnv);
  });

  it('rejects an invalid minScore (> 100) with an error', async () => {
    const res = await handleTriageCall(req({ paths: ['src'], minScore: 150 }));
    expect(res.isError).toBe(true);
    expect(txt(res)).toContain('minScore');
  });

  it('rejects a negative minScore with an error', async () => {
    const res = await handleTriageCall(req({ paths: ['src'], minScore: -1 }));
    expect(res.isError).toBe(true);
    expect(txt(res)).toContain('minScore');
  });

  it('passes minScore through and returns gate result in the payload', async () => {
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
    mockAuditFile.mockResolvedValue(mrOf({ mutationScore: '50.00%', survived: 5 }));
    const res = await handleTriageCall(req({ paths: ['src'], minScore: 80 }));
    const json = JSON.parse(txt(res));
    expect(json.gate).toBeDefined();
    expect(json.gate.minScore).toBe(80);
    expect(json.gate.passed).toBe(false);
    expect(json.gate.failingFiles).toContain('a.ts');
    expect(json.ranking[0].passed).toBe(false);
  });

  it('renders the gate verdict in the TEXT output and still does not set isError', async () => {
    // Audit M-gateText: the text renderer never received the gate, so
    // `outputFormat: 'text'` + `minScore` returned a plain leaderboard with no
    // sign that a gate had been requested or that it had failed — turning a
    // rendering choice into a feature toggle.
    //
    // `isError` stays UNSET on purpose. Both tools' input schemas promise it:
    // tool-schema.ts documents this tool's minScore as "the result reports
    // gate.passed=false and lists the failing files. Never causes an error", and
    // the audit tool's as "(never an error)". Every other `isError: true` here
    // means the sweep could not be performed — not that it ran and scored badly.
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
    mockAuditFile.mockResolvedValue(mrOf({ mutationScore: '50.00%', survived: 5 }));
    const res = await handleTriageCall(req({ paths: ['src'], minScore: 80, outputFormat: 'text' }));
    expect(res.isError).toBeUndefined();
    const lines = txt(res).split('\n');
    expect(lines[0]).toBe('Gate: FAILED (minScore 80) — 1 file(s) below threshold: a.ts');
    expect(() => JSON.parse(txt(res))).toThrow(); // proves it is text, not JSON
    // Text and structuredContent must agree about the verdict.
    expect((res.structuredContent as { gate: { passed: boolean } } | undefined)?.gate.passed).toBe(
      false,
    );
  });

  it('announces a passing gate in the text output too', async () => {
    // A gate that passed is still information the caller asked for by supplying
    // minScore; staying silent leaves "was a gate even applied?" unanswerable
    // from the text block.
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
    mockAuditFile.mockResolvedValue(mrOf({ mutationScore: '95.00%', survived: 1 }));
    const res = await handleTriageCall(req({ paths: ['src'], minScore: 80, outputFormat: 'text' }));
    expect(res.isError).toBeUndefined();
    expect(txt(res).split('\n')[0]).toBe('Gate: passed (minScore 80)');
  });

  it('passes minScore to the empty-result early return', async () => {
    mockDiscover.mockReturnValue({ files: [], discovered: 0, skipped: 0 });
    const res = await handleTriageCall(req({ paths: ['src'], minScore: 80 }));
    expect(res.isError).toBeUndefined();
    const json = JSON.parse(txt(res));
    // No ranked rows → failingFiles is empty → gate passes (no files to fail)
    expect(json.gate).toBeDefined();
    expect(json.gate.passed).toBe(true);
    expect(json.gate.failingFiles).toEqual([]);
  });
});

describe('handleTriageCall ctx: progress + cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectEnv.mockReturnValue(tsEnv);
  });

  it('fires reportProgress once per file (including errored files), done increments, total=N', async () => {
    // Three files: first succeeds, second throws, third succeeds.
    // The finally in auditOne must fire for ALL three → 3 progress calls.
    mockDiscover.mockReturnValue({ files: ['a.ts', 'b.ts', 'c.ts'], discovered: 3, skipped: 0 });
    mockAuditFile
      .mockResolvedValueOnce(mrOf({ mutationScore: '80.00%', survived: 2 }))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(mrOf({ mutationScore: '60.00%', survived: 4 }));

    const calls: [number, number | undefined, string | undefined][] = [];
    const ctx = {
      reportProgress: vi.fn((progress: number, total?: number, message?: string) => {
        calls.push([progress, total, message]);
      }),
    };

    await handleTriageCall(req({ paths: ['src'] }), undefined, ctx);

    // One call per file.
    expect(ctx.reportProgress).toHaveBeenCalledTimes(3);
    // total is always 3 (the discovered file count).
    expect(calls.every(([, total]) => total === 3)).toBe(true);
    // done values are 1, 2, 3 (in some order — pool may interleave, but sequentially
    // in unit tests with synchronous mocks they arrive 1,2,3).
    const dones = calls.map(([d]) => d).sort((a, b) => a - b);
    expect(dones).toEqual([1, 2, 3]);
    // Final call has done = total = 3.
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toBe(3);
    expect(lastCall[1]).toBe(3);
    // Message matches pattern "audited N/N".
    expect(lastCall[2]).toMatch(/audited 3\/3/);
  });

  it('does NOT fire reportProgress when no ctx is supplied (backward compat)', async () => {
    // Existing call-site (no ctx) must still work — progress is a no-op.
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
    mockAuditFile.mockResolvedValue(mrOf({}));
    // Should resolve without throwing — the reportProgress guard must handle undefined ctx.
    await expect(handleTriageCall(req({ paths: ['src'] }))).resolves.toBeDefined();
  });

  it('fires reportProgress N times with done=1..N even when all files error', async () => {
    // Invariant: the finally block in auditOne must advance done for all files,
    // including those that throw (error path) or return early (signal-aborted skip path).
    // This test covers the error path: mocking all auditFile calls to reject, verifying
    // progress fires 3 times with done advancing 1→2→3 despite all files failing.
    mockDiscover.mockReturnValue({ files: ['a.ts', 'b.ts', 'c.ts'], discovered: 3, skipped: 0 });
    mockAuditFile
      .mockRejectedValueOnce(new Error('error 1'))
      .mockRejectedValueOnce(new Error('error 2'))
      .mockRejectedValueOnce(new Error('error 3'));

    const calls: [number, number | undefined][] = [];
    const ctx = {
      reportProgress: vi.fn((progress: number, total?: number) => {
        calls.push([progress, total]);
      }),
    };

    const res = await handleTriageCall(req({ paths: ['src'] }), undefined, ctx);

    // All three files errored, so reportProgress fires 3 times.
    expect(ctx.reportProgress).toHaveBeenCalledTimes(3);
    // Done values must be 1, 2, 3 (in that sequential order).
    const dones = calls.map(([d]) => d);
    expect(dones).toEqual([1, 2, 3]);
    // Total is always the discovered count (3).
    expect(calls.every(([, total]) => total === 3)).toBe(true);
    // All three errors recorded in result.
    expect(res.isError).toBeUndefined();
    const json = JSON.parse((res.content[0] as { text: string }).text);
    expect(json.errors.length).toBe(3);
    expect(json.summary.filesErrored).toBe(3);
  });

  it('returns a cancelled result immediately when ctx.signal is pre-aborted (before discovery)', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = { signal: controller.signal };
    // Mock safety net: if abort check regresses, discovery is called but returns empty
    // rather than crashing with TypeError, so the test fails on the assertion.
    mockDiscover.mockReturnValue({ files: [], discovered: 0, skipped: 0 });

    const res = await handleTriageCall(req({ paths: ['src'] }), undefined, ctx);

    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('cancelled');
    // Discovery must not be invoked.
    expect(mockDiscover).not.toHaveBeenCalled();
    expect(mockAuditFile).not.toHaveBeenCalled();
  });

  it('threads ctx.signal into each auditFile call as a top-level signal field', async () => {
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
    mockAuditFile.mockResolvedValue(mrOf({}));
    const controller = new AbortController();
    const ctx = { signal: controller.signal };

    await handleTriageCall(req({ paths: ['src'] }), undefined, ctx);

    expect(mockAuditFile).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe('partitionOutcomes', () => {
  const row = (file: string): TriageRow => ({
    file,
    mutationScore: '50.00%',
    total: 2,
    killed: 1,
    survived: 1,
    noCoverage: 0,
  });

  it('sorts the four outcome variants into rows, errors and unaudited', () => {
    const a = row('a.ts');
    const b = row('b.ts');
    const { rows, errors, unaudited } = partitionOutcomes([
      { row: a },
      { unaudited: 'skipped.ts' },
      { error: { file: 'bad.ts', error: 'boom' } },
      { row: b },
    ]);

    expect(rows).toEqual([a, b]);
    expect(errors).toEqual([{ file: 'bad.ts', error: 'boom' }]);
    expect(unaudited).toEqual(['skipped.ts']);
  });

  it('preserves input order within each bucket', () => {
    // The ranking is sorted afterwards, but `unaudited` and `errors` are
    // reported in the order mapPool returned them (which is input order).
    const { errors, unaudited } = partitionOutcomes([
      { unaudited: 'z.ts' },
      { error: { file: 'e2.ts', error: 'second' } },
      { unaudited: 'a.ts' },
      { error: { file: 'e1.ts', error: 'first' } },
    ]);

    expect(unaudited).toEqual(['z.ts', 'a.ts']);
    expect(errors.map((e) => e.file)).toEqual(['e2.ts', 'e1.ts']);
  });

  it('turns the mapPool safety-net Error slot into an "(unknown)" error row', () => {
    // auditTriageFile never throws, so this slot should be unreachable — but a
    // raw Error landing in the outcome array must not be read as a row, which
    // would put `undefined` into the ranking.
    const { rows, errors, unaudited } = partitionOutcomes([
      new Error('pool blew up') as unknown as TriageAuditOutcome,
      { row: row('ok.ts') },
    ]);

    expect(errors).toEqual([{ file: '(unknown)', error: 'pool blew up' }]);
    expect(rows).toHaveLength(1);
    expect(unaudited).toEqual([]);
  });

  it('returns three empty buckets for no outcomes', () => {
    expect(partitionOutcomes([])).toEqual({ rows: [], errors: [], unaudited: [] });
  });
});

describe('resolveStrykerConcurrency', () => {
  it('returns undefined for a single-file pool', () => {
    expect(resolveStrykerConcurrency(1, 8)).toBeUndefined();
  });
  it('divides (cpus-1) across the pool, min 1', () => {
    expect(resolveStrykerConcurrency(4, 8)).toBe(1); // floor(7/4)=1
    expect(resolveStrykerConcurrency(2, 8)).toBe(3); // floor(7/2)=3
    expect(resolveStrykerConcurrency(8, 2)).toBe(1); // floor(1/8)=0 → clamped to 1
  });
  it('clamps the result to 64 on very-high-core machines', () => {
    // floor((200-1)/2) = 99 → clamped to 64 (Stryker's documented upper bound).
    // Kills the `Math.min(64, ...)` wrapping by ensuring an unclamped result exceeds 64.
    expect(resolveStrykerConcurrency(2, 200)).toBe(64);
  });
});
