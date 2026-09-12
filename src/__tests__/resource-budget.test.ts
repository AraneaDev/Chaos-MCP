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
      workerCostBytes: 300 * 1024 ** 2,
      cpuFileConcurrency: 4,
      cpuPerFileWorkers: 2,
    });
    expect(budget).toMatchObject({ fileConcurrency: 4, perFileWorkers: 2, overBudget: false });
  });

  it('keeps at least one file and one worker even under pressure', () => {
    const budget = resolveBudget({
      snapshot: snapshot(0),
      workerCostBytes: 1024 ** 3,
      cpuFileConcurrency: 4,
      cpuPerFileWorkers: 2,
    });
    expect(budget).toMatchObject({ fileConcurrency: 1, perFileWorkers: 1 });
  });

  it('reproduces the cpu figures exactly when the probe is unavailable', () => {
    const budget = resolveBudget({
      snapshot: { availableBytes: 0, limitBytes: 0, source: 'unavailable' },
      workerCostBytes: 1024 ** 3,
      cpuFileConcurrency: 4,
      cpuPerFileWorkers: 2,
    });
    expect(budget).toMatchObject({ fileConcurrency: 4, perFileWorkers: 2, overBudget: false });
  });

  it('honours an explicit request and flags it when it exceeds the budget', () => {
    const budget = resolveBudget({
      snapshot: snapshot(1 * GIB),
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
    // no memory verdict to report — overBudget stating true here would claim
    // a verdict no probe actually produced.
    const budget = resolveBudget({
      snapshot: { availableBytes: 0, limitBytes: 0, source: 'unavailable' },
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

describe('engine worker costs', () => {
  it('declares a positive cost for every engine', () => {
    for (const descriptor of Object.values(ENGINE_REGISTRY)) {
      expect(descriptor.workerCostBytes).toBeGreaterThan(0);
    }
  });
});
