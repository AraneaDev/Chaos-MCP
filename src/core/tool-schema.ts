/**
 * MCP tool definition for `audit_code_resilience`.
 *
 * Extracted from index.ts so the schema (a large static literal) lives apart
 * from request handling, formatting, and server bootstrap.
 */

import { MAX_TIMEOUT_MS } from '../utils/constants.js';
import { MAX_LINE_NUMBER } from './tool-args-validation.js';
import { primarySourceExtensions, supportedSourceExtensions } from '../utils/project-detector.js';
import { ENGINE_REGISTRY, type SupportedProjectType } from '../engines/registry.js';

/**
 * `['a', 'b', 'c']` → `'a, b, <conj> c'` (Oxford comma, conjunction before the
 * last item). Two items get `'a <conj> b'` with no comma; one or zero items are
 * returned as-is.
 *
 * Every call site today passes three or more items — four engines, three
 * line-scope-less languages, a dozen extensions — so the shorter branches are
 * unreachable through the schema strings alone. They are not dead: the lists are
 * derived from `ENGINE_REGISTRY`, so a language gaining line scoping (or the
 * registry shrinking) walks straight into them, and the wrong branch would put
 * "Python, and Rust" or "PythonRust" into prose the model reads.
 *
 * @internal Exported for testing only — the branches cannot be reached by
 * varying any input the schema builders accept.
 */
export function conjoin(items: readonly string[], conj: string): string {
  if (items.length < 2) return items.join('');
  if (items.length === 2) return `${items[0]} ${conj} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, ${conj} ${items[items.length - 1]}`;
}

/** `['.a', '.b', '.c']` → `'.a, .b, or .c'` (Oxford comma, `or` before the last). */
function orList(items: readonly string[]): string {
  return conjoin(items, 'or');
}

/**
 * Extension prose rendered from the per-language detection registry rather than
 * hardcoded, so a newly supported language is never described to the model as
 * unsupported (audit F15). These strings are what an LLM client reads to decide
 * whether a file is auditable, so their exact wording is pinned by
 * `tool-schema.test.ts`.
 */
const SUPPORTED_EXT_PROSE = orList(supportedSourceExtensions());

/** Compact slash-separated form for space-constrained prose: `.ts/.js/.py/…`. */
const PRIMARY_EXT_PROSE = primarySourceExtensions().join('/');

/**
 * `'TypeScript/JavaScript (StrykerJS), Python (cosmic-ray), Rust (cargo-mutants), and PHP (Infection)'`
 * — rendered from the engine registry's `label` + `displayName` pairs in
 * registry order, rather than hardcoded, so a newly supported language is never
 * described to the model as unsupported (audit finding 38). Byte-identical to
 * the string it replaced; pinned by `tool-schema.test.ts`.
 */
const ENGINE_SUPPORT_PROSE = conjoin(
  (Object.keys(ENGINE_REGISTRY) as SupportedProjectType[]).map(
    (t) => `${ENGINE_REGISTRY[t].label} (${ENGINE_REGISTRY[t].displayName})`,
  ),
  'and',
);

/**
 * The languages whose engines run whole-file because they have no line-level
 * scoping — `['Python', 'Rust', 'PHP']` today, in registry order, derived from
 * `supportsLineScope` rather than hardcoded so a language that gains (or loses)
 * line scoping is never described to the model with the wrong capability
 * (audit finding 4). Same motivation as {@link ENGINE_SUPPORT_PROSE}.
 */
const NO_LINE_SCOPE_LABELS = (Object.keys(ENGINE_REGISTRY) as SupportedProjectType[])
  .filter((t) => !ENGINE_REGISTRY[t].supportsLineScope)
  .map((t) => ENGINE_REGISTRY[t].label);

/**
 * `'Python, Rust, and PHP'` — the prose form, for the `lineScope` warning.
 * Byte-identical to the literal it replaced; pinned by `tool-schema.test.ts`.
 */
const NO_LINE_SCOPE_PROSE = conjoin(NO_LINE_SCOPE_LABELS, 'and');

