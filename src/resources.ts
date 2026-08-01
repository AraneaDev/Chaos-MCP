import { ENGINE_REGISTRY, type SupportedProjectType } from './engines/registry.js';

export interface ResourceListing {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

const LANGUAGES_URI = 'chaos://languages';
const CONFIG_URI = 'chaos://config-schema';
const CAPABILITIES_URI = 'chaos://capabilities';

export function listResources(): ResourceListing[] {
  return [
    {
      uri: LANGUAGES_URI,
      name: 'Supported languages',
      description: 'Languages, their mutation engine, line-scope support, and estimate fidelity.',
      mimeType: 'application/json',
    },
    {
      uri: CONFIG_URI,
      name: 'Config schema',
      description: 'chaos-mcp.config.json keys with types and meaning.',
      mimeType: 'application/json',
    },
    {
      uri: CAPABILITIES_URI,
      name: 'Capabilities overview',
      description: 'The three tools, their arguments, and the triage→audit→verify workflow.',
      mimeType: 'text/markdown',
    },
  ];
}

function languagesJson(): string {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(ENGINE_REGISTRY) as SupportedProjectType[]) {
    const entry = ENGINE_REGISTRY[key];
    out[key] = {
      // Engine name comes from the registry (was a private parallel
      // ENGINE_NAMES map here, which a new language could silently omit —
      // audit finding 38).
      engine: entry.displayName,
      supportsLineScope: entry.supportsLineScope,
      // Both come from the registry, which is also what estimate.ts's
      // `computeCount` stamps onto `EstimateResult.fidelity` and what
      // `estimateNeedsSandbox` gates on — so this resource cannot advertise a
      // fidelity the estimate does not actually deliver. It used to re-derive
      // `key === 'rust'` here, in a file that has no idea how the count is made.
      estimateFidelity: entry.estimateFidelity,
      // A bare 'exact' reads as "this is the audit's total", which it is not:
      // `cargo mutants --list` enumerates mutants that will not compile, and
      // engines/rust.ts excludes those from `totalMutants` and reports them as
      // `incompetent`. Qualify it in place rather than weakening the enum value
      // (estimate.ts:basis/note). The sentence is the engine's, so it lives on
      // the descriptor; 'approx' needs no caveat and carries none.
      ...(entry.estimateFidelityNote !== undefined
        ? { estimateFidelityNote: entry.estimateFidelityNote }
        : {}),
      configKey: entry.configKey,
      autoPrebuild: Boolean(entry.prebuild),
    };
  }
  return JSON.stringify(out, null, 2);
}

function configSchemaJson(): string {
  const keys = {
    defaultTimeoutMs: 'integer ms — per-run mutation timeout.',
    defaultMaxFiles: 'integer ≥ 1 — cap on how many files triage scans (default 25).',
    perMutantTimeoutMs: 'integer ms — per-mutant timeout (StrykerJS).',
    testRunner: 'string — test runner override when auto-detection is inconclusive.',
    concurrency: 'integer 1–64 — global worker count for engines that support it (StrykerJS).',
    // Kept (rather than dropped) so an operator who already has the key in a
    // config learns WHY it does nothing: `validateMutatorAllowlistArg` rejects
    // the tool argument unconditionally and `run-options.ts` deliberately
    // refuses to source it from args or config, so advertising it as supported
    // led callers into a hard error for a key this server recommended. Wording
    // matches cli.ts's `--mutator-allowlist` help text.
    mutatorAllowlist:
      'string[] — NOT SUPPORTED (StrykerJS v9 has no allowlist): ignored here, and rejected with an ' +
      'error when passed as a tool argument. Use mutatorDenylist.',
    mutatorDenylist: 'string[] — mutator names to skip.',
    defaultMaxSurvivors: 'integer ≥ 1 — cap on reported survivor groups (default 10).',
    defaultSeverityFloor: '"high"|"medium"|"low" — drop survivor groups below this severity.',
    defaultFileConcurrency: 'integer 1–64 — triage file-level worker pool size.',
    suppressionsPath:
      'string — path to the equivalent-mutant suppressions file (default .chaos-mcp/suppressions.json).',
    runCacheTtlMs: 'integer > 0 — runId cache TTL (default 86400000).',
    runCacheMax: 'integer ≥ 1 — runId cache max entries (default 200).',
    allowPrebuild: 'boolean — allow caller-supplied prebuildCommand (default false).',
    stryker: 'object — StrykerJS-specific overrides.',
    cosmicray: 'object — cosmic-ray (Python)-specific overrides.',
    rust: 'object — cargo-mutants-specific overrides.',
    infection:
      'object — Infection (PHP)-specific overrides (timeoutMs, threads, testFrameworkOptions).',
    container:
      'object — shared OCI execution backend: mode ("native"|"container"|"auto"), runtime ' +
      '("docker"|"podman"), network, cpus, memoryMb, pidsLimit, startupTimeoutMs, ' +
      'tmpfsSizeMb (writable /tmp size; the container root is read-only, so this holds every ' +
      'toolchain cache — default 2048), and per-language images.',
  };
  return JSON.stringify(keys, null, 2);
}

function capabilitiesMarkdown(): string {
  return [
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
    '5. Suppressions are fingerprinted against their source line. If a report shows `driftedSuppressions` or `unverifiedSuppressions`, those entries were NOT applied — re-check the equivalence argument and re-issue `suppress` to restore them.',
    '',
  ].join('\n');
}

export function readResource(uri: string): { uri: string; mimeType: string; text: string } {
  switch (uri) {
    case LANGUAGES_URI:
      return { uri, mimeType: 'application/json', text: languagesJson() };
    case CONFIG_URI:
      return { uri, mimeType: 'application/json', text: configSchemaJson() };
    case CAPABILITIES_URI:
      return { uri, mimeType: 'text/markdown', text: capabilitiesMarkdown() };
    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
}
