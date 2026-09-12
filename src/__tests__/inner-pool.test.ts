import { describe, it, expect } from 'vitest';
import { buildInnerEnv } from '../engines/inner-pool.js';

describe('buildInnerEnv', () => {
  it('caps cargo test threads and build jobs for rust', () => {
    expect(buildInnerEnv('rust', 2)).toEqual({
      RUST_TEST_THREADS: '2',
      CARGO_BUILD_JOBS: '2',
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
