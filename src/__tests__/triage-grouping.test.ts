import { describe, expect, it } from 'vitest';
import { MAX_GROUP_SIZE, planSweepUnits } from '../triage/grouping.js';

const ts = (file: string, over: Partial<{ workspaceRoot: string; runner: string }> = {}) => ({
  file,
  workspaceRoot: over.workspaceRoot ?? '/w',
  projectType: 'typescript',
  runner: over.runner ?? 'vitest',
});

describe('planSweepUnits', () => {
  it('groups eligible TypeScript files up to the cap', () => {
    expect(planSweepUnits([ts('a'), ts('b'), ts('c'), ts('d'), ts('e')])).toEqual([
      { kind: 'group', files: ['a', 'b', 'c', 'd'], workspaceRoot: '/w', runner: 'vitest' },
      { kind: 'single', file: 'e' },
    ]);
  });

  it('never groups across workspace roots', () => {
    const units = planSweepUnits([ts('a'), ts('b', { workspaceRoot: '/other' })]);
    expect(units.every((u) => u.kind === 'single')).toBe(true);
  });

  it('never groups across runners', () => {
    const units = planSweepUnits([ts('a'), ts('b', { runner: 'jest' })]);
    expect(units.every((u) => u.kind === 'single')).toBe(true);
  });

  it('never groups command-runner files', () => {
    const units = planSweepUnits([ts('a', { runner: 'command' }), ts('b', { runner: 'command' })]);
    expect(units.every((u) => u.kind === 'single')).toBe(true);
  });

  it('never groups non-TypeScript files', () => {
    const units = planSweepUnits([
      { file: 'x.py', workspaceRoot: '/w', projectType: 'python', runner: 'pytest' },
      { file: 'y.py', workspaceRoot: '/w', projectType: 'python', runner: 'pytest' },
    ]);
    expect(units.every((u) => u.kind === 'single')).toBe(true);
  });

  it('uses the single-file path for one eligible file', () => {
    expect(planSweepUnits([ts('a')])).toEqual([{ kind: 'single', file: 'a' }]);
  });

  it('accounts for every input exactly once', () => {
    const files = Array.from({ length: 11 }, (_, i) => ts(`f${i}`));
    const out = planSweepUnits(files).flatMap((u) => (u.kind === 'single' ? [u.file] : u.files));
    expect(out.sort()).toEqual(files.map((f) => f.file).sort());
  });

  it('keeps the safety cap at four', () => {
    expect(MAX_GROUP_SIZE).toBe(4);
    expect(
      planSweepUnits(
        Array.from({ length: 8 }, (_, i) => ts(String(i))),
        99,
      ),
    ).toHaveLength(2);
  });
});
