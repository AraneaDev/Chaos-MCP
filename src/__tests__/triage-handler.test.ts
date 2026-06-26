import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

vi.mock('../triage.js', async () => {
  const actual = await vi.importActual<typeof import('../triage.js')>('../triage.js');
  return { ...actual, discoverFiles: vi.fn() };
});
vi.mock('../utils/sandbox.js', () => ({
  createSandbox: vi.fn(() => ({ workDir: '/tmp/s', targetFile: '', cleanup: vi.fn() })),
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

import { discoverFiles } from '../triage.js';
import { detectEnvironment } from '../utils/project-detector.js';
import { auditFile } from '../handler.js';
import { handleTriageCall } from '../triage-handler.js';

const mockDiscover = vi.mocked(discoverFiles);
const mockDetectEnv = vi.mocked(detectEnvironment);
const mockAuditFile = vi.mocked(auditFile);

const req = (args: Record<string, unknown>): CallToolRequest =>
  ({
    method: 'tools/call',
    params: { name: 'triage_test_coverage', arguments: args },
  }) as CallToolRequest;

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

  it('rejects a missing/empty/non-array paths arg', async () => {
    expect((await handleTriageCall(req({}))).isError).toBe(true);
    expect((await handleTriageCall(req({ paths: [] }))).isError).toBe(true);
    expect((await handleTriageCall(req({ paths: 'src' }))).isError).toBe(true);
  });

  it('rejects a non-integer maxFiles', async () => {
    expect((await handleTriageCall(req({ paths: ['src'], maxFiles: 0 }))).isError).toBe(true);
  });

  it('returns a clean empty result when nothing is discovered', async () => {
    mockDiscover.mockReturnValue({ files: [], discovered: 0, skipped: 0 });
    const res = await handleTriageCall(req({ paths: ['src'] }));
    expect(res.isError).toBeUndefined();
    const json = JSON.parse((res.content[0] as { text: string }).text);
    expect(json.mode).toBe('triage');
    expect(json.ranking).toEqual([]);
    expect(json.note).toContain('No supported source files');
  });

  it('audits discovered files serially and ranks them weakest-first', async () => {
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
});
