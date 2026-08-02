import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mintRunIdSafely } from '../audit/run-id.js';
import type { MutationResult } from '../engines/base.js';
import type { MutantKey } from '../core/verify.js';

/**
 * `mintRunIdSafely` had no direct test — it was reached only indirectly through
 * handler.ts:301, and a mutation audit found its `baselineKeys` guard survives being
 * forced false. That guard is what stops a verify run minting a NEW runId: a verify
 * re-runs an existing baseline, so caching its result under a fresh id would offer the
 * caller an id whose contents are a delta, not a survivor set.
 *
 * Both refusal conditions are asserted alongside the minting case, because a guard
 * forced true (refuse always) and one forced false (refuse never) fail in opposite
 * directions and neither is visible from a single test.
 */

const result = (over: Partial<MutationResult> = {}): MutationResult => ({
  target: 'src/target.ts',
  totalMutants: 4,
  killed: 3,
  survived: 1,
  mutationScore: '75.00%',
  vulnerabilities: [
    {
      line: 2,
      mutator: 'ArithmeticOperator',
      kind: 'survived',
      description: 'ArithmeticOperator survived at line 2',
    },
  ],
  ...over,
});

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'chaos-run-id-'));
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

const mint = (baselineKeys: MutantKey[] | undefined, over: Partial<MutationResult> = {}) =>
  mintRunIdSafely(result(over), baselineKeys, 'src/target.ts', 'typescript', ws, {});

describe('mintRunIdSafely', () => {
  it('mints an id for an ordinary whole-file audit', () => {
    // The baseline case: without it, a guard forced to refuse ALWAYS would look correct.
    expect(mint(undefined)).toEqual(expect.any(String));
  });

  it('refuses to mint when a baseline was supplied', () => {
    // Verify mode. The cached entry would hold a delta rather than the survivor set the
    // id promises, so a later verify against it would compare against the wrong thing.
    expect(mint([{ line: 2, mutator: 'ArithmeticOperator' }])).toBeUndefined();
  });

  it('refuses to mint for a line-scoped run', () => {
    // A scoped run only saw part of the file, so its survivor set is not the file's.
    // Verify infers "killed" from absence, and absence here means "never mutated".
    expect(mint(undefined, { scopeKind: 'scoped' })).toBeUndefined();
  });

  it('still mints for a batched whole-file run', () => {
    // Batching is how a large file is covered, not a narrowing of what was mutated, so
    // 'whole-file' must keep its id — otherwise big files silently lose verify support.
    expect(mint(undefined, { scopeKind: 'whole-file' })).toEqual(expect.any(String));
  });

  it('refuses to mint when an empty baseline was supplied', () => {
    // An empty array is still a baseline: `if (baselineKeys)` is a presence check, not a
    // length check, and "I fixed everything, confirm it" is a real verify request.
    expect(mint([])).toBeUndefined();
  });
});
