import { describe, it, expect } from 'vitest';
import {
  resolveBaselineTestCommand,
  projectEstimatedMs,
  projectTimingRange,
} from '../core/baseline-timing.js';
import type { EnvironmentInfo, SupportedProjectType } from '../utils/project-detector.js';

const env = (over: Partial<EnvironmentInfo> = {}): EnvironmentInfo =>
  ({
    testRunner: 'command',
    detectedRunner: 'npm',
    packageManager: 'npm',
    workspaceRoot: '/ws',
    projectType: 'typescript',
    ...over,
  }) as EnvironmentInfo;

describe('projectEstimatedMs', () => {
  it('scales mutants by baseline over concurrency', () => {
    expect(projectEstimatedMs(100, 1000, 4)).toBe(25000);
  });
  it('treats concurrency < 1 as 1', () => {
    expect(projectEstimatedMs(10, 100, 0)).toBe(1000);
  });
  it('rounds up fractional results', () => {
    expect(projectEstimatedMs(3, 100, 4)).toBe(75);
    expect(projectEstimatedMs(1, 100, 3)).toBe(34);
  });
});

describe('projectTimingRange', () => {
  it('adds conservative startup and per-mutant overhead for command runners', () => {
    const result = projectTimingRange(40, 500, 4, 'commandRunner');
    expect(result.optimisticMs).toBe(5_000);
    expect(result.estimatedMs).toBe(40_000);
    expect(result.upperBoundMs).toBe(70_000);
    expect(result.confidence).toBe('low');
  });

  it('refuses a negative measured startup, keeping the range ordered', () => {
    // The override is a `Date.now()` delta from `applyTiming`, and a wall clock
    // that steps backwards mid-build makes it negative. Unclamped, the two upper
    // figures shrink below the work total and can go negative outright, breaking
    // the ordering this function documents for every input.
    const skewed = projectTimingRange(40, 500, 4, 'compiled', -1_000_000);
    expect(skewed.optimisticMs).toBeLessThanOrEqual(skewed.estimatedMs);
    expect(skewed.estimatedMs).toBeLessThanOrEqual(skewed.upperBoundMs);
    expect(skewed.estimatedMs).toBeGreaterThan(0);
    // A zero override is a real measurement (an already-warm build), not a
    // missing one, so it must NOT fall back to the table's guess.
    expect(projectTimingRange(40, 500, 4, 'compiled', 0).estimatedMs).toBe(skewed.estimatedMs);
  });

  it('uses a tighter range for native runners', () => {
    const command = projectTimingRange(40, 500, 4, 'commandRunner');
    const native = projectTimingRange(40, 500, 4, 'native');
    expect(native.estimatedMs).toBe(14_000);
    expect(native.upperBoundMs).toBe(23_125);
    expect(native.upperBoundMs).toBeLessThan(command.upperBoundMs);
    expect(native.confidence).toBe('medium');
  });
});

