import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  auditTriageFile,
  type TriageAuditOutcome,
  type TriageFileDeps,
} from '../triage/audit-one.js';
import type { TriageError, TriageRow } from '../core/triage.js';
import type { AuditDeadline } from '../utils/deadline.js';
import type { MutationResult } from '../engines/base.js';

/**
 * The row `triage/audit-one.ts` assembles from one file's mutation result.
 *
 * `audit-one-guards.test.ts` stops at the two "don't start" guards and says so:
 * everything below them needs the engine stack stubbed. This is that pass.
 *
 * What it is really about is OPTIONAL KEYS. A leaderboard row is a sparse object
 * — nine of its fields exist only when they have something to say — and the
 * difference between honouring that and assigning unconditionally is
 * `{ runId: undefined }` versus no `runId` at all. `toEqual` cannot see it, and
 * neither can JSON (which drops undefined-valued keys), so every one of those
 * guards was free to invert unnoticed. The key SET is what these assert, because
 * the rows are spread into the sweep's payload and a key that exists is a key a
 * consumer can enumerate.
 */

const arms = (outcome: TriageAuditOutcome) =>
  outcome as Partial<{ row: TriageRow; error: TriageError; unaudited: string }>;

/** Provisioning is stubbed: these tests are about the row, not the sandbox. */
const createSandboxMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/sandbox.js', () => ({ createSandbox: createSandboxMock }));

/** The engine is stubbed too — the MutationResult IS the input under test. */
const auditFileMock = vi.hoisted(() => vi.fn());
vi.mock('../audit/audit-file.js', () => ({ auditFile: auditFileMock }));

/**
 * Minting is stubbed so these tests never write to the shared on-disk run cache,
 * and so "no runId on the row" always means the row decided against one rather
 * than the cache having failed underneath it.
 */
const mintRunIdMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/run-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/run-cache.js')>();
  return { ...actual, mintRunId: mintRunIdMock };
});

let ws: string;
let onProgress: ReturnType<typeof vi.fn>;

/**
 * Honours the reserve argument, unlike the simpler stub in
 * `audit-one-guards.test.ts` — the engine floor is checked against
 * `remainingMs(cleanupReserveMs)`, so a stub that ignores it can never sit on
 * the boundary the floor actually tests.
 */
const deadlineWith = (remaining: number): AuditDeadline =>
  ({
    remainingMs: (reserve = 0) => Math.max(0, remaining - reserve),
    expired: () => remaining <= 0,
  }) as unknown as AuditDeadline;

