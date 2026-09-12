import { describe, it, expect } from 'vitest';
import { resolveBudget, resolveFloors } from '../utils/resources/budget.js';
import { ENGINE_REGISTRY } from '../engines/registry.js';

const GIB = 1024 ** 3;
const snapshot = (availableBytes: number, limitBytes = 8 * GIB) =>
  ({ availableBytes, limitBytes, source: 'host' }) as const;

describe('resolveFloors', () => {
  it('uses the percentage when it is larger than the absolute floor', () => {
    expect(resolveFloors(32 * GIB)).toEqual({
      admissionBytes: 0.15 * 32 * GIB,
      criticalBytes: 0.07 * 32 * GIB,
    });
  });

  it('never falls below the absolute floors on a small machine', () => {
    const floors = resolveFloors(2 * GIB);
    expect(floors.admissionBytes).toBe(1024 ** 3);
    expect(floors.criticalBytes).toBe(512 * 1024 ** 2);
  });
});

describe('resolveBudget', () => {
  it('lowers the cpu figure when memory is tight', () => {
    const budget = resolveBudget({
      snapshot: snapshot(2 * GIB),
      fileFixedCostBytes: 0,
      workerCostBytes: 300 * 1024 ** 2,
      cpuFileConcurrency: 4,
      cpuPerFileWorkers: 2,
    });
    // 2 GiB minus a 1 GiB admission floor leaves 1 GiB, which buys 3 workers.
    expect(budget.fileConcurrency * budget.perFileWorkers).toBeLessThanOrEqual(3);
    expect(budget.fileConcurrency).toBeLessThanOrEqual(4);
  });

  it('never raises the cpu figure when memory is plentiful', () => {
    const budget = resolveBudget({
      snapshot: snapshot(64 * GIB, 64 * GIB),
      fileFixedCostBytes: 0,
      workerCostBytes: 300 * 1024 ** 2,
      cpuFileConcurrency: 4,
      cpuPerFileWorkers: 2,
    });
    expect(budget).toMatchObject({ fileConcurrency: 4, perFileWorkers: 2, overBudget: false });
  });

  it('keeps at least one file and one worker even under pressure', () => {
    const budget = resolveBudget({
      snapshot: snapshot(0),
      fileFixedCostBytes: 0,
      workerCostBytes: 1024 ** 3,
      cpuFileConcurrency: 4,
      cpuPerFileWorkers: 2,
    });
    expect(budget).toMatchObject({ fileConcurrency: 1, perFileWorkers: 1 });
  });

  it('reproduces the cpu figures exactly when the probe is unavailable', () => {
    const budget = resolveBudget({
      snapshot: { availableBytes: 0, limitBytes: 0, source: 'unavailable' },
      fileFixedCostBytes: 0,
      workerCostBytes: 1024 ** 3,
      cpuFileConcurrency: 4,
      cpuPerFileWorkers: 2,
    });
    expect(budget).toMatchObject({ fileConcurrency: 4, perFileWorkers: 2, overBudget: false });
  });

  it('honours an explicit request and flags it when it exceeds the budget', () => {
    const budget = resolveBudget({
      snapshot: snapshot(1 * GIB),
      fileFixedCostBytes: 0,
      workerCostBytes: 300 * 1024 ** 2,
      cpuFileConcurrency: 4,
      cpuPerFileWorkers: 2,
      requested: { fileConcurrency: 8 },
    });
    expect(budget.fileConcurrency).toBe(8);
    expect(budget.overBudget).toBe(true);
  });

  it('never flags overBudget when the probe is unavailable, even for a request the cpu baseline would exceed (MINOR 9)', () => {
    // An 'unavailable' probe applies no memory constraint at all, so there is
    // no memory verdict to report, overBudget stating true here would claim
    // a verdict no probe actually produced.
    const budget = resolveBudget({
      snapshot: { availableBytes: 0, limitBytes: 0, source: 'unavailable' },
      fileFixedCostBytes: 0,
      workerCostBytes: 300 * 1024 ** 2,
      cpuFileConcurrency: 4,
      cpuPerFileWorkers: 2,
      requested: { fileConcurrency: 8, perFileWorkers: 6 },
    });
    expect(budget.fileConcurrency).toBe(8);
    expect(budget.perFileWorkers).toBe(6);
    expect(budget.overBudget).toBe(false);
  });
});

