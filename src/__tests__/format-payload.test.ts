import { describe, it, expect } from 'vitest';
import { buildResultPayload } from '../format.js';
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
