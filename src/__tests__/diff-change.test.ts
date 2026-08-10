import { describe, it, expect } from 'vitest';
import { extractDiffChange } from '../utils/diff-change.js';
import { parseInfectionJsonLog } from '../engines/php/report.js';
import { changeOf } from '../utils/mutant-identity.js';

describe('extractDiffChange', () => {
  it('takes the first removed and first added line', () => {
    const diff = [
      '--- Original',
      '+++ New',
      '@@ @@',
      '         if ($a > 0) {',
      '-        return $a;',
      '+        return null;',
    ].join('\n');
    expect(extractDiffChange(diff)).toEqual({ original: 'return $a;', mutated: 'return null;' });
  });

  it('ignores the --- and +++ file headers', () => {
    // Without the header skip, `--- a.php` is itself a removed line and every
    // mutant in the file would share the identity "-- a.php".
    expect(extractDiffChange('--- a.php\n+++ b.php\n-x\n+y')).toEqual({
      original: 'x',
      mutated: 'y',
    });
  });

  it('returns only what the diff carried', () => {
    expect(extractDiffChange('+only added')).toEqual({ mutated: 'only added' });
    expect(extractDiffChange('-only removed')).toEqual({ original: 'only removed' });
    expect(extractDiffChange('no markers here')).toEqual({});
  });

  it('omits absent halves rather than setting them undefined', () => {
    // `Object.assign(vuln, ...)` in the PHP engine is a live call site: an
    // explicit `mutated: undefined` would OVERWRITE a value already on the
    // vulnerability, so each half must be absent rather than undefined.
    expect(Object.hasOwn(extractDiffChange('+added'), 'original')).toBe(false);
    expect(Object.hasOwn(extractDiffChange('-removed'), 'mutated')).toBe(false);
    expect(Object.hasOwn(extractDiffChange('no markers'), 'original')).toBe(false);
    expect(Object.hasOwn(extractDiffChange('no markers'), 'mutated')).toBe(false);
  });

  it('does not clobber an existing value when spread onto a vulnerability', () => {
    // The behaviour the omission exists for, asserted at the shape the PHP
    // engine actually uses.
    const vuln = { mutated: 'already here' };
    Object.assign(vuln, extractDiffChange('-removed'));
    expect(vuln.mutated).toBe('already here');
  });

  it('keeps only the first pair when a diff has several hunks', () => {
    expect(extractDiffChange('-a\n+b\n-c\n+d')).toEqual({ original: 'a', mutated: 'b' });
  });
});

describe('Infection survivors carry a content identity', () => {
  const log = (extra: Record<string, unknown>): string =>
    JSON.stringify({ stats: { killedCount: 1 }, ...extra });

  it('extracts original and mutated instead of storing the diff blob', () => {
    const result = parseInfectionJsonLog(
      log({
        escaped: [
          {
            mutator: { mutatorName: 'GreaterThan', originalStartLine: 42 },
            diff: '--- Original\n+++ New\n@@ @@\n-        if ($n > 0) {\n+        if ($n >= 0) {',
          },
        ],
      }),
      'src/Foo.php',
    );
    const v = result.vulnerabilities[0];
    expect(v.original).toBe('if ($n > 0) {');
    expect(v.mutated).toBe('if ($n >= 0) {');
    expect(v.mutated).not.toContain('---');
    expect(changeOf(v)).toBe('if ($n > 0) { → if ($n >= 0) {');
  });

  it('gives two mutants on one line distinct identities', () => {
    const result = parseInfectionJsonLog(
      log({
        escaped: [
          {
            mutator: { mutatorName: 'Coalesce', originalStartLine: 7 },
            diff: '-$a = $b ?? $c;\n+$a = $c ?? $b;',
          },
          {
            mutator: { mutatorName: 'Coalesce', originalStartLine: 7 },
            diff: '-$d = $e ?? $f;\n+$d = $f ?? $e;',
          },
        ],
      }),
      'src/Foo.php',
    );
    const [a, b] = result.vulnerabilities;
    expect(changeOf(a)).not.toBe(changeOf(b));
  });

  it('applies the same extraction to no-coverage mutants', () => {
    const result = parseInfectionJsonLog(
      log({
        uncovered: [
          {
            mutator: { mutatorName: 'Increment', originalStartLine: 9 },
            diff: '--- Original\n+++ New\n-$i++;\n+$i--;',
          },
        ],
      }),
      'src/Foo.php',
    );
    const v = result.vulnerabilities.find((x) => x.kind === 'noCoverage');
    expect(v?.original).toBe('$i++;');
    expect(v?.mutated).toBe('$i--;');
  });
});
