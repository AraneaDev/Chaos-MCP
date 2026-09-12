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

  it('exposes the per-file admission charge as fixed cost plus workers times worker cost', () => {
    // Plentiful memory keeps the budget at the cpu figures, so the resolved
    // worker count is deterministic (3): the TypeScript registry entry's
    // fixed cost (900 MB) plus 3 workers at its worker cost (320 MB) should
    // be exactly what `perFileCostBytes` reports.
    const ctx = createResourceContext({
      projectType: 'typescript',
      cpuCount: 8,
      cpuFileConcurrency: 1,
      cpuPerFileWorkers: 3,
      probe: () => ({ availableBytes: 64 * GIB, limitBytes: 64 * GIB, source: 'host' }),
    });
    expect(ctx.budget.perFileWorkers).toBe(3);
    expect(ctx.perFileCostBytes).toBe(900 * 1024 ** 2 + 3 * 320 * 1024 ** 2);
    ctx.dispose();
  });

  it('builds the engine inner-pool env from the budget', () => {
    const ctx = createResourceContext({
      projectType: 'rust',
      cpuCount: 8,
      cpuFileConcurrency: 1,
      cpuPerFileWorkers: 8,
      probe: () => ({ availableBytes: 64 * GIB, limitBytes: 64 * GIB, source: 'host' }),
    });
    // Plenty of memory leaves the budget at 8, but cargo-mutants' own default
    // (resolveCargoJobs(undefined, 8) === 2) clamps `-j` to 2, so the inner
    // threads must be sized against that 2, not against the raw budget of 8:
    // 2 jobs x 4 threads = 8, the budget, rather than 2 jobs x 8 threads = 16.
    expect(ctx.innerEnv).toEqual({ RUST_TEST_THREADS: '4', CARGO_BUILD_JOBS: '4' });
    ctx.dispose();
  });
});
