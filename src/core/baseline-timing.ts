import {
  assertNeverProjectType,
  type EnvironmentInfo,
  type SupportedProjectType,
} from '../utils/project-detector.js';

export interface BaselineCommand {
  command: string;
  args: string[];
}

/**
 * Best-effort resolution of a one-shot test-suite command per language, used to
 * measure a baseline run time for `estimate_audit --withTiming`. Returns
 * undefined when no sensible default applies (caller omits timing).
 *
 * @param testRunner - The runner the AUDIT resolved for this target (engine
 *   config section → global config → detected env; see `buildRunOptions`).
 *   Passed EXPLICITLY rather than substituted into a copy of `env` so this
 *   function keeps one obvious source for the value and callers cannot pass a
 *   half-real environment; `env` still supplies `detectedRunner`, which is the
 *   detection signal and is genuinely environmental. Defaults to
 *   `env.testRunner`, preserving the behaviour of every existing call site.
 *   Measuring against `env.testRunner` when config overrode it made the
 *   baseline the wrong command for the run being estimated.
 */
/**
 * A build-only command to run BEFORE the timed baseline, for languages whose
 * test command compiles first. `undefined` when there is nothing to warm.
 *
 * Rust is the case this exists for. `cargo test` in a fresh sandbox compiles the
 * whole dependency graph and then runs the suite, and timing that gave a
 * `baselineMs` of 15s for a crate whose suite runs in under a second. The
 * projection multiplies the baseline BY THE MUTANT COUNT, so the one-time build
 * was charged to all 91 mutants: 14 minutes projected against a real 2. The
 * estimate then reported `fitsBudget: false` for a run that finishes inside the
 * default budget with time to spare — the estimate advising against an audit
 * that would have worked.
 *
 * Splitting the two measurements fixes the unit: this call's duration is the
 * one-time cost (passed to {@link projectTimingRange} as `startupMsOverride`),
 * and the timed run that follows it is the per-mutant cost, which is what the
 * multiplication actually wants.
 */
export function resolveBaselineWarmupCommand(
  projectType: SupportedProjectType,
): BaselineCommand | undefined {
  // `--no-run` builds the test binaries and stops. Only Rust: TypeScript and
  // Python are interpreted, and PHP's autoloader work is per-run rather than a
  // separable build step.
  if (projectType === 'rust') return { command: 'cargo', args: ['test', '--no-run'] };
  return undefined;
}

export function resolveBaselineTestCommand(
  env: EnvironmentInfo,
  projectType: SupportedProjectType,
  relFile?: string,
  testRunner: string = env.testRunner,
): BaselineCommand | undefined {
  switch (projectType) {
    case 'rust':
      return { command: 'cargo', args: ['test'] };
    case 'php':
      return { command: 'vendor/bin/phpunit', args: [] };
    case 'python': {
      const runner = env.detectedRunner || 'pytest';
      return { command: runner.includes('pytest') ? 'pytest' : runner, args: [] };
    }
    case 'typescript': {
      const runner = env.detectedRunner || 'npm';
      if (testRunner === 'command' && runner === 'vitest' && relFile) {
        return { command: 'npx', args: ['vitest', 'related', relFile, '--run'] };
      }
      if (runner === 'npm' || runner === 'yarn' || runner === 'pnpm') {
        return { command: runner, args: ['test'] };
      }
      if (runner === 'bun') return { command: 'bun', args: ['test'] };
      if (runner === 'node:test') return { command: 'node', args: ['--test'] };
      // vitest/jest/mocha → invoke via npx
      return { command: 'npx', args: [runner] };
    }
    default: {
      // Exhaustiveness guard, not a runtime check: `projectType` is narrowed to
      // `never` here, so adding a SupportedProjectType without a case above is a
      // COMPILE error rather than `estimate_audit --withTiming` silently
      // dropping timing (F15). The fallback below is retained and stays
      // unreachable for the declared union.
      assertNeverProjectType(projectType);
      return undefined;
    }
  }
}

/** Rough total-time projection: mutants × baseline / concurrency, rounded up. */
export function projectEstimatedMs(
  mutants: number,
  baselineMs: number,
  concurrency: number,
): number {
  return Math.ceil((mutants * baselineMs) / Math.max(1, concurrency));
}

export interface TimingProjection {
  optimisticMs: number;
  estimatedMs: number;
  upperBoundMs: number;
  confidence: 'low' | 'medium';
}

