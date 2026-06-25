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

    // survivedCount = max(2, 2) + suspicious(1) = 3
    // totalMutants = 3 + 3(killed) + 1(timeout) + 0(skipped) = 7
    expect(result.totalMutants).toBe(7);
    // killed includes timeouts: 3 + 1 = 4
    expect(result.killed).toBe(4);
    // survived now includes suspicious (M11): 2 + 1 = 3
    expect(result.survived).toBe(3);
    // 2 individual survivors + 1 suspicious summary = 3 vulnerabilities
    expect(result.vulnerabilities).toHaveLength(3);
    expect(result.vulnerabilities[0].line).toBe(15);
    expect(result.vulnerabilities[1].line).toBe(32);
    expect(result.vulnerabilities[2].replacement).toBe('Suspicious Mutation');
  });

  it('does not match a mutant ID whose path starts with a category keyword (H4 regression)', () => {
    // A mutant ID like `survived_logic.py:7` must NOT be misread as a
    // section header — it appears indented under the real `Survived 🙂 (1)` header.
    const result = parseMutmutResults(
      ['Survived 🙂 (1)', '  survived_logic.py:7'].join('\n'),
      'survived_logic.py',
    );
    expect(result.survived).toBe(1);
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].line).toBe(7);
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

  it('treats suspicious mutants as surviving (M11 regression)', () => {
    const output = ['Suspicious 🤨 (3)', 'Killed 🎉 (7)'].join('\n');
    const result = parseMutmutResults(output, target);

    // survivedCount = max(survived_header, IDs) + suspicious = 0 + 3 = 3
    // totalMutants = survived(3) + killed(7) + timeout(0) + skipped(0) = 10
    expect(result.totalMutants).toBe(10);
    expect(result.killed).toBe(7);
    // Suspicious mutants now contribute to the survived count
    expect(result.survived).toBe(3);
    // score = 7/10 = 70%
    expect(result.mutationScore).toBe('70.00%');
    // Should emit a summary entry for suspicious mutants
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].replacement).toBe('Suspicious Mutation');
    expect(result.vulnerabilities[0].description).toContain('3 suspicious mutant(s)');
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

  it('resets currentCategory on blank lines between categories', () => {
    const output = [
      'Survived 🙂 (2)',
      '  src/calc.py:10',
      '', // blank line resets category
      'Some random text that is not a header',
      '',
      'Killed 🎉 (1)',
    ].join('\n');
    const result = parseMutmutResults(output, target);
    // survived=2 (from header), 1 ID captured, killed=1
    expect(result.survived).toBe(2);
    expect(result.killed).toBe(1);
    expect(result.vulnerabilities).toHaveLength(1);
  });

  it('handles Survived header with parens count but no emoji', () => {
    const output = 'Survived (4)\nKilled 🎉 (2)';
    const result = parseMutmutResults(output, target);
    // Survived matched via parens count (fallback), Killed via emoji
    expect(result.survived).toBe(4);
    expect(result.killed).toBe(2);
  });

  it('does not match Survived-(digits) as a header when it looks like a path', () => {
    // A line like "Survived.py (3)" is a path-like name with parens count.
    // The looksLikePath gate should prevent it being classified as a header.
    const output = ['Survived.py (3)'].join('\n');
    const result = parseMutmutResults(output, target);
    expect(result.survived).toBe(0);
    expect(result.totalMutants).toBe(0);
  });

  it('extracts line number from complex mutant ID paths', () => {
    const output = ['Survived 🙂 (1)', '  src/utils/helper:42'].join('\n');
    const result = parseMutmutResults(output, target);
    // extractLineFromId should match ":42" in "src/utils/helper:42"
    expect(result.vulnerabilities[0].line).toBe(42);
  });

  it('handles header with parens count but no emoji for Skipped category', () => {
    const output = 'Skipped (5)\nSurvived 🙂 (0)\nKilled 🎉 (0)';
    const result = parseMutmutResults(output, target);
    // Skipped matched via parens count fallback; contributes to totalMutants
    // totalMutants = survivedCount(0) + killed(0) + timeout(0) + skipped(5) = 5
    expect(result.totalMutants).toBe(5);
  });
});
