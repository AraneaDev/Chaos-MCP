import { describe, it, expect } from 'vitest';
import { applySuppressions } from '../audit/apply-suppressions.js';
import type { SuppressionVerdict, ResolvedSuppression } from '../utils/suppression.js';
import type { MutationResult, Vulnerability } from '../engines/base.js';

/**
 * `audit/apply-suppressions.ts` is the code that decides what a score MEANS: a
 * suppressed mutant is declared unkillable, so it leaves the denominator
 * entirely rather than counting as killed. Get the arithmetic wrong in either
 * direction and every score the server reports is wrong — too generous if
 * suppressed mutants are credited as kills, too harsh if they stay in the total.
 *
 * Since v3 it also OWNS mutant identity at match time (mutator + change, never
 * the line) and tier 3 of the resolution ladder, so the cases below cover both
 * the arithmetic and the placement rules.
 */

const survivor = (line: number, mutator = 'ConditionalExpression'): Vulnerability => ({
  line,
  mutator,
  kind: 'survived',
  description: `${mutator} survived at line ${line}`,
});

/** A survivor carrying a content identity, as StrykerJS reports one. */
const changed = (
  line: number,
  original: string,
  mutated: string,
  mutator = 'ConditionalExpression',
): Vulnerability => ({ ...survivor(line, mutator), original, mutated });

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

/** One tier-1 entry, placed exactly where it is stored. */
const at = (line: number, mutator: string, change?: string): ResolvedSuppression => ({
  line,
  storedLine: line,
  mutator,
  fingerprint: 'ff',
  tier: 1,
  ...(change === undefined ? {} : { change }),
});

const verdict = (over: Partial<SuppressionVerdict> = {}): SuppressionVerdict => ({
  resolved: [],
  pending: [],
  drifted: 0,
  unverified: 0,
  ...over,
});

describe('applySuppressions arithmetic', () => {
  it('returns the result untouched when nothing is suppressed', () => {
    const input = result();
    const { result: out, suppressedCount } = applySuppressions(input, verdict());

    expect(suppressedCount).toBe(0);
    expect(out).toBe(input);
  });

  it('returns the result untouched when no suppression matches a real mutant', () => {
    // A stale entry pointing at a line that no longer has that mutant must not
    // silently shrink the denominator.
    const input = result();
    const { result: out, suppressedCount } = applySuppressions(
      input,
      verdict({ resolved: [at(99, 'ArithmeticOperator')] }),
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
      verdict({ resolved: [at(1, 'ConditionalExpression')] }),
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
      verdict({ resolved: [at(3, 'BlockStatement')] }),
    );

    expect(suppressedCount).toBe(1);
    expect(out.totalMutants).toBe(9);
    expect(out.survived).toBe(3);
  });

  it('does not mutate the input result', () => {
    const input = result();
    applySuppressions(input, verdict({ resolved: [at(1, 'ConditionalExpression')] }));

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
      verdict({
        resolved: [
          at(1, 'ConditionalExpression'),
          at(2, 'ConditionalExpression'),
          at(3, 'BlockStatement'),
        ],
      }),
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
      verdict({
        resolved: [
          at(1, 'ConditionalExpression'),
          at(2, 'ConditionalExpression'),
          at(3, 'BlockStatement'),
        ],
      }),
    );

    expect(out.scopeNote).toBe('Partial audit: 1 of 3.');
  });

  it('never lets the counters go negative', () => {
    // Defensive clamps: a suppression set larger than the recorded totals must not
    // produce a negative denominator, which would make the score meaningless.
    const { result: out } = applySuppressions(
      result({ totalMutants: 1, survived: 0 }),
      verdict({
        resolved: [
          at(1, 'ConditionalExpression'),
          at(2, 'ConditionalExpression'),
          at(3, 'BlockStatement'),
        ],
      }),
    );

    expect(out.totalMutants).toBe(0);
    expect(out.survived).toBe(0);
  });
});

describe('orphans', () => {
  it('reports an applied entry that matched no mutant', () => {
    const out = applySuppressions(
      result({ totalMutants: 2, killed: 1, survived: 1, vulnerabilities: [survivor(10)] }),
      verdict({ resolved: [at(10, 'ConditionalExpression'), at(42, 'EqualityOperator')] }),
    );

    expect(out.suppressedCount).toBe(1);
    expect(out.orphaned).toBe(1);
  });

  it('reports no orphans when every applied entry matched', () => {
    const out = applySuppressions(
      result({ totalMutants: 1, killed: 0, survived: 1, vulnerabilities: [survivor(10)] }),
      verdict({ resolved: [at(10, 'ConditionalExpression')] }),
    );

    expect(out.orphaned).toBe(0);
  });

  it('reports no orphans when nothing is suppressed', () => {
    expect(applySuppressions(result(), undefined).orphaned).toBe(0);
    expect(applySuppressions(result(), verdict()).orphaned).toBe(0);
  });

  it('carries the verdict’s own drift through even with nothing to place', () => {
    // A file whose every entry was refused by the fingerprint check has an empty
    // resolved AND pending list. Returning 0 here would silently drop the one
    // signal telling the reader why the score fell.
    expect(applySuppressions(result(), verdict({ drifted: 4 })).drifted).toBe(4);
  });
});