/**
 * `'Python/Rust/PHP'` — the compact form, for the `diffBase` warning, which
 * uses a slash list rather than a conjunction. Deliberately a second rendering
 * of the same set: the two call sites' wording differs and both are pinned.
 */
const NO_LINE_SCOPE_SLASH_PROSE = NO_LINE_SCOPE_LABELS.join('/');

/** A single (line, mutator) mutant identity — shared by verify-mode delta arrays. */
const MUTANT_KEY_SCHEMA = {
  type: 'object',
  properties: { line: { type: 'integer' }, mutator: { type: 'string' } },
  required: ['line', 'mutator'],
} as const;

/**
 * A baseline survivor/noCoverage group: `{ line: int≥1, mutators: { name: count } }`.
 * Mirrors the shape the handler actually validates so a schema-driven client can
 * predict the rejection instead of hitting a bare `items: { type: 'object' }` (L6).
 *
 * The bounds are the validator's, not decorative: `assertValidLine` caps `line`
 * at {@link MAX_LINE_NUMBER}, and `validateBaselineArg` rejects any mutator
 * count below 1 ("baseline mutator counts must be positive integers"). Both were
 * looser here than in `tool-args-validation.ts`, so a schema-driven client could
 * not predict either rejection (audit finding 19c/19d).
 */
const BASELINE_GROUP_SCHEMA = {
  type: 'object',
  properties: {
    line: { type: 'integer', minimum: 1, maximum: MAX_LINE_NUMBER },
    mutators: { type: 'object', additionalProperties: { type: 'integer', minimum: 1 } },
  },
  required: ['line', 'mutators'],
} as const;

