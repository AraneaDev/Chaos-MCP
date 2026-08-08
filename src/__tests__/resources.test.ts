import { describe, it, expect } from 'vitest';
import { listResources, readResource } from '../core/resources.js';
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

  it("qualifies Rust's 'exact' fidelity as a count of GENERATED mutants only", () => {
    // The bare 'exact' reads as "this is the audit's total". It is not:
    // cargo-mutants enumerates mutants that fail to compile, and engines/rust.ts
    // excludes those from `totalMutants` and reports them as `incompetent`.
    // estimate.ts's basis/note say so; this resource used to promise otherwise.
    const data = JSON.parse(readResource('chaos://languages').text) as Record<
      string,
      { estimateFidelityNote?: string }
    >;
    expect(data.rust.estimateFidelityNote).toContain('GENERATES');
    expect(data.rust.estimateFidelityNote).toContain('incompetent');
    // Only the qualified claim carries the note; 'approx' needs no caveat.
    expect(data.typescript.estimateFidelityNote).toBeUndefined();
  });

  it('reports the correct engine display name per language', () => {
    // The doc-facing engine labels are a contract; kills the object-emptied and
    // per-string-literal mutants. Sourced from EngineDescriptor.displayName
    // since finding 38 — resources.ts no longer keeps a private parallel map.
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
    // Derivation, not coincidence: every rendered engine name is the registry's.
    for (const [key, entry] of Object.entries(ENGINE_REGISTRY)) {
      expect(data[key].engine).toBe(entry.displayName);
    }
  });

  it('reads config-schema as JSON listing known keys', () => {
    const res = readResource('chaos://config-schema');
    expect(res.mimeType).toBe('application/json');
    const data = JSON.parse(res.text) as Record<string, unknown>;
    expect(data.defaultMaxSurvivors).toBeDefined();
    expect(data.suppressionsPath).toBeDefined();
  });

  // The two document resources below ARE the answer an MCP client gets when it
  // asks what this server can do and how to configure it. `toBeDefined()` and
  // `toContain()` pass just as happily on an empty description, so a blanked
  // entry ships as an undocumented key with nothing to tell the reader.

  it('documents exactly the supported config keys, each with a non-empty description', () => {
    const data = JSON.parse(readResource('chaos://config-schema').text) as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(
      [
        'allowPrebuild',
        'concurrency',
        'container',
        'cosmicray',
        'defaultFileConcurrency',
        'defaultMaxFiles',
        'defaultMaxSurvivors',
        'defaultSeverityFloor',
        'defaultTimeoutMs',
        'infection',
        'mutatorAllowlist',
        'mutatorDenylist',
        'perMutantTimeoutMs',
        'rust',
        'runCacheMax',
        'runCacheTtlMs',
        'sandbox',
        'stryker',
        'suppressionsPath',
        'testRunner',
      ].sort(),
    );
    // Reported as a map so a failure names the offending key rather than just
    // "expected false to be true".
    const emptyDescriptions = Object.entries(data)
      .filter(([, description]) => typeof description !== 'string' || description.length === 0)
      .map(([key]) => key);
    expect(emptyDescriptions).toEqual([]);
  });

  it('states each documented default and range, not just the key type', () => {
    // The numbers here are the ONLY place a caller learns what happens when
    // they omit a key. Each assertion pins one factual claim in its description.
    const d = JSON.parse(readResource('chaos://config-schema').text) as Record<string, string>;
    expect(d.defaultMaxFiles).toContain('default 25');
    expect(d.defaultMaxSurvivors).toContain('default 10');
    expect(d.runCacheTtlMs).toContain('86400000');
    expect(d.runCacheMax).toContain('200');
    expect(d.allowPrebuild).toContain('default false');
    expect(d.concurrency).toContain('1–64');
    expect(d.defaultFileConcurrency).toContain('1–64');
    expect(d.suppressionsPath).toContain('.chaos-mcp/suppressions.json');
    expect(d.defaultSeverityFloor).toContain('"high"|"medium"|"low"');
    // WAS `toContain('StrykerJS only')`, which pinned the defect: the resource
    // advertised mutatorAllowlist as a supported StrykerJS key, while
    // `validateMutatorAllowlistArg` rejects the tool argument on every path and
    // `run-options.ts` never sources the config key. The entry must now say so.
    expect(d.mutatorAllowlist).toContain('NOT SUPPORTED');
    expect(d.mutatorAllowlist).toContain('mutatorDenylist');
  });

  it('describes every part of the multi-line container key', () => {
    // `container` is assembled from four concatenated fragments; blanking any
    // one of them leaves a still-non-empty string that a length check cannot
    // catch, while silently dropping a whole group of documented settings.
    const d = JSON.parse(readResource('chaos://config-schema').text) as Record<string, string>;
    expect(d.container).toContain('"native"|"container"|"auto"');
    expect(d.container).toContain('"docker"|"podman"');
    expect(d.container).toContain('the container root is read-only');
    expect(d.container).toContain('default 2048');
  });

  it('reads capabilities (markdown) mentioning all three tools', () => {
    const res = readResource('chaos://capabilities');
    // The mime type is how a client decides to render this as markdown rather
    // than as an opaque blob — the other two resources pin theirs already.
    expect(res.mimeType).toBe('text/markdown');
    expect(res.text).toContain('audit_code_resilience');
    expect(res.text).toContain('triage_test_coverage');
    expect(res.text).toContain('estimate_audit');
  });

  it('renders the capabilities document verbatim, headings and blank lines included', () => {
    // Exact text, because this markdown is read by a human or an LLM as-is: a
    // dropped heading, a lost blank line between sections, or a blanked bullet
    // all render as valid markdown that no longer says what it should.
    expect(readResource('chaos://capabilities').text).toBe(
      [
        '# Chaos-MCP capabilities',
        '',
        '## Tools',
        '- **audit_code_resilience** — mutation-test one file. Args: filePath, lineScope/diffBase/baseline/runId, suppress/unsuppress, enrich, maxSurvivors, severityFloor, minScore, prebuildCommand. Returns survivors + a runId.',
        '- **triage_test_coverage** — rank a tree weakest-first. Args: paths and/or diffBase, maxFiles, survivorsPerFile, fileConcurrency, minScore. Returns a ranking + per-file runIds.',
        '- **estimate_audit** — cheap pre-flight mutant-count (no test cycle). Args: filePath, withTiming. Returns mutants + fidelity.',
        '',
        '## The loop',
        '1. `triage_test_coverage` (optionally with diffBase) to find the weakest files.',
        '2. `audit_code_resilience` the weakest file; write tests for the reported survivors.',
        '3. Re-run `audit_code_resilience` with the returned `runId` to verify those mutants are now killed.',
        '4. Use `minScore` to gate; suppress only genuinely-equivalent mutants.',
        '5. Suppressions are fingerprinted against their source line. If a report shows `driftedSuppressions` or `unverifiedSuppressions`, those entries were NOT applied — re-check the equivalence argument and re-issue `suppress` to restore them. `orphanedSuppressions` means an entry WAS applied but matched no surviving mutant this run (inert) — the mutant may now be killed, or its line/mutator may be gone; re-audit to tell which, then re-issue `suppress` against the current mutant or drop it with `unsuppress`.',
        '',
      ].join('\n'),
    );
  });

  it('throws on an unknown uri, naming the uri it was given', () => {
    // A bare `throw new Error('')` still fails the call but tells the caller
    // nothing about which uri was wrong.
    expect(() => readResource('chaos://nope')).toThrow('Unknown resource: chaos://nope');
  });
});
