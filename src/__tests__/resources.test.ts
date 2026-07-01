import { describe, it, expect } from 'vitest';
import { listResources, readResource } from '../resources.js';
import { ENGINE_REGISTRY } from '../engines/registry.js';

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
    expect(Object.keys(data).sort()).toEqual(Object.keys(ENGINE_REGISTRY).sort());
    expect(data.typescript.supportsLineScope).toBe(true);
    expect(data.python.supportsLineScope).toBe(false);
    expect(data.rust.supportsLineScope).toBe(false);
    expect(data.php.supportsLineScope).toBe(false);
    expect(data.rust.estimateFidelity).toBe('exact');
    expect(data.typescript.estimateFidelity).toBe('approx');
  });

  it('reports the correct engine display name per language', () => {
    // Pins the ENGINE_NAMES map (the doc-facing engine labels are a contract);
    // kills the object-emptied and per-string-literal mutants.
    const data = JSON.parse(readResource('chaos://languages').text) as Record<
      string,
      { engine: string; configKey: string; autoPrebuild: boolean }
    >;
    expect(data.typescript.engine).toBe('StrykerJS');
    expect(data.python.engine).toBe('cosmic-ray');
    expect(data.rust.engine).toBe('cargo-mutants');
    expect(data.php.engine).toBe('Infection');
    // Structural fields sourced from ENGINE_REGISTRY (configKey + autoPrebuild).
    for (const [key, entry] of Object.entries(ENGINE_REGISTRY)) {
      expect(data[key].configKey).toBe(entry.configKey);
      expect(data[key].autoPrebuild).toBe(Boolean(entry.prebuild));
    }
    // Rust declares an auto-prebuild; TS and Python do not.
    expect(data.rust.autoPrebuild).toBe(true);
    expect(data.typescript.autoPrebuild).toBe(false);
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
