import { describe, it, expect } from 'vitest';
import { formatResultAsText, formatResultAsJson } from '../format.js';
import type { MutationResultShape } from '../format.js';

type Vuln = MutationResultShape['vulnerabilities'][number];

/** A description that matches the NoCoverage marker regex in format.ts. */
const NO_COVERAGE_DESC = 'no test reached this mutant';

function vuln(line: number, replacement: string, description = 'survived mutant'): Vuln {
  return { line, replacement, description };
}

function result(overrides: Partial<MutationResultShape> = {}): MutationResultShape {
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

interface JsonShape {
  target: string;
  mutationScore: string;
  summary: { total: number; killed: number; survived: number };
  survivors: { line: number; mutators: Record<string, number> }[];
  noCoverage: { line: number; mutators: Record<string, number> }[];
  note: string;
}

const CLEAN_NOTE = 'No surviving mutants — the test suite caught every mutation.';
const DIRTY_NOTE =
  'survivors: mutants your tests ran but did not kill. noCoverage: mutants no test reached (per line+mutator, so a line may appear here and in survivors). mutators = type→count. Add or strengthen tests targeting these.';

describe('formatResultAsText', () => {
  it('renders the header and the clean success line when nothing survived', () => {
    const text = formatResultAsText(
      result({
        mutationScore: '100.00%',
        killed: 10,
        totalMutants: 10,
        survived: 0,
        vulnerabilities: [],
      }),
    );
    expect(text).toBe(
      [
        'Chaos-MCP Audit Report: src/foo.ts',
        'Mutation score: 100.00% (10/10 killed, 0 survived)',
        '✅ No surviving mutants — your tests caught all mutations.',
      ].join('\n'),
    );
  });

  it('groups survivors by line, sorts ascending, and collapses duplicate mutators to counts', () => {
    // Deliberately out of line order, with a duplicated mutator on line 3.
    const text = formatResultAsText(
      result({
        vulnerabilities: [
          vuln(10, 'ConditionalExpression'),
          vuln(3, 'StringLiteral'),
          vuln(3, 'StringLiteral'),
          vuln(10, 'LogicalOperator'),
          vuln(5, 'EqualityOperator'),
        ],
      }),
    );
    expect(text).toBe(
      [
        'Chaos-MCP Audit Report: src/foo.ts',
        'Mutation score: 80.00% (8/10 killed, 2 survived)',
        'Survivors (line: mutators):',
        '  3: StringLiteral×2',
        '  5: EqualityOperator',
        '  10: ConditionalExpression, LogicalOperator',
        'Add or strengthen tests targeting these lines to kill the survivors.',
      ].join('\n'),
    );
  });

  it('renders a single occurrence without an ×count suffix but two occurrences with ×2', () => {
    const text = formatResultAsText(
      result({ vulnerabilities: [vuln(7, 'BooleanLiteral'), vuln(8, 'Regex'), vuln(8, 'Regex')] }),
    );
    expect(text).toContain('  7: BooleanLiteral\n');
    expect(text).toContain('  8: Regex×2');
    // A `count > 1` → `count >= 1` mutant would render "BooleanLiteral×1".
    expect(text).not.toContain('BooleanLiteral×1');
  });

  it('shows only the no-coverage table (and no survivors header) when every survivor is uncovered', () => {
    const text = formatResultAsText(
      result({
        survived: 0,
        killed: 18,
        totalMutants: 20,
        mutationScore: '90.00%',
        vulnerabilities: [
          vuln(7, 'StringLiteral', NO_COVERAGE_DESC),
          vuln(7, 'BlockStatement', NO_COVERAGE_DESC),
        ],
      }),
    );
    expect(text).toBe(
      [
        'Chaos-MCP Audit Report: src/foo.ts',
        'Mutation score: 90.00% (18/20 killed, 0 survived)',
        'No-coverage mutants (line: mutators):',
        '  7: StringLiteral, BlockStatement',
        'Add or strengthen tests targeting these lines to kill the survivors.',
      ].join('\n'),
    );
    expect(text).not.toContain('Survivors (line: mutators):');
    expect(text).not.toContain('✅');
  });

  it('shows both the survivors and no-coverage tables, survivors first', () => {
    const text = formatResultAsText(
      result({
        vulnerabilities: [
          vuln(4, 'ConditionalExpression'),
          vuln(9, 'StringLiteral', NO_COVERAGE_DESC),
        ],
      }),
    );
    expect(text).toBe(
      [
        'Chaos-MCP Audit Report: src/foo.ts',
        'Mutation score: 80.00% (8/10 killed, 2 survived)',
        'Survivors (line: mutators):',
        '  4: ConditionalExpression',
        'No-coverage mutants (line: mutators):',
        '  9: StringLiteral',
        'Add or strengthen tests targeting these lines to kill the survivors.',
      ].join('\n'),
    );
  });
});

describe('formatResultAsJson', () => {
  it('emits the clean note and empty tables when nothing survived', () => {
    const json = JSON.parse(
      formatResultAsJson(result({ survived: 0, killed: 10, vulnerabilities: [] })),
    ) as JsonShape;
    expect(json).toEqual({
      target: 'src/foo.ts',
      mutationScore: '80.00%',
      summary: { total: 10, killed: 10, survived: 0 },
      survivors: [],
      noCoverage: [],
      note: CLEAN_NOTE,
    });
  });

  it('emits the dirty note and a survivors table when mutants survived', () => {
    const json = JSON.parse(
      formatResultAsJson(
        result({
          vulnerabilities: [vuln(5, 'ConditionalExpression'), vuln(5, 'ConditionalExpression')],
        }),
      ),
    ) as JsonShape;
    expect(json.note).toBe(DIRTY_NOTE);
    expect(json.survivors).toEqual([{ line: 5, mutators: { ConditionalExpression: 2 } }]);
    expect(json.noCoverage).toEqual([]);
    expect(json.summary).toEqual({ total: 10, killed: 8, survived: 2 });
  });

  it('emits the dirty note when only no-coverage mutants exist', () => {
    const json = JSON.parse(
      formatResultAsJson(
        result({ survived: 0, vulnerabilities: [vuln(12, 'StringLiteral', NO_COVERAGE_DESC)] }),
      ),
    ) as JsonShape;
    expect(json.note).toBe(DIRTY_NOTE);
    expect(json.survivors).toEqual([]);
    expect(json.noCoverage).toEqual([{ line: 12, mutators: { StringLiteral: 1 } }]);
  });
});
