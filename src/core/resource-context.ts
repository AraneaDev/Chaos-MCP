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
import { defaultProbeDeps, probeMemory, type MemorySnapshot } from '../utils/resources/memory-probe.js';
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
  report(): ResourcesPayload;
  dispose(): void;
}

export function createResourceContext(input: ResourceContextInput): ResourceContext {
  const deps = defaultProbeDeps();
  const probe = input.probe ?? (() => probeMemory(deps));
  const snapshot = probe();
  const workerCostBytes = ENGINE_REGISTRY[input.projectType].workerCostBytes;

  const budget = resolveBudget({
    snapshot,
    workerCostBytes,
    cpuFileConcurrency: input.cpuFileConcurrency,
    cpuPerFileWorkers: input.cpuPerFileWorkers,
    requested: input.requested,
  });

  const floors = resolveFloors(snapshot.limitBytes);
  const watchdog = createWatchdog({
    probe: input.watchdogEnabled === false ? () => ({ ...snapshot, source: 'unavailable' }) : probe,
    admissionBytes: input.admissionFloorBytes ?? floors.admissionBytes,
    criticalBytes: input.criticalFloorBytes ?? floors.criticalBytes,
  });

  // The `-j`/`--concurrency` figure the engine will ACTUALLY run with, not
  // the raw per-file budget: `handler.ts` and `triage/audit-one.ts` clamp it
  // to the engine's own default (`defaultWorkers`) before handing it over.
  // This ensures we never raise the footprint above what the engine would use
  // on its own. When concurrency is omitted entirely (no explicit setting, probe
  // unavailable), the engine still applies its own default, so `buildInnerEnv`
  // has the real jobs figure to split the inner-pool env properly
  // (Finding: inner-pool env multiplied the budget instead of dividing it).
  const ownDefault = ENGINE_REGISTRY[input.projectType].defaultWorkers?.(
    input.cpuCount ?? cpus().length,
  );
  const jobs = ownDefault === undefined ? budget.perFileWorkers : Math.min(budget.perFileWorkers, ownDefault);

  return {
    budget,
    watchdog,
    innerEnv: buildInnerEnv(input.projectType, budget.perFileWorkers, jobs),
    workerCostBytes,
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