export const TOOL_DEFINITION = {
  name: 'audit_code_resilience',
  description:
    'Runs on-demand, sandbox-isolated mutation testing against a single source file to identify gaps in unit test coverage. ' +
    'Chaos-MCP generates mutants (logical faults like changing `>` to `>=`) and checks whether the local test suite catches them. ' +
    `Surviving mutants indicate test coverage holes. Supports ${ENGINE_SUPPORT_PROSE}. ` +
    "PATHS: `filePath` is resolved against the SERVER's working directory (or given absolute). " +
    "The `target` in the result is relative to the audited file's own WORKSPACE, which differs " +
    'whenever the file sits in a monorepo package or another root — `packages/api/src/math.ts` ' +
    'comes back as `src/math.ts`. When the two differ the result carries `workspace` (an absolute ' +
    'path) and `join(workspace, target)` is a `filePath` you can pass straight back; when it is ' +
    'absent, `target` already is one. A `file` from triage_test_coverage is always a valid ' +
    '`filePath` as-is.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      filePath: {
        type: 'string',
        description:
          "Path to the file to audit, resolved against the server's working directory (an absolute " +
          "path is also accepted). NOT relative to the audited file's workspace — in a monorepo " +
          'that is the package root, and the two differ. ' +
          `Must end in ${SUPPORTED_EXT_PROSE}. ` +
          'Example: "src/utils/math.ts"',
      },
      timeoutMs: {
        type: 'number',
        exclusiveMinimum: 0,
        maximum: MAX_TIMEOUT_MS,
        description:
          'Maximum time in milliseconds for the entire mutation run. ' +
          'Default: 300000 (5 minutes). Increase for large files or slow test suites. ' +
          `Must be <= ${MAX_TIMEOUT_MS} (the largest delay a timer accepts). ` +
          'Example: 120000 for a 2-minute cap.',
      },
      lineScope: {
        type: 'object',
        description:
          `Constrain mutations to a 1-based line range (inclusive). Only supported by StrykerJS; ignored for ${NO_LINE_SCOPE_PROSE} targets. ` +
          'Useful for surgically auditing a specific function or block. ' +
          'Example: { "start": 10, "end": 45 }',
        properties: {
          // `maximum` is the validator's MAX_LINE_NUMBER, imported rather than
          // repeated: `validateLineScopeArg` rejects anything above it, and the
          // SDK does not check arguments against this schema, so a client can
          // only predict that rejection if the two numbers cannot drift (19d).
          start: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_LINE_NUMBER,
            description: 'Start line (1-based, inclusive).',
          },
          end: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_LINE_NUMBER,
            // `end >= start` is a cross-field rule JSON Schema cannot express,
            // so it stays prose and is enforced only by the validator.
            description: 'End line (1-based, inclusive). Must be >= start.',
          },
        },
        required: ['start', 'end'],
      },
      mutatorAllowlist: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        // The schema used to call this harmless ("ignored — passing it has no
        // effect"), but `validateMutatorAllowlistArg` REJECTS every form of it,
        // `[]` included, and does so deliberately: a clear error beats a silent
        // no-op. Since the MCP SDK never validates arguments against this
        // schema, the description is the only place a caller can learn that the
        // call FAILS. Wording now matches `resources.ts` and `cli.ts` (F11).
        description:
          'NOT SUPPORTED in StrykerJS v9 — REJECTED: passing this fails the call with an error. ' +
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
          'Number of parallel mutation workers. Honoured by StrykerJS (--concurrency), ' +
          'cargo-mutants (-j) and Infection (--threads); cosmic-ray has no worker flag and reports ' +
          'this as an ignored option. When omitted, StrykerJS auto-detects CPU core count while ' +
          'cargo-mutants deliberately stays low (2 jobs, or 1 on a small machine) because each job ' +
          'wants its own multi-GB target directory. Lower this on memory-constrained machines; raise ' +
          'it on CI with spare cores. Must be an integer between 1 and 64. Example: 4',
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
          'Path segments for files/directories to exclude from the sandbox, applied in addition to ' +
          'built-in exclusions. A path is skipped when any of its segments equals the pattern exactly. ' +
          'This now also suppresses the dependency-directory link, so excluding "node_modules" leaves ' +
          'the sandbox without it — which will usually break the run. A pattern is never a suffix or ' +
          'a substring: ".test.ts" excludes only a path segment named exactly that, not "billing.test.ts". ' +
          'One trailing separator is stripped, so "fixtures/" and "fixtures" are the same pattern. ' +
          'Example: ["fixtures/", "testdata"]',
      },
      prebuildCommand: {
        type: 'string',
        description:
          'Shell command to run in the sandbox BEFORE mutation testing begins. ' +
          'Use this to compile/build the target — the sandbox has a full workspace copy. ' +
          'Essential for TypeScript projects ("npm run build") and Rust projects ("cargo build"). ' +
          'DISABLED BY DEFAULT: because it runs an arbitrary shell command that can reach outside ' +
          'the sandbox, the server must opt in via "allowPrebuild": true in its config file or the ' +
          'CHAOS_MCP_ALLOW_PREBUILD=1 environment variable. Counts against the overall timeoutMs budget. ' +
          'Example: "npm run build"',
      },
      perMutantTimeoutMs: {
        type: 'number',
        exclusiveMinimum: 0,
        maximum: MAX_TIMEOUT_MS,
        description:
          'Maximum time in milliseconds per individual mutant test (StrykerJS only). ' +
          'Distinct from timeoutMs (total run cap). Use this to prevent a single slow mutant ' +
          'from hanging the entire mutation run. Default: StrykerJS default (~5000ms). ' +
          `Must be <= ${MAX_TIMEOUT_MS} (the largest delay a timer accepts). ` +
          'Example: 10000 for a 10-second per-mutant ceiling.',
      },
      diffBase: {
        type: 'string',
        description:
          'Auto-scope mutation to only the lines changed in git. The value selects the base to diff against: ' +
          '"HEAD" (all uncommitted changes), "staged" (staged changes only), or any git ref/branch/SHA ' +
          '(e.g. "main", resolved via merge-base with HEAD). Mutually exclusive with lineScope. ' +
          `Line-level scoping is StrykerJS-only; ${NO_LINE_SCOPE_SLASH_PROSE} targets run whole-file with a note. ` +
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
          survivors: { type: 'array', items: BASELINE_GROUP_SCHEMA },
          noCoverage: { type: 'array', items: BASELINE_GROUP_SCHEMA },
        },
        // A bare `{}` is rejected — "baseline must contain at least one
        // (line, mutator) entry across survivors/noCoverage" — so at least one
        // of the two keys must be present. Neither can be `required` on its
        // own (either alone is legal), which is what the `anyOf` expresses (19b).
        anyOf: [{ required: ['survivors'] }, { required: ['noCoverage'] }],
      },
      runId: {
        type: 'string',
        description:
          'Verify mode by id: re-run against the cached survivor baseline from a prior audit (the runId it returned). ' +
          'Auto-scoped to the baseline lines (StrykerJS) or whole-file (other languages). ' +
          'Mutually exclusive with baseline, diffBase, and lineScope. Example: "a1b2c3d4".',
      },
      suppress: {
        type: 'array',
        description:
          'Mark mutants as equivalent (unkillable) so future runs exclude them from the score and output. ' +
          'Appended to .chaos-mcp/suppressions.json for this file, stamped with a fingerprint of the source line so a later edit to that line retires the suppression instead of silently re-pointing it. ' +
          'Re-issue the same entry to re-confirm one reported as drifted or unverified. ' +
          'A suppression is identified by its mutator and the CHANGE it makes, not by its line, so it follows the code when an edit moves it. ' +
          'Supply `change` (the "original \u2192 mutated" string from a survivor\'s `changes`) to name WHICH mutant when one line carries several of the same mutator; omit it and Chaos-MCP resolves it from this run\'s survivors, refusing the entry rather than suppressing all of them if several match. ' +
          'Example: [{ "line": 42, "mutator": "ConditionalExpression", "reason": "guard unreachable" }].',
        // `validateMutantKeyArray` rejects an empty array ("must be a non-empty
        // array"), and caps each line at MAX_LINE_NUMBER (19a/19d).
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            line: { type: 'integer', minimum: 1, maximum: MAX_LINE_NUMBER },
            mutator: { type: 'string' },
            reason: { type: 'string' },
            change: { type: 'string' },
          },
          required: ['line', 'mutator'],
        },
      },
      unsuppress: {
        type: 'array',
        description:
          'Remove previously-suppressed mutants for this file (undo a wrong suppress). ' +
          'Supply `change` to remove one specific entry; omit it to remove every entry for that mutator. ' +
          'The `line` is ignored when matching, so an entry that has relocated is still removable.',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            line: { type: 'integer', minimum: 1, maximum: MAX_LINE_NUMBER },
            mutator: { type: 'string' },
            change: { type: 'string' },
          },
          required: ['line', 'mutator'],
        },
      },
      minScore: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        description:
          'Gate: if the mutation score is below this (0–100), the result reports gate.passed=false (never an error). Example: 80.',
      },
      enrich: {
        type: 'boolean',
        description:
          'Augment each surviving / no-coverage line with deterministic guidance: severity (high/medium/low), ' +
          'a "why it matters" explanation, a test-writing hint, and a source-context snippet — and rank survivors severity-first. ' +
          'Defaults to TRUE; pass false to disable and return the plain (unranked, unclassified) output. ' +
          'Richest for TypeScript; Python and PHP report severity "unknown".',
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
      // Present only when the audited file's workspace root is not the server's
      // working directory — a monorepo package, or another root reached via
      // CHAOS_ALLOWED_ROOTS — where `target` alone cannot say which project it
      // names. See `reportableWorkspace` in utils/path-safety.ts.
      workspace: {
        type: 'string',
        description:
          'Absolute workspace root that `target` is relative to. Present only when that root is ' +
          "not the server's working directory (a monorepo package, or another root via " +
          'CHAOS_ALLOWED_ROOTS). `join(workspace, target)` is a path this tool accepts as ' +
          '`filePath`; when the field is absent, `target` already is one.',
      },
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
      // Advisory that the RUN may misreport (a misconfiguration in the audited
      // project), as opposed to `scopeNote`, which explains what was mutated.
      // Produced by `buildResultPayload` from `MutationResult.fidelityNote`
      // (see the PHPUnit phantom-survivor warning in engines/php.ts); it was
      // missing here, so a client binding fields from this schema never
      // surfaced the warning at all.
      fidelityNote: { type: 'string' },
      enrichNote: { type: 'string' },
      runId: { type: 'string' },
      suppressedCount: { type: 'integer' },
      driftedSuppressions: { type: 'integer' },
      unverifiedSuppressions: { type: 'integer' },
      orphanedSuppressions: { type: 'integer' },
      rejectedSuppressions: { type: 'integer' },
      unsuppressedCount: { type: 'integer' },
      relocatedSuppressions: { type: 'integer' },
      gate: {
        type: 'object',
        properties: {
          minScore: { type: 'number' },
          passed: { type: 'boolean' },
          reason: { type: 'string', enum: ['partial_audit'] },
        },
      },
      incompetent: { type: 'integer' },
      complete: { type: 'boolean' },
      batchesCompleted: { type: 'integer' },
      batchesPlanned: { type: 'integer' },
      stoppedReason: { type: 'string', enum: ['time_budget_exhausted'] },
      note: { type: 'string' },
      // ── Verify-mode fields (present only when a baseline/runId was supplied).
      // Verify responses carry a delta shape instead of the audit report; the
      // `oneOf` below discriminates the two required-sets so a strict MCP client
      // validates both a standard audit and a verify delta against this schema. ──
      mode: { type: 'string', enum: ['verify'] },
      baselineTotal: { type: 'integer' },
      killedCount: { type: 'integer' },
      nowKilled: { type: 'array', items: MUTANT_KEY_SCHEMA },
      stillSurviving: { type: 'array', items: MUTANT_KEY_SCHEMA },
      newSurvivors: { type: 'array', items: MUTANT_KEY_SCHEMA },
    },
    oneOf: [
      // Standard audit report.
      { required: ['target', 'mutationScore', 'summary', 'survivors', 'noCoverage', 'note'] },
      // Verify-mode delta.
      {
        required: [
          'target',
          'mode',
          'baselineTotal',
          'killedCount',
          'nowKilled',
          'stillSurviving',
          'newSurvivors',
          'note',
        ],
      },
    ],
  },
};

