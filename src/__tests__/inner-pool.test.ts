import { describe, it, expect } from 'vitest';
import { buildInnerEnv } from '../engines/inner-pool.js';

describe('buildInnerEnv', () => {
  it('divides the budget between jobs and threads instead of restating it', () => {
    // Budget 8, jobs clamped to 2 (cargo-mutants' own default): the product
    // of jobs x threads must fit the budget, so threads = floor(8 / 2) = 4,
    // not 8 (which would make the product 16, exceeding the budget).
    expect(buildInnerEnv('rust', 8, 2)).toEqual({
      RUST_TEST_THREADS: '4',
      CARGO_BUILD_JOBS: '4',
    });
  });

  it('defaults jobs to the whole budget when the caller has no separate figure', () => {
    // No third argument: conservatively spends the whole budget on jobs and
    // leaves exactly one inner thread, rather than restating the budget on
    // both layers (the CRITICAL 3 bug: 2 jobs x 2 threads x fileConcurrency
    // squared the budget instead of dividing it).
    expect(buildInnerEnv('rust', 2)).toEqual({
      RUST_TEST_THREADS: '1',
      CARGO_BUILD_JOBS: '1',
    });
  });

  it('never lets the product of jobs and threads exceed the budget', () => {
    // jobs (3) does not evenly divide the budget (10): floor(10/3) = 3, so
    // jobs x threads = 9 <= 10, never rounding up past the budget.
    const env = buildInnerEnv('rust', 10, 3);
    expect(3 * Number(env.RUST_TEST_THREADS)).toBeLessThanOrEqual(10);
  });

  it('never asks for fewer than one thread even when jobs exceeds the budget', () => {
    expect(buildInnerEnv('rust', 1, 4)).toEqual({
      RUST_TEST_THREADS: '1',
      CARGO_BUILD_JOBS: '1',
    });
  });

  it('never asks for fewer than one thread', () => {
    expect(buildInnerEnv('rust', 0)).toEqual({
      RUST_TEST_THREADS: '1',
      CARGO_BUILD_JOBS: '1',
    });
  });

  it('bounds infection threads instead of leaving them at max', () => {
    expect(buildInnerEnv('php', 3)).toEqual({ CHAOS_PHP_THREADS: '3' });
  });

  it('has nothing to cap for typescript, whose runner is already single-threaded', () => {
    expect(buildInnerEnv('typescript', 4)).toEqual({});
  });

  it('has no pool to cap for python, which runs serially', () => {
    expect(buildInnerEnv('python', 4)).toEqual({});
  });
});
