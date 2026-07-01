import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from 'fs';
import { loadConfig, validateConfig } from '../utils/config-loader.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

describe('loadConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('returns empty config when no config file exists', () => {
    const config = loadConfig();
    expect(config).toEqual({});
  });

  it('returns empty config when explicit config path does not exist', () => {
    const config = loadConfig('/tmp/nonexistent.json');
    expect(config).toEqual({});
  });

  it('loads defaultTimeoutMs from config file', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ defaultTimeoutMs: 60000 }));

    const config = loadConfig('/tmp/config.json');
    expect(config.defaultTimeoutMs).toBe(60000);
  });

  it('loads defaultMaxFiles from config file', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ defaultMaxFiles: 10 }));
    expect(loadConfig('/tmp/config.json').defaultMaxFiles).toBe(10);
  });

  it('accepts defaultMaxFiles at the lower boundary of 1', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ defaultMaxFiles: 1 }));
    expect(loadConfig('/tmp/config.json').defaultMaxFiles).toBe(1);
  });

  it('ignores a non-integer / < 1 defaultMaxFiles', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ defaultMaxFiles: 0 }));
    expect(loadConfig('/tmp/config.json').defaultMaxFiles).toBeUndefined();
    mockReadFileSync.mockReturnValue(JSON.stringify({ defaultMaxFiles: 2.5 }));
    expect(loadConfig('/tmp/config.json').defaultMaxFiles).toBeUndefined();
  });

  it('loads testRunner from config file', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ testRunner: 'jest' }));

    const config = loadConfig('/tmp/config.json');
    expect(config.testRunner).toBe('jest');
  });

  it('loads allowPrebuild from config file', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ allowPrebuild: true }));

    const config = loadConfig('/tmp/config.json');
    expect(config.allowPrebuild).toBe(true);
  });

  it('ignores a non-boolean allowPrebuild', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ allowPrebuild: 'yes' }));

    const config = loadConfig('/tmp/config.json');
    expect(config.allowPrebuild).toBeUndefined();
  });

  it('loads concurrency from config file', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ concurrency: 4 }));

    const config = loadConfig('/tmp/config.json');
    expect(config.concurrency).toBe(4);
  });

  it('loads mutatorAllowlist from config file', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ mutatorAllowlist: ['ConditionalExpression', 'ArithmeticOperator'] }),
    );

    const config = loadConfig('/tmp/config.json');
    expect(config.mutatorAllowlist).toEqual(['ConditionalExpression', 'ArithmeticOperator']);
  });

  it('loads mutatorDenylist from config file', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ mutatorDenylist: ['StringLiteral'] }));

    const config = loadConfig('/tmp/config.json');
    expect(config.mutatorDenylist).toEqual(['StringLiteral']);
  });

  it('loads all fields from a complete config', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        defaultTimeoutMs: 120000,
        testRunner: 'vitest',
        concurrency: 3,
        mutatorAllowlist: ['ConditionalExpression'],
        mutatorDenylist: ['StringLiteral'],
      }),
    );

    const config = loadConfig('/tmp/config.json');
    expect(config).toEqual({
      defaultTimeoutMs: 120000,
      testRunner: 'vitest',
      concurrency: 3,
      mutatorAllowlist: ['ConditionalExpression'],
      mutatorDenylist: ['StringLiteral'],
    });
  });

  it('filters non-string values from mutator arrays', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mutatorAllowlist: ['ConditionalExpression', 42, null, 'ArithmeticOperator'],
        mutatorDenylist: ['StringLiteral', true, 'BooleanLiteral'],
      }),
    );

    const config = loadConfig('/tmp/config.json');
    expect(config.mutatorAllowlist).toEqual(['ConditionalExpression', 'ArithmeticOperator']);
    expect(config.mutatorDenylist).toEqual(['StringLiteral', 'BooleanLiteral']);
  });

  it('ignores invalid defaultTimeoutMs values', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ defaultTimeoutMs: -1 }));

    const config = loadConfig('/tmp/config.json');
    expect(config.defaultTimeoutMs).toBeUndefined();
  });

  it('ignores unknown config keys', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ unknownKey: 'value', defaultTimeoutMs: 60000 }),
    );

    const config = loadConfig('/tmp/config.json');
    expect(config).toEqual({ defaultTimeoutMs: 60000 });
    expect((config as Record<string, unknown>).unknownKey).toBeUndefined();
  });

  it('throws for invalid JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not valid json {{{');

    expect(() => loadConfig('/tmp/config.json')).toThrow(/Failed to load config file/);
  });

  it('throws for array config (not an object)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(['not', 'an', 'object']));

    expect(() => loadConfig('/tmp/config.json')).toThrow(/Failed to load config file/);
  });

  it('loads perMutantTimeoutMs from config file', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ perMutantTimeoutMs: 15000 }));

    const config = loadConfig('/tmp/config.json');
    expect(config.perMutantTimeoutMs).toBe(15000);
  });

  it('ignores invalid perMutantTimeoutMs (non-positive)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ perMutantTimeoutMs: 0 }));

    const config = loadConfig('/tmp/config.json');
    expect(config.perMutantTimeoutMs).toBeUndefined();
  });

  // ─── Engine-specific config section tests ───────────────────────────────

  it('loads stryker engine-specific config', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        stryker: {
          timeoutMs: 60000,
          concurrency: 4,
          perMutantTimeoutMs: 10000,
          dryRun: true,
          incremental: false,
          mutatorAllowlist: ['ConditionalExpression'],
          mutatorDenylist: ['StringLiteral'],
        },
      }),
    );

    const config = loadConfig('/tmp/config.json');
    expect(config.stryker).toEqual({
      timeoutMs: 60000,
      concurrency: 4,
      perMutantTimeoutMs: 10000,
      dryRun: true,
      incremental: false,
      mutatorAllowlist: ['ConditionalExpression'],
      mutatorDenylist: ['StringLiteral'],
    });
  });

  it('loads cosmicray engine-specific config', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        cosmicray: { timeoutMs: 120000, testRunner: 'pytest' },
      }),
    );

    const config = loadConfig('/tmp/config.json');
    expect(config.cosmicray).toEqual({ timeoutMs: 120000, testRunner: 'pytest' });
  });

  it('loads cosmicray testSelection and excludeOperators arrays', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        cosmicray: {
          testSelection: ['tests/unit/test_x.py'],
          excludeOperators: ['core/NumberReplacer', 'core/.*String.*'],
        },
      }),
    );

    const config = loadConfig('/tmp/config.json');
    expect(config.cosmicray?.testSelection).toEqual(['tests/unit/test_x.py']);
    expect(config.cosmicray?.excludeOperators).toEqual(['core/NumberReplacer', 'core/.*String.*']);
  });

  it('loads rust engine-specific config', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ rust: { timeoutMs: 600000 } }));

    const config = loadConfig('/tmp/config.json');
    expect(config.rust).toEqual({ timeoutMs: 600000 });
  });

  it('loads a config with both global and engine-specific overrides', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        defaultTimeoutMs: 120000,
        stryker: { timeoutMs: 60000, concurrency: 2 },
        rust: { timeoutMs: 600000 },
      }),
    );

    const config = loadConfig('/tmp/config.json');
    expect(config.defaultTimeoutMs).toBe(120000);
    expect(config.stryker?.timeoutMs).toBe(60000);
    expect(config.stryker?.concurrency).toBe(2);
    expect(config.rust?.timeoutMs).toBe(600000);
    // No cosmicray section should be present
    expect(config.cosmicray).toBeUndefined();
  });

  it('filters invalid values from stryker config section', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        stryker: {
          timeoutMs: 0,
          concurrency: -1,
          mutatorAllowlist: ['ValidOne', 42, null, 'ValidTwo'],
          mutatorDenylist: ['ExcludeMe', false],
          perMutantTimeoutMs: -50,
        },
      }),
    );

    const config = loadConfig('/tmp/config.json');
    expect(config.stryker?.timeoutMs).toBeUndefined();
    expect(config.stryker?.concurrency).toBeUndefined();
    expect(config.stryker?.mutatorAllowlist).toEqual(['ValidOne', 'ValidTwo']);
    expect(config.stryker?.mutatorDenylist).toEqual(['ExcludeMe']);
    expect(config.stryker?.perMutantTimeoutMs).toBeUndefined();
  });

  it('returns undefined for engine config when section is empty', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ stryker: {} }));

    const config = loadConfig('/tmp/config.json');
    expect(config.stryker).toBeUndefined();
  });

  it('returns undefined for engine config when section is not an object', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ stryker: 'not-an-object' }));

    const config = loadConfig('/tmp/config.json');
    expect(config.stryker).toBeUndefined();
  });

  it('returns undefined for engine config when section is an array', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ stryker: [1, 2, 3] }));

    const config = loadConfig('/tmp/config.json');
    expect(config.stryker).toBeUndefined();
  });

  it('loads defaultMaxSurvivors and defaultSeverityFloor', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ defaultMaxSurvivors: 20, defaultSeverityFloor: 'high' }),
    );
    const cfg = loadConfig('/tmp/config.json');
    expect(cfg.defaultMaxSurvivors).toBe(20);
    expect(cfg.defaultSeverityFloor).toBe('high');
  });

  it('loads a valid defaultFileConcurrency', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ defaultFileConcurrency: 4 }));
    expect(loadConfig('/tmp/config.json').defaultFileConcurrency).toBe(4);
  });

  it('ignores a non-integer / out-of-range defaultFileConcurrency', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ defaultFileConcurrency: 0 }));
    expect(loadConfig('/tmp/config.json').defaultFileConcurrency).toBeUndefined();
    mockReadFileSync.mockReturnValue(JSON.stringify({ defaultFileConcurrency: 100 }));
    expect(loadConfig('/tmp/config.json').defaultFileConcurrency).toBeUndefined();
    mockReadFileSync.mockReturnValue(JSON.stringify({ defaultFileConcurrency: 2.5 }));
    expect(loadConfig('/tmp/config.json').defaultFileConcurrency).toBeUndefined();
  });
});