describe('resolveBudget: the 2026-09-12 fixed-per-file-cost amendment', () => {
  const FIXED = 900 * 1024 ** 2;
  const WORKER = 320 * 1024 ** 2;

  it('buys the fixed cost before workers: a budget for two files fixed plus one worker beyond it lands on two files at one worker each, not one file at many workers', () => {
    // spendable = 2 * FIXED (both files' fixed cost) + 2 * WORKER (exactly
    // one worker each, split across the two files bought).
    const spendable = 2 * FIXED + 2 * WORKER;
    const budget = resolveBudget({
      snapshot: snapshot(spendable + 1.2 * GIB, 8 * GIB), // + the 8 GiB admission floor
      fileFixedCostBytes: FIXED,
      workerCostBytes: WORKER,
      cpuFileConcurrency: 4,
      cpuPerFileWorkers: 8,
    });
    expect(budget).toMatchObject({ fileConcurrency: 2, perFileWorkers: 1 });
  });

  it('costs fewer workers over more files as MORE than more workers over fewer files, the property a per-worker-only model gets backwards', () => {
    // The two real acceptance-ramp sweeps from the amendment: 2 files x 3
    // workers peaked at 3547 MB, 4 files x 1 worker peaked at 4665 MB, i.e.
    // the SAME engine cost MORE with fewer workers spread over more files. A
    // per-worker-only model (the pre-amendment `workerCostBytes: 600 MB`)
    // gets the ORDER backwards: 6 workers x 600 MB (3600 MB) looks pricier
    // than 4 workers x 600 MB (2400 MB), the opposite of what was measured.
    //
    // Exercised through `resolveBudget` itself rather than the two figures'
    // raw arithmetic, so a regression in the production cost function fails
    // this test: give both configurations the SAME memory, sized to the
    // cheaper measurement, and check which one `resolveBudget` actually has
    // to cut.
    const MIB = 1024 ** 2;
    const limitBytes = 8 * GIB;
    const { admissionBytes } = resolveFloors(limitBytes);
    const availableAtCheaperMeasurement = 3547 * MIB + admissionBytes;

    const cheaper = resolveBudget({
      snapshot: snapshot(availableAtCheaperMeasurement, limitBytes),
      fileFixedCostBytes: FIXED,
      workerCostBytes: WORKER,
      cpuFileConcurrency: 2,
      cpuPerFileWorkers: 3,
    });
    // The memory its own real measurement needed is enough: its file count
    // is not cut.
    expect(cheaper.fileConcurrency).toBe(2);

    const pricier = resolveBudget({
      snapshot: snapshot(availableAtCheaperMeasurement, limitBytes),
      fileFixedCostBytes: FIXED,
      workerCostBytes: WORKER,
      cpuFileConcurrency: 4,
      cpuPerFileWorkers: 1,
    });
    // The same memory that comfortably covers 2 files at 3 workers each is
    // not enough for 4 files at 1 worker each: `resolveBudget` cuts its file
    // count. A per-worker-only model, which sees 6 workers as pricier than
    // 4, would have cut the CHEAPER configuration instead.
    expect(pricier.fileConcurrency).toBeLessThan(4);

    // Handed its OWN real measurement as the available memory, the pricier
    // configuration is not cut.
    const availableAtPricierMeasurement = 4665 * MIB + admissionBytes;
    const pricierAtOwnMeasurement = resolveBudget({
      snapshot: snapshot(availableAtPricierMeasurement, limitBytes),
      fileFixedCostBytes: FIXED,
      workerCostBytes: WORKER,
      cpuFileConcurrency: 4,
      cpuPerFileWorkers: 1,
    });
    expect(pricierAtOwnMeasurement).toMatchObject({ fileConcurrency: 4, perFileWorkers: 1 });
  });

  it('an unavailable probe still reproduces the cpu figures exactly with a nonzero fixed cost, and overBudget stays false', () => {
    const budget = resolveBudget({
      snapshot: { availableBytes: 0, limitBytes: 0, source: 'unavailable' },
      fileFixedCostBytes: FIXED,
      workerCostBytes: WORKER,
      cpuFileConcurrency: 4,
      cpuPerFileWorkers: 2,
    });
    expect(budget).toMatchObject({ fileConcurrency: 4, perFileWorkers: 2, overBudget: false });
  });
});

describe('engine worker and fixed costs', () => {
  it('declares a positive worker cost for every engine', () => {
    for (const descriptor of Object.values(ENGINE_REGISTRY)) {
      expect(descriptor.workerCostBytes).toBeGreaterThan(0);
    }
  });

  it('declares a nonnegative fixed cost for every engine, positive only where measured (TypeScript)', () => {
    expect(ENGINE_REGISTRY.typescript.fileFixedCostBytes).toBeGreaterThan(0);
    for (const descriptor of Object.values(ENGINE_REGISTRY)) {
      expect(descriptor.fileFixedCostBytes).toBeGreaterThanOrEqual(0);
    }
    const nonTypescript = Object.entries(ENGINE_REGISTRY).filter(([projectType]) => projectType !== 'typescript');
    for (const [, descriptor] of nonTypescript) {
      expect(descriptor.fileFixedCostBytes).toBe(0);
    }
  });
});