describe('resolveBaselineTestCommand', () => {
  it('resolves rust', () => {
    expect(resolveBaselineTestCommand(env(), 'rust')).toEqual({ command: 'cargo', args: ['test'] });
  });
  it('resolves php to the vendored phpunit binary with no arguments', () => {
    // The PHP case had no test at all: a blanked command string or a stray
    // argument would have shipped an unrunnable baseline command, and
    // `estimate_audit --withTiming` would have silently reported no timing.
    expect(resolveBaselineTestCommand(env(), 'php')).toEqual({
      command: 'vendor/bin/phpunit',
      args: [],
    });
  });

  it('ignores the detected runner for php', () => {
    // PHP resolution is unconditional — a JS runner leaking in from the
    // environment must not change the command.
    expect(resolveBaselineTestCommand(env({ detectedRunner: 'vitest' }), 'php')?.command).toBe(
      'vendor/bin/phpunit',
    );
  });

  it('resolves python to pytest with empty args', () => {
    expect(resolveBaselineTestCommand(env({ detectedRunner: 'pytest' }), 'python')).toEqual({
      command: 'pytest',
      args: [],
    });
  });
  it('resolves a non-pytest python runner to that runner verbatim', () => {
    // The ternary `runner.includes('pytest') ? 'pytest' : runner` false arm.
    expect(resolveBaselineTestCommand(env({ detectedRunner: 'nose2' }), 'python')).toEqual({
      command: 'nose2',
      args: [],
    });
  });
  it('resolves python with default to pytest when no detectedRunner', () => {
    expect(resolveBaselineTestCommand(env({ detectedRunner: '' }), 'python')?.command).toBe(
      'pytest',
    );
  });
  it('resolves a js runner via npm', () => {
    const cmd = resolveBaselineTestCommand(env({ detectedRunner: 'npm' }), 'typescript');
    expect(cmd).toBeDefined();
    expect(cmd?.command).toBe('npm');
    expect(cmd?.args).toEqual(['test']);
  });
  it('defaults a TS runner-less env to npm test', () => {
    // `env.detectedRunner || 'npm'` — an empty detectedRunner must fall back to npm.
    expect(resolveBaselineTestCommand(env({ detectedRunner: '' }), 'typescript')).toEqual({
      command: 'npm',
      args: ['test'],
    });
  });
  it('resolves yarn', () => {
    const cmd = resolveBaselineTestCommand(env({ detectedRunner: 'yarn' }), 'typescript');
    expect(cmd).toEqual({ command: 'yarn', args: ['test'] });
  });
  it('resolves pnpm', () => {
    const cmd = resolveBaselineTestCommand(env({ detectedRunner: 'pnpm' }), 'typescript');
    expect(cmd).toEqual({ command: 'pnpm', args: ['test'] });
  });
  it('resolves bun', () => {
    const cmd = resolveBaselineTestCommand(env({ detectedRunner: 'bun' }), 'typescript');
    expect(cmd).toEqual({ command: 'bun', args: ['test'] });
  });
  it('resolves vitest/jest via npx', () => {
    const cmd = resolveBaselineTestCommand(env({ detectedRunner: 'vitest' }), 'typescript');
    expect(cmd?.command).toBe('npx');
    expect(cmd?.args).toEqual(['vitest']);
  });
  it('matches the scoped Vitest command-runner command used by mutation audits', () => {
    expect(
      resolveBaselineTestCommand(
        env({ testRunner: 'command', detectedRunner: 'vitest' }),
        'typescript',
        'src/gate.ts',
      ),
    ).toEqual({
      command: 'npx',
      args: ['vitest', 'related', 'src/gate.ts', '--run'],
    });
  });
  it('does not scope native Vitest or a command runner backed by another framework', () => {
    expect(
      resolveBaselineTestCommand(
        env({ testRunner: 'vitest', detectedRunner: 'vitest' }),
        'typescript',
        'src/gate.ts',
      ),
    ).toEqual({ command: 'npx', args: ['vitest'] });
    expect(
      resolveBaselineTestCommand(
        env({ testRunner: 'command', detectedRunner: 'jest' }),
        'typescript',
        'src/gate.ts',
      ),
    ).toEqual({ command: 'npx', args: ['jest'] });
  });
  it('prefers an explicitly resolved runner over env.testRunner', () => {
    // The audit resolves its runner as
    // `engine config section ?? cfg.testRunner ?? env.testRunner`, so a config
    // file can turn a detected-vitest project into a command-runner audit.
    // Reading `env.testRunner` here measured the baseline with the WRONG
    // command for the run being estimated — `npx vitest` (whole suite, native)
    // instead of the scoped `vitest related` the command runner uses.
    expect(
      resolveBaselineTestCommand(
        env({ testRunner: 'vitest', detectedRunner: 'vitest' }),
        'typescript',
        'src/gate.ts',
        'command',
      ),
    ).toEqual({ command: 'npx', args: ['vitest', 'related', 'src/gate.ts', '--run'] });
  });

  it('honours a resolved runner that is NOT the command runner over a command-runner env', () => {
    // The opposite direction of the same override, so the parameter cannot be
    // ignored in one arm only.
    expect(
      resolveBaselineTestCommand(
        env({ testRunner: 'command', detectedRunner: 'vitest' }),
        'typescript',
        'src/gate.ts',
        'vitest',
      ),
    ).toEqual({ command: 'npx', args: ['vitest'] });
  });

  it('resolves node:test to node --test', () => {
    const cmd = resolveBaselineTestCommand(env({ detectedRunner: 'node:test' }), 'typescript');
    expect(cmd).toEqual({ command: 'node', args: ['--test'] });
  });
  it('returns undefined for an unsupported project type (default arm)', () => {
    expect(resolveBaselineTestCommand(env(), 'cobol' as never)).toBeUndefined();
  });
});

describe('resolveBaselineTestCommand — per-language coverage (audit F15)', () => {
  const SUPPORTED: SupportedProjectType[] = ['typescript', 'python', 'rust', 'php'];

  it.each(SUPPORTED)('resolves a baseline command for %s', (projectType) => {
    // The switch behind this used to fall through to `return undefined`, so a
    // newly supported language made `estimate_audit --withTiming` silently drop
    // timing. A `never` guard now makes that a compile error; this pins the
    // runtime half — every supported language must resolve a real command.
    const cmd = resolveBaselineTestCommand(env({ projectType }), projectType, 'src/widget.ts');
    expect(cmd).toBeDefined();
    expect(cmd?.command).toBeTruthy();
    expect(Array.isArray(cmd?.args)).toBe(true);
  });
});
