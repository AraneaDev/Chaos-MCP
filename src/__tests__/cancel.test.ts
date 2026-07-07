import { describe, it, expect } from 'vitest';

import { isCancel } from '../utils/cancel.js';
import { ExecFailureError } from '../utils/exec.js';
import type { ToolContext } from '../tool-context.js';

/**
 * Helper: build a ToolContext whose signal starts un-aborted and is wired
 * to a manual AbortController so each test can flip it cleanly.
 */
function makeContext(initialAborted = false): {
  ctx: ToolContext;
  abort: () => void;
} {
  const controller = new AbortController();
  if (initialAborted) controller.abort();
  const ctx = { signal: controller.signal } as unknown as ToolContext;
  return { ctx, abort: () => controller.abort() };
}

describe('isCancel', () => {
  // ─── Branch 1: ctx.signal.aborted === true ──────────────────────────────
  describe('when ctx.signal.aborted is true', () => {
    it('returns true regardless of the error argument', () => {
      const { ctx } = makeContext(true);
      expect(isCancel(new Error('boom'), ctx)).toBe(true);
      expect(isCancel(undefined, ctx)).toBe(true);
      // Even for a non-cancellation-flavoured error: the signal still wins
      // (intentional — signal-flip-during-teardown must override a noisy
      // secondary error class).
      expect(isCancel(Object.assign(new Error('x'), { code: 'TIMEOUT' }), ctx)).toBe(true);
    });

    it('returns true when ctx is supplied with no error', () => {
      const { ctx } = makeContext(true);
      expect(isCancel(undefined, ctx)).toBe(true);
    });
  });

  // ─── Branch 2: error.name === 'AbortError' ──────────────────────────────
  describe('when error.name === "AbortError"', () => {
    it('returns true for a real DOMException AbortError', () => {
      const err = new DOMException('aborted', 'AbortError');
      expect(isCancel(err)).toBe(true);
    });

    it('returns true for a plain Error subclass named AbortError', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      expect(isCancel(err)).toBe(true);
    });

    it('returns true for a non-Error object with name="AbortError"', () => {
      // Existing ad-hoc code in handler.ts also matched this; the helper
      // must remain a faithful superset.
      expect(isCancel({ name: 'AbortError', message: 'shaped like one' })).toBe(true);
    });

    it('returns true even with no ctx', () => {
      const err = new DOMException('aborted', 'AbortError');
      expect(isCancel(err, undefined)).toBe(true);
    });
  });

  // ─── Branch 3: ExecFailureError with code === 'ABORTED' ────────────────
  describe('when error is an ExecFailureError with code "ABORTED"', () => {
    // Build an `ExecFailureError` exactly the way `runShell` / `runShellCommand`
    // do when an aborted child surfaces: constructor takes the ExecResult-shaped
    // first arg (with optional `code`) and the human-readable message second.
    function abortedChildError(): ExecFailureError {
      return new ExecFailureError(
        { stdout: '', stderr: '', exit: null, signal: null, code: 'ABORTED' },
        'Shell command was cancelled: <test>',
      );
    }

    it('returns true for the canonical engine-aborted failure', () => {
      const err = abortedChildError();
      expect(err.code).toBe('ABORTED');
      expect(isCancel(err)).toBe(true);
    });

    it('returns true even if the engine EXEC failure has no Error name override', () => {
      const err = abortedChildError();
      // Sanity: ExecFailureError sets `name = 'ExecFailureError'` for itself;
      // the predicate must NOT depend on .name for this branch.
      expect(err.name).toBe('ExecFailureError');
      expect(err.name).not.toBe('AbortError');
      expect(isCancel(err)).toBe(true);
    });
  });

  // ─── Negative cases ─────────────────────────────────────────────────────
  describe('when nothing signals cancellation', () => {
    it('returns false for an unrelated Error', () => {
      expect(isCancel(new Error('boom'))).toBe(false);
    });

    it('returns false for an ExecFailureError with a non-ABORTED code', () => {
      const err = new ExecFailureError('timeout', 'TIMEOUT', 124);
      expect(isCancel(err)).toBe(false);
    });

    it('returns false for a plain object with a non-cancel name and code', () => {
      expect(isCancel({ name: 'TypeError', message: 'not cancel' })).toBe(false);
    });

    it('returns false when error is null', () => {
      expect(isCancel(null)).toBe(false);
    });

    it('returns false when error is undefined', () => {
      expect(isCancel(undefined)).toBe(false);
    });

    it('returns false when ctx has no signal', () => {
      const ctx = {} as ToolContext;
      expect(isCancel(new Error('boom'), ctx)).toBe(false);
    });

    it('returns false when signal is not aborted and error is not cancel-shaped', () => {
      const { ctx } = makeContext(false);
      expect(isCancel(new Error('boom'), ctx)).toBe(false);
    });
  });

  // ─── Short-circuit / interaction sanity ─────────────────────────────────
  describe('interaction between branches', () => {
    it('signal-flip during teardown wins over a non-cancel error', () => {
      const { ctx, abort } = makeContext(false);
      // Simulate mid-flight engine error then caller aborts.
      const err = new ExecFailureError('disk full', 'EIO', 1);
      expect(isCancel(err, ctx)).toBe(false);
      abort();
      expect(isCancel(err, ctx)).toBe(true);
    });

    it('a non-cancel ctx + non-cancel error + non-ABORTED ExecFailure returns false', () => {
      const { ctx } = makeContext(false);
      const err = new ExecFailureError('plain fail', 'ENOENT', 2);
      expect(isCancel(err, ctx)).toBe(false);
    });
  });
});
