import { describe, it, expect } from 'vitest';
import { runShell, runShellCommand } from '../utils/exec.js';
import { ExecFailureError, MAX_OUTPUT_BYTES } from '../utils/exec-error.js';
import { invokeMutationTool, MutationToolStartupError } from '../utils/exec-classify.js';

/**
 * Regression tests for the output-overflow classification.
 *
 * When a child writes more than `maxBuffer`, Node kills it and calls back with a
 * RangeError whose `code` is the STRING 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' and
 * whose `killed`/`signal` are unset — so it matched none of the numeric,
 * ENOENT, timeout, or signal branches and fell through to the generic
 * "exited with code null" case, carrying the TRUNCATED stdout with it.
 *
 * That mattered because every engine parses that stdout as a complete mutation
 * report. The Rust text parser is the worst case: truncation drops
 * cargo-mutants' authoritative summary line, the parser falls back to counting
 * printed result lines, and since cargo-mutants prints only MISSED lines by
 * default the run reports 0% — a confident wrong score on a suite that actually
 * kills its mutants, with no error anywhere.
 *
 * These tests use a tiny explicit `maxBuffer` via the real 10 MB path being
 * impractical to fill quickly; the classification logic is identical.
 */
async function expectRejection(fn: () => Promise<unknown>): Promise<ExecFailureError> {
  try {
    await fn();
  } catch (err: unknown) {
    if (err instanceof ExecFailureError) return err;
    throw err;
  }
  throw new Error('expected the command to reject, but it resolved');
}

/** A command that writes more than 10 MB to stdout, overflowing the cap. */
const OVERFLOW_SCRIPT = `process.stdout.write('x'.repeat(${MAX_OUTPUT_BYTES + 1024}))`;

describe('output-overflow classification', () => {
  it('runShell reports OUTPUT_TRUNCATED, not a bare non-zero exit', async () => {
    const caught = await expectRejection(() => runShell('node', ['-e', OVERFLOW_SCRIPT]));
    expect(caught.code).toBe('OUTPUT_TRUNCATED');
    // The message must name the cause; "exited with code null" (the old
    // behaviour) told the operator nothing about why.
    expect(caught.message).toContain('truncated');
  });

  it('runShellCommand reports OUTPUT_TRUNCATED too', async () => {
    const caught = await expectRejection(() =>
      runShellCommand(`node -e "${OVERFLOW_SCRIPT.replace(/"/g, '\\"')}"`),
    );
    expect(caught.code).toBe('OUTPUT_TRUNCATED');
    expect(caught.message).toContain('truncated');
  });

  it('invokeMutationTool promotes truncation to a fail-fast startup error', async () => {
    // The engines treat MutationToolStartupError as "surface verbatim, do not
    // parse" — which is the whole point: a truncated report must never reach a
    // parser that would score it.
    await expect(
      invokeMutationTool('cargo-mutants', 'node', ['-e', OVERFLOW_SCRIPT]),
    ).rejects.toBeInstanceOf(MutationToolStartupError);
  });

  it('the truncation error explains how to make the run fit', async () => {
    const err = await invokeMutationTool('StrykerJS', 'node', ['-e', OVERFLOW_SCRIPT]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MutationToolStartupError);
    expect((err as Error).message).toContain('cannot be scored');
    expect((err as Error).message).toContain('Narrow the run');
  });

  it('output just under the cap still succeeds', async () => {
    // Guards against the classification firing on a large-but-valid run.
    const res = await runShell('node', ['-e', `process.stdout.write('y'.repeat(${1024 * 1024}))`]);
    expect(res.exit).toBe(0);
    expect(res.stdout.length).toBe(1024 * 1024);
  });
});
