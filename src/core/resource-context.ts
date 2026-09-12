/**
 * One request's memory budget, watchdog and engine env.
 *
 * Lives in core rather than utils because it reads per-engine worker costs from
 * ENGINE_REGISTRY, and utils must not import engines.
 */
import { cpus } from 'node:os';
import { ENGINE_REGISTRY } from '../engines/registry.js';
import { buildInnerEnv } from '../engines/inner-pool.js';
import type { SupportedProjectType } from '../utils/project-detector.js';
import {
  defaultProbeDeps,
  probeMemory,
  type MemorySnapshot,
} from '../utils/resources/memory-probe.js';
import { resolveBudget, resolveFloors, type Budget } from '../utils/resources/budget.js';
import { createWatchdog, type Watchdog } from '../utils/resources/watchdog.js';

export interface ResourcesPayload {
  availableAtStartBytes: number;
  limitBytes: number;
  source: MemorySnapshot['source'];
  fileConcurrency: number;
  perFileWorkers: number;
  overBudget: boolean;
  watchdogTrips: number;
}

export interface ResourceContextInput {
  projectType: SupportedProjectType;
  cpuCount?: number;
  cpuFileConcurrency: number;
  cpuPerFileWorkers: number;
  requested?: { fileConcurrency?: number; perFileWorkers?: number };
  watchdogEnabled?: boolean;
  admissionFloorBytes?: number;
  criticalFloorBytes?: number;
  /** Injectable for tests; defaults to the real probe. */
  probe?: () => MemorySnapshot;
}

export interface ResourceContext {
  budget: Budget;
  watchdog: Watchdog;
  innerEnv: NodeJS.ProcessEnv;
  workerCostBytes: number;
  /**
   * The admission charge for ONE file at the resolved budget:
   * `fileFixedCostBytes + perFileWorkers * workerCostBytes`. This is what the
   * triage admission gate and the watchdog registration on both the triage
   * and single-file paths charge, per the 2026-09-12 cost-model amendment,
   * rather than the pre-amendment workers-only figure.
   */
  perFileCostBytes: number;
  report(): ResourcesPayload;
  dispose(): void;
}

export function createResourceContext(input: ResourceContextInput): ResourceContext {
  const deps = defaultProbeDeps();
  const probe = input.probe ?? (() => probeMemory(deps));
  const snapshot = probe();
  const { workerCostBytes, fileFixedCostBytes } = ENGINE_REGISTRY[input.projectType];

  const budget = resolveBudget({
    snapshot,
    fileFixedCostBytes,
    workerCostBytes,
    cpuFileConcurrency: input.cpuFileConcurrency,
    cpuPerFileWorkers: input.cpuPerFileWorkers,
    requested: input.requested,
  });

  const floors = resolveFloors(snapshot.limitBytes);
  const criticalBytes = input.criticalFloorBytes ?? floors.criticalBytes;
  // An admission floor below the critical floor would let a run start at a
  // memory level the very next watchdog tick immediately stops it at, so the
  // resolved pair (defaults and either override merged) is clamped to keep
  // the invariant `admissionBytes >= criticalBytes` rather than trusting an
  // independently-valid but jointly-unsafe pair of config values.
  const admissionBytes = Math.max(
    input.admissionFloorBytes ?? floors.admissionBytes,
    criticalBytes,
  );
  // `resources.watchdog: false` disables ONLY the critical-stop sampler
  // (`criticalStopEnabled`), documented as leaving sizing and the admission
  // gate in place. The watchdog keeps the REAL probe either way: faking an
  // 'unavailable' snapshot here would also disable `admit()`'s check against
  // `admissionBytes`, since the watchdog treats that source as "disable every
  // judgement", not just the critical one.
  const watchdog = createWatchdog({
    probe,
    criticalStopEnabled: input.watchdogEnabled !== false,
    admissionBytes,
    criticalBytes,
  });

  // The `-j`/`--concurrency` figure the engine will ACTUALLY run with, not
  // the raw per-file budget: `handler.ts` and `triage/audit-one.ts` clamp it
  // to the engine's own default (`defaultWorkers`) before handing it over.
  // This ensures we never raise the footprint above what the engine would use
  // on its own. When concurrency is omitted entirely (no explicit setting, probe
  // unavailable), the engine still applies its own default, so `buildInnerEnv`
  // has the real jobs figure to split the inner-pool env properly
  // (Finding: inner-pool env multiplied the budget instead of dividing it).
  //
  // An explicit setting skips that clamp entirely: `resolveCargoJobs` (and its
  // TypeScript/PHP equivalents) run cargo-mutants at the user's own value, so
  // sizing `buildInnerEnv` against the engine's default here would build inner
  // thread counts for a job count cargo never actually runs with.
  const ownDefault = ENGINE_REGISTRY[input.projectType].defaultWorkers?.(
    input.cpuCount ?? cpus().length,
  );
  const jobs =
    input.requested?.perFileWorkers !== undefined
      ? budget.perFileWorkers
      : ownDefault === undefined
        ? budget.perFileWorkers
        : Math.min(budget.perFileWorkers, ownDefault);

  return {
    budget,
    watchdog,
    innerEnv: buildInnerEnv(input.projectType, budget.perFileWorkers, jobs),
    workerCostBytes,
    perFileCostBytes: fileFixedCostBytes + budget.perFileWorkers * workerCostBytes,
    report: () => ({
      availableAtStartBytes: snapshot.availableBytes,
      limitBytes: snapshot.limitBytes,
      source: snapshot.source,
      fileConcurrency: budget.fileConcurrency,
      perFileWorkers: budget.perFileWorkers,
      overBudget: budget.overBudget,
      watchdogTrips: watchdog.trips,
    }),
    dispose: () => watchdog.stop(),
  };
}