const deps = (over: Partial<TriageFileDeps> = {}): TriageFileDeps =>
  ({
    rootCwd: ws,
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

/** A clean whole-file result: nothing optional to report. */
const cleanResult = (over: Partial<MutationResult> = {}): MutationResult => ({
  target: 'src/x.ts',
  totalMutants: 10,
  killed: 10,
  survived: 0,
  mutationScore: '100.00%',
  vulnerabilities: [],
  scopeKind: 'whole-file',
  ...over,
});

/**
 * A workspace `detectEnvironment` stops at: `package.json` is the TypeScript
 * marker, so the walk resolves here instead of wandering up to the real repo.
 */
const sourceFile = (name: string): string => {
  const abs = join(ws, 'src', name);
  writeFileSync(abs, 'export const x = 1;\nexport const y = 2;\n');
  return abs;
};

const rowFor = async (file: string, over: Partial<TriageFileDeps> = {}): Promise<TriageRow> => {
  const outcome = arms(await auditTriageFile(file, deps(over)));
  if (!outcome.row) throw new Error(`expected a row, got ${JSON.stringify(outcome)}`);
  return outcome.row;
};

beforeEach(() => {
  onProgress = vi.fn();
  ws = mkdtempSync(join(tmpdir(), 'chaos-triage-row-'));
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'fixture' }));

  createSandboxMock.mockReset();
  createSandboxMock.mockResolvedValue({
    workDir: join(ws, '.sandbox'),
    targetFile: 'src/x.ts',
    cleanup: vi.fn(),
  });
  auditFileMock.mockReset();
  auditFileMock.mockResolvedValue(cleanResult());
  mintRunIdMock.mockReset();
  mintRunIdMock.mockReturnValue('abcd1234');
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe('buildTriageRow — optional keys are absent, not undefined', () => {
  it('omits every optional key for a clean, unscoped, unsuppressed file', async () => {
    const row = await rowFor(sourceFile('x.ts'));

    // The six mandatory fields, plus the runId this row DID earn. Anything else
    // appearing here is a guard that fired when it had nothing to report.
    expect(Object.keys(row).sort()).toEqual([
      'file',
      'killed',
      'mutationScore',
      'noCoverage',
      'runId',
      'survived',
      'total',
    ]);
  });

  it('labels the row when the sweep could not line-scope this language', async () => {
    // The other arm of the scopeNote guard, reached without git: a diff-scoped
    // sweep over a language whose engine cannot take a line scope says so on the
    // row, because an unlabelled score would read as covering only the diff.
    const row = await rowFor(sourceFile('x.py'), { diffBase: 'main' });

    expect(row.scopeNote).toBe('diff scoping unsupported for this language; whole file');
  });

  it('records a partial audit without inventing batch counts it was not given', async () => {
    // `complete: false` is the fact; the batch numbers are provenance the engine
    // may not have. Assigning them unconditionally puts `batchesCompleted:
    // undefined` on a row whose consumer reads it as a count.
    const row = await rowFor(sourceFile('x.ts'), {});
    expect(row).not.toHaveProperty('complete');

    auditFileMock.mockResolvedValue(cleanResult({ complete: false }));
    const partial = await rowFor(sourceFile('y.ts'));

    expect(partial.complete).toBe(false);
    expect(Object.keys(partial)).not.toContain('batchesCompleted');
    expect(Object.keys(partial)).not.toContain('batchesPlanned');
  });

  it('carries the batch counts when the engine did report them', async () => {
    auditFileMock.mockResolvedValue(
      cleanResult({ complete: false, batchesCompleted: 2, batchesPlanned: 7 }),
    );

    const row = await rowFor(sourceFile('x.ts'));

    expect(row.batchesCompleted).toBe(2);
    expect(row.batchesPlanned).toBe(7);
  });

  it('withholds the runId entirely for a line-scoped row', async () => {
    // A scoped run's survivors are not a whole-file baseline, and verify re-runs
    // whole-file — so handing one back reports every pre-existing survivor on an
    // unchanged line as a regression the caller just introduced. The key must be
    // absent rather than present-and-undefined: `'runId' in row` is exactly how a
    // consumer decides whether it has a baseline to verify against.
    auditFileMock.mockResolvedValue(cleanResult({ scopeKind: 'scoped' }));

    const row = await rowFor(sourceFile('x.ts'));

    expect(mintRunIdMock).not.toHaveBeenCalled();
    expect(Object.keys(row)).not.toContain('runId');
  });

  it('omits worstSeverity when the run produced nothing to rank', async () => {
    // Only reachable with survivorsPerFile > 0, where the enriched payload is
    // built. A clean file has no worst severity, and `worstSeverity: undefined`
    // on the row is a field a leaderboard will happily sort on.
    const row = await rowFor(sourceFile('x.ts'), { survivorsPerFile: 3 });

    expect(Object.keys(row)).not.toContain('worstSeverity');
    expect(Object.keys(row)).not.toContain('survivors');
  });

  it('reports worstSeverity when there IS a surviving mutant', async () => {
    auditFileMock.mockResolvedValue(
      cleanResult({
        totalMutants: 10,
        killed: 9,
        survived: 1,
        mutationScore: '90.00%',
        vulnerabilities: [
          { line: 1, mutator: 'ConditionalExpression', description: 'survived', kind: 'survived' },
        ],
      } as Partial<MutationResult>),
    );

    const row = await rowFor(sourceFile('x.ts'), { survivorsPerFile: 3 });

    expect(row.worstSeverity).toBeTruthy();
    expect(row.survivors).toHaveLength(1);
  });
});

describe('auditTriageFile — a context with no signal is a real call shape', () => {
  // Both `ctx?.signal?.aborted` reads guard against a ToolContext that carries no
  // signal at all. Dropping the second optional link turns that into a TypeError:
  // at the entry guard it fails the file before anything runs, and in the row
  // builder it fails a file that has already been fully audited.

  it('starts a file whose context carries no abort signal', async () => {
    const outcome = arms(await auditTriageFile(sourceFile('x.ts'), deps({ ctx: {} as never })));

    expect(outcome.row).toBeDefined();
    expect(outcome.error).toBeUndefined();
  });

  it('still enriches survivors when the context carries no abort signal', async () => {
    auditFileMock.mockResolvedValue(
      cleanResult({
        totalMutants: 10,
        killed: 9,
        survived: 1,
        mutationScore: '90.00%',
        vulnerabilities: [
          { line: 1, mutator: 'ConditionalExpression', description: 'survived', kind: 'survived' },
        ],
      } as Partial<MutationResult>),
    );

    const row = await rowFor(sourceFile('x.ts'), { ctx: {} as never, survivorsPerFile: 3 });

    expect(row.survivors).toHaveLength(1);
  });
});

describe('auditTriageFile — the engine budget floor', () => {
  // The floor is the smallest slice worth STARTING an engine with. Exactly at it
  // the engine runs; below it the file is unaudited rather than failed, because
  // nothing went wrong and nothing was measured.

  it('runs the engine on exactly the minimum budget', async () => {
    const outcome = arms(
      await auditTriageFile(
        sourceFile('x.ts'),
        deps({ deadline: deadlineWith(6_000), cleanupReserveMs: 5_000 }),
      ),
    );

    expect(outcome.row).toBeDefined();
    expect(outcome.unaudited).toBeUndefined();
    expect(auditFileMock).toHaveBeenCalled();
  });

  it('leaves the file unaudited one millisecond below the floor', async () => {
    const outcome = arms(
      await auditTriageFile(
        sourceFile('x.ts'),
        deps({ deadline: deadlineWith(5_999), cleanupReserveMs: 5_000 }),
      ),
    );

    expect(outcome.unaudited).toBe(sourceFile('x.ts'));
    expect(auditFileMock).not.toHaveBeenCalled();
  });
});
