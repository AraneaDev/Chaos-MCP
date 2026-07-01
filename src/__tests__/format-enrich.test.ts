// src/__tests__/format-enrich.test.ts
import { describe, it, expect } from 'vitest';
import { formatResultAsJson, formatResultAsText } from '../format.js';
import type { MutationResult } from '../engines/base.js';

const RESULT: MutationResult = {
  target: 'src/utils/math.ts',
  totalMutants: 12,
  killed: 10,
  survived: 2,
  mutationScore: '83.33%',
  vulnerabilities: [
    { line: 88, mutator: 'StringLiteral', description: 'survived', mutated: '"a" -> ""' },
    {
      line: 42,
      mutator: 'EqualityOperator',
      description: 'survived',
      original: 'a > b',
      mutated: 'a >= b',
    },
  ],
};

const SRC = [
  'L1',
  'L2',
  'L3',
  'L4',
  'L5',
  'L6',
  'L7',
  'L8',
  'L9',
  'L10',
  'L11',
  'L12',
  'L13',
  'L14',
  'L15',
  'L16',
  'L17',
  'L18',
  'L19',
  'L20',
  ...Array.from({ length: 70 }, (_, i) => `L${i + 21}`),
]; // 90 lines

describe('formatResultAsJson with enrich', () => {
  it('is byte-identical to non-enriched when enrich is omitted', () => {
    const plain1 = formatResultAsJson(RESULT);
    const plain2 = formatResultAsJson(RESULT, undefined);
    expect(plain2).toBe(plain1);
    expect(JSON.parse(plain1).survivors[0]).not.toHaveProperty('severity');
  });

  it('attaches severity/why/hint/context and ranks severity-first', () => {
    const out = JSON.parse(
      formatResultAsJson(RESULT, { projectType: 'typescript', sourceLines: SRC }),
    );
    // EqualityOperator (line 42, high) ranks before StringLiteral (line 88, low)
    expect(out.survivors[0].line).toBe(42);
    expect(out.survivors[0].severity).toBe('high');
    expect(out.survivors[0].why.length).toBeGreaterThan(0);
    expect(out.survivors[0].hint.length).toBeGreaterThan(0);
    expect(out.survivors[0].context).toContain('42: L42');
    expect(out.survivors[1].severity).toBe('low');
    expect(out.summary.worstSeverity).toBe('high');
  });

  it('adds enrichNote when a survivor is unclassified (coarse engine)', () => {
    const coarseResult: MutationResult = {
      ...RESULT,
      vulnerabilities: [{ line: 5, mutator: 'Rust Mutation Operator', description: 'survived' }],
    };
    const out = JSON.parse(
      formatResultAsJson(coarseResult, { projectType: 'rust', sourceLines: SRC }),
    );
    expect(out.survivors[0].severity).toBe('unknown');
    expect(out.enrichNote).toBeDefined();
  });

  it('omits enrichNote when every survivor is classified', () => {
    // The negative of the case above: a fully-classified TypeScript result must
    // NOT carry an enrichNote. Guards the `hasUnknown` accumulation against
    // being forced always-true.
    const out = JSON.parse(
      formatResultAsJson(RESULT, { projectType: 'typescript', sourceLines: SRC }),
    );
    expect(out.survivors.every((s: { severity: string }) => s.severity !== 'unknown')).toBe(true);
    expect(out.enrichNote).toBeUndefined();
  });

  it('ranks a high-severity survivor above a low one on an EARLIER line', () => {
    // The high mutator sits on the LATER line, so a no-op sort would leave the
    // low one first. Forces the severity-descending sort to actually reorder.
    const result: MutationResult = {
      ...RESULT,
      vulnerabilities: [
        { line: 10, mutator: 'StringLiteral', description: 'survived', mutated: '"x" -> ""' },
        {
          line: 50,
          mutator: 'EqualityOperator',
          description: 'survived',
          original: 'a > b',
          mutated: 'a >= b',
        },
      ],
    };
    const out = JSON.parse(
      formatResultAsJson(result, { projectType: 'typescript', sourceLines: SRC }),
    );
    expect(out.survivors[0].line).toBe(50);
    expect(out.survivors[0].severity).toBe('high');
    expect(out.survivors[1].line).toBe(10);
  });

  it('sets worstSeverity from noCoverage groups when there are no survivors', () => {
    // worstSeverity now considers noCoverage too — a noCoverage-only result
    // that has high-severity groups (EqualityOperator → high) must report it.
    const result: MutationResult = {
      ...RESULT,
      vulnerabilities: [
        {
          line: 7,
          mutator: 'EqualityOperator',
          description: 'no test reached this mutant',
          original: 'a > b',
          mutated: 'a >= b',
        },
      ],
    };
    const out = JSON.parse(
      formatResultAsJson(result, { projectType: 'typescript', sourceLines: SRC }),
    );
    expect(out.survivors).toHaveLength(0);
    expect(out.noCoverage).toHaveLength(1);
    expect(out.summary.worstSeverity).toBe('high');
  });
});

describe('formatResultAsText with enrich', () => {
  it('is identical to non-enriched when enrich is omitted', () => {
    expect(formatResultAsText(RESULT, undefined)).toBe(formatResultAsText(RESULT));
  });

  it('renders severity, why, hint, and context inline when enriched', () => {
    const txt = formatResultAsText(RESULT, { projectType: 'typescript', sourceLines: SRC });
    expect(txt).toContain('[high]');
    expect(txt).toContain('why:');
    expect(txt).toContain('hint:');
    // The context line is only emitted when sourceLines were supplied, and the
    // numbered source rows are joined with ' | '.
    expect(txt).toContain('context: 40: L40 | 41: L41 | 42: L42 | 43: L43 | 44: L44');
  });

  it('omits the context line (without throwing) when sourceLines are absent', () => {
    // enrich is on but no source is available — context is undefined, so the
    // text renderer must skip the context line rather than join over undefined.
    const txt = formatResultAsText(RESULT, { projectType: 'typescript' });
    expect(txt).toContain('[high]');
    expect(txt).not.toContain('context:');
  });
});
