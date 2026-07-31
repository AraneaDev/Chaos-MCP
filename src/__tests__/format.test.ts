import { describe, it, expect } from 'vitest';
import {
  formatResultAsText,
  formatResultAsJson,
  hasNoMutableLogic,
  displayMutationScore,
} from '../format.js';
import type { MutationResult } from '../engines/base.js';

type Vuln = MutationResult['vulnerabilities'][number];

/** A description that matches the NoCoverage marker regex in format.ts. */
const NO_COVERAGE_DESC = 'no test reached this mutant';

function vuln(line: number, mutator: string, description = 'survived mutant'): Vuln {
  return { line, mutator, description };
}

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

describe('formatResultAsText — advisory lines', () => {
  it('surfaces a fidelity warning when the engine flagged one', () => {
    // A fidelity note means the run's own numbers may be wrong (a
    // misconfiguration in the audited project, not a finding about the code).
    // Text consumers get no other signal that the score is untrustworthy.
    const text = formatResultAsText(result({ fidelityNote: 'PHPUnit stopped on a warning.' }));
    expect(text).toContain('Warning: PHPUnit stopped on a warning.');
  });

  it('prints no warning line for an ordinary result', () => {
    expect(formatResultAsText(result())).not.toContain('Warning:');
  });

  it('reports incompetent mutants, which explain why total < generated', () => {
    const text = formatResultAsText(result({ incompetent: 3 }));
    expect(text).toContain(
      'Note: 3 mutant(s) excluded as incompetent (mutated code never produced a real pass/fail).',
    );
  });

  it('ignores a negative incompetent count rather than printing it', () => {
    // The `&&` guard is what rejects nonsense; under `||` a negative value is
    // truthy and the report gains a "-1 mutant(s) excluded" line.
    expect(formatResultAsText(result({ incompetent: -1 }))).not.toContain('incompetent');
  });

  it('says nothing about incompetent mutants when there were none', () => {
    // Both arms of `result.incompetent && result.incompetent > 0`: absent, and
    // present-but-zero. A "0 mutant(s) excluded" line is pure noise.
    expect(formatResultAsText(result())).not.toContain('incompetent');
    expect(formatResultAsText(result({ incompetent: 0 }))).not.toContain('incompetent');
  });

  it('prints the scope note when the run was scoped', () => {
    const text = formatResultAsText(result({ scopeNote: 'no changed lines' }));
    expect(text).toContain('Scope: no changed lines');
    expect(formatResultAsText(result())).not.toContain('Scope:');
  });
});

describe('formatResultAsText — no-coverage section', () => {
  const noCov = (line: number, mutator = 'ConditionalExpression') =>
    vuln(line, mutator, NO_COVERAGE_DESC);

  it('reports how many no-coverage groups the cap hid', () => {
    // The survivors section has its own truncation note; the no-coverage
    // section repeats the pattern, and only a no-coverage-heavy result reaches
    // that second copy. Without it the list silently ends at the cap.
    const text = formatResultAsText(
      result({ vulnerabilities: [1, 2, 3, 4, 5].map((n) => noCov(n)) }),
      undefined,
      { maxSurvivors: 2 },
    );
    expect(text).toContain('No-coverage mutants (line: mutators):');
    expect(text).toContain('…3 more (raise maxSurvivors to see them)');
  });

  it('reports how many no-coverage groups the severity floor hid', () => {
    const text = formatResultAsText(
      result({ vulnerabilities: [noCov(1, 'ConditionalExpression'), noCov(2, 'StringLiteral')] }),
      { projectType: 'typescript' },
      { severityFloor: 'high' },
    );
    expect(text).toContain('…1 hidden below severityFloor');
  });

  it('adds neither note when nothing was capped or filtered', () => {
    const text = formatResultAsText(result({ vulnerabilities: [noCov(1)] }));
    expect(text).toContain('No-coverage mutants (line: mutators):');
    expect(text).not.toContain('raise maxSurvivors');
    expect(text).not.toContain('hidden below severityFloor');
  });

  it('prints the floor-ignored note when the caller asked for a floor without enrichment', () => {
    // Audit M6: the JSON path attaches this via enrichNote, and text users got
    // nothing — so a severityFloor that silently did nothing looked like a
    // floor that found nothing to hide.
    const text = formatResultAsText(
      result({ vulnerabilities: [vuln(1, 'StringLiteral')] }),
      undefined,
      {
        floorIgnoredNote: 'severityFloor ignored: enrichment is disabled.',
      },
    );
    expect(text).toContain('severityFloor ignored: enrichment is disabled.');
    expect(
      formatResultAsText(result({ vulnerabilities: [vuln(1, 'StringLiteral')] })),
    ).not.toContain('severityFloor ignored');
  });
});

