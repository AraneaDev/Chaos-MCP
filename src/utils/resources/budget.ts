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

export function resolveBudget(input: BudgetInput): Budget {
  const { snapshot, workerCostBytes, cpuFileConcurrency, cpuPerFileWorkers, requested } = input;

  const cpuTotal = Math.max(1, cpuFileConcurrency) * Math.max(1, cpuPerFileWorkers);
  let affordableWorkers = cpuTotal;

  if (snapshot.source !== 'unavailable') {
    const { admissionBytes } = resolveFloors(snapshot.limitBytes);
    const spendable = Math.max(0, snapshot.availableBytes - admissionBytes);
    affordableWorkers = Math.max(1, Math.min(cpuTotal, Math.floor(spendable / workerCostBytes)));
  }

  // Spend the budget on files first, then on workers within a file: a second
  // file buys parallel progress, a second worker inside one file only shortens
  // that file.
  const fileConcurrency = Math.max(1, Math.min(cpuFileConcurrency, affordableWorkers));
  const perFileWorkers = Math.max(
    1,
    Math.min(cpuPerFileWorkers, Math.floor(affordableWorkers / fileConcurrency)),
  );

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
