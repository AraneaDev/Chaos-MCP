/**
 * Turns available memory into concurrency numbers.
 *
 * The rule that makes this safe to add: memory may only LOWER what the CPU
 * math already chose. A probe that cannot answer therefore reproduces today's
 * behaviour exactly, and no configuration can be made faster by breaking the
 * probe.
 *
 * Per-engine costs arrive as a parameter rather than being read from
 * ENGINE_REGISTRY, because utils must not import engines (Knossos boundary).
 */
import type { MemorySnapshot } from './memory-probe.js';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

const ADMISSION_FRACTION = 0.15;
const CRITICAL_FRACTION = 0.07;
const ADMISSION_ABSOLUTE_BYTES = 1 * GIB;
const CRITICAL_ABSOLUTE_BYTES = 512 * MIB;

export interface Floors {
  /** Memory that must remain free before another file is allowed to start. */
  admissionBytes: number;
  /** Memory below which the watchdog aborts the newest run. */
  criticalBytes: number;
}

export function resolveFloors(limitBytes: number): Floors {
  return {
    admissionBytes: Math.max(ADMISSION_ABSOLUTE_BYTES, limitBytes * ADMISSION_FRACTION),
    criticalBytes: Math.max(CRITICAL_ABSOLUTE_BYTES, limitBytes * CRITICAL_FRACTION),
  };
}

export interface BudgetInput {
  snapshot: MemorySnapshot;
  /**
   * What one FILE costs before any worker runs, in bytes. Paid before any
   * worker is bought (see `resolveBudget`'s sizing order). `0` for an engine
   * with no two-point measurement, which folds this term out entirely and
   * reproduces the pre-amendment, per-worker-only sizing for that engine.
   */
  fileFixedCostBytes: number;
  workerCostBytes: number;
  /** What the existing CPU-only math chose. Never raised, only lowered. */
  cpuFileConcurrency: number;
  cpuPerFileWorkers: number;
  /** Explicit user settings. These win, and set `overBudget` when they exceed the budget. */
  requested?: { fileConcurrency?: number; perFileWorkers?: number };
}

export interface Budget {
  fileConcurrency: number;
  perFileWorkers: number;
  /** True when an explicit setting asked for more than the memory budget allows. */
  overBudget: boolean;
}

/**
 * Sizing per the 2026-09-12 amendment: the cost of running `f` files at `w`
 * workers each is `f * (fixed + w * worker)`, so the fixed term is paid
 * BEFORE any worker is bought, in this order:
 *
 *   1. spendable = available - admissionFloor
 *   2. fileConcurrency = max(1, min(cpuFileConcurrency, floor(spendable / fixed)))
 *   3. perFileWorkers = max(1, min(cpuPerFileWorkers,
 *        floor((spendable - fileConcurrency * fixed) / (fileConcurrency * worker))))
 *
 * A `fileFixedCostBytes` of `0` (every engine but TypeScript today) falls
 * back, for step 2 only, to bounding file concurrency by `workerCostBytes`
 * instead of a fixed cost of zero. This is deliberate, not an approximation:
 * it makes step 2 and step 3 together reproduce the pre-amendment,
 * per-worker-only formula (`floor(floor(spendable / worker) / files)` is the
 * same number as `floor(spendable / (files * worker))` for positive integer
 * `files`, by the standard floor-division identity), so an engine with no
 * fixed-cost measurement gets EXACTLY today's behaviour, not a weaker one
 * where a zero fixed cost stops memory from bounding file concurrency at all.
 */
export function resolveBudget(input: BudgetInput): Budget {
  const { snapshot, fileFixedCostBytes, workerCostBytes, cpuFileConcurrency, cpuPerFileWorkers, requested } =
    input;

  let fileConcurrency = Math.max(1, cpuFileConcurrency);
  let perFileWorkers = Math.max(1, cpuPerFileWorkers);

  if (snapshot.source !== 'unavailable') {
    const { admissionBytes } = resolveFloors(snapshot.limitBytes);
    const spendable = Math.max(0, snapshot.availableBytes - admissionBytes);

    // Step 2: pay the fixed per-file cost first, one file at a time. No
    // measured fixed cost falls back to the worker cost for this step alone
    // (see the docblock above for why that reproduces, rather than weakens,
    // the pre-amendment sizing).
    const fileConcurrencyLimit = Math.floor(
      spendable / (fileFixedCostBytes > 0 ? fileFixedCostBytes : workerCostBytes),
    );
    fileConcurrency = Math.max(1, Math.min(cpuFileConcurrency, fileConcurrencyLimit));

    // Step 3: spend whatever the fixed cost left on workers, split evenly
    // across the files just bought.
    const remaining = Math.max(0, spendable - fileConcurrency * fileFixedCostBytes);
    const workerLimit = Math.floor(remaining / (fileConcurrency * workerCostBytes));
    perFileWorkers = Math.max(1, Math.min(cpuPerFileWorkers, workerLimit));
  }

  const resolvedFiles = requested?.fileConcurrency ?? fileConcurrency;
  const resolvedWorkers = requested?.perFileWorkers ?? perFileWorkers;
  // An 'unavailable' probe applied no memory constraint at all (the CPU-only
  // figures were reproduced exactly, above), so there is no memory verdict to
  // report: `overBudget` must stay false regardless of what was requested,
  // never state a verdict the probe never actually produced (MINOR 9).
  const overBudget =
    snapshot.source !== 'unavailable' &&
    ((requested?.fileConcurrency !== undefined && requested.fileConcurrency > fileConcurrency) ||
      (requested?.perFileWorkers !== undefined && requested.perFileWorkers > perFileWorkers));

  return {
    fileConcurrency: resolvedFiles,
    perFileWorkers: resolvedWorkers,
    overBudget,
  };
}