describe('validateConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('warns when config file is missing', () => {
    const { warnings } = validateConfig('/tmp/nonexistent.json');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('not found');
  });

  it('warns about unknown top-level keys', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ bogusKey: 'value', anotherBogus: 42 }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('bogusKey'))).toBe(true);
    expect(warnings.some((w) => w.includes('anotherBogus'))).toBe(true);
  });

  it('warns when engine section has all fields rejected', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ stryker: { timeoutMs: 0, concurrency: -1 } }),
    );

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('stryker') && w.includes('no valid fields'))).toBe(true);
  });

  it('warns about unknown keys inside engine sections', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ stryker: { timeoutMs: 60000, bogusOption: true } }),
    );

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('bogusOption') && w.includes('stryker'))).toBe(true);
  });

  it('warns about wrong types in engine sections', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ stryker: { timeoutMs: 'not-a-number' } }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('must be a number'))).toBe(true);
  });

  it('warns about non-object engine section', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ stryker: 'not-an-object' }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('stryker') && w.includes('must be an object'))).toBe(
      true,
    );
  });

  it('returns no warnings for a valid config', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        defaultTimeoutMs: 300000,
        stryker: { timeoutMs: 60000, concurrency: 4 },
        rust: { timeoutMs: 600000 },
      }),
    );

    const { config, warnings } = validateConfig('/tmp/config.json');
    expect(warnings).toHaveLength(0);
    expect(config.defaultTimeoutMs).toBe(300000);
    expect(config.stryker?.timeoutMs).toBe(60000);
  });

  it('loads stryker testRunner from config file (H7 regression)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ stryker: { testRunner: 'vitest' } }));

    const config = loadConfig('/tmp/config.json');
    expect(config.stryker?.testRunner).toBe('vitest');
  });

  it('loads cosmicray testRunner from config file', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ cosmicray: { testRunner: 'unittest' } }));

    const config = loadConfig('/tmp/config.json');
    expect(config.cosmicray?.testRunner).toBe('unittest');
  });

  it('returns undefined for stryker config when only empty testRunner is provided', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ stryker: { testRunner: '' } }));

    const config = loadConfig('/tmp/config.json');
    expect(config.stryker).toBeUndefined();
  });

  it('warns when stryker testRunner is not a string', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ stryker: { testRunner: 42 } }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('testRunner') && w.includes('must be a string'))).toBe(
      true,
    );
  });

  it('warns when stryker concurrency is a float', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ stryker: { concurrency: 2.5 } }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(
      warnings.some((w) => w.includes('concurrency') && w.includes('must be an integer')),
    ).toBe(true);
  });

  // ─── Global field validation warnings ────────────────────────────────────

  it('warns about non-boolean dryRun in stryker section', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ stryker: { dryRun: 'yes' } }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('dryRun') && w.includes('must be a boolean'))).toBe(
      true,
    );
  });

  it('warns about non-boolean incremental in stryker section', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ stryker: { incremental: 1 } }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('incremental') && w.includes('must be a boolean'))).toBe(
      true,
    );
  });

  it('warns about non-array mutatorAllowlist in stryker section', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ stryker: { mutatorAllowlist: 'StringLiteral' } }),
    );

    const { warnings } = validateConfig('/tmp/config.json');
    expect(
      warnings.some((w) => w.includes('mutatorAllowlist') && w.includes('must be an array')),
    ).toBe(true);
  });

  it('warns about stryker timeoutMs <= 0 in validateConfig', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ stryker: { timeoutMs: 0 } }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('timeoutMs') && w.includes('must be positive'))).toBe(
      true,
    );
  });

  it('warns about stryker concurrency out of range in validateConfig', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ stryker: { concurrency: 128 } }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('concurrency') && w.includes('between 1 and 64'))).toBe(
      true,
    );
  });

  it('silently drops global mutatorAllowlist when it is not an array', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ mutatorAllowlist: 'not-an-array' }));

    const config = loadConfig('/tmp/config.json');
    // loadConfig silently drops non-array mutatorAllowlist
    expect(config.mutatorAllowlist).toBeUndefined();
  });

  it('warns when global perMutantTimeoutMs is wrong type', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ perMutantTimeoutMs: '1000' }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(
      warnings.some((w) => w.includes('perMutantTimeoutMs') && w.includes('must be a number')),
    ).toBe(true);
  });

  it('warns about unknown keys in rust engine section', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ rust: { timeoutMs: 60000, unknownField: 1 } }),
    );

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('unknownField') && w.includes('rust'))).toBe(true);
  });

  it('returns valid config alongside warnings for partially-bad input', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        unknownGlobal: 'skip-me',
        defaultTimeoutMs: 120000,
        stryker: { timeoutMs: 60000, badStrykerKey: true },
      }),
    );

    const { config, warnings } = validateConfig('/tmp/config.json');
    // Valid fields still load
    expect(config.defaultTimeoutMs).toBe(120000);
    expect(config.stryker?.timeoutMs).toBe(60000);
    // Warnings for the unknown keys
    expect(warnings.some((w) => w.includes('unknownGlobal'))).toBe(true);
    expect(warnings.some((w) => w.includes('badStrykerKey'))).toBe(true);
  });

  // ─── Engine-specific validation edge cases ──────────────────────────────

  it('warns about unknown keys in cosmicray engine section', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ cosmicray: { timeoutMs: 60000, bogusMutmutKey: true } }),
    );

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('bogusMutmutKey') && w.includes('cosmicray'))).toBe(
      true,
    );
  });

  it('warns about wrong type for rust timeoutMs', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ rust: { timeoutMs: false } }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(
      warnings.some((w) => w.includes('rust.timeoutMs') && w.includes('must be a number')),
    ).toBe(true);
  });

  it('warns about global testRunner wrong type', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ testRunner: 123 }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('testRunner') && w.includes('must be a string'))).toBe(
      true,
    );
  });

  it('warns about global concurrency out of range', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ concurrency: 128 }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('concurrency') && w.includes('between 1 and 64'))).toBe(
      true,
    );
  });

  it('warns about global concurrency float value', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ concurrency: 2.5 }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('concurrency') && w.includes('integer'))).toBe(true);
  });

  it('warns about non-object cosmicray section', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ cosmicray: 'not-an-object' }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('cosmicray') && w.includes('must be an object'))).toBe(
      true,
    );
  });

  it('warns about rust timeoutMs <= 0 in validateEngineSection', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ rust: { timeoutMs: 0 } }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(
      warnings.some((w) => w.includes('rust.timeoutMs') && w.includes('must be positive')),
    ).toBe(true);
  });

  it('warns about cosmicray timeoutMs <= 0', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ cosmicray: { timeoutMs: 0 } }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(
      warnings.some((w) => w.includes('cosmicray.timeoutMs') && w.includes('must be positive')),
    ).toBe(true);
  });

  it('reports parse failure via warnings', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not valid json {{{');

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('Failed to parse config file'))).toBe(true);
  });

  it('ignores global concurrency=0 (must be between 1 and 64)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ concurrency: 0 }));

    const config = loadConfig('/tmp/config.json');
    expect(config.concurrency).toBeUndefined();
  });

  it('loads testRunner from validateConfig output', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ testRunner: 'vitest', defaultTimeoutMs: 60000 }),
    );

    const { config } = validateConfig('/tmp/config.json');
    expect(config.testRunner).toBe('vitest');
    expect(config.defaultTimeoutMs).toBe(60000);
  });

  it('rejects invalid defaultMaxSurvivors and defaultSeverityFloor with warnings', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ defaultMaxSurvivors: 0, defaultSeverityFloor: 'critical' }),
    );
    const { config, warnings } = validateConfig('/tmp/config.json');
    expect(config.defaultMaxSurvivors).toBeUndefined();
    expect(config.defaultSeverityFloor).toBeUndefined();
    expect(warnings.join(' ')).toContain('defaultMaxSurvivors');
    expect(warnings.join(' ')).toContain('defaultSeverityFloor');
  });

  it('rejects an out-of-range defaultFileConcurrency with a warning', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ defaultFileConcurrency: 0 }));
    const { config, warnings } = validateConfig('/tmp/config.json');
    expect(config.defaultFileConcurrency).toBeUndefined();
    expect(warnings.join(' ')).toContain('defaultFileConcurrency');
  });
});

