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
  /**
   * Every OTHER project type actually present among a sweep's targets
   * (Finding: a triage sweep sized its whole budget off only the FIRST
   * file's engine, so a TypeScript-first, Rust-second sweep handed Rust
   * files an empty inner-pool env, uncapping cargo-mutants' own worker pool,
   * and charged the admission gate TypeScript's per-worker cost for a file
   * that actually costs more). Combined with `projectType` below to pick
   * whichever type resolves to the most expensive per-file charge at the
   * resolved worker count: the conservative direction is the higher cost and
   * the lower concurrency, never the first file's language alone. `undefined`
   * (every single-file caller, and a sweep that only ever saw one language)
   * reproduces the pre-amendment, `projectType`-only sizing exactly.
   */
  projectTypes?: SupportedProjectType[];
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
  /** `innerEnvFor(projectType)`, the single-language convenience every caller with only one type used before `projectTypes` existed. */
  innerEnv: NodeJS.ProcessEnv;
  /**
   * The engine inner-pool env for ONE target's OWN project type, sized from
   * the SAME resolved worker budget every target in the sweep shares. A
   * mixed-language sweep must build this per file from that file's own
   * type, not once from whichever type sizing picked: TypeScript's own inner
   * env is `{}` (StrykerJS forces `singleThread: true` on its own), and
   * handing that verbatim to a Rust file left cargo-mutants' `-j` and its
   * build/test thread count completely uncapped.
   */
  innerEnvFor(projectType: SupportedProjectType): NodeJS.ProcessEnv;
  workerCostBytes: number;
  /**
   * The admission charge for ONE file at the resolved budget:
   * `fileFixedCostBytes + perFileWorkers * workerCostBytes`. This is what the
   * triage admission gate and the watchdog registration on both the triage
   * and single-file paths charge, per the 2026-09-12 cost-model amendment,
   * rather than the pre-amendment workers-only figure. Sized from the most
   * expensive of `projectType` and `projectTypes` (see there), so a sweep
   * that spans several engines charges every file the pricier one's cost
   * rather than under-charging for it.
   */
  perFileCostBytes: number;
  report(): ResourcesPayload;
  dispose(): void;
}

export function createResourceContext(input: ResourceContextInput): ResourceContext {
  const deps = defaultProbeDeps();
  const probe = input.probe ?? (() => probeMemory(deps));
  const snapshot = probe();

  const resolveFor = (projectType: SupportedProjectType) => {
    const { workerCostBytes, fileFixedCostBytes } = ENGINE_REGISTRY[projectType];
    const budget = resolveBudget({
      snapshot,
      fileFixedCostBytes,
      workerCostBytes,
      cpuFileConcurrency: input.cpuFileConcurrency,
      cpuPerFileWorkers: input.cpuPerFileWorkers,
      requested: input.requested,
    });
    return {
      workerCostBytes,
      fileFixedCostBytes,
      budget,
      perFileCostBytes: fileFixedCostBytes + budget.perFileWorkers * workerCostBytes,
    };
  };

  // Pick whichever candidate type resolves to the most expensive per-file
  // charge, and size the WHOLE sweep (fileConcurrency, perFileWorkers, the
  // admission charge) from that one rather than from `projectType` alone: a
  // sweep spans one language most of the time, but when it does not, sizing
  // off only the first file's engine silently under-charged a pricier one.
  // The conservative direction is the higher cost and the lower concurrency.
  const candidates = Array.from(new Set([input.projectType, ...(input.projectTypes ?? [])]));
  let chosen = resolveFor(candidates[0]);
  for (const projectType of candidates.slice(1)) {
    const candidate = resolveFor(projectType);
    if (candidate.perFileCostBytes > chosen.perFileCostBytes) chosen = candidate;
  }
  const { budget, perFileCostBytes } = chosen;

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
  //
  // Computed PER TARGET TYPE (not just the type sizing picked): each engine's
  // own default clamp is its own, and `buildInnerEnv`'s env keys and split
  // are per-language too (Finding: a TypeScript-sized inner env is `{}`,
  // which left a Rust file's cargo-mutants entirely uncapped). Every type
  // shares the SAME resolved `budget.perFileWorkers`, only the clamp and the
  // resulting env differ.
  const jobsFor = (projectType: SupportedProjectType): number => {
    const ownDefault = ENGINE_REGISTRY[projectType].defaultWorkers?.(
      input.cpuCount ?? cpus().length,
    );
    return input.requested?.perFileWorkers !== undefined
      ? budget.perFileWorkers
      : ownDefault === undefined
        ? budget.perFileWorkers
        : Math.min(budget.perFileWorkers, ownDefault);
  };
  const innerEnvFor = (projectType: SupportedProjectType): NodeJS.ProcessEnv =>
    buildInnerEnv(projectType, budget.perFileWorkers, jobsFor(projectType));

  return {
    budget,
    watchdog,
    innerEnv: innerEnvFor(input.projectType),
    innerEnvFor,
    workerCostBytes: chosen.workerCostBytes,
    perFileCostBytes,
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
