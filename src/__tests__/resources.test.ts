import { describe, it, expect } from 'vitest';
import { listResources, readResource } from '../resources.js';

describe('resources', () => {
  it('lists exactly the three resources', () => {
    const uris = listResources()
      .map((r) => r.uri)
      .sort();
    expect(uris).toEqual(['chaos://capabilities', 'chaos://config-schema', 'chaos://languages']);
    for (const r of listResources()) {
      expect(r.name).toBeTruthy();
      expect(r.description).toBeTruthy();
      expect(r.mimeType).toBeTruthy();
    }
  });

  it('reads languages as JSON built from the engine registry', () => {
    const res = readResource('chaos://languages');
    expect(res.mimeType).toBe('application/json');
    const data = JSON.parse(res.text) as Record<
      string,
      { engine: string; supportsLineScope: boolean; estimateFidelity: string }
    >;
    expect(data.typescript.supportsLineScope).toBe(true);
    expect(data.rust.estimateFidelity).toBe('exact');
    expect(data.typescript.estimateFidelity).toBe('approx');
  });

  it('reads config-schema as JSON listing known keys', () => {
    const res = readResource('chaos://config-schema');
    expect(res.mimeType).toBe('application/json');
    const data = JSON.parse(res.text) as Record<string, unknown>;
    expect(data.defaultMaxSurvivors).toBeDefined();
    expect(data.suppressionsPath).toBeDefined();
  });

  it('reads capabilities (markdown) mentioning all three tools', () => {
    const res = readResource('chaos://capabilities');
    expect(res.text).toContain('audit_code_resilience');
    expect(res.text).toContain('triage_test_coverage');
    expect(res.text).toContain('estimate_audit');
  });

  it('throws on an unknown uri', () => {
    expect(() => readResource('chaos://nope')).toThrow();
  });
});
