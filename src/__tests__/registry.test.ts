import { describe, it, expect } from 'vitest';
import { ENGINE_REGISTRY } from '../engines/registry.js';
import { TypeScriptEngine } from '../engines/typescript.js';
import { PythonEngine } from '../engines/python.js';
import { GoEngine } from '../engines/go.js';
import { RustEngine } from '../engines/rust.js';

describe('ENGINE_REGISTRY', () => {
  it('exposes exactly the four supported languages', () => {
    expect(Object.keys(ENGINE_REGISTRY).sort()).toEqual(['go', 'python', 'rust', 'typescript']);
  });

  it('maps each language to the correct config section key', () => {
    expect(ENGINE_REGISTRY.typescript.configKey).toBe('stryker');
    expect(ENGINE_REGISTRY.python.configKey).toBe('mutmut');
    expect(ENGINE_REGISTRY.go.configKey).toBe('go');
    expect(ENGINE_REGISTRY.rust.configKey).toBe('rust');
  });

  it('constructs the matching engine instance for each language', () => {
    expect(ENGINE_REGISTRY.typescript.make()).toBeInstanceOf(TypeScriptEngine);
    expect(ENGINE_REGISTRY.python.make()).toBeInstanceOf(PythonEngine);
    expect(ENGINE_REGISTRY.go.make()).toBeInstanceOf(GoEngine);
    expect(ENGINE_REGISTRY.rust.make()).toBeInstanceOf(RustEngine);
  });

  it('grants line-scope support ONLY to TypeScript (StrykerJS)', () => {
    // Pins the BooleanLiteral on every entry: flipping python/rust to true,
    // or typescript to false, must fail here.
    expect(ENGINE_REGISTRY.typescript.supportsLineScope).toBe(true);
    expect(ENGINE_REGISTRY.python.supportsLineScope).toBe(false);
    expect(ENGINE_REGISTRY.go.supportsLineScope).toBe(false);
    expect(ENGINE_REGISTRY.rust.supportsLineScope).toBe(false);
  });

  it('defines auto-prebuild ONLY for the compiled languages (go, rust)', () => {
    expect(ENGINE_REGISTRY.typescript.prebuild).toBeUndefined();
    expect(ENGINE_REGISTRY.python.prebuild).toBeUndefined();
    expect(ENGINE_REGISTRY.go.prebuild).toEqual({ marker: 'go.mod', command: 'go mod download' });
    expect(ENGINE_REGISTRY.rust.prebuild).toEqual({
      marker: 'Cargo.toml',
      command: 'cargo check',
    });
  });
});
