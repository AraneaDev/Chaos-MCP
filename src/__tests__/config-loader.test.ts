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

  it('loads mutmut engine-specific config', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mutmut: { timeoutMs: 120000, testRunner: 'pytest' },
      }),
    );

    const config = loadConfig('/tmp/config.json');
    expect(config.mutmut).toEqual({ timeoutMs: 120000, testRunner: 'pytest' });
  });

  it('loads go engine-specific config', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ go: { timeoutMs: 180000 } }));

    const config = loadConfig('/tmp/config.json');
    expect(config.go).toEqual({ timeoutMs: 180000 });
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
    // No go/mutmut sections should be present
    expect(config.go).toBeUndefined();
    expect(config.mutmut).toBeUndefined();
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

  it('loads mutmut testRunner from config file', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ mutmut: { testRunner: 'unittest' } }));

    const config = loadConfig('/tmp/config.json');
    expect(config.mutmut?.testRunner).toBe('unittest');
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

  it('warns about unknown keys in go engine section', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ go: { timeoutMs: 60000, bogus: true } }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('bogus') && w.includes('go'))).toBe(true);
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

  it('warns about unknown keys in mutmut engine section', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ mutmut: { timeoutMs: 60000, bogusMutmutKey: true } }),
    );

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('bogusMutmutKey') && w.includes('mutmut'))).toBe(true);
  });

  it('warns about wrong type for go timeoutMs', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ go: { timeoutMs: 'not-a-number' } }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('go.timeoutMs') && w.includes('must be a number'))).toBe(
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

  it('warns about non-object mutmut section', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ mutmut: 'not-an-object' }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('mutmut') && w.includes('must be an object'))).toBe(
      true,
    );
  });

  it('warns about go timeoutMs <= 0 in validateEngineSection', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ go: { timeoutMs: -1 } }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('go.timeoutMs') && w.includes('must be positive'))).toBe(
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

  it('warns about mutmut timeoutMs <= 0', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ mutmut: { timeoutMs: 0 } }));

    const { warnings } = validateConfig('/tmp/config.json');
    expect(
      warnings.some((w) => w.includes('mutmut.timeoutMs') && w.includes('must be positive')),
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
      stryker: { timeoutMs: 1 },
      mutmut: { timeoutMs: 1 },
      go: { timeoutMs: 1 },
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

  it('accepts every known mutmut key without an unknown-key warning', () => {
    setConfig({ mutmut: { timeoutMs: 1, testRunner: 'pytest' } });
    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('Unknown key') && w.includes('mutmut'))).toBe(false);
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
      mutmut: { timeoutMs: 1 },
      go: { timeoutMs: 1 },
      rust: { timeoutMs: 1 },
    });
    const cfg = loadConfig('/tmp/config.json');
    expect(cfg.defaultTimeoutMs).toBe(1);
    expect(cfg.perMutantTimeoutMs).toBe(1);
    expect(cfg.stryker?.timeoutMs).toBe(1);
    expect(cfg.mutmut?.timeoutMs).toBe(1);
    expect(cfg.go?.timeoutMs).toBe(1);
    expect(cfg.rust?.timeoutMs).toBe(1);
  });

  it('rejects timeoutMs of exactly 0 across all engine sections', () => {
    setConfig({
      defaultTimeoutMs: 0,
      perMutantTimeoutMs: 0,
      stryker: { timeoutMs: 0 },
      mutmut: { timeoutMs: 0 },
      go: { timeoutMs: 0 },
      rust: { timeoutMs: 0 },
    });
    const cfg = loadConfig('/tmp/config.json');
    expect(cfg.defaultTimeoutMs).toBeUndefined();
    expect(cfg.perMutantTimeoutMs).toBeUndefined();
    expect(cfg.stryker).toBeUndefined();
    expect(cfg.mutmut).toBeUndefined();
    expect(cfg.go).toBeUndefined();
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

  it('drops a mutmut section whose only field is an empty testRunner', () => {
    setConfig({ mutmut: { testRunner: '' } });
    expect(loadConfig('/tmp/config.json').mutmut).toBeUndefined();
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
});
