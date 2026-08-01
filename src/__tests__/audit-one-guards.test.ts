import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { auditTriageFile, type TriageFileDeps } from '../triage/audit-one.js';
import type { AuditDeadline } from '../utils/deadline.js';

/**
 * `triage/audit-one.ts` had no test file. These cover its two "don't start" guards —
 * the ones that decide a file will not be audited at all, before any engine runs.
 *
 * The distinction they draw is the interesting part. A cancelled file is an ERROR
 * (the caller stopped us), while a file the budget never reached is UNAUDITED —
 * nothing went wrong and nothing was measured. Collapsing the second into either of
 * the others is what makes a truncated sweep read as if it covered everything it was
 * asked for, which is precisely the misreading the ranking has to avoid.
 *
 * The engine-driven paths below these guards are not covered here; they need the whole
 * engine stack stubbed and are worth their own pass.
 */

let ws: string;
let onProgress: ReturnType<typeof vi.fn>;

const deadlineWith = (remaining: number): AuditDeadline =>
  ({ remainingMs: () => remaining, expired: () => remaining <= 0 }) as unknown as AuditDeadline;

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

beforeEach(() => {
  onProgress = vi.fn();
  ws = mkdtempSync(join(tmpdir(), 'chaos-audit-one-'));
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe('auditTriageFile — refuses to start when already cancelled', () => {
  it('reports a cancelled file as an error naming the file', async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await auditTriageFile('src/a.ts', deps({ ctx: { signal: controller.signal } }));

    expect(outcome.error).toEqual({ file: 'src/a.ts', error: 'Operation cancelled.' });
    // Not unaudited: the caller stopped this deliberately, and the sweep says so with
    // the same wording every other abort path uses.
    expect(outcome.unaudited).toBeUndefined();
    expect(outcome.row).toBeUndefined();
  });

  it('proceeds past the guard when the signal is not aborted', async () => {
    // The other arm. Without it, a guard forced true refuses every file in the sweep
    // and the whole run reports as cancelled.
    const controller = new AbortController();

    const outcome = await auditTriageFile(
      'src/missing.ts',
      deps({ ctx: { signal: controller.signal } }),
    );

    expect(outcome.error?.error).not.toBe('Operation cancelled.');
  });
});

describe('auditTriageFile — refuses to start when the budget is spent', () => {
  it('reports a file the budget never reached as unaudited, not as an error', async () => {
    // Neither an error (nothing went wrong) nor a result (nothing was measured).
    // Reporting it as either would let a truncated sweep read as complete.
    const outcome = await auditTriageFile('src/a.ts', deps({ deadline: deadlineWith(0) }));

    expect(outcome.unaudited).toBe('src/a.ts');
    expect(outcome.error).toBeUndefined();
    expect(outcome.row).toBeUndefined();
  });

  it('treats an overspent budget the same as an exhausted one', async () => {
    const outcome = await auditTriageFile('src/a.ts', deps({ deadline: deadlineWith(-1) }));

    expect(outcome.unaudited).toBe('src/a.ts');
  });

  it('spends the budget net of the cleanup reserve', async () => {
    // `remainingMs(cleanupReserveMs)` must be asked for the budget MINUS the reserve.
    // Reading the raw remainder would let the last file consume everything and leave
    // no time to rank and format what the sweep already measured.
    let seenReserve: number | undefined;
    const deadline = {
      remainingMs: (reserve: number) => {
        seenReserve = reserve;
        return 0;
      },
      expired: () => false,
    } as unknown as AuditDeadline;

    await auditTriageFile('src/a.ts', deps({ deadline, cleanupReserveMs: 7_500 }));

    expect(seenReserve).toBe(7_500);
  });

  it('checks cancellation before the budget', async () => {
    // Both conditions hold. A cancelled sweep must report cancellation rather than
    // silently blaming the clock, or a user who pressed stop is told the run timed out.
    const controller = new AbortController();
    controller.abort();

    const outcome = await auditTriageFile(
      'src/a.ts',
      deps({ deadline: deadlineWith(0), ctx: { signal: controller.signal } }),
    );

    expect(outcome.error?.error).toBe('Operation cancelled.');
    expect(outcome.unaudited).toBeUndefined();
  });
});

describe('auditTriageFile — progress accounting', () => {
  it('advances the progress counter even for a file it refused to start', async () => {
    // The counter lives in a `finally`, so the caller's "audited N/M" stays truthful
    // about how far the sweep has got. Skipping it for refused files would stall the
    // reported progress while the sweep actually moved on.
    await auditTriageFile('src/a.ts', deps({ deadline: deadlineWith(0) }));

    expect(onProgress).toHaveBeenCalledTimes(1);
  });
});
