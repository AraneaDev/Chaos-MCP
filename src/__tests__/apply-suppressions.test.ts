import { describe, it, expect } from 'vitest';
import { applySuppressions } from '../audit/apply-suppressions.js';
import type { MutationResult, Vulnerability } from '../engines/base.js';

/**
 * `audit/apply-suppressions.ts` had no test file, and it is the code that decides what
 * a score MEANS: a suppressed mutant is declared unkillable, so it leaves the
 * denominator entirely rather than counting as killed. Get the arithmetic wrong in
 * either direction and every score the server reports is wrong — too generous if
 * suppressed mutants are credited as kills, too harsh if they stay in the total.
 */

const survivor = (line: number, mutator = 'ConditionalExpression'): Vulnerability => ({
  line,
  mutator,
  kind: 'survived',
  description: `${mutator} survived at line ${line}`,
});

const noCoverage = (line: number, mutator = 'BlockStatement'): Vulnerability => ({
  line,
  mutator,
  kind: 'noCoverage',
  description: `no test reached ${mutator} at line ${line}`,
});

const result = (over: Partial<MutationResult> = {}): MutationResult => ({
  target: 'src/target.ts',
  totalMutants: 10,
  killed: 7,
  survived: 3,
  mutationScore: '70.00%',
  vulnerabilities: [survivor(1), survivor(2), noCoverage(3)],
  ...over,
});

describe('applySuppressions', () => {
  it('returns the result untouched when nothing is suppressed', () => {
    const input = result();
    const { result: out, suppressedCount } = applySuppressions(input, new Set());

    expect(suppressedCount).toBe(0);
    expect(out).toBe(input);
  });

  it('returns the result untouched when no suppression matches a real mutant', () => {
    // A stale entry pointing at a line that no longer has that mutant must not
    // silently shrink the denominator.
    const input = result();
    const { result: out, suppressedCount } = applySuppressions(
      input,
      new Set(['99 ArithmeticOperator']),
    );

    expect(suppressedCount).toBe(0);
    expect(out).toBe(input);
  });

  it('removes a suppressed mutant from the denominator rather than crediting a kill', () => {
    // 7/10 -> 7/9. If a suppressed mutant were counted as killed the score would be
    // 8/10; if it stayed in the total it would still be 7/10. Both are wrong, and only
    // asserting the exact score distinguishes the three.
    const { result: out, suppressedCount } = applySuppressions(
      result(),
      new Set(['1 ConditionalExpression']),
    );

    expect(suppressedCount).toBe(1);
    expect(out.totalMutants).toBe(9);
    expect(out.killed).toBe(7);
    expect(out.survived).toBe(2);
    expect(out.mutationScore).toBe('77.78%');
    expect(out.vulnerabilities).toEqual([survivor(2), noCoverage(3)]);
  });

  it('does not decrement survived for a suppressed no-coverage mutant', () => {
    // `survived` counts mutants a test RAN and failed to kill. A noCoverage mutant was
    // never in that number, so suppressing it must shrink the total without touching
    // survived — subtracting it would under-report the survivors that remain.
    const { result: out, suppressedCount } = applySuppressions(
      result(),
      new Set(['3 BlockStatement']),
    );

    expect(suppressedCount).toBe(1);
    expect(out.totalMutants).toBe(9);
    expect(out.survived).toBe(3);
  });

  it('does not mutate the input result', () => {
    const input = result();
    applySuppressions(input, new Set(['1 ConditionalExpression']));

    expect(input.totalMutants).toBe(10);
    expect(input.survived).toBe(3);
    expect(input.vulnerabilities).toHaveLength(3);
  });

  it('explains an all-suppressed file instead of reporting it as having no logic', () => {
    // totalMutants: 0 with no scopeNote is the exact signature `hasNoMutableLogic`
    // reads as "nothing here to mutate". Without the note, a file whose every mutant an
    // operator declared equivalent would be reported as having no mutable logic — the
    // opposite of the truth — and would rank as a genuine 100%.
    const { result: out, suppressedCount } = applySuppressions(
      result({ totalMutants: 3, killed: 0, survived: 2 }),
      new Set(['1 ConditionalExpression', '2 ConditionalExpression', '3 BlockStatement']),
    );

    expect(suppressedCount).toBe(3);
    expect(out.totalMutants).toBe(0);
    expect(out.scopeNote).toContain('suppressed as equivalent');
    expect(out.scopeNote).toContain('nothing was left to score');
  });

  it('keeps an existing scope note rather than overwriting it', () => {
    // A partial run already carries a note saying so; replacing it would drop the fact
    // that the run was incomplete, which is the more important of the two.
    const { result: out } = applySuppressions(
      result({ totalMutants: 3, killed: 0, survived: 2, scopeNote: 'Partial audit: 1 of 3.' }),
      new Set(['1 ConditionalExpression', '2 ConditionalExpression', '3 BlockStatement']),
    );

    expect(out.scopeNote).toBe('Partial audit: 1 of 3.');
  });

  it('never lets the counters go negative', () => {
    // Defensive clamps: a suppression set larger than the recorded totals must not
    // produce a negative denominator, which would make the score meaningless.
    const { result: out } = applySuppressions(
      result({ totalMutants: 1, survived: 0 }),
      new Set(['1 ConditionalExpression', '2 ConditionalExpression', '3 BlockStatement']),
    );

    expect(out.totalMutants).toBe(0);
    expect(out.survived).toBe(0);
  });

  it('reports an applied key that matched no mutant', () => {
    const out = applySuppressions(
      result({
        totalMutants: 2,
        killed: 1,
        survived: 1,
        vulnerabilities: [survivor(10)],
      }),
      new Set(['10 ConditionalExpression', '42 EqualityOperator']),
    );

    expect(out.suppressedCount).toBe(1);
    expect(out.orphanedKeys).toEqual(['42 EqualityOperator']);
  });

  it('reports no orphans when every applied key matched', () => {
    const out = applySuppressions(
      result({ totalMutants: 1, killed: 0, survived: 1, vulnerabilities: [survivor(10)] }),
      new Set(['10 ConditionalExpression']),
    );

    expect(out.orphanedKeys).toEqual([]);
  });

  it('reports no orphans when nothing is suppressed', () => {
    expect(applySuppressions(result(), undefined).orphanedKeys).toEqual([]);
    expect(applySuppressions(result(), new Set()).orphanedKeys).toEqual([]);
  });
});
