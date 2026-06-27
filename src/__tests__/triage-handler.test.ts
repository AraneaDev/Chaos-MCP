import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dirname, basename, join } from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { resolveStrykerConcurrency } from '../triage-handler.js';

vi.mock('../triage.js', async () => {
  const actual = await vi.importActual<typeof import('../triage.js')>('../triage.js');
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
vi.mock('../handler.js', async () => {
  const actual = await vi.importActual<typeof import('../handler.js')>('../handler.js');
  return { ...actual, auditFile: vi.fn(), makeEngine: vi.fn(() => ({ run: vi.fn() })) };
});

import { discoverFiles, discoverChangedFiles } from '../triage.js';
import { detectEnvironment } from '../utils/project-detector.js';
import { auditFile } from '../handler.js';
import { listChangedFiles, computeChangedRanges } from '../utils/git-diff.js';
import { handleTriageCall } from '../triage-handler.js';

const mockDiscover = vi.mocked(discoverFiles);
const mockDiscoverChanged = vi.mocked(discoverChangedFiles);
const mockDetectEnv = vi.mocked(detectEnvironment);
const mockAuditFile = vi.mocked(auditFile);
const mockListChangedFiles = vi.mocked(listChangedFiles);
const mockComputeChangedRanges = vi.mocked(computeChangedRanges);

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
});
