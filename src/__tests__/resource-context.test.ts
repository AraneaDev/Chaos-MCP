import { describe, it, expect } from 'vitest';
import { createResourceContext } from '../core/resource-context.js';

const GIB = 1024 ** 3;

describe('createResourceContext', () => {
  it('lowers concurrency and reports what it chose', () => {
    const ctx = createResourceContext({
      projectType: 'typescript',
      cpuCount: 8,
      cpuFileConcurrency: 4,
      cpuPerFileWorkers: 2,
      probe: () => ({ availableBytes: 2 * GIB, limitBytes: 8 * GIB, source: 'host' }),
    });
    expect(ctx.budget.fileConcurrency).toBeLessThanOrEqual(4);
    expect(ctx.report()).toMatchObject({ source: 'host', watchdogTrips: 0 });
    ctx.dispose();
  });

  it('reproduces the cpu figures when the probe is unavailable', () => {
    const ctx = createResourceContext({
      projectType: 'rust',
      cpuCount: 8,
      cpuFileConcurrency: 4,
      cpuPerFileWorkers: 2,
      probe: () => ({ availableBytes: 0, limitBytes: 0, source: 'unavailable' }),
    });
    expect(ctx.budget).toMatchObject({ fileConcurrency: 4, perFileWorkers: 2 });
    expect(ctx.report().source).toBe('unavailable');
    ctx.dispose();
  });

  it('builds the engine inner-pool env from the budget', () => {
    const ctx = createResourceContext({
      projectType: 'rust',
      cpuCount: 8,
      cpuFileConcurrency: 1,
      cpuPerFileWorkers: 2,
      probe: () => ({ availableBytes: 64 * GIB, limitBytes: 64 * GIB, source: 'host' }),
    });
    expect(ctx.innerEnv).toEqual({ RUST_TEST_THREADS: '2', CARGO_BUILD_JOBS: '2' });
    ctx.dispose();
  });
});