describe('hasNoMutableLogic', () => {
  it('is true only for a zero-mutant result carrying no scope note', () => {
    expect(hasNoMutableLogic(result({ totalMutants: 0 }))).toBe(true);
  });

  it('is false as soon as a single mutant was enumerated', () => {
    // Pins `totalMutants === 0` against a `<= 0` / `!== 0` mutant: a one-mutant
    // file has real logic and must keep its own score.
    expect(hasNoMutableLogic(result({ totalMutants: 1 }))).toBe(false);
  });

  it('is false for a zero-mutant result that carries a scope note', () => {
    // A scoped run that mutated nothing (e.g. a diff with no changed lines) is a
    // real run, not a file without logic — this kills the `&& !result.scopeNote`
    // conjunct, which a note-less fixture alone cannot reach.
    expect(hasNoMutableLogic(result({ totalMutants: 0, scopeNote: 'no changed lines' }))).toBe(
      false,
    );
  });

  it('treats an empty scope note as absent', () => {
    // `!result.scopeNote` is a truthiness test, not a presence test: an engine
    // that emits '' has said nothing, so the row must still read as "no logic".
    expect(hasNoMutableLogic(result({ totalMutants: 0, scopeNote: '' }))).toBe(true);
  });
});

describe('displayMutationScore', () => {
  it('substitutes "n/a" for a file with no mutable logic', () => {
    // Audit M3: a bare "100.00%" here would rank a logic-free file as the safest
    // in the leaderboard, indistinguishable from a genuine perfect kill rate.
    expect(displayMutationScore(result({ totalMutants: 0, mutationScore: '100.00%' }))).toBe('n/a');
  });

  it('passes the raw score through untouched for a real run', () => {
    expect(displayMutationScore(result({ mutationScore: '80.00%' }))).toBe('80.00%');
  });

  it('keeps a genuine 100% distinguishable from "n/a"', () => {
    // Kills a mutant that inverts the branch: with mutants enumerated, a perfect
    // score is proven coverage and must survive as "100.00%".
    expect(
      displayMutationScore(result({ totalMutants: 10, killed: 10, mutationScore: '100.00%' })),
    ).toBe('100.00%');
  });
});

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
        'No surviving mutants — your tests caught all mutations.',
      ].join('\n'),
    );
  });

  it('renders n/a and an honest note for a file with zero enumerated mutants', () => {
    const text = formatResultAsText(
      result({
        mutationScore: '100.00%',
        killed: 0,
        totalMutants: 0,
        survived: 0,
        vulnerabilities: [],
      }),
    );
    expect(text).toBe(
      [
        'Chaos-MCP Audit Report: src/foo.ts',
        'Mutation score: n/a (0/0 killed, 0 survived)',
        'No mutants generated — this file has no mutable logic, so mutation testing is not meaningful here (this is not the same as proven coverage).',
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
    // No-coverage mutants exist, so the all-clear success line must NOT appear.
    expect(text).not.toContain('No surviving mutants');
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

function baseResult(vulns: MutationResult['vulnerabilities']): MutationResult {
  return {
    target: 'src/x.ts',
    totalMutants: 10,
    killed: 7,
    survived: 3,
    mutationScore: '70.00%',
    vulnerabilities: vulns,
  };
}

describe('A1 mutation detail (changes)', () => {
  it('emits original → mutated when both present', () => {
    const json = JSON.parse(
      formatResultAsJson(
        baseResult([
          {
            line: 42,
            mutator: 'ConditionalExpression',
            description: 'survived',
            original: 'a > b',
            mutated: 'a >= b',
          },
        ]),
      ),
    );
    expect(json.survivors[0].changes).toEqual(['a > b → a >= b']);
  });

  it('emits mutated alone when original absent (Rust case)', () => {
    const json = JSON.parse(
      formatResultAsJson(
        baseResult([
          { line: 5, mutator: 'Rust', description: 'survived', mutated: 'replace foo -> bar' },
        ]),
      ),
    );
    expect(json.survivors[0].changes).toEqual(['replace foo -> bar']);
  });

  it('omits changes entirely when no detail present', () => {
    const json = JSON.parse(
      formatResultAsJson(
        baseResult([{ line: 9, mutator: 'BooleanLiteral', description: 'survived' }]),
      ),
    );
    expect(json.survivors[0].changes).toBeUndefined();
  });

  it('dedupes identical changes on a line', () => {
    const json = JSON.parse(
      formatResultAsJson(
        baseResult([
          { line: 1, mutator: 'M', description: 'survived', original: 'x', mutated: 'y' },
          { line: 1, mutator: 'M', description: 'survived', original: 'x', mutated: 'y' },
        ]),
      ),
    );
    expect(json.survivors[0].changes).toEqual(['x → y']);
  });

  it('caps at 3 distinct changes with a …N more sentinel', () => {
    const vulns = ['a', 'b', 'c', 'd', 'e'].map((c) => ({
      line: 1,
      mutator: 'M',
      description: 'survived',
      original: c,
      mutated: c + '!',
    }));
    const json = JSON.parse(formatResultAsJson(baseResult(vulns)));
    expect(json.survivors[0].changes).toHaveLength(4);
    expect(json.survivors[0].changes[3]).toBe('…2 more');
  });

  it('normalizes whitespace/newlines to a single line', () => {
    const json = JSON.parse(
      formatResultAsJson(
        baseResult([
          {
            line: 1,
            mutator: 'M',
            description: 'survived',
            original: 'a  >\n  b',
            mutated: 'a >= b',
          },
        ]),
      ),
    );
    expect(json.survivors[0].changes).toEqual(['a > b → a >= b']);
  });

  it('renders changes inline in text format', () => {
    const text = formatResultAsText(
      baseResult([
        {
          line: 42,
          mutator: 'ConditionalExpression',
          description: 'survived',
          original: 'a > b',
          mutated: 'a >= b',
        },
      ]),
    );
    expect(text).toContain('42: ConditionalExpression  (a > b → a >= b)');
  });

  it('emits original alone when mutated absent', () => {
    const json = JSON.parse(
      formatResultAsJson(
        baseResult([
          { line: 3, mutator: 'BlockStatement', description: 'survived', original: 'doStuff()' },
        ]),
      ),
    );
    expect(json.survivors[0].changes).toEqual(['doStuff()']);
  });

  it('adds the changes clause to the JSON note only when detail is present', () => {
    const withDetail = JSON.parse(
      formatResultAsJson(
        baseResult([
          { line: 1, mutator: 'M', description: 'survived', original: 'a', mutated: 'b' },
        ]),
      ),
    );
    expect(withDetail.note).toContain('changes = sampled');

    const noDetail = JSON.parse(
      formatResultAsJson(baseResult([{ line: 1, mutator: 'M', description: 'survived' }])),
    );
    expect(noDetail.note).not.toContain('changes = sampled');
  });

  it('trims leading/trailing whitespace in change strings (kills .trim mutant, line 44)', () => {
    const json = JSON.parse(
      formatResultAsJson(
        baseResult([
          { line: 1, mutator: 'M', description: 'survived', original: '  a > b  ', mutated: 'c' },
        ]),
      ),
    );
    expect(json.survivors[0].changes).toEqual(['a > b → c']);
  });

  it('shows all 3 distinct changes with no sentinel at the cap boundary (kills <= mutant, line 57)', () => {
    const vulns = ['a', 'b', 'c'].map((c) => ({
      line: 1,
      mutator: 'M',
      description: 'survived',
      original: c,
      mutated: c + '!',
    }));
    const json = JSON.parse(formatResultAsJson(baseResult(vulns)));
    expect(json.survivors[0].changes).toEqual(['a → a!', 'b → b!', 'c → c!']);
  });

  it('joins multiple change strings with "; " in text output (kills join-separator mutant, line 125)', () => {
    const text = formatResultAsText(
      baseResult([
        { line: 7, mutator: 'M', description: 'survived', original: 'a', mutated: 'b' },
        { line: 7, mutator: 'M', description: 'survived', original: 'c', mutated: 'd' },
      ]),
    );
    expect(text).toContain('7: M×2  (a → b; c → d)');
  });

  it('renders changes on no-coverage lines in text output (kills no-coverage suffix mutant, line 132)', () => {
    const text = formatResultAsText(
      baseResult([
        {
          line: 9,
          mutator: 'M',
          description: 'No test reached this line (NoCoverage).',
          original: 'x',
          mutated: 'y',
        },
      ]),
    );
    expect(text).toContain('No-coverage mutants (line: mutators):');
    expect(text).toContain('9: M  (x → y)');
  });

  it('adds the note clause when only one of several groups has detail (kills .some→.every mutant, line 148)', () => {
    const json = JSON.parse(
      formatResultAsJson(
        baseResult([
          { line: 1, mutator: 'M', description: 'survived', original: 'a', mutated: 'b' },
          { line: 2, mutator: 'M', description: 'No test reached this line (NoCoverage).' },
        ]),
      ),
    );
    expect(json.survivors[0].changes).toEqual(['a → b']);
    expect(json.noCoverage[0].changes).toBeUndefined();
    expect(json.note).toContain('changes = sampled');
  });
});

describe('formatResultAsText severityFloor signal', () => {
  it('shows floor-hidden count and cap truncation lines in text output', () => {
    // 2 high-severity survivors (one shown, one truncated by cap) + 1 low-severity (filtered by floor)
    const text = formatResultAsText(
      result({
        vulnerabilities: [
          { line: 1, mutator: 'ConditionalExpression', description: 'survived' }, // high
          { line: 2, mutator: 'ConditionalExpression', description: 'survived' }, // high
          { line: 3, mutator: 'StringLiteral', description: 'survived' }, // low
        ],
      }),
      { projectType: 'typescript' },
      { maxSurvivors: 1, severityFloor: 'high' },
    );
    expect(text).toContain('[high]');
    expect(text).toContain('…1 more (raise maxSurvivors to see them)');
    expect(text).toContain('…1 hidden below severityFloor');
  });
});

describe('A2 scopeNote', () => {
  it('includes scopeNote in JSON when present', () => {
    const r = baseResult([]);
    r.scopeNote = 'No changed lines in src/x.ts vs HEAD; nothing to mutate.';
    const json = JSON.parse(formatResultAsJson(r));
    expect(json.scopeNote).toBe('No changed lines in src/x.ts vs HEAD; nothing to mutate.');
  });

  it('omits scopeNote from JSON when absent', () => {
    const json = JSON.parse(formatResultAsJson(baseResult([])));
    expect('scopeNote' in json).toBe(false);
  });

  it('prints a Scope line in text output when present', () => {
    const r = baseResult([]);
    r.scopeNote = 'diffBase scoping is not supported for go; mutated the whole file.';
    const text = formatResultAsText(r);
    expect(text).toContain(
      'Scope: diffBase scoping is not supported for go; mutated the whole file.',
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
