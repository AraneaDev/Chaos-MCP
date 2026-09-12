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
    cpuCount: input.cpuCount ?? cpus().length,
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

  return {
    budget,
    watchdog,
    innerEnv: buildInnerEnv(input.projectType, budget.perFileWorkers),
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