export const TRIAGE_TOOL_DEFINITION = {
  name: 'triage_test_coverage',
  description:
    'Batch triage: audit a set of files and/or directories and return a weakest-first ranked ' +
    'leaderboard of mutation scores, so you can see where the test suite is most fragile in one call. ' +
    `Directories are recursively expanded to supported source files (${PRIMARY_EXT_PROSE}), skipping ` +
    'test files. Files are audited in parallel (see fileConcurrency, default min(4, cpus-1)), under a ' +
    'shared wall-clock budget (see totalTimeoutMs). Drill into a weak file with audit_code_resilience ' +
    "for per-mutant survivor detail: each row's `file` is relative to the server's working directory, " +
    "so it can be passed straight back as that tool's `filePath` (its own `target` is spelled " +
    "differently — see that tool's description).",
  inputSchema: {
    type: 'object' as const,
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Files and/or directories to triage, resolved against the server's working directory. " +
          'Directories are recursively expanded to supported source files. Each ranked row reports ' +
          'its `file` in that same spelling, so a row can be fed straight back to this tool or to ' +
          'audit_code_resilience. Example: ["src/utils", "src/index.ts"]',
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
        exclusiveMinimum: 0,
        maximum: MAX_TIMEOUT_MS,
        description:
          'Per-file mutation-run timeout in milliseconds. Default: 300000 (5 minutes). ' +
          `Must be <= ${MAX_TIMEOUT_MS} (the largest delay a timer accepts). ` +
          'Also clamped by whatever remains of totalTimeoutMs.',
      },
      totalTimeoutMs: {
        type: 'number',
        exclusiveMinimum: 0,
        maximum: MAX_TIMEOUT_MS,
        description:
          'Wall-clock budget for the WHOLE sweep in milliseconds. Default: 900000 (15 minutes). ' +
          'Files not started before it runs out are returned in "unaudited" rather than audited, ' +
          'so a large sweep still returns the ranking it produced. ' +
          `Must be <= ${MAX_TIMEOUT_MS} (the largest delay a timer accepts). Example: 1800000`,
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
          'How many files to audit in parallel. Default min(4, cpus-1). When >1, the per-file worker ' +
          'count is capped for every engine that has one (StrykerJS --concurrency, cargo-mutants -j, ' +
          "Infection --threads), and for StrykerJS each mutant's test run is additionally pinned to a " +
          'single vitest worker, so those three layers multiply out to roughly the core count. Rust is ' +
          'the exception to watch: `cargo build`/`cargo test` parallelise internally and take no cap, ' +
          'so a Rust sweep runs fileConcurrency concurrent cargo builds, each of which wants its own ' +
          'multi-GB target directory — lower this to 1 or 2 on a memory-constrained machine. Raise ' +
          'with care on a workstation: a sweep is still the most resource-hungry thing this server ' +
          'does. Example: 4',
      },
      minScore: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        description:
          "Gate: if any file's mutation score is below this (0–100), the result reports gate.passed=false and lists the failing files. Never causes an error. Example: 80.",
      },
    },
    // No single argument is required, but a bare `{}` IS rejected —
    // `validateTargetPresence` returns 'Provide "paths" … or "diffBase" … — at
    // least one is required.' `required: []` alone advertised the opposite, so a
    // schema-driven client could not predict the rejection (19e).
    required: [],
    anyOf: [{ required: ['paths'] }, { required: ['diffBase'] }],
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
          filesUnaudited: { type: 'integer' },
        },
        required: ['filesDiscovered', 'filesAudited', 'filesSkipped', 'filesErrored'],
      },
      ranking: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            // Always emitted for every row — the load-bearing leaderboard fields.
            file: { type: 'string' },
            mutationScore: { type: 'string' },
            total: { type: 'integer' },
            killed: { type: 'integer' },
            survived: { type: 'integer' },
            noCoverage: { type: 'integer' },
            // Optional per-row fields.
            scopeNote: { type: 'string' },
            worstSeverity: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
            survivors: { type: 'array', items: { type: 'object' } },
            noCoverageGroups: { type: 'array', items: { type: 'object' } },
            noMutableLogic: { type: 'boolean' },
            runId: { type: 'string' },
            suppressedCount: { type: 'integer' },
            driftedSuppressions: { type: 'integer' },
            unverifiedSuppressions: { type: 'integer' },
            orphanedSuppressions: { type: 'integer' },
            rejectedSuppressions: { type: 'integer' },
            relocatedSuppressions: { type: 'integer' },
            passed: { type: 'boolean' },
            // Present (false) only when the file's audit was truncated by the
            // time budget; its score then covers only the completed batches.
            complete: { type: 'boolean' },
            batchesCompleted: { type: 'integer' },
            batchesPlanned: { type: 'integer' },
          },
          required: ['file', 'mutationScore', 'total', 'killed', 'survived', 'noCoverage'],
        },
      },
      errors: { type: 'array', items: { type: 'object' } },
      unaudited: { type: 'array', items: { type: 'string' } },
      stoppedReason: { type: 'string', enum: ['time_budget_exhausted'] },
      scopeNote: { type: 'string' },
      note: { type: 'string' },
      gate: {
        type: 'object',
        properties: {
          minScore: { type: 'number' },
          passed: { type: 'boolean' },
          failingFiles: { type: 'array', items: { type: 'string' } },
          // Same class of defect as `fidelityNote` above: `buildTriagePayload`
          // has always emitted `reason` on a failure and `notGraded` on EVERY
          // gated sweep, but neither was declared — so a client generating
          // types or binding fields from this schema could not see them at all.
          //
          // `reason` is the only machine-readable way to tell "measured and
          // below threshold" from "never measured": the gate fails CLOSED over
          // errored or unaudited files (see triage.ts), so `passed: false` with
          // an empty `failingFiles` is a real, and otherwise unexplained, state.
          reason: { type: 'string', enum: ['below_threshold', 'files_not_graded'] },
          notGraded: {
            type: 'object',
            properties: { errored: { type: 'integer' }, unaudited: { type: 'integer' } },
            required: ['errored', 'unaudited'],
          },
        },
        // `reason` is conditional (failures only); the other four are set
        // unconditionally whenever `minScore` was supplied.
        required: ['minScore', 'passed', 'failingFiles', 'notGraded'],
      },
    },
    required: ['mode', 'summary', 'ranking', 'errors', 'note'],
  },
};

