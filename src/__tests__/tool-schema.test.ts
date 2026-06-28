import { describe, it, expect } from 'vitest';
import {
  TOOL_DEFINITION,
  TRIAGE_TOOL_DEFINITION,
  ESTIMATE_TOOL_DEFINITION,
} from '../tool-schema.js';

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
      baseline: 'object',
      enrich: 'boolean',
      maxSurvivors: 'integer',
      severityFloor: 'string',
      runId: 'string',
      suppress: 'array',
      unsuppress: 'array',
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

  it('advertises the baseline object parameter', () => {
    const props = TOOL_DEFINITION.inputSchema.properties as Record<string, { type: string }>;
    expect(props.baseline).toBeDefined();
    expect(props.baseline.type).toBe('object');
  });
});

describe('TRIAGE_TOOL_DEFINITION contract', () => {
  it('is named triage_test_coverage with paths array and maxFiles integer', () => {
    expect(TRIAGE_TOOL_DEFINITION.name).toBe('triage_test_coverage');
    const props = TRIAGE_TOOL_DEFINITION.inputSchema.properties as Record<string, { type: string }>;
    expect(props.paths.type).toBe('array');
    expect(props.maxFiles.type).toBe('integer');
  });
});

interface SchemaProp {
  type?: string;
  minimum?: number;
  enum?: string[];
  description?: string;
}

interface ToolDefWithOutput {
  outputSchema: {
    type: string;
    properties: Record<string, unknown>;
  };
}

describe('TRIAGE_TOOL_DEFINITION phase-2 additions', () => {
  it('declares diffBase, survivorsPerFile, fileConcurrency', () => {
    const props = TRIAGE_TOOL_DEFINITION.inputSchema.properties as Record<
      string,
      { type?: string; minimum?: number; maximum?: number }
    >;
    expect(props.diffBase.type).toBe('string');
    expect(props.survivorsPerFile.type).toBe('integer');
    expect(props.survivorsPerFile.minimum).toBe(0);
    expect(props.fileConcurrency.type).toBe('integer');
    expect(props.fileConcurrency.minimum).toBe(1);
    expect(props.fileConcurrency.maximum).toBe(64);
  });

  it('no longer requires paths', () => {
    expect(TRIAGE_TOOL_DEFINITION.inputSchema.required).not.toContain('paths');
  });

  it('exposes an outputSchema with ranking and summary', () => {
    const out = (
      TRIAGE_TOOL_DEFINITION as { outputSchema?: { properties?: Record<string, unknown> } }
    ).outputSchema;
    expect(out?.properties?.ranking).toBeDefined();
    expect(out?.properties?.summary).toBeDefined();
  });
});

describe('TOOL_DEFINITION phase-1 additions', () => {
  it('declares maxSurvivors and severityFloor inputs', () => {
    const props = TOOL_DEFINITION.inputSchema.properties as Record<string, SchemaProp>;
    expect(props.maxSurvivors.type).toBe('integer');
    expect(props.maxSurvivors.minimum).toBe(1);
    expect(props.severityFloor.enum).toEqual(['high', 'medium', 'low']);
  });

  it('documents enrich as default-on', () => {
    const props = TOOL_DEFINITION.inputSchema.properties as Record<string, SchemaProp>;
    expect(props.enrich.description?.toLowerCase()).toContain('default');
    expect(props.enrich.description?.toLowerCase()).toContain('true');
    expect((props.enrich as { description: string }).description).toContain('Defaults to TRUE');
  });

  it('exposes an outputSchema with survivors and summary', () => {
    const out = (TOOL_DEFINITION as ToolDefWithOutput).outputSchema;
    expect(out.type).toBe('object');
    expect(out.properties.summary).toBeDefined();
    expect(out.properties.survivors).toBeDefined();
  });
});

describe('TOOL_DEFINITION phase-3 additions', () => {
  it('audit input schema exposes runId / suppress / unsuppress', () => {
    const props = TOOL_DEFINITION.inputSchema.properties as Record<string, unknown>;
    expect(props.runId).toBeDefined();
    expect(props.suppress).toBeDefined();
    expect(props.unsuppress).toBeDefined();
  });

  it('audit output schema exposes runId / suppressedCount', () => {
    const props = (TOOL_DEFINITION.outputSchema?.properties ?? {}) as Record<string, unknown>;
    expect(props.runId).toBeDefined();
    expect(props.suppressedCount).toBeDefined();
  });

  it('triage ranking items expose runId / suppressedCount', () => {
    const ranking = (TRIAGE_TOOL_DEFINITION.outputSchema?.properties?.ranking ?? {}) as {
      items?: { properties?: Record<string, unknown> };
    };
    expect(ranking.items?.properties?.runId).toBeDefined();
    expect(ranking.items?.properties?.suppressedCount).toBeDefined();
  });
});

describe('ESTIMATE_TOOL_DEFINITION contract', () => {
  it('exposes estimate_audit definition', () => {
    expect(ESTIMATE_TOOL_DEFINITION.name).toBe('estimate_audit');
    const props = ESTIMATE_TOOL_DEFINITION.inputSchema.properties as Record<string, unknown>;
    expect(props.filePath).toBeDefined();
    expect(props.withTiming).toBeDefined();
    expect(ESTIMATE_TOOL_DEFINITION.inputSchema.required).toContain('filePath');
    const out = (ESTIMATE_TOOL_DEFINITION.outputSchema?.properties ?? {}) as Record<
      string,
      unknown
    >;
    expect(out.mutants).toBeDefined();
    expect(out.fidelity).toBeDefined();
  });
});
