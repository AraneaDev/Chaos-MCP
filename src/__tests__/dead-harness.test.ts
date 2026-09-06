/**
 * The silent-harness advisory: `looksLikeDeadHarness` and the `fidelityNote`
 * `auditFile` composes from it.
 *
 * The failure being guarded is one where every OTHER signal looks normal — the
 * suite passes, the tool exits on its break threshold, the report is
 * well-formed — and only the "nothing at all was killed" shape gives it away.
 * These tests pin the boundary between that shape and the ordinary weak-coverage
 * result it must not be confused with.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  looksLikeDeadHarness,
  DEAD_HARNESS_NOTE,
  DEAD_HARNESS_THRESHOLD,
} from '../core/score-semantics.js';
import { auditFile } from '../audit/audit-file.js';
import type { MutationResult, Vulnerability } from '../engines/base.js';
import type { EnvironmentInfo } from '../utils/project-detector.js';

function env(overrides: Partial<EnvironmentInfo> = {}): EnvironmentInfo {
  return {
    projectType: 'typescript',
    testRunner: 'vitest',
    detectedRunner: 'vitest',
    packageManager: '',
    workspaceRoot: '/ws',
    ...overrides,
  };
}

function survivors(n: number, kind: Vulnerability['kind'] = 'survived'): Vulnerability[] {
  return Array.from({ length: n }, (_unused, i) => ({
    line: i + 1,
    mutator: 'ConditionalExpression',
    kind,
    description: 'x',
  }));
}

function result(overrides: Partial<MutationResult> = {}): MutationResult {
  return {
    target: 'src/x.ts',
    totalMutants: 0,
    killed: 0,
    survived: 0,
    mutationScore: '0.00%',
    vulnerabilities: [],
    ...overrides,
  };
}

describe('looksLikeDeadHarness', () => {
  it('flags a run where many covered mutants survived and none were killed', () => {
    const r = result({
      totalMutants: DEAD_HARNESS_THRESHOLD,
      survived: DEAD_HARNESS_THRESHOLD,
      vulnerabilities: survivors(DEAD_HARNESS_THRESHOLD),
    });
    expect(looksLikeDeadHarness(r)).toBe(true);
  });

  it('does NOT flag a run that killed even one mutant', () => {
    // A single kill proves mutants are being applied and the suite can react to
    // them. Whatever else is wrong, it is not a dead harness — and this is the
    // conjunct that keeps a genuinely bad 3% score reported as a measurement.
    const r = result({
      totalMutants: 100,
      killed: 1,
      survived: 99,
      mutationScore: '1.00%',
      vulnerabilities: survivors(99),
    });
    expect(looksLikeDeadHarness(r)).toBe(false);
  });

  it('does NOT flag a handful of survivors — that is ordinary weak coverage', () => {
    // Kills `survived >= T → survived > 0` and the `>= → >` boundary slip: one
    // below the threshold must stay silent, exactly at it must warn.
    const below = DEAD_HARNESS_THRESHOLD - 1;
    expect(
      looksLikeDeadHarness(
        result({ totalMutants: below, survived: below, vulnerabilities: survivors(below) }),
      ),
    ).toBe(false);
    expect(
      looksLikeDeadHarness(
        result({
          totalMutants: DEAD_HARNESS_THRESHOLD,
          survived: DEAD_HARNESS_THRESHOLD,
          vulnerabilities: survivors(DEAD_HARNESS_THRESHOLD),
        }),
      ),
    ).toBe(true);
  });

  it('does NOT flag a file no test reaches, however many mutants it has', () => {
    // The whole reason the predicate counts `survived` rather than
    // `totalMutants`: an unimported file legitimately reports every mutant as
    // NoCoverage with zero kills, and there is nothing wrong with the harness.
    const r = result({
      totalMutants: 50,
      killed: 0,
      survived: 0,
      vulnerabilities: survivors(50, 'noCoverage'),
    });
    expect(looksLikeDeadHarness(r)).toBe(false);
  });

  it('does NOT flag a clean run', () => {
    expect(
      looksLikeDeadHarness(
        result({ totalMutants: 40, killed: 40, survived: 0, mutationScore: '100.00%' }),
      ),
    ).toBe(false);
  });

  it('does NOT flag a run that enumerated nothing', () => {
    // A zero-mutant run has no evidence either way; `displayMutationScore`
    // already renders it "n/a" and this must not add a second, contradictory
    // story on top of it.
    expect(looksLikeDeadHarness(result())).toBe(false);
  });
});

describe('auditFile dead-harness advisory', () => {
  const base = {
    targetFile: 'src/x.ts',
    env: env(),
    projectType: 'typescript' as const,
    args: {},
    config: {},
    workDir: '/tmp/sandbox',
    prebuildCmd: null,
  };

  it('attaches the advisory when the engine result killed nothing', async () => {
    const engineResult = result({
      totalMutants: 26,
      survived: 26,
      vulnerabilities: survivors(26),
    });
    const run = vi.fn().mockResolvedValue(engineResult);
    const out = await auditFile({ ...base, engine: { run } as never });
    expect(out.fidelityNote).toBe(DEAD_HARNESS_NOTE);
  });

  it('names both causes rather than blaming the tests', async () => {
    // The advisory's job is to stop a caller "fixing" a broken harness by
    // writing tests against it, so it has to offer the experiment that tells
    // the two apart instead of asserting one.
    const run = vi
      .fn()
      .mockResolvedValue(
        result({ totalMutants: 26, survived: 26, vulnerabilities: survivors(26) }),
      );
    const out = await auditFile({ ...base, engine: { run } as never });
    expect(out.fidelityNote).toMatch(/hand-edit/i);
    expect(out.fidelityNote).toMatch(/version/i);
  });

  it('keeps an advisory the engine already set', async () => {
    // PHP sets its own WARNING_FIDELITY_NOTE; both facts can be true at once and
    // clobbering either one loses information the caller needs.
    const engineResult = result({
      totalMutants: 26,
      survived: 26,
      vulnerabilities: survivors(26),
      fidelityNote: 'Infection may misreport under this config.',
    });
    const run = vi.fn().mockResolvedValue(engineResult);
    const out = await auditFile({ ...base, engine: { run } as never });
    expect(out.fidelityNote).toContain('Infection may misreport under this config.');
    expect(out.fidelityNote).toContain(DEAD_HARNESS_NOTE);
  });

  it('leaves an ordinary result untouched', async () => {
    const engineResult = result({
      totalMutants: 40,
      killed: 30,
      survived: 10,
      mutationScore: '75.00%',
      vulnerabilities: survivors(10),
    });
    const run = vi.fn().mockResolvedValue(engineResult);
    const out = await auditFile({ ...base, engine: { run } as never });
    expect(out.fidelityNote).toBeUndefined();
  });
});
