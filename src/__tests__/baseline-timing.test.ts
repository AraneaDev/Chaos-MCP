import { describe, it, expect } from 'vitest';
import { resolveBaselineTestCommand, projectEstimatedMs } from '../baseline-timing.js';
import type { EnvironmentInfo } from '../utils/project-detector.js';

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

describe('resolveBaselineTestCommand', () => {
  it('resolves go and rust', () => {
    expect(resolveBaselineTestCommand(env(), 'go')).toEqual({
      command: 'go',
      args: ['test', './...'],
    });
    expect(resolveBaselineTestCommand(env(), 'rust')).toEqual({ command: 'cargo', args: ['test'] });
  });
  it('resolves python to pytest', () => {
    expect(resolveBaselineTestCommand(env({ detectedRunner: 'pytest' }), 'python')?.command).toBe(
      'pytest',
    );
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
  it('resolves node:test to node --test', () => {
    const cmd = resolveBaselineTestCommand(env({ detectedRunner: 'node:test' }), 'typescript');
    expect(cmd).toEqual({ command: 'node', args: ['--test'] });
  });
});
