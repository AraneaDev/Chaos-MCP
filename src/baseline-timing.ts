import {
  assertNeverProjectType,
  type EnvironmentInfo,
  type SupportedProjectType,
} from './utils/project-detector.js';

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
   * a warm worker and pays only mutant activation.
   */
  perMutantOverheadMs: { commandRunner: 1_500, native: 250 },
  /** One-time cost before the first mutant runs: Stryker init, instrumentation, dry run. */
  startupMs: { commandRunner: 10_000, native: 5_000 },
  /** Central-estimate multiplier over the adjusted work total. */
  estimateFactor: { commandRunner: 1.5, native: 1.2 },
  /** Upper-bound multiplier: how far a slow machine or noisy suite can stretch it. */
  upperBoundFactor: { commandRunner: 2.5, native: 1.75 },
} as const;

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
  commandRunner: boolean,
): TimingProjection {
  const workers = Math.max(1, concurrency);
  const mode = commandRunner ? 'commandRunner' : 'native';
  const startupMs = TIMING.startupMs[mode];
  const optimisticMs = projectEstimatedMs(mutants, baselineMs, workers);
  const adjustedWorkMs = Math.ceil(
    (mutants * (baselineMs + TIMING.perMutantOverheadMs[mode])) / workers,
  );
  return {
    optimisticMs,
    estimatedMs: startupMs + Math.ceil(adjustedWorkMs * TIMING.estimateFactor[mode]),
    upperBoundMs: startupMs * 2 + Math.ceil(adjustedWorkMs * TIMING.upperBoundFactor[mode]),
    confidence: commandRunner ? 'low' : 'medium',
  };
}
