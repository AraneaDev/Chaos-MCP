// src/__tests__/enrich-handler.test.ts
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { validateToolArgs, buildEnrichContext } from '../handler.js';
import { TOOL_DEFINITION } from '../tool-schema.js';

describe('enrich schema + validation', () => {
  it('declares enrich as a boolean in the tool schema', () => {
    expect(TOOL_DEFINITION.inputSchema.properties).toHaveProperty('enrich');
    expect(
      (TOOL_DEFINITION.inputSchema.properties as Record<string, { type: string }>).enrich.type,
    ).toBe('boolean');
  });

  it('accepts enrich: true and enrich absent', () => {
    expect(validateToolArgs({ enrich: true })).toBeNull();
    expect(validateToolArgs({})).toBeNull();
  });

  it('rejects a non-boolean enrich', () => {
    const err = validateToolArgs({ enrich: 'yes' });
    expect(err?.isError).toBe(true);
  });
});

describe('buildEnrichContext', () => {
  it('returns undefined when enrich is not true', () => {
    expect(buildEnrichContext({}, '/nope', 'typescript')).toBeUndefined();
    expect(buildEnrichContext({ enrich: false }, '/nope', 'typescript')).toBeUndefined();
  });

  it('reads source lines when enrich is true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'enrich-'));
    const file = join(dir, 'm.ts');
    writeFileSync(file, 'line1\nline2\nline3\n');
    const ctx = buildEnrichContext({ enrich: true }, file, 'typescript');
    expect(ctx?.projectType).toBe('typescript');
    expect(ctx?.sourceLines?.slice(0, 3)).toEqual(['line1', 'line2', 'line3']);
  });

  it('degrades to undefined sourceLines when the file is unreadable', () => {
    const ctx = buildEnrichContext({ enrich: true }, '/does/not/exist.ts', 'typescript');
    expect(ctx).toBeDefined();
    expect(ctx?.sourceLines).toBeUndefined();
  });
});
