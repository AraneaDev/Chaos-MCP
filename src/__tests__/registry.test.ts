import { describe, it, expect } from 'vitest';
import { ENGINE_REGISTRY, dependencyDirectories } from '../engines/registry.js';
import { TypeScriptEngine } from '../engines/typescript.js';
import { PythonEngine } from '../engines/python.js';
import { RustEngine } from '../engines/rust.js';
import { PhpEngine } from '../engines/php.js';

describe('ENGINE_REGISTRY', () => {
  it('exposes exactly the four supported languages', () => {
    expect(Object.keys(ENGINE_REGISTRY).sort()).toEqual(['php', 'python', 'rust', 'typescript']);
  });

  it('maps each language to the correct config section key', () => {
    expect(ENGINE_REGISTRY.typescript.configKey).toBe('stryker');
    expect(ENGINE_REGISTRY.python.configKey).toBe('cosmicray');
    expect(ENGINE_REGISTRY.rust.configKey).toBe('rust');
    expect(ENGINE_REGISTRY.php.configKey).toBe('infection');
  });

  it('constructs the matching engine instance for each language', () => {
    expect(ENGINE_REGISTRY.typescript.make()).toBeInstanceOf(TypeScriptEngine);
    expect(ENGINE_REGISTRY.python.make()).toBeInstanceOf(PythonEngine);
    expect(ENGINE_REGISTRY.rust.make()).toBeInstanceOf(RustEngine);
    expect(ENGINE_REGISTRY.php.make()).toBeInstanceOf(PhpEngine);
  });

  it('grants line-scope support ONLY to TypeScript (StrykerJS)', () => {
    // Pins the BooleanLiteral on every entry: flipping python/rust to true,
    // or typescript to false, must fail here.
    expect(ENGINE_REGISTRY.typescript.supportsLineScope).toBe(true);
    expect(ENGINE_REGISTRY.python.supportsLineScope).toBe(false);
    expect(ENGINE_REGISTRY.rust.supportsLineScope).toBe(false);
    expect(ENGINE_REGISTRY.php.supportsLineScope).toBe(false);
  });

  it('grants concurrency support to every engine EXCEPT cosmic-ray (python)', () => {
    // Gates whether `concurrency` is reported back to the caller as an ignored
    // option (M1). Flipping any of these silently either drops a flag the tool
    // does honour, or promises one it discards.
    expect(ENGINE_REGISTRY.typescript.honorsConcurrency).toBe(true);
    expect(ENGINE_REGISTRY.python.honorsConcurrency).toBe(false);
    expect(ENGINE_REGISTRY.rust.honorsConcurrency).toBe(true);
    expect(ENGINE_REGISTRY.php.honorsConcurrency).toBe(true);
  });

  it('defines auto-prebuild ONLY for the compiled languages (rust)', () => {
    expect(ENGINE_REGISTRY.typescript.prebuild).toBeUndefined();
    expect(ENGINE_REGISTRY.python.prebuild).toBeUndefined();
    expect(ENGINE_REGISTRY.rust.prebuild).toEqual({
      marker: 'Cargo.toml',
      command: 'cargo check',
    });
    expect(ENGINE_REGISTRY.php.prebuild).toBeUndefined();
  });

  it('declares each language heavyweight dependency dirs — and NONE for rust', () => {
    // Finding 35b: these feed utils/sandbox.ts's SYMLINK_DIRS. Rust must stay
    // empty: `target/` is build OUTPUT, and symlinking it lets a mutation run
    // corrupt the host's build cache (audit H1).
    expect(ENGINE_REGISTRY.typescript.dependencyDirs).toEqual(['node_modules']);
    expect(ENGINE_REGISTRY.python.dependencyDirs).toEqual(['.venv', 'venv']);
    expect(ENGINE_REGISTRY.rust.dependencyDirs).toEqual([]);
    expect(ENGINE_REGISTRY.php.dependencyDirs).toEqual(['vendor']);
  });

  it('never lists a build-output directory as a dependency dir', () => {
    // A structural restatement of audit H1 that survives new languages: anything
    // ALWAYS_EXCLUDE treats as generated output must never become a symlink.
    const buildOutputs = ['target', 'dist', 'build', '.next', 'coverage'];
    for (const entry of Object.values(ENGINE_REGISTRY)) {
      for (const dir of entry.dependencyDirs) {
        expect(buildOutputs).not.toContain(dir);
      }
    }
  });

  it('unions dependency dirs across languages in registry order', () => {
    // The exact list utils/sandbox.ts uses. Order is load-bearing (registry
    // declaration order), so this pins order, not just membership.
    expect(dependencyDirectories()).toEqual(['node_modules', '.venv', 'venv', 'vendor']);
  });

  it('assigns each language a lexical syntax family', () => {
    // Finding 35b: estimate-heuristic.ts strips comments/strings by FAMILY, not
    // by language — rust shares the C family with typescript. A wrong value here
    // silently skews the mutant estimate.
    expect(ENGINE_REGISTRY.typescript.syntaxFamily).toBe('c');
    expect(ENGINE_REGISTRY.python.syntaxFamily).toBe('python');
    expect(ENGINE_REGISTRY.rust.syntaxFamily).toBe('c');
    expect(ENGINE_REGISTRY.php.syntaxFamily).toBe('php');
  });

  it('carries the doc-facing engine name and language label for each entry', () => {
    // Finding 38: resources.ts (chaos://languages) and tool-schema.ts (the MCP
    // tool description) both render from these — the label is deliberately NOT
    // the registry key ('typescript' → 'TypeScript/JavaScript').
    expect(ENGINE_REGISTRY.typescript.displayName).toBe('StrykerJS');
    expect(ENGINE_REGISTRY.python.displayName).toBe('cosmic-ray');
    expect(ENGINE_REGISTRY.rust.displayName).toBe('cargo-mutants');
    expect(ENGINE_REGISTRY.php.displayName).toBe('Infection');

    expect(ENGINE_REGISTRY.typescript.label).toBe('TypeScript/JavaScript');
    expect(ENGINE_REGISTRY.python.label).toBe('Python');
    expect(ENGINE_REGISTRY.rust.label).toBe('Rust');
    expect(ENGINE_REGISTRY.php.label).toBe('PHP');
  });

  it('gives every language a non-empty display name and label', () => {
    for (const entry of Object.values(ENGINE_REGISTRY)) {
      expect(entry.displayName.trim().length).toBeGreaterThan(0);
      expect(entry.label.trim().length).toBeGreaterThan(0);
    }
  });
});
