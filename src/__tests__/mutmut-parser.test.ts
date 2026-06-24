import { describe, it, expect } from 'vitest';
import { parseMutmutResults } from '../engines/python.js';

describe('parseMutmutResults', () => {
  const target = 'src/calculator.py';

  it('handles empty output', () => {
    const result = parseMutmutResults('', target);
    expect(result.totalMutants).toBe(0);
    expect(result.killed).toBe(0);
    expect(result.survived).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
    expect(result.vulnerabilities).toHaveLength(0);
  });

  it('handles whitespace-only output', () => {
    const result = parseMutmutResults('   \n\n  \n', target);
    expect(result.totalMutants).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
  });

  it('parses all-killed results with emoji', () => {
    const output = ['Killed 🎉 (5)'].join('\n');
    const result = parseMutmutResults(output, target);
    expect(result.killed).toBe(5);
    expect(result.survived).toBe(0);
    expect(result.totalMutants).toBe(5);
    expect(result.mutationScore).toBe('100.00%');
  });

  it('parses mixed categories with emoji', () => {
    const output = [
      'Survived 🙂 (2)',
      '  src/calculator.py:15',
      '  src/calculator.py:32',
      'Killed 🎉 (3)',
      'Timeout ⏰ (1)',
      'Skipped 🤔 (0)',
      'Suspicious 🤨 (1)',
    ].join('\n');
    const result = parseMutmutResults(output, target);

    // survived(2) + killed(3) + timeout(1) + skipped(0) + suspicious(1) = 7
    expect(result.totalMutants).toBe(7);
    // killed includes timeouts: 3 + 1 = 4
    expect(result.killed).toBe(4);
    expect(result.survived).toBe(2);
    expect(result.vulnerabilities).toHaveLength(2);
    expect(result.vulnerabilities[0].line).toBe(15);
    expect(result.vulnerabilities[1].line).toBe(32);
  });

  it('counts timeouts as killed in mutation score', () => {
    const output = ['Survived 🙂 (2)', 'Killed 🎉 (2)', 'Timeout ⏰ (2)'].join('\n');
    const result = parseMutmutResults(output, target);

    // killed = 2 + 2 (timeouts) = 4, total = 2 + 2 + 2 = 6
    // score = 4/6 * 100 = 66.67%
    expect(result.killed).toBe(4);
    expect(result.totalMutants).toBe(6);
    expect(result.mutationScore).toBe('66.67%');
  });

  it('treats suspicious mutants as surviving', () => {
    const output = ['Suspicious 🤨 (3)', 'Killed 🎉 (7)'].join('\n');
    const result = parseMutmutResults(output, target);

    expect(result.totalMutants).toBe(10);
    expect(result.killed).toBe(7);
    expect(result.survived).toBe(0); // suspicious not counted as survived
    // But suspicious IS in total, lowering the score: 7/10 = 70%
    expect(result.mutationScore).toBe('70.00%');
  });

  it('parses with text-only labels (no emoji fallback)', () => {
    const output = ['Survived (1)', '  mutant_42', 'Killed (4)'].join('\n');
    const result = parseMutmutResults(output, target);

    expect(result.survived).toBe(1);
    expect(result.killed).toBe(4);
    expect(result.totalMutants).toBe(5);
    expect(result.vulnerabilities).toHaveLength(1);
  });

  it('extracts line numbers from file:line mutant IDs', () => {
    const output = ['Survived 🙂 (1)', '  src/billing.py:42'].join('\n');
    const result = parseMutmutResults(output, target);

    expect(result.vulnerabilities[0].line).toBe(42);
  });

  it('handles numeric-only mutant IDs (no line number)', () => {
    const output = ['Survived 🙂 (1)', '  3'].join('\n');
    const result = parseMutmutResults(output, target);

    expect(result.vulnerabilities[0].line).toBe(0);
    expect(result.vulnerabilities[0].description).toContain('mutmut show');
  });

  it('adds a summary entry when survived count > 0 but no IDs captured', () => {
    const output = ['Survived 🙂 (3)'].join('\n');
    const result = parseMutmutResults(output, target);

    expect(result.survived).toBe(3);
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].line).toBe(0);
    expect(result.vulnerabilities[0].description).toContain('3 mutant(s) survived');
  });

  it('trusts header count over captured IDs when they differ', () => {
    const output = ['Survived 🙂 (5)', '  src/calc.py:10'].join('\n');
    const result = parseMutmutResults(output, target);

    // Header says 5, only 1 ID captured — use 5
    expect(result.survived).toBe(5);
    // But still report the 1 ID we have
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].line).toBe(10);
  });

  it('handles all categories with zero counts', () => {
    const output = [
      'Survived 🙂 (0)',
      'Killed 🎉 (0)',
      'Timeout ⏰ (0)',
      'Skipped 🤔 (0)',
      'Suspicious 🤨 (0)',
    ].join('\n');
    const result = parseMutmutResults(output, target);

    expect(result.totalMutants).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
    expect(result.vulnerabilities).toHaveLength(0);
  });

  it('handles missing parenthetical count in header', () => {
    // No (N) in the header — count should default to 0
    const output = ['Survived 🙂', '  src/calc.py:10'].join('\n');
    const result = parseMutmutResults(output, target);

    // No count in header, but 1 ID captured → survived = max(0, 1) = 1
    expect(result.survived).toBe(1);
    expect(result.vulnerabilities).toHaveLength(1);
  });
});