describe('phase3 config keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it('accepts suppressionsPath / runCacheTtlMs / runCacheMax', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ suppressionsPath: '.x/sup.json', runCacheTtlMs: 1000, runCacheMax: 5 }),
    );
    const { config, warnings } = validateConfig('/tmp/config.json');
    expect(config.suppressionsPath).toBe('.x/sup.json');
    expect(config.runCacheTtlMs).toBe(1000);
    expect(config.runCacheMax).toBe(5);
    expect(warnings).toHaveLength(0);
  });

  it('warns on invalid runCacheMax', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ runCacheMax: 0 }));
    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('runCacheMax'))).toBe(true);
  });

  it('warns on invalid suppressionsPath', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ suppressionsPath: '' }));
    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('suppressionsPath'))).toBe(true);
  });

  it('warns on invalid runCacheTtlMs', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ runCacheTtlMs: 0 }));
    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('runCacheTtlMs'))).toBe(true);
  });
});

/**
 * Mutation-driven coverage. Chaos-MCP flagged surviving mutants in the
 * KNOWN_*_KEYS sets, the boundary comparisons (`> 0`, `>= 1`, `<= 64`,
 * `length > 0`), and validateConfig's global type checks. These tests pin
 * those exact boundaries and the known-key inventories.
 */
