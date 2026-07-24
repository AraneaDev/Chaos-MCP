import type { EnvironmentInfo } from './utils/project-detector.js';
import type { SupportedProjectType } from './engines/registry.js';

export interface BaselineCommand {
  command: string;
  args: string[];
}

/**
 * Best-effort resolution of a one-shot test-suite command per language, used to
 * measure a baseline run time for `estimate_audit --withTiming`. Returns
 * undefined when no sensible default applies (caller omits timing).
 */
export function resolveBaselineTestCommand(
  env: EnvironmentInfo,
  projectType: SupportedProjectType,
  relFile?: string,
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
      if (env.testRunner === 'command' && runner === 'vitest' && relFile) {
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
    default:
      return undefined;
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
 * Project a deliberately conservative wall-clock range.
 *
 * Command runners pay process/bootstrap cost for every mutant and do not enjoy
 * native per-test coverage optimisation. A baseline-only formula materially
 * underestimates that path, so include per-mutant and one-time Stryker overhead.
 */
export function projectTimingRange(
  mutants: number,
  baselineMs: number,
  concurrency: number,
  commandRunner: boolean,
): TimingProjection {
  const workers = Math.max(1, concurrency);
  const perMutantOverheadMs = commandRunner ? 1_500 : 250;
  const startupMs = commandRunner ? 10_000 : 5_000;
  const optimisticMs = projectEstimatedMs(mutants, baselineMs, workers);
  const adjustedWorkMs = Math.ceil((mutants * (baselineMs + perMutantOverheadMs)) / workers);
  return {
    optimisticMs,
    estimatedMs: startupMs + Math.ceil(adjustedWorkMs * (commandRunner ? 1.5 : 1.2)),
    upperBoundMs: startupMs * 2 + Math.ceil(adjustedWorkMs * (commandRunner ? 2.5 : 1.75)),
    confidence: commandRunner ? 'low' : 'medium',
  };
}
