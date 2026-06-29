import { describe, it, expect } from 'vitest';
import {
  parseMutmutResults,
  parseMutmutShow,
  mutmutModuleGlob,
  parseMutmutCicdStats,
  parseMutmutSurvivors,
  buildMutmutConfigInjection,
} from '../engines/python.js';

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
    expect(result.vulnerabilities[2].mutator).toBe('Suspicious Mutation');
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
    expect(result.vulnerabilities[0].mutator).toBe('Suspicious Mutation');
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

  // ─── mutmut v3 counts come from the cicd-stats JSON (B) ───────────────────
  // `mutmut results` in v3 OMITS killed mutants, so counts/score MUST come from
  // `mutmut export-cicd-stats` → mutants/mutmut-cicd-stats.json, not the text.
  describe('parseMutmutCicdStats', () => {
    const stats = (o: Record<string, number>) => JSON.stringify(o);

    it('maps the JSON counts to a MutationResult (the realistic fixture)', () => {
      const r = parseMutmutCicdStats(
        stats({
          killed: 3,
          survived: 4,
          total: 7,
          no_tests: 0,
          skipped: 0,
          suspicious: 0,
          timeout: 0,
          segfault: 0,
        }),
        target,
      );
      expect(r.killed).toBe(3);
      expect(r.survived).toBe(4);
      expect(r.totalMutants).toBe(7);
      expect(r.mutationScore).toBe('42.86%'); // 3/7
    });

    it('counts timeout and segfault as killed (suite detected them)', () => {
      const r = parseMutmutCicdStats(
        stats({ killed: 1, survived: 0, total: 3, timeout: 1, segfault: 1 }),
        target,
      );
      expect(r.killed).toBe(3);
      expect(r.survived).toBe(0);
      expect(r.totalMutants).toBe(3);
      expect(r.mutationScore).toBe('100.00%');
    });

    it('counts suspicious and no_tests as surviving holes', () => {
      const r = parseMutmutCicdStats(
        stats({ killed: 1, survived: 1, total: 4, suspicious: 1, no_tests: 1 }),
        target,
      );
      expect(r.killed).toBe(1);
      expect(r.survived).toBe(3); // 1 survived + 1 suspicious + 1 no_tests
      expect(r.totalMutants).toBe(4);
    });

    it('folds the total-vs-explicit remainder (e.g. caught_by_type_check) into killed', () => {
      // v3's caught_by_type_check is in `total` but absent from the JSON fields;
      // the gap is a caught mutant and must count as killed, not vanish.
      const r = parseMutmutCicdStats(stats({ killed: 2, survived: 1, total: 4 }), target);
      expect(r.killed).toBe(3); // 2 explicit + 1 reconciled from total
      expect(r.totalMutants).toBe(4);
    });

    it('treats a zero-total run as 100% (nothing to catch)', () => {
      expect(parseMutmutCicdStats(stats({ total: 0 }), target).mutationScore).toBe('100.00%');
    });

    it('returns null for malformed JSON', () => {
      expect(parseMutmutCicdStats('{not json', target)).toBeNull();
    });
  });

  // ─── mutmut v3 survivor IDs come from `mutmut results` text ───────────────
  describe('parseMutmutSurvivors', () => {
    it('extracts the surviving mutant ids and their statuses', () => {
      const out = [
        '    calc.x_classify__mutmut_1: survived',
        '    calc.x_classify__mutmut_2: survived',
      ].join('\n');
      const survivors = parseMutmutSurvivors(out);
      expect(survivors).toEqual([
        { id: 'calc.x_classify__mutmut_1', status: 'survived' },
        { id: 'calc.x_classify__mutmut_2', status: 'survived' },
      ]);
    });

    it('captures suspicious and no_tests statuses too', () => {
      const out = ['m.x_f__mutmut_1: suspicious', 'm.x_f__mutmut_2: no_tests'].join('\n');
      expect(parseMutmutSurvivors(out).map((s) => s.status)).toEqual(['suspicious', 'no_tests']);
    });

    it('returns an empty list for v2 text or empty output', () => {
      expect(parseMutmutSurvivors('Survived 🙂 (3)')).toEqual([]);
      expect(parseMutmutSurvivors('')).toEqual([]);
    });
  });

  // ─── Gap A/B: inject [tool.mutmut] into the sandbox pyproject ─────────────
  // mutmut v3 cannot start without source_paths; most projects don't configure
  // [tool.mutmut]. The engine injects it into the sandbox copy (never the real
  // project). Optional test selection scopes the baseline for large suites.
  describe('buildMutmutConfigInjection', () => {
    const rel = 'core/cve_scanners/apt.py';

    it('creates a pyproject with [tool.mutmut] + source_paths when none exists', () => {
      const out = buildMutmutConfigInjection(null, rel);
      expect(out).toContain('[tool.mutmut]');
      expect(out).toContain('source_paths = ["core/cve_scanners/apt.py"]');
    });

    it('appends [tool.mutmut] to an existing pyproject, preserving its content', () => {
      const existing = '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n';
      const out = buildMutmutConfigInjection(existing, rel) ?? '';
      expect(out).toContain('[tool.pytest.ini_options]'); // original kept
      expect(out).toContain('[tool.mutmut]'); // section added
      expect(out.indexOf('[tool.pytest.ini_options]')).toBeLessThan(out.indexOf('[tool.mutmut]'));
    });

    it('returns null when [tool.mutmut] is already configured (respects the project)', () => {
      const existing = '[tool.mutmut]\nsource_paths = ["pkg"]\n';
      expect(buildMutmutConfigInjection(existing, rel)).toBeNull();
    });

    it('adds pytest_add_cli_args_test_selection when a test selection is given', () => {
      const out = buildMutmutConfigInjection(null, rel, ['tests/unit/test_apt_version_compare.py']);
      expect(out).toContain(
        'pytest_add_cli_args_test_selection = ["tests/unit/test_apt_version_compare.py"]',
      );
    });

    it('omits the test-selection line when no selection is given', () => {
      expect(buildMutmutConfigInjection(null, rel)).not.toContain(
        'pytest_add_cli_args_test_selection',
      );
    });

    it('quotes multiple selection args as a TOML string array', () => {
      const out = buildMutmutConfigInjection(null, rel, ['-m', 'unit']);
      expect(out).toContain('pytest_add_cli_args_test_selection = ["-m", "unit"]');
    });
  });

  // ─── v3 run scoping: file path → mutant-name glob ────────────────────────
  describe('mutmutModuleGlob', () => {
    it('derives a v3 mutant-name glob from a file path', () => {
      // mutmut v3 `run` takes a mutant-name filter (module.func__mutmut_N), not a
      // path. The module is the dotted path with the .py stripped.
      expect(mutmutModuleGlob('calc.py')).toBe('calc.*');
      expect(mutmutModuleGlob('pkg/calc.py')).toBe('pkg.calc.*');
      expect(mutmutModuleGlob('a/b/c.py')).toBe('a.b.c.*');
    });
  });

  // ─── mutmut show <id> unified-diff parsing (A: per-mutant detail) ─────────
  describe('parseMutmutShow', () => {
    const showOutput = [
      '# calc.x_classify__mutmut_1: survived',
      '--- calc.py',
      '+++ calc.py',
      '@@ -1,4 +1,4 @@',
      ' def classify(n):',
      '-    if n > 10:',
      '+    if n >= 10:',
      '         return "big"',
      '     return "small"',
    ].join('\n');

    it('extracts the changed line number and original/mutated source', () => {
      const parsed = parseMutmutShow(showOutput);
      expect(parsed).not.toBeNull();
      expect(parsed?.line).toBe(2); // `if n > 10:` is line 2 of the file
      expect(parsed?.original).toBe('if n > 10:');
      expect(parsed?.mutated).toBe('if n >= 10:');
    });

    it('reads the line offset from the hunk header (not always line 1)', () => {
      const diff = [
        '# m.x_f__mutmut_9: survived',
        '--- m.py',
        '+++ m.py',
        '@@ -40,4 +40,4 @@',
        ' a = 1',
        ' b = 2',
        '-    total = a + b',
        '+    total = a - b',
      ].join('\n');
      const parsed = parseMutmutShow(diff);
      expect(parsed?.line).toBe(42); // 40 (a) , 41 (b), 42 (the changed line)
      expect(parsed?.original).toBe('total = a + b');
      expect(parsed?.mutated).toBe('total = a - b');
    });

    it('returns null when there is no diff hunk', () => {
      expect(parseMutmutShow('# m.x_f__mutmut_1: survived\n(no diff available)')).toBeNull();
    });
  });
});
