import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../utils/git-diff.js', () => ({
  listChangedFiles: vi.fn(),
}));

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveTriageTargets } from '../triage/discover-targets.js';
import { listChangedFiles } from '../utils/git-diff.js';
import { ExecFailureError } from '../utils/exec-error.js';
import type { AuditDeadline } from '../utils/deadline.js';

const mockListChangedFiles = vi.mocked(listChangedFiles);

/**
 * `triage/discover-targets.ts` had no test file. A mutation audit found the options
 * object handed to `listChangedFiles` can be emptied without any test noticing — so
 * nothing asserted that the sweep's cancellation signal and remaining budget reach
 * git at all. This repo has already shipped 5157ab0 to fix a cancellation bug, which
 * is exactly the failure an unasserted forward re-opens: the sweep would look
 * cancellable while git ran to completion regardless.
 *
 * The result discriminant is covered for the same reason — `kind: 'targets'` blanks
 * out unpunished, and it is the tag every caller switches on.
 */

const REMAINING_MS = 12_345;

let ws: string;

/** Only `remainingMs` is consulted on this path; the rest of the deadline is unused. */
const deadline = (): AuditDeadline =>
  ({ remainingMs: () => REMAINING_MS }) as unknown as AuditDeadline;

const input = (over: Partial<Parameters<typeof resolveTriageTargets>[0]> = {}) => ({
  rootCwd: ws,
  paths: undefined,
  diffBase: undefined,
  maxFiles: 25,
  deadline: deadline(),
  cleanupReserveMs: 5_000,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  ws = mkdtempSync(join(tmpdir(), 'chaos-targets-'));
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(ws, 'src', 'b.ts'), 'export const b = 2;\n');
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe('resolveTriageTargets — filesystem sweep', () => {
  it('tags the result as targets and returns the discovered files', async () => {
    const targets = await resolveTriageTargets(input({ paths: ['src'] }));

    // The tag is asserted explicitly: callers switch on it, and blanking it is
    // invisible to any test that only looks at `files`.
    expect(targets.kind).toBe('targets');
    if (targets.kind !== 'targets') return;
    expect(targets.files).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']));
    expect(targets.discovered).toBe(2);
  });
});

describe('resolveTriageTargets — diff sweep forwards cancellation and budget to git', () => {
  it('passes the abort signal and the remaining budget to listChangedFiles', async () => {
    const controller = new AbortController();
    mockListChangedFiles.mockResolvedValue({ kind: 'not-a-repo' } as never);

    await resolveTriageTargets(input({ diffBase: 'main', signal: controller.signal }));

    // Emptying this options object is the mutation that survived. Asserting the call
    // happened is not enough — the third argument is the whole point.
    expect(mockListChangedFiles).toHaveBeenCalledWith(ws, 'main', {
      signal: controller.signal,
      timeoutMs: REMAINING_MS,
    });
  });

  it('spends the budget net of the cleanup reserve', async () => {
    // `remainingMs(cleanupReserveMs)` — the reserve has to be handed over, or git may
    // consume the whole budget and leave nothing to build a response with.
    const remainingMs = vi.fn().mockReturnValue(999);
    mockListChangedFiles.mockResolvedValue({ kind: 'not-a-repo' } as never);

    await resolveTriageTargets(
      input({
        diffBase: 'main',
        cleanupReserveMs: 7_500,
        deadline: { remainingMs } as unknown as AuditDeadline,
      }),
    );

    expect(remainingMs).toHaveBeenCalledWith(7_500);
  });

  it('rethrows a cancellation instead of reporting it as a git failure', async () => {
    // Turning an abort into a sweep error would tell the user their git setup broke
    // because they pressed stop, and would make the handler's cancel branch
    // unreachable.
    const controller = new AbortController();
    controller.abort();
    mockListChangedFiles.mockRejectedValue(
      new ExecFailureError('aborted', { code: 'ABORTED', command: 'git' } as never),
    );

    await expect(
      resolveTriageTargets(input({ diffBase: 'main', signal: controller.signal })),
    ).rejects.toBeInstanceOf(ExecFailureError);
  });

  it('reports an ordinary git failure as a sweep error rather than throwing', async () => {
    // The other arm of the isCancel branch.
    mockListChangedFiles.mockRejectedValue(new Error('git exploded'));

    const targets = await resolveTriageTargets(input({ diffBase: 'main' }));

    expect(targets.kind).toBe('error');
  });
});
