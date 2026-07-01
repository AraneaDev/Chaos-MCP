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
): BaselineCommand | undefined {
  switch (projectType) {
    case 'rust':
      return { command: 'cargo', args: ['test'] };
    case 'python': {
      const runner = env.detectedRunner || 'pytest';
      return { command: runner.includes('pytest') ? 'pytest' : runner, args: [] };
    }
    case 'typescript': {
      const runner = env.detectedRunner || 'npm';
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