/**
 * Tuning constants for {@link projectTimingRange}.
 *
 * These are ESTIMATES, not measurements, and the range they produce is what
 * `fitsBudget` and the caller's audit/scope-down/skip decision rest on — so
 * each one records what it represents and which direction it errs in. They are
 * deliberately pessimistic: over-estimating costs a needless scope-down,
 * under-estimating costs a run that blows its budget and returns a partial
 * result. `timing-projection.test.ts` pins the invariants they must satisfy
 * (ordering, monotonicity) rather than the values themselves, so they can be
 * re-tuned against real runs without rewriting the tests.
 */
const TIMING = {
  /**
   * Per-mutant cost beyond the test run itself. The command runner re-launches
   * the whole test process per mutant and gets no per-test coverage
   * optimisation, so it pays a full framework bootstrap; a native runner keeps
   * a warm worker and pays only mutant activation. A compiled language pays an
   * INCREMENTAL REBUILD of the mutated crate before each mutant's suite can run
   * — measured at roughly two seconds on a small crate, and the single largest
   * per-mutant cost cargo-mutants has.
   */
  perMutantOverheadMs: { commandRunner: 1_500, native: 250, compiled: 2_000 },
  /**
   * One-time cost before the first mutant runs: Stryker init, instrumentation,
   * dry run. For `compiled` this is the cold build of the sandbox's workspace,
   * and the fallback below is only used when the warm-up could not be measured
   * — {@link projectTimingRange}'s `startupMsOverride` supplies the real figure.
   */
  startupMs: { commandRunner: 10_000, native: 5_000, compiled: 20_000 },
  /** Central-estimate multiplier over the adjusted work total. */
  estimateFactor: { commandRunner: 1.5, native: 1.2, compiled: 1.2 },
  /** Upper-bound multiplier: how far a slow machine or noisy suite can stretch it. */
  upperBoundFactor: { commandRunner: 2.5, native: 1.75, compiled: 1.75 },
} as const;

/**
 * Which cost profile a target runs under.
 *
 * - `commandRunner` — StrykerJS driving an external test command per mutant.
 * - `native` — an in-process runner reusing a warm worker.
 * - `compiled` — the engine rebuilds before each mutant (cargo-mutants), so the
 *   one-time build and the per-mutant cost are DIFFERENT numbers and the
 *   baseline must be measured warm. See {@link resolveBaselineWarmupCommand}.
 */
export type TimingMode = keyof (typeof TIMING)['perMutantOverheadMs'];

/** The cost profile for a language + runner pair. */
export function timingModeFor(projectType: SupportedProjectType, testRunner: string): TimingMode {
  if (projectType === 'rust') return 'compiled';
  if (projectType === 'typescript' && testRunner === 'command') return 'commandRunner';
  return 'native';
}

/**
 * Project a deliberately conservative wall-clock range.
 *
 * Command runners pay process/bootstrap cost for every mutant and do not enjoy
 * native per-test coverage optimisation. A baseline-only formula materially
 * underestimates that path, so include per-mutant and one-time Stryker overhead.
 *
 * Guarantees `optimisticMs <= estimatedMs <= upperBoundMs` for every input, so
 * a caller can treat the triple as a genuine range.
 */
export function projectTimingRange(
  mutants: number,
  baselineMs: number,
  concurrency: number,
  mode: TimingMode,
  startupMsOverride?: number,
): TimingProjection {
  const workers = Math.max(1, concurrency);
  // A MEASURED one-time cost beats the table's guess whenever the caller has
  // one. Only the compiled path produces it today (the warm-up build), and it
  // is the whole reason that path stopped over-projecting by a factor of seven.
  const startupMs = startupMsOverride ?? TIMING.startupMs[mode];
  const optimisticMs = projectEstimatedMs(mutants, baselineMs, workers);
  const adjustedWorkMs = Math.ceil(
    (mutants * (baselineMs + TIMING.perMutantOverheadMs[mode])) / workers,
  );
  return {
    optimisticMs,
    estimatedMs: startupMs + Math.ceil(adjustedWorkMs * TIMING.estimateFactor[mode]),
    upperBoundMs: startupMs * 2 + Math.ceil(adjustedWorkMs * TIMING.upperBoundFactor[mode]),
    confidence: mode === 'commandRunner' ? 'low' : 'medium',
  };
}