export const ESTIMATE_TOOL_DEFINITION = {
  name: 'estimate_audit',
  description:
    'Cheap pre-flight estimate of how big/long auditing a file will be, WITHOUT running the full ' +
    'mutation test cycle. Returns an approximate mutant count (for Rust, an exact count of the mutants ' +
    'cargo-mutants --list GENERATES — the audit scores fewer, excluding unviable ones as `incompetent`; ' +
    'a source heuristic for TS/JS/Python/PHP, labeled fidelity:"approx"). Set withTiming:true to also ' +
    'run the test suite once and estimate wall-clock time. Use this before audit_code_resilience to ' +
    'decide whether to audit now, scope down, or skip.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      filePath: {
        type: 'string',
        description:
          'Path to the source file to estimate, within the workspace. Example: "src/math.ts".',
      },
      withTiming: {
        type: 'boolean',
        description:
          'When true, run the test suite once to measure a baseline and estimate total wall-clock ' +
          'time (mutants × baseline / concurrency). Default false (count only, no test run).',
      },
      // `estimate-handler.ts` has always READ this argument — it runs
      // `validateTimeoutMs(args)` and then `resolveAuditTimeoutMs(args, …)` —
      // but the schema declared only filePath/withTiming with
      // `additionalProperties: false`, so the one argument that decides
      // `budgetMs`, `fitsBudget` and `recommendation` was advertised as
      // forbidden. Shape matches the identical argument on
      // `audit_code_resilience` and `triage_test_coverage` (finding 13).
      timeoutMs: {
        type: 'number',
        exclusiveMinimum: 0,
        maximum: MAX_TIMEOUT_MS,
        description:
          'The audit budget in milliseconds this estimate is GRADED against: budgetMs echoes it, and ' +
          'fitsBudget/recommendation compare the estimated time to it. Resolved exactly as ' +
          'audit_code_resilience resolves its own timeoutMs (same argument, config keys, and ' +
          'per-language defaults), so an estimate answers the question for the audit you would ' +
          `actually run. Default: 300000 (5 minutes). Must be <= ${MAX_TIMEOUT_MS} ` +
          '(the largest delay a timer accepts). Example: 120000.',
      },
    },
    required: ['filePath'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      target: { type: 'string' },
      // Present only when the audited file's workspace root is not the server's
      // working directory — a monorepo package, or another root reached via
      // CHAOS_ALLOWED_ROOTS — where `target` alone cannot say which project it
      // names. See `reportableWorkspace` in utils/path-safety.ts.
      workspace: {
        type: 'string',
        description:
          'Absolute workspace root that `target` is relative to. Present only when that root is ' +
          "not the server's working directory (a monorepo package, or another root via " +
          'CHAOS_ALLOWED_ROOTS). `join(workspace, target)` is a path this tool accepts as ' +
          '`filePath`; when the field is absent, `target` already is one.',
      },
      language: { type: 'string' },
      mutants: { type: 'integer' },
      fidelity: { type: 'string', enum: ['exact', 'approx'] },
      basis: { type: 'string' },
      baselineMs: { type: 'integer' },
      optimisticMs: { type: 'integer' },
      estimatedMs: { type: 'integer' },
      upperBoundMs: { type: 'integer' },
      concurrency: { type: 'integer' },
      timingConfidence: { type: 'string', enum: ['low', 'medium'] },
      budgetMs: { type: 'integer' },
      fitsBudget: { type: 'boolean' },
      recommendation: { type: 'string' },
      note: { type: 'string' },
    },
    required: ['target', 'language', 'mutants', 'fidelity', 'basis', 'note'],
  },
} as const;