describe('identity is the change, not the line', () => {
  const twoOnOneLine = result({
    totalMutants: 4,
    killed: 2,
    survived: 2,
    vulnerabilities: [
      changed(134, 'Array.isArray(args.unsuppress)', 'true'),
      changed(134, 'args.unsuppress.length > 0', 'true'),
    ],
  });

  it('suppresses only the mutant whose change matches', () => {
    // The case the whole schema exists for. Both mutants share a line, a mutator
    // AND a replacement string; only the original span tells them apart. Keying
    // on (line, mutator) took the killed sibling down with the equivalent one.
    const out = applySuppressions(
      twoOnOneLine,
      verdict({
        resolved: [at(134, 'ConditionalExpression', 'args.unsuppress.length > 0 → true')],
      }),
    );

    expect(out.suppressedCount).toBe(1);
    expect(out.result.vulnerabilities).toHaveLength(1);
    expect(out.result.vulnerabilities[0].original).toBe('Array.isArray(args.unsuppress)');
  });

  it('a changeless entry still matches every mutant of its mutator on the line', () => {
    // cargo-mutants reports no replacement; its mutator name IS the change
    // description, so mutator-only identity is correct there.
    const out = applySuppressions(
      result({
        totalMutants: 1,
        killed: 0,
        survived: 1,
        vulnerabilities: [survivor(42, 'replace add -> sub')],
      }),
      verdict({ resolved: [at(42, 'replace add -> sub')] }),
    );

    expect(out.suppressedCount).toBe(1);
  });

  it('does not match a mutant whose change differs', () => {
    const out = applySuppressions(
      twoOnOneLine,
      verdict({ resolved: [at(134, 'ConditionalExpression', 'something else → true')] }),
    );

    expect(out.suppressedCount).toBe(0);
    expect(out.orphaned).toBe(1);
  });
});

describe('tier 3: placing an entry whose line was rewritten', () => {
  const pending = (change: string, storedLine = 134, reason?: string): ResolvedSuppression => ({
    line: storedLine,
    storedLine,
    mutator: 'ConditionalExpression',
    change,
    fingerprint: 'ff',
    tier: 1,
    ...(reason === undefined ? {} : { reason }),
  });

  it('relocates onto the survivor carrying its change', () => {
    const out = applySuppressions(
      result({
        totalMutants: 2,
        killed: 1,
        survived: 1,
        vulnerabilities: [changed(96, 'a > 0', 'true')],
      }),
      verdict({ pending: [pending('a > 0 → true', 134, 'guard unreachable')] }),
    );

    expect(out.suppressedCount).toBe(1);
    expect(out.relocated).toHaveLength(1);
    expect(out.relocated[0]).toMatchObject({ line: 96, storedLine: 134, tier: 3 });
    expect(out.relocated[0].reason).toBe('guard unreachable');
    expect(out.drifted).toBe(0);
  });

  it('refuses when the same change occurs on two lines', () => {
    // Uniqueness is the only evidence tier 3 has. Two candidates means guessing,
    // and guessing is what would move a suppression onto unrelated code.
    const out = applySuppressions(
      result({
        totalMutants: 3,
        killed: 1,
        survived: 2,
        vulnerabilities: [changed(96, 'a > 0', 'true'), changed(212, 'a > 0', 'true')],
      }),
      verdict({ pending: [pending('a > 0 → true')] }),
    );

    expect(out.suppressedCount).toBe(0);
    expect(out.drifted).toBe(1);
  });

  it('counts a pending entry matching nothing as drift, not as an orphan', () => {
    // The two mean different things: an orphan resolved against SOURCE and found
    // no mutant, a drifted entry could not be placed at all. Reporting one as the
    // other sends the reader to the wrong fix.
    const out = applySuppressions(
      result({
        totalMutants: 2,
        killed: 1,
        survived: 1,
        vulnerabilities: [changed(96, 'a > 0', 'a >= 0', 'EqualityOperator')],
      }),
      verdict({ pending: [pending('a > 0 → true')] }),
    );

    expect(out.drifted).toBe(1);
    expect(out.orphaned).toBe(0);
  });

  it('places an entry matching several mutants on ONE line', () => {
    // Same identity twice on a line is not ambiguity — they move together.
    const out = applySuppressions(
      result({
        totalMutants: 3,
        killed: 1,
        survived: 2,
        vulnerabilities: [changed(96, 'a > 0', 'true'), changed(96, 'a > 0', 'true')],
      }),
      verdict({ pending: [pending('a > 0 → true')] }),
    );

    expect(out.suppressedCount).toBe(2);
    expect(out.drifted).toBe(0);
  });

  it('sums drift from both halves of the ladder', () => {
    const out = applySuppressions(
      result({ totalMutants: 1, killed: 1, survived: 0, vulnerabilities: [] }),
      verdict({ drifted: 2, pending: [pending('a > 0 → true')] }),
    );

    expect(out.drifted).toBe(3);
  });
});

describe('relocation reporting', () => {
  it('counts a tier-2 move but leaves it out of the per-entry notes', () => {
    // Tier 2 cannot be wrong — the line's CONTENT is unchanged, it only moved —
    // so it is counted and not narrated. Only tier 3 gets an individual note.
    const out = applySuppressions(
      result({ totalMutants: 1, killed: 0, survived: 1, vulnerabilities: [survivor(96)] }),
      verdict({
        resolved: [
          {
            line: 96,
            storedLine: 134,
            mutator: 'ConditionalExpression',
            fingerprint: 'ff',
            tier: 2,
          },
        ],
      }),
    );

    expect(out.suppressedCount).toBe(1);
    expect(out.relocated).toHaveLength(1);
    expect(out.relocated[0].tier).toBe(2);
  });

  it('does not count a tier-1 entry as relocated', () => {
    const out = applySuppressions(
      result({ totalMutants: 1, killed: 0, survived: 1, vulnerabilities: [survivor(10)] }),
      verdict({ resolved: [at(10, 'ConditionalExpression')] }),
    );

    expect(out.relocated).toEqual([]);
  });
});
