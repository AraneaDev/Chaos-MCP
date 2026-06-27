/**
 * MCP tool definition for `audit_code_resilience`.
 *
 * Extracted from index.ts so the schema (a large static literal) lives apart
 * from request handling, formatting, and server bootstrap.
 */
export const TOOL_DEFINITION = {
  name: 'audit_code_resilience',
  description:
    'Runs on-demand, sandbox-isolated mutation testing against a single source file to identify gaps in unit test coverage. ' +
    'Chaos-MCP generates mutants (logical faults like changing `>` to `>=`) and checks whether the local test suite catches them. ' +
    'Surviving mutants indicate test coverage holes. Supports TypeScript/JavaScript (StrykerJS), Python (Mutmut), Go (go-mutesting), and Rust (cargo-mutants).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      filePath: {
        type: 'string',
        description:
          'Workspace-relative path to the file to audit. ' +
          'Must end in .ts, .js, .tsx, .jsx, .py, .go, or .rs. ' +
          'Example: "src/utils/math.ts"',
      },
      timeoutMs: {
        type: 'number',
        description:
          'Maximum time in milliseconds for the entire mutation run. ' +
          'Default: 300000 (5 minutes). Increase for large files or slow test suites. ' +
          'Example: 120000 for a 2-minute cap.',
      },
      lineScope: {
        type: 'object',
        description:
          'Constrain mutations to a 1-based line range (inclusive). Only supported by StrykerJS; ignored for Python, Go, and Rust targets. ' +
          'Useful for surgically auditing a specific function or block. ' +
          'Example: { "start": 10, "end": 45 }',
        properties: {
          start: {
            type: 'number',
            description: 'Start line (1-based, inclusive).',
          },
          end: {
            type: 'number',
            description: 'End line (1-based, inclusive). Must be >= start.',
          },
        },
      },
      mutatorAllowlist: {
        type: 'array',
        items: { type: 'string' },
        description:
          'NOT SUPPORTED in StrykerJS v9 and ignored — passing it has no effect. ' +
          'v9 has no way to express "only these mutators" without the full mutator list. ' +
          'Use mutatorDenylist to exclude noisy mutators instead, or supply your own stryker.config.json.',
      },
      mutatorDenylist: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Stryker mutator names to exclude — these are filtered out. StrykerJS only. ' +
          'Useful for skipping noisy or irrelevant mutators. ' +
          'Example: ["StringLiteral"]',
      },
      concurrency: {
        type: 'integer',
        minimum: 1,
        maximum: 64,
        description:
          'Number of parallel mutation workers (StrykerJS only). ' +
          'When omitted, StrykerJS auto-detects CPU core count. ' +
          'Lower this on memory-constrained machines; raise it on CI with spare cores. ' +
          'Must be an integer between 1 and 64. Example: 4',
      },
      dryRun: {
        type: 'boolean',
        description:
          'If true, run only the dry-run phase to validate the test suite passes before mutation testing (StrykerJS only). ' +
          'Useful for pre-flight checks. Example: false',
      },
      outputFormat: {
        type: 'string',
        enum: ['json', 'text'],
        description:
          'Output format for the result. "json" (default) returns a structured MutationResult object. ' +
          '"text" returns a human-readable summary. Example: "json"',
      },
      incremental: {
        type: 'boolean',
        description:
          'Enable incremental mode to reuse results from a previous run and skip unchanged mutants (StrykerJS only). ' +
          'Speeds up repeat audits of the same file. Example: true',
      },
      ignorePatterns: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Substring patterns for files/directories to exclude from the sandbox copy, applied in addition to built-in exclusions. ' +
          'Any path containing the pattern string is skipped. Example: [".test.ts", "fixtures/", "snapshots/"]',
      },
      prebuildCommand: {
        type: 'string',
        description:
          'Shell command to run in the sandbox BEFORE mutation testing begins. ' +
          'Use this to compile/build the target — the sandbox has a full workspace copy. ' +
          'Essential for TypeScript projects ("npm run build"), Go projects ("go build ./..."), ' +
          'and Rust projects ("cargo build"). ' +
          'DISABLED BY DEFAULT: because it runs an arbitrary shell command that can reach outside ' +
          'the sandbox, the server must opt in via "allowPrebuild": true in its config file or the ' +
          'CHAOS_MCP_ALLOW_PREBUILD=1 environment variable. Counts against the overall timeoutMs budget. ' +
          'Example: "npm run build"',
      },
      perMutantTimeoutMs: {
        type: 'number',
        description:
          'Maximum time in milliseconds per individual mutant test (StrykerJS only). ' +
          'Distinct from timeoutMs (total run cap). Use this to prevent a single slow mutant ' +
          'from hanging the entire mutation run. Default: StrykerJS default (~5000ms). ' +
          'Example: 10000 for a 10-second per-mutant ceiling.',
      },
      diffBase: {
        type: 'string',
        description:
          'Auto-scope mutation to only the lines changed in git. The value selects the base to diff against: ' +
          '"HEAD" (all uncommitted changes), "staged" (staged changes only), or any git ref/branch/SHA ' +
          '(e.g. "main", resolved via merge-base with HEAD). Mutually exclusive with lineScope. ' +
          'Line-level scoping is StrykerJS-only; Go/Python/Rust targets run whole-file with a note. ' +
          'If the file has no changes vs the base, the run is skipped. Example: "HEAD"',
      },
      baseline: {
        type: 'object',
        description:
          'Verify mode: pass back the `survivors` and `noCoverage` arrays from a PRIOR run to re-test only ' +
          'those mutants and get a delta — which are now killed vs still surviving (plus any new regressions ' +
          'on the same lines). The re-run is auto-scoped to the baseline lines (StrykerJS) or whole-file (other ' +
          'languages). Mutually exclusive with diffBase and lineScope. ' +
          'Example: { "survivors": [{ "line": 42, "mutators": { "ConditionalExpression": 1 } }] }',
        properties: {
          survivors: { type: 'array', items: { type: 'object' } },
          noCoverage: { type: 'array', items: { type: 'object' } },
        },
      },
      enrich: {
        type: 'boolean',
        description:
          'Augment each surviving / no-coverage line with deterministic guidance: severity (high/medium/low), ' +
          'a "why it matters" explanation, a test-writing hint, and a source-context snippet — and rank survivors severity-first. ' +
          'Defaults to TRUE; pass false to disable and return the plain (unranked, unclassified) output. ' +
          'Richest for TypeScript and Go; Python reports severity "unknown".',
      },
      maxSurvivors: {
        type: 'integer',
        minimum: 1,
        description:
          'Cap on how many survivor (and how many no-coverage) line groups are returned, after severity ranking. ' +
          'Hidden groups are counted in survivorsTruncated/noCoverageTruncated. ' +
          'Precedence: this arg > config.defaultMaxSurvivors > 10. Example: 20',
      },
      severityFloor: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description:
          'Report-time filter: drop survivor groups below this severity (requires enrichment, which is on by default). ' +
          'Dropped groups are counted in survivorsFiltered/noCoverageFiltered. "unknown"-severity groups are below "low" and are dropped by any floor. ' +
          'Ignored (with a note) when enrich is false. Example: "high"',
      },
    },
    required: ['filePath'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      target: { type: 'string' },
      mutationScore: { type: 'string' },
      summary: {
        type: 'object',
        properties: {
          total: { type: 'integer' },
          killed: { type: 'integer' },
          survived: { type: 'integer' },
          worstSeverity: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
        },
        required: ['total', 'killed', 'survived'],
      },
      survivors: { type: 'array', items: { type: 'object' } },
      noCoverage: { type: 'array', items: { type: 'object' } },
      suggestedTestFile: {
        type: 'object',
        properties: { path: { type: 'string' }, exists: { type: 'boolean' } },
      },
      ignoredOptions: { type: 'array', items: { type: 'string' } },
      survivorsTruncated: { type: 'integer' },
      noCoverageTruncated: { type: 'integer' },
      survivorsFiltered: { type: 'integer' },
      noCoverageFiltered: { type: 'integer' },
      scopeNote: { type: 'string' },
      enrichNote: { type: 'string' },
      note: { type: 'string' },
    },
    required: ['target', 'mutationScore', 'summary', 'survivors', 'noCoverage', 'note'],
  },
};

