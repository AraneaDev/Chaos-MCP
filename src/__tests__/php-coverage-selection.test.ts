import { describe, expect, it } from 'vitest';
import { parsePhpCoverageSelection } from '../engines/php/coverage-selection.js';

describe('parsePhpCoverageSelection', () => {
  it('accepts equals-form suite selection', () => {
    expect(parsePhpCoverageSelection('--testsuite=unit')).toEqual({
      raw: '--testsuite=unit',
      args: ['--testsuite=unit'],
      scope: 'selected',
    });
  });

  it('accepts separated suite selection', () => {
    const selection = parsePhpCoverageSelection('--testsuite unit');
    if (selection === undefined) throw new Error('Expected a selected coverage scope.');
    expect(selection.args).toEqual(['--testsuite', 'unit']);
  });

  it.each(['--filter=CalculatorTest', '--group unit', '--exclude-group slow'])(
    'accepts %s',
    (raw) => {
      expect(parsePhpCoverageSelection(raw)?.scope).toBe('selected');
    },
  );

  it('preserves quoted filter expressions as one normalized argument', () => {
    expect(parsePhpCoverageSelection('--filter "CalculatorTest with data set"')?.args).toEqual([
      '--filter',
      'CalculatorTest with data set',
    ]);
  });

  it('returns undefined when no selector is configured', () => {
    expect(parsePhpCoverageSelection(undefined)).toBeUndefined();
  });

  it.each([
    '--colors=never',
    '--process-isolation',
    '--testsuite=unit --colors=never',
    '--testsuite=unit trailing',
    '',
    '   ',
    '--testsuite',
    '--testsuite=',
    '--testsuite ""',
    'unit',
    '--testsuite=unit --unknown=value',
    '--testsuite "unit',
  ])('rejects %s', (raw) => {
    expect(() => parsePhpCoverageSelection(raw)).toThrow();
  });
});
