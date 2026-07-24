import { describe, it, expect } from 'vitest';
import { buildResultPayload } from '../format.js';
import { evaluateGate } from '../gate.js';
import type { MutationResult } from '../engines/base.js';

function result(overrides: Partial<MutationResult> = {}): MutationResult {
  return {
    target: 'src/foo.ts',
    totalMutants: 10,
    killed: 8,
    survived: 2,
    mutationScore: '80.00%',
    vulnerabilities: [],
    ...overrides,
  };
}

describe('buildResultPayload', () => {
  it('returns the same shape formatResultAsJson serializes (clean run)', () => {
    const payload = buildResultPayload(
      result({ survived: 0, killed: 10, mutationScore: '100.00%' }),
    );
    expect(payload).toMatchObject({
      target: 'src/foo.ts',
      mutationScore: '100.00%',
      summary: { total: 10, killed: 10, survived: 0 },
      survivors: [],
      noCoverage: [],
      note: 'No surviving mutants — the test suite caught every mutation.',
    });
  });

  it('reports n/a and an honest note when zero mutants were enumerated', () => {
    const payload = buildResultPayload(
      result({ survived: 0, killed: 0, totalMutants: 0, mutationScore: '100.00%' }),
    );
    expect(payload).toMatchObject({
      mutationScore: 'n/a',
      summary: { total: 0, killed: 0, survived: 0 },
      note: 'No mutants generated — this file has no mutable logic, so mutation testing is not meaningful here (not the same as proven coverage).',
    });
  });

  it('surfaces incompetent mutants in the payload and note (audit I3)', () => {
    const payload = buildResultPayload(result({ incompetent: 3 }));
    expect(payload.incompetent).toBe(3);
    expect(payload.note).toContain('3 mutant(s) were excluded as incompetent');
  });

  it('omits incompetent when zero or absent', () => {
    expect(buildResultPayload(result({ incompetent: 0 })).incompetent).toBeUndefined();
    expect(buildResultPayload(result()).incompetent).toBeUndefined();
  });

  it('groups survivors by line with mutator counts', () => {
    const payload = buildResultPayload(
      result({
        vulnerabilities: [
          { line: 3, mutator: 'ConditionalExpression', description: 'survived' },
          { line: 3, mutator: 'ConditionalExpression', description: 'survived' },
        ],
      }),
    );
    expect(payload.survivors).toEqual([{ line: 3, mutators: { ConditionalExpression: 2 } }]);
  });
});

function manySurvivors(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    line: i + 1,
    mutator: 'ConditionalExpression',
    description: 'survived',
  }));
}

describe('buildResultPayload maxSurvivors', () => {
  it('caps survivors and records how many were truncated', () => {
    const payload = buildResultPayload(result({ vulnerabilities: manySurvivors(15) }), {
      maxSurvivors: 10,
    });
    expect(payload.survivors).toHaveLength(10);
    expect(payload.survivorsTruncated).toBe(5);
  });

  it('omits the truncation count when nothing is dropped', () => {
    const payload = buildResultPayload(result({ vulnerabilities: manySurvivors(3) }), {
      maxSurvivors: 10,
    });
    expect(payload.survivors).toHaveLength(3);
    expect(payload.survivorsTruncated).toBeUndefined();
  });
});

describe('buildResultPayload severityFloor', () => {
  it('drops groups below the floor and counts them, when enriched', () => {
    const payload = buildResultPayload(
      result({
        vulnerabilities: [
          { line: 1, mutator: 'ConditionalExpression', description: 'survived' }, // high
          { line: 2, mutator: 'StringLiteral', description: 'survived' }, // low
        ],
      }),
      { enrich: { projectType: 'typescript' }, severityFloor: 'high' },
    );
    expect(payload.survivors).toHaveLength(1);
    expect(payload.survivors[0].line).toBe(1);
    expect(payload.survivorsFiltered).toBe(1);
  });

  it('ignores severityFloor when not enriched and notes why', () => {
    const payload = buildResultPayload(
      result({
        vulnerabilities: [{ line: 1, mutator: 'ConditionalExpression', description: 'survived' }],
      }),
      { severityFloor: 'high' },
    );
    expect(payload.survivors).toHaveLength(1);
    expect(payload.survivorsFiltered).toBeUndefined();
    expect(payload.enrichNote).toContain('severityFloor');
  });
});

describe('buildResultPayload worstSeverity', () => {
  it('derives worstSeverity from noCoverage when survivors is empty', () => {
    // ConditionalExpression is 'high' severity; description routes to noCoverage bucket
    const payload = buildResultPayload(
      result({
        survived: 0,
        killed: 10,
        mutationScore: '100.00%',
        vulnerabilities: [
          {
            line: 5,
            mutator: 'ConditionalExpression',
            description: 'no test reached this mutant',
          },
        ],
      }),
      { enrich: { projectType: 'typescript' } },
    );
    expect(payload.survivors).toHaveLength(0);
    expect(payload.noCoverage).toHaveLength(1);
    expect(payload.summary.worstSeverity).toBe('high');
  });
});

describe('buildResultPayload runId / suppressedCount', () => {
  it('threads runId and suppressedCount into the payload', () => {
    const r = {
      target: 'a.ts',
      totalMutants: 8,
      killed: 6,
      survived: 2,
      mutationScore: '75.00%',
      vulnerabilities: [],
    };
    const payload = buildResultPayload(r, { runId: 'abc123de', suppressedCount: 2 });
    expect(payload.runId).toBe('abc123de');
    expect(payload.suppressedCount).toBe(2);
    expect(payload.note).toContain('suppressed');
  });

  it('omits runId/suppressedCount when not provided', () => {
    const r = {
      target: 'a.ts',
      totalMutants: 4,
      killed: 4,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    };
    const payload = buildResultPayload(r, {});
    expect(payload.runId).toBeUndefined();
    expect(payload.suppressedCount).toBeUndefined();
  });
});

describe('buildResultPayload gate', () => {
  it('threads a gate result into the payload', () => {
    const r = {
      target: 'a.ts',
      totalMutants: 8,
      killed: 6,
      survived: 2,
      mutationScore: '75.00%',
      vulnerabilities: [],
    };
    const payload = buildResultPayload(r, { gate: evaluateGate('75.00%', 80) });
    expect(payload.gate).toEqual({ minScore: 80, passed: false });
  });

  it('omits gate when not provided', () => {
    const r = {
      target: 'a.ts',
      totalMutants: 4,
      killed: 4,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    };
    expect(buildResultPayload(r, {}).gate).toBeUndefined();
  });
});

describe('buildResultPayload batch completion metadata', () => {
  it('threads every partial-audit field into the payload', () => {
    const payload = buildResultPayload(
      result({
        complete: false,
        batchesCompleted: 1,
        batchesPlanned: 3,
        stoppedReason: 'time_budget_exhausted',
      }),
      {},
    );
    expect(payload).toMatchObject({
      complete: false,
      batchesCompleted: 1,
      batchesPlanned: 3,
      stoppedReason: 'time_budget_exhausted',
    });
  });

  it('omits every batch field when the engine did not provide it', () => {
    const payload = buildResultPayload(result({}), {});
    expect(payload).not.toHaveProperty('complete');
    expect(payload).not.toHaveProperty('batchesCompleted');
    expect(payload).not.toHaveProperty('batchesPlanned');
    expect(payload).not.toHaveProperty('stoppedReason');
  });
});