describe('config-loader mutation hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  /** Set the on-disk config to `obj` (serialized) for the next load/validate. */
  function setConfig(obj: unknown): void {
    mockReadFileSync.mockReturnValue(JSON.stringify(obj));
  }

  // ── KNOWN_*_KEYS inventories (a deleted key would make a real field "unknown") ──

  it('accepts every known top-level key without an "Unknown config key" warning', () => {
    setConfig({
      defaultTimeoutMs: 1000,
      testRunner: 'vitest',
      concurrency: 4,
      mutatorAllowlist: ['a'],
      mutatorDenylist: ['b'],
      perMutantTimeoutMs: 5000,
      suppressionsPath: '.chaos-mcp/suppressions.json',
      runCacheTtlMs: 1000,
      runCacheMax: 10,
      stryker: { timeoutMs: 1 },
      cosmicray: { timeoutMs: 1 },
      rust: { timeoutMs: 1 },
    });
    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('Unknown config key'))).toBe(false);
  });

  it('accepts every known stryker key without an unknown-key warning', () => {
    setConfig({
      stryker: {
        timeoutMs: 1,
        concurrency: 4,
        mutatorAllowlist: ['a'],
        mutatorDenylist: ['b'],
        perMutantTimeoutMs: 5000,
        dryRun: true,
        incremental: false,
        testRunner: 'vitest',
      },
    });
    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('Unknown key') && w.includes('stryker'))).toBe(false);
  });

  it('accepts every known cosmicray key without an unknown-key warning', () => {
    setConfig({ cosmicray: { timeoutMs: 1, testRunner: 'pytest' } });
    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('Unknown key') && w.includes('cosmicray'))).toBe(false);
  });

  // ── validateConfig global type checks (327/328, 336/337 were NoCoverage) ──

  it('warns when global defaultTimeoutMs is the wrong type', () => {
    setConfig({ defaultTimeoutMs: 'nope' });
    const { warnings } = validateConfig('/tmp/config.json');
    expect(
      warnings.some((w) => w.includes('defaultTimeoutMs') && w.includes('must be a number')),
    ).toBe(true);
  });

  it('does not warn about defaultTimeoutMs when it is a valid number', () => {
    setConfig({ defaultTimeoutMs: 1000 });
    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('defaultTimeoutMs'))).toBe(false);
  });

  it('warns when global perMutantTimeoutMs is the wrong type', () => {
    setConfig({ perMutantTimeoutMs: 'nope' });
    const { warnings } = validateConfig('/tmp/config.json');
    expect(
      warnings.some((w) => w.includes('perMutantTimeoutMs') && w.includes('must be a number')),
    ).toBe(true);
  });

  // ── Global concurrency boundary: exactly 1 and exactly 64 are valid ──

  it('accepts global concurrency at the lower bound (1)', () => {
    setConfig({ concurrency: 1 });
    const { config, warnings } = validateConfig('/tmp/config.json');
    expect(config.concurrency).toBe(1);
    expect(warnings.some((w) => w.includes('concurrency'))).toBe(false);
  });

  it('accepts global concurrency at the upper bound (64)', () => {
    setConfig({ concurrency: 64 });
    const { config, warnings } = validateConfig('/tmp/config.json');
    expect(config.concurrency).toBe(64);
    expect(warnings.some((w) => w.includes('concurrency'))).toBe(false);
  });

  it('rejects global concurrency just above the upper bound (65)', () => {
    setConfig({ concurrency: 65 });
    const { config, warnings } = validateConfig('/tmp/config.json');
    expect(config.concurrency).toBeUndefined();
    expect(warnings.some((w) => w.includes('concurrency'))).toBe(true);
  });

  // ── Stryker concurrency boundary in buildConfig/parseStrykerConfig ──

  it('loads stryker concurrency at both bounds (1 and 64)', () => {
    setConfig({ stryker: { concurrency: 1 } });
    expect(loadConfig('/tmp/config.json').stryker?.concurrency).toBe(1);
    setConfig({ stryker: { concurrency: 64 } });
    expect(loadConfig('/tmp/config.json').stryker?.concurrency).toBe(64);
  });

  it('drops stryker concurrency just outside the bounds (0 and 65)', () => {
    setConfig({ stryker: { concurrency: 0 } });
    expect(loadConfig('/tmp/config.json').stryker).toBeUndefined();
    setConfig({ stryker: { concurrency: 65 } });
    expect(loadConfig('/tmp/config.json').stryker).toBeUndefined();
  });

  // ── timeoutMs strictly-positive boundary: 1 accepted, 0 rejected ──

  it('accepts timeoutMs of exactly 1 across all engine sections', () => {
    setConfig({
      defaultTimeoutMs: 1,
      perMutantTimeoutMs: 1,
      stryker: { timeoutMs: 1 },
      cosmicray: { timeoutMs: 1 },
      rust: { timeoutMs: 1 },
    });
    const cfg = loadConfig('/tmp/config.json');
    expect(cfg.defaultTimeoutMs).toBe(1);
    expect(cfg.perMutantTimeoutMs).toBe(1);
    expect(cfg.stryker?.timeoutMs).toBe(1);
    expect(cfg.cosmicray?.timeoutMs).toBe(1);
    expect(cfg.rust?.timeoutMs).toBe(1);
  });

  it('rejects timeoutMs of exactly 0 across all engine sections', () => {
    setConfig({
      defaultTimeoutMs: 0,
      perMutantTimeoutMs: 0,
      stryker: { timeoutMs: 0 },
      cosmicray: { timeoutMs: 0 },
      rust: { timeoutMs: 0 },
    });
    const cfg = loadConfig('/tmp/config.json');
    expect(cfg.defaultTimeoutMs).toBeUndefined();
    expect(cfg.perMutantTimeoutMs).toBeUndefined();
    expect(cfg.stryker).toBeUndefined();
    expect(cfg.cosmicray).toBeUndefined();
    expect(cfg.rust).toBeUndefined();
  });

  // ── hasAny: a section with only empty mutator arrays contributes nothing ──

  it('treats a stryker section with only empty mutator arrays as absent', () => {
    setConfig({ stryker: { mutatorAllowlist: [], mutatorDenylist: [] } });
    expect(loadConfig('/tmp/config.json').stryker).toBeUndefined();
  });

  it('keeps a stryker section when a mutator array is non-empty', () => {
    setConfig({ stryker: { mutatorAllowlist: ['ArithmeticOperator'] } });
    expect(loadConfig('/tmp/config.json').stryker?.mutatorAllowlist).toEqual([
      'ArithmeticOperator',
    ]);
  });

  // ── Default config filename (line 132 StringLiteral) ──

  it('uses the default "chaos-mcp.config.json" filename when no path is given', () => {
    mockExistsSync.mockReturnValue(false);
    const { warnings } = validateConfig();
    expect(warnings[0]).toContain('chaos-mcp.config.json');
  });

  // ── hasAny: a section whose ONLY field is a single scalar must survive ──

  it('keeps a stryker section when its only field is a positive perMutantTimeoutMs', () => {
    setConfig({ stryker: { perMutantTimeoutMs: 5000 } });
    expect(loadConfig('/tmp/config.json').stryker?.perMutantTimeoutMs).toBe(5000);
  });

  it('keeps a stryker section when its only field is dryRun', () => {
    setConfig({ stryker: { dryRun: true } });
    expect(loadConfig('/tmp/config.json').stryker?.dryRun).toBe(true);
  });

  // ── strictly-positive / non-empty boundaries on single-field sections ──

  it('drops a stryker section whose only field is a non-positive perMutantTimeoutMs', () => {
    setConfig({ stryker: { perMutantTimeoutMs: 0 } });
    expect(loadConfig('/tmp/config.json').stryker).toBeUndefined();
  });

  it('drops a cosmicray section whose only field is an empty testRunner', () => {
    setConfig({ cosmicray: { testRunner: '' } });
    expect(loadConfig('/tmp/config.json').cosmicray).toBeUndefined();
  });

  it('drops the global testRunner when it is an empty string', () => {
    setConfig({ testRunner: '' });
    expect(loadConfig('/tmp/config.json').testRunner).toBeUndefined();
  });

  // ── Exact error message for a non-object config file (line 236 StringLiteral) ──

  it('throws with the "must contain a JSON object" message for an array config', () => {
    setConfig(['not', 'an', 'object']);
    expect(() => loadConfig('/tmp/config.json')).toThrow(/Config file must contain a JSON object/);
  });

  // ── validateConfig message detail ──

  it('includes the offending numeric value in the global concurrency warning', () => {
    setConfig({ concurrency: 128 });
    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('concurrency') && w.includes('128'))).toBe(true);
  });

  it('reports an array engine section as an array (not just a non-object)', () => {
    setConfig({ stryker: [1, 2, 3] });
    const { warnings } = validateConfig('/tmp/config.json');
    expect(
      warnings.some(
        (w) => w.includes('stryker') && w.includes('must be an object') && w.includes('array'),
      ),
    ).toBe(true);
  });

  it('lists the valid keys in an unknown-key warning for an engine section', () => {
    setConfig({ stryker: { timeoutMs: 1, bogusKey: true } });
    const { warnings } = validateConfig('/tmp/config.json');
    expect(
      warnings.some(
        (w) => w.includes('bogusKey') && w.includes('Valid keys:') && w.includes('timeoutMs'),
      ),
    ).toBe(true);
  });

  // ── Wrong-typed-but-coercible timeouts must be dropped, not accepted ──
  // The `typeof x === 'number' → true` mutants survive against numeric inputs
  // because the `> 0` guard still rejects them. A *string* '5' slips past `> 0`
  // (JS coerces it), so only this exercises the typeof check itself.
  it('drops a string-typed timeoutMs in every section (typeof check)', () => {
    setConfig({
      defaultTimeoutMs: '5',
      perMutantTimeoutMs: '5',
      stryker: { timeoutMs: '5', perMutantTimeoutMs: '5' },
      cosmicray: { timeoutMs: '5' },
      rust: { timeoutMs: '5' },
    });
    const cfg = loadConfig('/tmp/config.json');
    expect(cfg.defaultTimeoutMs).toBeUndefined();
    expect(cfg.perMutantTimeoutMs).toBeUndefined();
    expect(cfg.stryker).toBeUndefined();
    expect(cfg.cosmicray).toBeUndefined();
    expect(cfg.rust).toBeUndefined();
  });

  it('drops a string-typed defaultMaxFiles (typeof check)', () => {
    setConfig({ defaultMaxFiles: '5' });
    expect(loadConfig('/tmp/config.json').defaultMaxFiles).toBeUndefined();
  });

  // ── A float concurrency must be dropped (kills the `&&` → `||` mutant, which
  //    would let the typeof-number arm alone admit 2.5). ──
  it('drops a float concurrency in both the global and stryker sections', () => {
    setConfig({ concurrency: 2.5 });
    expect(loadConfig('/tmp/config.json').concurrency).toBeUndefined();
    setConfig({ stryker: { concurrency: 2.5 } });
    expect(loadConfig('/tmp/config.json').stryker).toBeUndefined();
  });

  // ── A null engine section must yield `undefined`, not a null-deref crash.
  //    Kills `raw === null → false` in each parser. ──
  it('treats a null engine section as absent without crashing', () => {
    setConfig({ stryker: null, cosmicray: null, rust: null });
    const cfg = loadConfig('/tmp/config.json');
    expect(cfg.stryker).toBeUndefined();
    expect(cfg.cosmicray).toBeUndefined();
    expect(cfg.rust).toBeUndefined();
  });

  // ── A top-level `null` config is rejected with the specific message.
  //    Kills `parsed === null → false` in readConfigRaw. ──
  it('throws "must contain a JSON object" for a literal null config', () => {
    setConfig(null);
    expect(() => loadConfig('/tmp/config.json')).toThrow(/Config file must contain a JSON object/);
  });

  // ── validateConfig: allowPrebuild non-boolean warning was wholly uncovered. ──
  it('warns when allowPrebuild is not a boolean (validateConfig)', () => {
    setConfig({ allowPrebuild: 'yes' });
    const { warnings } = validateConfig('/tmp/config.json');
    expect(
      warnings.some((w) => w.includes('allowPrebuild') && w.includes('must be a boolean')),
    ).toBe(true);
  });

  // ── validateConfig global concurrency lower-bound: 0 must warn (kills the
  //    `concurrency < 1 → false` mutant). ──
  it('warns about a global concurrency of 0 (below the lower bound)', () => {
    setConfig({ concurrency: 0 });
    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('concurrency') && w.includes('between 1 and 64'))).toBe(
      true,
    );
  });

  // ── validateEngineSection concurrency range boundaries (kills the `< 1`/`> 64`
  //    → `<= 1`/`>= 64` and `→ false` EqualityOperator/Conditional mutants). ──
  it('does not warn about an engine concurrency exactly at the bounds (1 and 64)', () => {
    setConfig({ stryker: { concurrency: 1 } });
    expect(
      validateConfig('/tmp/config.json').warnings.some((w) => w.includes('between 1 and 64')),
    ).toBe(false);
    setConfig({ stryker: { concurrency: 64 } });
    expect(
      validateConfig('/tmp/config.json').warnings.some((w) => w.includes('between 1 and 64')),
    ).toBe(false);
  });

  it('warns "between 1 and 64" for an engine concurrency just above the upper bound (65)', () => {
    // Only the upper bound is reachable here: concurrency 0 is caught earlier by
    // the `val <= 0` ("must be positive") guard, so the `val < 1` arm at line 450
    // is unreachable for positive input (an equivalent mutant). 65 exercises the
    // `val > 64` arm, killing its `> 64 → >= 64` / `→ false` mutants.
    setConfig({ stryker: { concurrency: 65 } });
    expect(
      validateConfig('/tmp/config.json').warnings.some((w) => w.includes('between 1 and 64')),
    ).toBe(true);
  });

  // ── A null engine section must not crash validateConfig either (kills the
  //    `raw === null → false` mutant in validateEngineSection). ──
  it('does not throw or warn for a null engine section in validateConfig', () => {
    setConfig({ stryker: null });
    let warnings: string[] = [];
    expect(() => {
      warnings = validateConfig('/tmp/config.json').warnings;
    }).not.toThrow();
    expect(warnings.some((w) => w.includes('stryker'))).toBe(false);
  });

  // ── A non-object, non-null top-level config (e.g. a bare number) is rejected
  //    with the specific message (kills `typeof parsed !== 'object' → false`). ──
  it('throws "must contain a JSON object" for a bare-number config', () => {
    setConfig(5);
    expect(() => loadConfig('/tmp/config.json')).toThrow(/Config file must contain a JSON object/);
  });

  // ── A stryker section whose ONLY field is a non-empty mutatorDenylist must be
  //    kept (kills `result.mutatorDenylist.length > 0 → false` at line 175;
  //    previously only the mutatorAllowlist branch was covered). ──
  it('keeps a stryker section whose only field is a non-empty mutatorDenylist', () => {
    setConfig({ stryker: { mutatorDenylist: ['StringLiteral'] } });
    expect(loadConfig('/tmp/config.json').stryker?.mutatorDenylist).toEqual(['StringLiteral']);
  });

  // ── validateConfig global type checks: a VALID value must produce NO warning.
  //    The `typeof X !== 'Y' → true` mutants would warn even for valid input. ──
  it('does not warn about a valid global testRunner / perMutantTimeoutMs / allowPrebuild', () => {
    setConfig({ testRunner: 'vitest', perMutantTimeoutMs: 5000, allowPrebuild: true });
    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('testRunner'))).toBe(false);
    expect(warnings.some((w) => w.includes('perMutantTimeoutMs'))).toBe(false);
    expect(warnings.some((w) => w.includes('allowPrebuild'))).toBe(false);
  });

  // ── validateEngineSection: each key's wrong-type warning must fire for THAT
  //    key (kills the `key === '…' → false` / `→ true` dispatch mutants). ──
  it('warns about a wrong-typed perMutantTimeoutMs in an engine section', () => {
    // `key === 'perMutantTimeoutMs' → false` would let a non-number slip past the
    // numeric block and be counted as a valid field.
    setConfig({ stryker: { perMutantTimeoutMs: 'nope' } });
    expect(
      validateConfig('/tmp/config.json').warnings.some(
        (w) => w.includes('perMutantTimeoutMs') && w.includes('must be a number'),
      ),
    ).toBe(true);
  });

  it('does not call a float timeoutMs a non-integer (concurrency-only check)', () => {
    // `key === 'concurrency' → true` at the integer check would mis-flag a
    // perfectly valid float timeoutMs as "must be an integer".
    setConfig({ stryker: { timeoutMs: 1.5 } });
    expect(
      validateConfig('/tmp/config.json').warnings.some((w) => w.includes('must be an integer')),
    ).toBe(false);
  });

  it('warns about a non-array mutatorDenylist in an engine section', () => {
    // `key === 'mutatorDenylist' → false` would skip the array check for denylist.
    setConfig({ stryker: { mutatorDenylist: 'StringLiteral' } });
    expect(
      validateConfig('/tmp/config.json').warnings.some(
        (w) => w.includes('mutatorDenylist') && w.includes('must be an array'),
      ),
    ).toBe(true);
  });

  it('does not warn about valid array / boolean / string fields in an engine section', () => {
    // Kills the `!Array.isArray(val) → true` (458), `typeof val !== 'boolean' → true`
    // (466), and `typeof val !== 'string' → true` (474) mutants, which would warn
    // even when the field is well-formed.
    setConfig({
      stryker: { mutatorAllowlist: ['ConditionalExpression'], dryRun: true, testRunner: 'vitest' },
    });
    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('must be an array'))).toBe(false);
    expect(warnings.some((w) => w.includes('must be a boolean'))).toBe(false);
    expect(warnings.some((w) => w.includes('must be a string'))).toBe(false);
  });
});

describe('back-compat: legacy go section', () => {
  beforeEach(() => {
    // Reset mocks for this test block
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it('treats a legacy "go" config section as an ignorable unknown key', () => {
    // Set up the mock to return a config with a go section
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ go: { timeoutMs: 1000 }, defaultTimeoutMs: 5000 }),
    );

    const { config, warnings } = validateConfig('/tmp/config.json');

    // After go is removed from KNOWN_KEYS, it should not be in config
    expect(config).not.toHaveProperty('go');
    // But the defaultTimeoutMs should still be there
    expect(config.defaultTimeoutMs).toBe(5000);
    // And there should be a warning about the unknown "go" key
    expect(warnings.some((w) => w.includes('"go"'))).toBe(true);
  });
});
