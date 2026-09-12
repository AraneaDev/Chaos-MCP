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

  it('runs the Rust inner-pool env at the explicit job count, not the engine default (MAJOR 1)', () => {
    const ctx = createResourceContext({
      projectType: 'rust',
      cpuCount: 8,
      cpuFileConcurrency: 1,
      cpuPerFileWorkers: 1,
      // An explicit request for 8 wins outright over the CPU baseline
      // (resolveBudget lets `requested.perFileWorkers` win), so `perFileWorkers`
      // resolves to 8 regardless of `cpuPerFileWorkers` above.
      requested: { perFileWorkers: 8 },
      probe: () => ({ availableBytes: 64 * GIB, limitBytes: 64 * GIB, source: 'host' }),
    });
    // Before the fix, `jobs` was still clamped to cargo-mutants' own default
    // (resolveCargoJobs(undefined, 8) === 2) even for an explicit setting,
    // sizing RUST_TEST_THREADS/CARGO_BUILD_JOBS for `-j 2` while `resolveCargoJobs`
    // (rust/args.ts) actually runs cargo at `-j 8`, multiplying the real
    // concurrent thread count instead of spending the budget once.
    expect(ctx.innerEnv).toEqual({ RUST_TEST_THREADS: '1', CARGO_BUILD_JOBS: '1' });
    ctx.dispose();
  });

  it('keeps the admission gate enforcing admissionFloorBytes when watchdog is disabled (MAJOR 2)', async () => {
    const ctx = createResourceContext({
      projectType: 'typescript',
      cpuCount: 8,
      cpuFileConcurrency: 1,
      cpuPerFileWorkers: 1,
      watchdogEnabled: false,
      admissionFloorBytes: 2 * GIB,
      probe: () => ({ availableBytes: 1 * GIB, limitBytes: 8 * GIB, source: 'host' }),
    });
    // Before the fix, `watchdog: false` swapped in a fake 'unavailable'
    // snapshot for the watchdog's own probe, and `admit()` treats that source
    // as "admit unconditionally", so a signal aborted BEFORE admission would
    // still resolve 'admitted' instead of 'cancelled', because the
    // unconditional-admit branch runs before the abort check ever does.
    const controller = new AbortController();
    controller.abort();
    const result = await ctx.watchdog.admit(0, controller.signal);
    expect(result).toBe('cancelled');
    ctx.dispose();
  });

  it('sizes a mixed-language sweep from the most expensive target type, not the first one (Finding 2)', () => {
    // TypeScript first, Rust second: the exact ordering that hid the bug,
    // since a sweep that only ever reads `files[0]`'s engine never notices a
    // pricier language showing up later. TypeScript's admission charge (900
    // MiB fixed + 320 MiB/worker) is cheaper than Rust's (0 fixed + 850
    // MiB/worker), so sizing off TypeScript alone would under-charge Rust and
    // leave cargo-mutants' own worker pool unsized.
    const ctx = createResourceContext({
      projectType: 'typescript',
      projectTypes: ['rust'],
      cpuCount: 8,
      cpuFileConcurrency: 1,
      cpuPerFileWorkers: 4,
      probe: () => ({ availableBytes: 64 * GIB, limitBytes: 64 * GIB, source: 'host' }),
    });
    const perFileWorkers = ctx.budget.perFileWorkers;
    expect(ctx.perFileCostBytes).toBe(850 * 1024 ** 2 * perFileWorkers);
    expect(ctx.workerCostBytes).toBe(850 * 1024 ** 2);
    // The TypeScript-first, Rust-second ordering must not leak into which
    // language's cost is charged: the SAME sizing results whichever position
    // Rust appears at.
    const swapped = createResourceContext({
      projectType: 'rust',
      projectTypes: ['typescript'],
      cpuCount: 8,
      cpuFileConcurrency: 1,
      cpuPerFileWorkers: 4,
      probe: () => ({ availableBytes: 64 * GIB, limitBytes: 64 * GIB, source: 'host' }),
    });
    expect(swapped.perFileCostBytes).toBe(ctx.perFileCostBytes);
    ctx.dispose();
    swapped.dispose();
  });

  it('builds each target its OWN inner-pool env from the shared budget (Finding 2)', () => {
    // Plentiful memory keeps the shared worker budget at the CPU figure (4),
    // and Rust being the pricier engine (see above) does not change what
    // TypeScript's own inner env looks like: TypeScript still gets `{}`
    // (StrykerJS forces `singleThread: true` on its own), while Rust gets a
    // real cap rather than the empty env a TypeScript-only sizing pass used
    // to hand it.
    const ctx = createResourceContext({
      projectType: 'typescript',
      projectTypes: ['rust'],
      cpuCount: 8,
      cpuFileConcurrency: 1,
      cpuPerFileWorkers: 4,
      probe: () => ({ availableBytes: 64 * GIB, limitBytes: 64 * GIB, source: 'host' }),
    });
    expect(ctx.innerEnvFor('typescript')).toEqual({});
    const rustEnv = ctx.innerEnvFor('rust');
    expect(rustEnv.CARGO_BUILD_JOBS).toBeDefined();
    expect(rustEnv.RUST_TEST_THREADS).toBeDefined();
    ctx.dispose();
  });

  it('never resolves an admission floor below the critical floor (MINOR 8)', async () => {
    // `admissionFloorBytes` below `criticalFloorBytes` would let the admission
    // gate start a file at a memory level the very next watchdog tick stops
    // it at. 512 MiB admission vs 1 GiB critical is exactly that
    // independently-valid but jointly-unsafe pair from the finding.
    //
    // 768 MiB available sits strictly between the two configured numbers, so
    // it distinguishes which floor the gate actually enforces: it clears the
    // configured 512 MiB admission floor but not the 1 GiB critical floor.
    const ctx = createResourceContext({
      projectType: 'typescript',
      cpuCount: 8,
      cpuFileConcurrency: 1,
      cpuPerFileWorkers: 1,
      admissionFloorBytes: 512 * 1024 ** 2,
      criticalFloorBytes: 1 * GIB,
      probe: () => ({ availableBytes: 768 * 1024 ** 2, limitBytes: 8 * GIB, source: 'host' }),
    });
    const controller = new AbortController();
    controller.abort();
    // Before the fix, admissionBytes stayed at the configured 512 MiB, so 768
    // MiB available would satisfy admission (>= 512 MiB) and resolve
    // 'admitted' despite sitting below the 1 GiB critical floor. After the
    // fix, admissionBytes is clamped up to the critical floor (1 GiB), so 768
    // MiB no longer clears it and the pre-aborted signal resolves 'cancelled'.
    const result = await ctx.watchdog.admit(0, controller.signal);
    expect(result).toBe('cancelled');
    ctx.dispose();
  });
});