export const TRIAGE_TOOL_DEFINITION = {
  name: 'triage_test_coverage',
  description:
    'Batch triage: audit a set of files and/or directories and return a weakest-first ranked ' +
    'leaderboard of mutation scores, so you can see where the test suite is most fragile in one call. ' +
    'Directories are recursively expanded to supported source files (.ts/.js/.py/.go/.rs), skipping ' +
    'test files. Files are audited serially. Drill into a weak file with audit_code_resilience for ' +
    'per-mutant survivor detail.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Workspace-relative files and/or directories to triage. Directories are recursively ' +
          'expanded to supported source files. Example: ["src/utils", "src/index.ts"]',
      },
      maxFiles: {
        type: 'integer',
        minimum: 1,
        description:
          'Cap on the number of files audited (precedence: this arg > config.defaultMaxFiles > 25). ' +
          'Files beyond the cap are skipped (reported in the summary). Example: 25',
      },
      timeoutMs: {
        type: 'number',
        description: 'Per-file mutation-run timeout in milliseconds. Default: 300000 (5 minutes).',
      },
      mutatorDenylist: {
        type: 'array',
        items: { type: 'string' },
        description: 'Stryker mutator names to exclude, applied to every TypeScript/JS file.',
      },
      outputFormat: {
        type: 'string',
        enum: ['json', 'text'],
        description: 'Output format. "json" (default) or "text".',
      },
      diffBase: {
        type: 'string',
        description:
          'Auto-scope the triage to files changed in git. "HEAD" (uncommitted), "staged", or any ' +
          'ref/branch/SHA (merge-base with HEAD). Makes "paths" optional: diffBase alone scans all ' +
          'changed supported source files; diffBase + paths intersects with those paths. TypeScript ' +
          'files are mutated only on changed lines; other languages run whole-file. Example: "main"',
      },
      survivorsPerFile: {
        type: 'integer',
        minimum: 0,
        description:
          'How many top (severity-ranked, enriched) survivor groups to inline per ranked file. ' +
          '0 (default) returns a scores-only leaderboard. Example: 3',
      },
      fileConcurrency: {
        type: 'integer',
        minimum: 1,
        maximum: 64,
        description:
          "How many files to audit in parallel. Default min(4, cpus-1). When >1, each StrykerJS run's " +
          'worker count is capped so total CPU use stays near the core count. Example: 4',
      },
    },
    required: [],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      mode: { type: 'string' },
      summary: {
        type: 'object',
        properties: {
          filesDiscovered: { type: 'integer' },
          filesAudited: { type: 'integer' },
          filesSkipped: { type: 'integer' },
          filesErrored: { type: 'integer' },
        },
        required: ['filesDiscovered', 'filesAudited', 'filesSkipped', 'filesErrored'],
      },
      ranking: { type: 'array', items: { type: 'object' } },
      errors: { type: 'array', items: { type: 'object' } },
      scopeNote: { type: 'string' },
      note: { type: 'string' },
    },
    required: ['mode', 'summary', 'ranking', 'errors', 'note'],
  },
};
