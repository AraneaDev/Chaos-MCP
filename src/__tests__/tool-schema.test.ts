import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITION } from '../tool-schema.js';

describe('TOOL_DEFINITION contract', () => {
  it('exposes the audit_code_resilience tool with an object input schema', () => {
    expect(TOOL_DEFINITION.name).toBe('audit_code_resilience');
    expect(TOOL_DEFINITION.inputSchema.type).toBe('object');
  });

  it('declares every documented parameter with the correct JSON-schema type', () => {
    const expectedTypes: Record<string, string> = {
      filePath: 'string',
      timeoutMs: 'number',
      lineScope: 'object',
      mutatorAllowlist: 'array',
      mutatorDenylist: 'array',
      concurrency: 'integer',
      dryRun: 'boolean',
      outputFormat: 'string',
      incremental: 'boolean',
      ignorePatterns: 'array',
      prebuildCommand: 'string',
      perMutantTimeoutMs: 'number',
      diffBase: 'string',
    };
    const props = TOOL_DEFINITION.inputSchema.properties as Record<string, { type: string }>;
    // Exactly these keys — no more, no fewer.
    expect(Object.keys(props).sort()).toEqual(Object.keys(expectedTypes).sort());
    for (const [key, type] of Object.entries(expectedTypes)) {
      expect(props[key]?.type).toBe(type);
    }
  });

  it('types every array parameter as an array of strings', () => {
    const props = TOOL_DEFINITION.inputSchema.properties as Record<
      string,
      { type: string; items?: { type: string } }
    >;
    for (const key of ['mutatorAllowlist', 'mutatorDenylist', 'ignorePatterns']) {
      expect(props[key]?.items?.type).toBe('string');
    }
  });

  it('bounds concurrency to the integer range 1..64', () => {
    const concurrency = (
      TOOL_DEFINITION.inputSchema.properties as Record<
        string,
        { type: string; minimum?: number; maximum?: number }
      >
    ).concurrency;
    expect(concurrency.type).toBe('integer');
    expect(concurrency.minimum).toBe(1);
    expect(concurrency.maximum).toBe(64);
  });

  it('restricts outputFormat to exactly the json and text values', () => {
    const outputFormat = (
      TOOL_DEFINITION.inputSchema.properties as Record<string, { enum?: string[] }>
    ).outputFormat;
    expect(outputFormat.enum).toEqual(['json', 'text']);
  });

  it('describes the nested lineScope object with numeric start and end', () => {
    const lineScope = (
      TOOL_DEFINITION.inputSchema.properties as Record<
        string,
        { type: string; properties?: Record<string, { type: string }> }
      >
    ).lineScope;
    expect(lineScope.type).toBe('object');
    expect(lineScope.properties?.start?.type).toBe('number');
    expect(lineScope.properties?.end?.type).toBe('number');
  });

  it('requires only filePath and forbids additional properties', () => {
    expect(TOOL_DEFINITION.inputSchema.required).toEqual(['filePath']);
    // The `additionalProperties: false` BooleanLiteral is security-relevant —
    // it rejects unknown args at the MCP boundary.
    expect(TOOL_DEFINITION.inputSchema.additionalProperties).toBe(false);
  });

  it('advertises the diffBase string parameter', () => {
    const props = TOOL_DEFINITION.inputSchema.properties as Record<string, { type: string }>;
    expect(props.diffBase).toBeDefined();
    expect(props.diffBase.type).toBe('string');
  });
});
