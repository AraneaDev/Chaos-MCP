import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from 'fs';
import { loadConfig } from '../utils/config-loader.js';

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

  it('loads testRunner from config file', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ testRunner: 'jest' }));

    const config = loadConfig('/tmp/config.json');
    expect(config.testRunner).toBe('jest');
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
});
