import { describe, it, expect } from 'vitest';
import {
  TOOL_DEFINITION,
  TRIAGE_TOOL_DEFINITION,
  ESTIMATE_TOOL_DEFINITION,
} from '../core/tool-schema.js';
import { supportedSourceExtensions } from '../utils/project-detector.js';
import { ENGINE_REGISTRY } from '../engines/registry.js';
import type { ResultPayload } from '../core/format.js';

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
      minScore: 'number',
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

  it('caps every millisecond field at the 32-bit timer maximum', () => {
    // Without a `maximum`, a schema-driven client happily sends 3e9, which Node
    // clamps to a 1ms timer — the run dies immediately instead of lasting longer.
    const MAX_TIMEOUT = 2_147_483_647;
    const audit = TOOL_DEFINITION.inputSchema.properties as Record<
      string,
      { exclusiveMinimum?: number; maximum?: number }
    >;
    const triage = TRIAGE_TOOL_DEFINITION.inputSchema.properties as Record<
      string,
      { exclusiveMinimum?: number; maximum?: number }
    >;
    for (const field of [
      audit.timeoutMs,
      audit.perMutantTimeoutMs,
      triage.timeoutMs,
      triage.totalTimeoutMs,
    ]) {
      expect(field.exclusiveMinimum).toBe(0);
      expect(field.maximum).toBe(MAX_TIMEOUT);
    }
  });

  it('restricts outputFormat to exactly the json and text values', () => {
    const outputFormat = (
      TOOL_DEFINITION.inputSchema.properties as Record<string, { enum?: string[] }>
    ).outputFormat;
    expect(outputFormat.enum).toEqual(['json', 'text']);
  });

  it('describes the nested lineScope object with integer start and end >= 1 (audit L6)', () => {
    const lineScope = (
      TOOL_DEFINITION.inputSchema.properties as Record<
        string,
        {
          type: string;
          required?: string[];
          properties?: Record<string, { type: string; minimum?: number }>;
        }
      >
    ).lineScope;
    expect(lineScope.type).toBe('object');
    // Tightened from bare `number` to `integer` with a `minimum` so a
    // schema-driven client can predict the handler's int>=1 rejection (L6).
    expect(lineScope.properties?.start?.type).toBe('integer');
    expect(lineScope.properties?.start?.minimum).toBe(1);
    expect(lineScope.properties?.end?.type).toBe('integer');
    expect(lineScope.properties?.end?.minimum).toBe(1);
    expect(lineScope.required).toEqual(['start', 'end']);
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

  it('fully types partial-audit completion metadata', () => {
    const props = TOOL_DEFINITION.outputSchema?.properties as Record<
      string,
      { type?: string; enum?: readonly string[] }
    >;
    expect(props.complete).toEqual({ type: 'boolean' });
    expect(props.batchesCompleted).toEqual({ type: 'integer' });
    expect(props.batchesPlanned).toEqual({ type: 'integer' });
    expect(props.stoppedReason).toEqual({
      type: 'string',
      enum: ['time_budget_exhausted'],
    });
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

describe('TOOL_DEFINITION phase-4 additions', () => {
  it('audit input schema exposes minScore with numeric type and 0–100 bounds', () => {
    const props = TOOL_DEFINITION.inputSchema.properties as Record<
      string,
      { type?: string; minimum?: number; maximum?: number }
    >;
    expect(props.minScore).toBeDefined();
    expect(props.minScore.type).toBe('number');
    expect(props.minScore.minimum).toBe(0);
    expect(props.minScore.maximum).toBe(100);
  });

  it('audit output schema exposes gate with minScore and passed', () => {
    const props = (TOOL_DEFINITION.outputSchema?.properties ?? {}) as Record<
      string,
      { type?: string; properties?: Record<string, { type?: string }> }
    >;
    expect(props.gate).toBeDefined();
    expect(props.gate.type).toBe('object');
    expect(props.gate.properties?.minScore?.type).toBe('number');
    expect(props.gate.properties?.passed?.type).toBe('boolean');
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

  it('forbids additional properties in inputSchema', () => {
    expect(
      (ESTIMATE_TOOL_DEFINITION.inputSchema as Record<string, unknown>).additionalProperties,
    ).toBe(false);
  });

  it('does not require withTiming in inputSchema', () => {
    expect(ESTIMATE_TOOL_DEFINITION.inputSchema.required).not.toContain('withTiming');
  });

  it('requires fidelity and mutants in outputSchema', () => {
    const outputRequired = (ESTIMATE_TOOL_DEFINITION.outputSchema as Record<string, unknown>)
      .required as string[];
    expect(outputRequired).toContain('fidelity');
    expect(outputRequired).toContain('mutants');
    expect(outputRequired).not.toContain('baselineMs');
    expect(outputRequired).not.toContain('estimatedMs');
    expect(outputRequired).not.toContain('concurrency');
  });

  it('fully types timing-range and budget-admission output fields', () => {
    const props = ESTIMATE_TOOL_DEFINITION.outputSchema?.properties as Record<
      string,
      { type?: string; enum?: readonly string[] }
    >;
    expect(props.optimisticMs).toEqual({ type: 'integer' });
    expect(props.upperBoundMs).toEqual({ type: 'integer' });
    expect(props.timingConfidence).toEqual({ type: 'string', enum: ['low', 'medium'] });
    expect(props.budgetMs).toEqual({ type: 'integer' });
    expect(props.fitsBudget).toEqual({ type: 'boolean' });
    expect(props.recommendation).toEqual({ type: 'string' });
  });
});

/**
 * Structural invariants for every schema node in the file.
 *
 * These schemas ARE the MCP contract: clients validate arguments against the
 * input schema and read `description` to decide what to send. A blanked
 * description or an emptied nested object still parses as valid JSON Schema and
 * still lets the server start — it just stops constraining anything and stops
 * telling the caller what the field means. Per-field assertions cannot scale to
 * a structure this size, so these walk it instead.
 */
describe('schema structural invariants', () => {
  type Node = Record<string, unknown>;

  const SCHEMA_ROOTS: [string, Node][] = [
    ['audit.inputSchema', TOOL_DEFINITION.inputSchema as unknown as Node],
    ['audit.outputSchema', TOOL_DEFINITION.outputSchema as unknown as Node],
    ['triage.inputSchema', TRIAGE_TOOL_DEFINITION.inputSchema as unknown as Node],
    ['triage.outputSchema', TRIAGE_TOOL_DEFINITION.outputSchema as unknown as Node],
    ['estimate.inputSchema', ESTIMATE_TOOL_DEFINITION.inputSchema as unknown as Node],
    ['estimate.outputSchema', ESTIMATE_TOOL_DEFINITION.outputSchema as unknown as Node],
  ];

  const JSON_SCHEMA_TYPES = new Set([
    'object',
    'array',
    'string',
    'number',
    'integer',
    'boolean',
    'null',
  ]);

  /** Every schema node reachable from a root, as [path, node] pairs. */
  function walk(node: unknown, path: string, out: [string, Node][] = []): [string, Node][] {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return out;
    const n = node as Node;
    out.push([path, n]);
    const properties = n.properties;
    if (properties !== null && typeof properties === 'object') {
      for (const [key, child] of Object.entries(properties as Node)) {
        walk(child, `${path}.${key}`, out);
      }
    }
    if (n.items !== undefined) walk(n.items, `${path}[]`, out);
    return out;
  }

  const ALL_NODES = SCHEMA_ROOTS.flatMap(([name, root]) => walk(root, name));

  it('reaches a non-trivial number of schema nodes', () => {
    // Guards the walker itself: if it stopped descending, every assertion below
    // would pass vacuously.
    expect(ALL_NODES.length).toBeGreaterThan(80);
  });

  it('gives every node a recognised JSON-schema type', () => {
    // An emptied node (`{}`) loses its type and constrains nothing.
    const untyped = ALL_NODES.filter(
      ([, n]) => typeof n.type !== 'string' || !JSON_SCHEMA_TYPES.has(n.type),
    ).map(([path]) => path);
    expect(untyped).toEqual([]);
  });

  it('gives every object node a non-empty properties map', () => {
    const empty = ALL_NODES.filter(
      ([, n]) =>
        n.type === 'object' &&
        n.properties !== undefined &&
        Object.keys(n.properties as Node).length === 0,
    ).map(([path]) => path);
    expect(empty).toEqual([]);
  });

  it('gives every array node an items schema', () => {
    const missing = ALL_NODES.filter(
      ([, n]) => n.type === 'array' && (n.items === null || typeof n.items !== 'object'),
    ).map(([path]) => path);
    expect(missing).toEqual([]);
  });

  it('never carries a blank description', () => {
    const blank = ALL_NODES.filter(
      ([, n]) => n.description !== undefined && String(n.description).trim().length === 0,
    ).map(([path]) => path);
    expect(blank).toEqual([]);
  });

  it('describes every INPUT parameter a caller can pass', () => {
    // Output fields are self-describing by name; input fields are what the
    // caller has to choose values for, so each one must say what it means.
    const undescribed = SCHEMA_ROOTS.filter(([name]) => name.endsWith('inputSchema'))
      .flatMap(([name, root]) => walk(root, name))
      .filter(
        ([path, n]) =>
          // Top-level parameters only — not the `items` schema of an array
          // parameter, which the parameter's own description already covers.
          path.split('.').length === 3 && !path.endsWith('[]') && typeof n.description !== 'string',
      )
      .map(([path]) => path);
    expect(undescribed).toEqual([]);
  });

  it('lists only non-empty strings in every required array', () => {
    const bad = ALL_NODES.filter(
      ([, n]) =>
        Array.isArray(n.required) &&
        (n.required as unknown[]).some((k) => typeof k !== 'string' || k.length === 0),
    ).map(([path]) => path);
    expect(bad).toEqual([]);
  });

  it('lists only non-empty strings in every enum', () => {
    const bad = ALL_NODES.filter(
      ([, n]) =>
        Array.isArray(n.enum) &&
        ((n.enum as unknown[]).length === 0 ||
          (n.enum as unknown[]).some((v) => typeof v !== 'string' || v.length === 0)),
    ).map(([path]) => path);
    expect(bad).toEqual([]);
  });

  it('closes every input schema to unknown properties', () => {
    // `additionalProperties: false` is what turns a typo in an argument name
    // into an error instead of a silently ignored option.
    const inputRoots = SCHEMA_ROOTS.filter(([n]) => n.endsWith('inputSchema'));
    expect(inputRoots.map(([name, root]) => [name, root.additionalProperties, root.type])).toEqual(
      inputRoots.map(([name]) => [name, false, 'object']),
    );
  });
});

/**
 * `structuredContent` is assembled BY HAND in `format.ts` (`ResultPayload` +
 * `buildResultPayload`) and described BY HAND in this file's `outputSchema`.
 * Nothing links the two, and they have now drifted twice: the partial-audit
 * fields (`complete`/`batchesCompleted`/`batchesPlanned`/`stoppedReason`) and
 * `fidelityNote`, the PHPUnit phantom-survivor advisory, which was produced for
 * releases without ever being declared — so an MCP client generating types or
 * binding fields from the schema silently never surfaced it.
 *
 * These cases are that link. `PAYLOAD_FIELDS` below is typed
 * `Record<keyof ResultPayload, true>`, so adding a field to the interface
 * without listing it here is a COMPILE error under `tsc -p tsconfig.tests.json`
 * — and every listed field is then required to exist in the schema. The reverse
 * direction catches a schema field that nothing produces.
 */
describe('audit outputSchema ↔ ResultPayload parity', () => {
  const PAYLOAD_FIELDS: Record<keyof ResultPayload, true> = {
    target: true,
    mutationScore: true,
    summary: true,
    survivors: true,
    noCoverage: true,
    suggestedTestFile: true,
    ignoredOptions: true,
    survivorsTruncated: true,
    noCoverageTruncated: true,
    survivorsFiltered: true,
    noCoverageFiltered: true,
    scopeNote: true,
    fidelityNote: true,
    enrichNote: true,
    note: true,
    runId: true,
    suppressedCount: true,
    driftedSuppressions: true,
    unverifiedSuppressions: true,
    gate: true,
    incompetent: true,
    complete: true,
    batchesCompleted: true,
    batchesPlanned: true,
    stoppedReason: true,
  };

  /**
   * Schema properties with no `ResultPayload` counterpart BY DESIGN: a verify
   * run returns a different shape (built in `audit/audit-output.ts`, rendered by
   * `verify.ts`), which the schema's `oneOf` discriminates from the audit
   * report. Everything outside this list must have a producer.
   */
  const VERIFY_ONLY_FIELDS = [
    'mode',
    'baselineTotal',
    'killedCount',
    'nowKilled',
    'stillSurviving',
    'newSurvivors',
  ];

  const SCHEMA_PROPS = (TOOL_DEFINITION.outputSchema?.properties ?? {}) as Record<string, unknown>;

  it('declares every ResultPayload field in the outputSchema', () => {
    const undeclared = Object.keys(PAYLOAD_FIELDS).filter((field) => !(field in SCHEMA_PROPS));
    expect(undeclared).toEqual([]);
  });

  it('declares no outputSchema field that nothing produces', () => {
    const orphaned = Object.keys(SCHEMA_PROPS).filter(
      (field) => !(field in PAYLOAD_FIELDS) && !VERIFY_ONLY_FIELDS.includes(field),
    );
    expect(orphaned).toEqual([]);
  });

  it('types every optional advisory note as a string', () => {
    // The three note fields are the ones that drift: they are conditionally
    // assigned (`if (result.x) payload.x = result.x`), so no fixture that omits
    // them notices a missing or mistyped declaration.
    for (const note of ['scopeNote', 'fidelityNote', 'enrichNote', 'note']) {
      expect(SCHEMA_PROPS[note]).toEqual({ type: 'string' });
    }
  });

  it('requires only fields the payload always populates', () => {
    // `buildResultPayload` unconditionally sets these; everything else is
    // conditional, so requiring it would reject a legitimate response.
    const oneOf =
      (TOOL_DEFINITION.outputSchema as { oneOf?: { required: string[] }[] }).oneOf ?? [];
    expect(oneOf[0].required).toEqual([
      'target',
      'mutationScore',
      'summary',
      'survivors',
      'noCoverage',
      'note',
    ]);
    for (const field of oneOf[0].required) {
      expect(PAYLOAD_FIELDS[field as keyof ResultPayload]).toBe(true);
    }
  });
});

describe('nested argument schemas', () => {
  const props = TOOL_DEFINITION.inputSchema.properties as Record<string, Record<string, unknown>>;

  it('shapes the baseline argument as two arrays of line-group objects', () => {
    const baseline = props.baseline;
    expect(baseline.type).toBe('object');
    const inner = baseline.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(inner).sort()).toEqual(['noCoverage', 'survivors']);
    for (const key of ['survivors', 'noCoverage']) {
      expect(inner[key].type).toBe('array');
      const items = inner[key].items as Record<string, unknown>;
      expect(items.type).toBe('object');
      expect(Object.keys(items.properties as object).sort()).toEqual(['line', 'mutators']);
      expect(items.required).toEqual(['line', 'mutators']);
    }
  });

  it('shapes suppress entries as { line, mutator, reason? } with line and mutator required', () => {
    const items = props.suppress.items as Record<string, unknown>;
    const inner = items.properties as Record<string, Record<string, unknown>>;
    expect(items.type).toBe('object');
    expect(Object.keys(inner).sort()).toEqual(['line', 'mutator', 'reason']);
    expect(inner.line.type).toBe('integer');
    expect(inner.line.minimum).toBe(1);
    expect(inner.mutator.type).toBe('string');
    expect(inner.reason.type).toBe('string');
    expect(items.required).toEqual(['line', 'mutator']);
  });

  it('shapes unsuppress entries WITHOUT a reason field', () => {
    // The asymmetry is deliberate: a reason is recorded when suppressing and
    // meaningless when undoing it.
    const items = props.unsuppress.items as Record<string, unknown>;
    const inner = items.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(inner).sort()).toEqual(['line', 'mutator']);
    expect(inner.line.type).toBe('integer');
    expect(inner.line.minimum).toBe(1);
    expect(inner.mutator.type).toBe('string');
    expect(items.required).toEqual(['line', 'mutator']);
  });

  it('shapes lineScope as an inclusive 1-based start/end pair, both required', () => {
    const lineScope = props.lineScope;
    const inner = lineScope.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(inner).sort()).toEqual(['end', 'start']);
    expect(inner.start.minimum).toBe(1);
    expect(inner.end.minimum).toBe(1);
    expect(lineScope.required).toEqual(['start', 'end']);
  });

  it('requires exactly filePath on the audit tool, and nothing on triage', () => {
    // `required: []` on triage is meaningful, not an oversight: a triage call
    // may supply paths OR diffBase, so neither can be required in the schema.
    expect(TOOL_DEFINITION.inputSchema.required).toEqual(['filePath']);
    expect(TRIAGE_TOOL_DEFINITION.inputSchema.required).toEqual([]);
    expect(ESTIMATE_TOOL_DEFINITION.inputSchema.required).toEqual(['filePath']);
  });
});

describe('output schema contracts', () => {
  /** The fields a client is guaranteed to receive, per response shape. */
  it('requires the full audit summary triple', () => {
    const summary = (
      TOOL_DEFINITION.outputSchema.properties as Record<string, Record<string, unknown>>
    ).summary;
    expect(summary.required).toEqual(['total', 'killed', 'survived']);
  });

  it('offers exactly two audit response shapes, each with its own required set', () => {
    // `oneOf` is what lets a client tell a standard report from a verify delta.
    // Emptied, the schema accepts anything and the distinction disappears.
    const oneOf = (TOOL_DEFINITION.outputSchema as unknown as { oneOf: { required: string[] }[] })
      .oneOf;
    expect(oneOf).toHaveLength(2);
    expect(oneOf[0].required).toEqual([
      'target',
      'mutationScore',
      'summary',
      'survivors',
      'noCoverage',
      'note',
    ]);
    expect(oneOf[1].required).toEqual([
      'target',
      'mode',
      'baselineTotal',
      'killedCount',
      'nowKilled',
      'stillSurviving',
      'newSurvivors',
      'note',
    ]);
  });

  it('requires the four triage summary counters', () => {
    const summary = (
      TRIAGE_TOOL_DEFINITION.outputSchema.properties as Record<string, Record<string, unknown>>
    ).summary;
    expect(summary.required).toEqual([
      'filesDiscovered',
      'filesAudited',
      'filesSkipped',
      'filesErrored',
    ]);
  });

  it('requires the scoring fields on every triage ranking row', () => {
    const ranking = (
      TRIAGE_TOOL_DEFINITION.outputSchema.properties as Record<string, Record<string, unknown>>
    ).ranking;
    const row = ranking.items as Record<string, unknown>;
    expect(row.required).toEqual([
      'file',
      'mutationScore',
      'total',
      'killed',
      'survived',
      'noCoverage',
    ]);
  });

  it('requires the top-level triage response fields', () => {
    expect(TRIAGE_TOOL_DEFINITION.outputSchema.required).toEqual([
      'mode',
      'summary',
      'ranking',
      'errors',
      'note',
    ]);
  });
});

describe('parameter documentation facts', () => {
  const inputProps = (def: { inputSchema: { properties: unknown } }) =>
    def.inputSchema.properties as Record<string, { description?: string }>;

  const AUDIT = inputProps(TOOL_DEFINITION);
  const TRIAGE = inputProps(TRIAGE_TOOL_DEFINITION);
  const ESTIMATE = inputProps(ESTIMATE_TOOL_DEFINITION);

  it('keeps the worked example on every parameter that documents one', () => {
    // The descriptions are what an LLM reads to choose argument VALUES, and the
    // concrete example is the part it copies. These six are self-evident from
    // their type (a boolean, a plain string array, a two-value enum) and carry
    // no example today; every OTHER parameter must keep the one it has.
    const KNOWN_WITHOUT_EXAMPLE = new Set([
      'audit.mutatorAllowlist',
      'audit.unsuppress',
      'audit.enrich',
      'triage.timeoutMs',
      'triage.mutatorDenylist',
      'triage.outputFormat',
    ]);
    const missing = [
      ...Object.entries(AUDIT).map(([k, v]) => [`audit.${k}`, v] as const),
      ...Object.entries(TRIAGE).map(([k, v]) => [`triage.${k}`, v] as const),
    ]
      .filter(([, v]) => !(v.description ?? '').includes('Example:'))
      .map(([k]) => k)
      .filter((k) => !KNOWN_WITHOUT_EXAMPLE.has(k));
    expect(missing).toEqual([]);
  });

  it('states the documented default or range for each bounded parameter', () => {
    // These numbers are the reason the parameter is optional at all; without
    // them a caller cannot tell what happens when they leave it out.
    expect(AUDIT.timeoutMs.description).toContain('Default: 300000');
    expect(AUDIT.concurrency.description).toContain('integer between 1 and 64');
    expect(AUDIT.maxSurvivors.description).toContain(
      'Precedence: this arg > config.defaultMaxSurvivors > 10',
    );
    expect(AUDIT.perMutantTimeoutMs.description).toContain('Distinct from timeoutMs');
    expect(TRIAGE.maxFiles.description).toContain('config.defaultMaxFiles > 25');
    expect(TRIAGE.totalTimeoutMs.description).toContain('Default: 900000');
    expect(TRIAGE.fileConcurrency.description).toContain('Default min(4, cpus-1)');
    expect(TRIAGE.survivorsPerFile.description).toContain('0 (default)');
  });

  it('warns, in the parameter itself, where an option is ignored or unsupported', () => {
    // A caller who passes one of these gets no error — the only signal that it
    // did nothing is this text.
    expect(AUDIT.mutatorAllowlist.description).toContain('NOT SUPPORTED in StrykerJS v9');
    expect(AUDIT.mutatorAllowlist.description).toContain('Use mutatorDenylist');
    expect(AUDIT.lineScope.description).toContain('ignored for Python, Rust, and PHP targets');
    expect(AUDIT.prebuildCommand.description).toContain('DISABLED BY DEFAULT');
    expect(AUDIT.severityFloor.description).toContain('requires enrichment');
  });

  it('states each mutual-exclusion rule on the arguments it applies to', () => {
    // Passing two scoping arguments is a validation error; the schema is where
    // a caller finds out before making the call.
    expect(AUDIT.baseline.description).toContain('Mutually exclusive with diffBase and lineScope');
    expect(AUDIT.lineScope.description).toContain('Only supported by StrykerJS');
    expect(AUDIT.runId.description).toContain('Mutually exclusive with baseline, diffBase');
    expect(AUDIT.diffBase.description).toContain('Mutually exclusive with lineScope');
  });

  it('documents what the estimate tool trades away for its speed', () => {
    expect(ESTIMATE.withTiming.description).toContain('run the test suite once');
    expect(ESTIMATE.filePath.description).toContain('Example:');
    expect(ESTIMATE_TOOL_DEFINITION.description).toContain('WITHOUT running the full mutation');
  });

  it('describes each tool by what it does and which engines back it', () => {
    expect(TOOL_DEFINITION.description).toContain('sandbox-isolated mutation testing');
    expect(TOOL_DEFINITION.description).toContain('Surviving mutants indicate test coverage holes');
    expect(TOOL_DEFINITION.description).toContain('StrykerJS');
    expect(TOOL_DEFINITION.description).toContain('cosmic-ray');
    expect(TOOL_DEFINITION.description).toContain('cargo-mutants');
    expect(TOOL_DEFINITION.description).toContain('Infection');
    expect(TRIAGE_TOOL_DEFINITION.description).toContain('weakest-first');
  });

  it('renders the engine-support sentence from the registry, byte-identically', () => {
    // Finding 38: this sentence was a hardcoded literal that a new language
    // would silently contradict. It is now rendered from ENGINE_REGISTRY's
    // label + displayName pairs — and an LLM client reads it verbatim, so the
    // exact punctuation (Oxford comma, `and` before the last pair, trailing
    // full stop) is the contract.
    expect(TOOL_DEFINITION.description).toContain(
      'Supports TypeScript/JavaScript (StrykerJS), Python (cosmic-ray), Rust (cargo-mutants), and PHP (Infection).',
    );
    // …and it really is derived: every registry pair appears, in registry order.
    const rendered = TOOL_DEFINITION.description;
    let cursor = -1;
    for (const entry of Object.values(ENGINE_REGISTRY)) {
      const pair = `${entry.label} (${entry.displayName})`;
      const at = rendered.indexOf(pair);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('renders both line-scope warnings from supportsLineScope, byte-identically', () => {
    // Finding 4: the two "no line scoping here" language lists were hardcoded,
    // so flipping `supportsLineScope` for a language left the schema telling the
    // model the opposite of the truth. They are now derived from the registry.
    // The two sites use DIFFERENT separators on purpose and an LLM client reads
    // both verbatim, so each exact rendering is the contract.
    expect(AUDIT.lineScope.description).toBe(
      'Constrain mutations to a 1-based line range (inclusive). Only supported by StrykerJS; ' +
        'ignored for Python, Rust, and PHP targets. ' +
        'Useful for surgically auditing a specific function or block. ' +
        'Example: { "start": 10, "end": 45 }',
    );
    expect(AUDIT.diffBase.description).toContain(
      'Line-level scoping is StrykerJS-only; Python/Rust/PHP targets run whole-file with a note.',
    );
  });

  it('names exactly the engines that lack line scoping, in registry order', () => {
    // …and it really is derived: the list must track `supportsLineScope` in both
    // directions, so a language that gains line scoping drops out of both
    // warnings and one that loses it is added.
    const expected = Object.values(ENGINE_REGISTRY)
      .filter((entry) => !entry.supportsLineScope)
      .map((entry) => entry.label);
    expect(expected.length).toBeGreaterThan(0);

    expect(AUDIT.diffBase.description).toContain(`${expected.join('/')} targets run whole-file`);

    const lineScopeDesc = AUDIT.lineScope.description ?? '';
    for (const entry of Object.values(ENGINE_REGISTRY)) {
      expect(lineScopeDesc.includes(entry.label)).toBe(!entry.supportsLineScope);
    }
  });
});

// ─── Extension prose derived from the detection registry (audit F15) ────────
//
// The extension lists an LLM client reads to decide whether a file is auditable
// used to be hardcoded here, so adding a language left the schema telling the
// model the new extension was unsupported. They are now rendered from
// `project-detector`'s per-language registry — these tests pin BOTH that the
// rendering is byte-identical to the hand-written prose it replaced AND that it
// actually tracks the registry.
describe('supported-extension prose', () => {
  const AUDIT = TOOL_DEFINITION.inputSchema.properties as Record<string, { description: string }>;

  it('renders the audit filePath list byte-identically to the hand-written prose', () => {
    expect(AUDIT.filePath.description).toBe(
      'Workspace-relative path to the file to audit. ' +
        'Must end in .ts, .js, .tsx, .jsx, .mjs, .cjs, .mts, .cts, .py, .rs, or .php. ' +
        'Example: "src/utils/math.ts"',
    );
  });

  it('keeps the Oxford comma and the "or" before the final extension', () => {
    // An LLM reads this to decide whether to call the tool at all; a mangled
    // list ("..., .rs, .php" or ".rs or, .php") is a real regression.
    expect(AUDIT.filePath.description).toContain(', .rs, or .php.');
  });

  it('renders the triage directory-expansion list byte-identically', () => {
    expect(TRIAGE_TOOL_DEFINITION.description).toContain(
      'Directories are recursively expanded to supported source files (.ts/.js/.py/.rs/.php), skipping ' +
        'test files.',
    );
  });

  it('advertises every extension the detection registry claims to support', () => {
    for (const ext of supportedSourceExtensions()) {
      expect(AUDIT.filePath.description).toContain(ext);
    }
  });

  it('advertises no extension the detection registry does not support', () => {
    // Guards the other direction: prose must not promise support for a language
    // that was removed from the registry (as Go once was).
    const advertised = AUDIT.filePath.description.match(/\.[a-z]+/g) ?? [];
    const known = new Set([...supportedSourceExtensions(), '.']);
    for (const token of advertised) {
      // '.' terminates the sentence; 'src/utils/math.ts' is the example path.
      expect(known.has(token) || token === '.').toBe(true);
    }
  });
});
