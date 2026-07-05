import { resolve, isAbsolute, relative, join } from 'path';
import { existsSync, realpathSync, readFileSync } from 'fs';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext } from './tool-context.js';
import { BaseEngine, RunOptions, MutationResult } from './engines/base.js';
import { ENGINE_REGISTRY, type SupportedProjectType } from './engines/registry.js';
import { detectProjectType, detectEnvironment, EnvironmentInfo } from './utils/project-detector.js';
import { createSandbox } from './utils/sandbox.js';
import { runShellCommand, ExecFailureError } from './utils/exec.js';
import { ChaosConfig } from './utils/config-loader.js';
import { log, isVerbose } from './utils/logger.js';
import { formatResultAsText, buildResultPayload, type EnrichContext } from './format.js';
import { evaluateGate, validateMinScore } from './gate.js';
import type { Severity } from './enrich.js';
import { suggestTestFile, findPythonTestSelection } from './test-file.js';
import { computeChangedRanges } from './utils/git-diff.js';
import { saveRun, loadRun } from './utils/run-cache.js';
import {
  loadSuppressions,
  addSuppressions,
  removeSuppressions,
  applySuppressions,
} from './utils/suppression.js';
import {
  parseBaseline,
  baselineLines,
  computeVerifyDelta,
  formatVerifyResultAsJson,
  formatVerifyResultAsText,
  buildVerifyNote,
  type BaselineInput,
  type MutantKey,
} from './verify.js';

/**
 * Returns true when `candidate` is `root` itself, or a path strictly inside
 * `root` (no `..` traversal, no absolute escape).
 *
 * Used by the audit_code_resilience handler (audit finding C2) to enforce
 * the workspace-boundary rule: callers cannot audit files outside the
 * current process cwd.
 */
function isPathInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/** Resolve symlinks (falling back to the lexical path when the target does not
 *  exist), then test lexical containment. Defense-in-depth against a symlink
 *  whose lexical path is inside the workspace but resolves outside it. */
export function isRealPathInside(candidate: string, root: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p; // path does not exist yet — can't resolve symlinks, use lexical
    }
  };
  return isPathInside(real(candidate), real(root));
}

/** Build an MCP error response from a single message. */
export function toolError(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Whether an explicit, caller-supplied `prebuildCommand` may run. It executes an
 * arbitrary shell command inside the sandbox (which can reach outside it), so it
 * is opt-in: enabled via `allowPrebuild: true` in the config file or the
 * `CHAOS_MCP_ALLOW_PREBUILD` environment variable (audit Med#10).
 */
export function isPrebuildAllowed(cfg: ChaosConfig): boolean {
  if (cfg.allowPrebuild === true) return true;
  const flag = process.env.CHAOS_MCP_ALLOW_PREBUILD;
  return flag === '1' || flag === 'true';
}

type ProjectType = ReturnType<typeof detectProjectType>;

/** Tool-call arguments object (untyped MCP payload). */
type ToolArgs = Record<string, unknown>;

/**
 * StrykerJS-only tool options that the other engines silently ignore.
 *
 * `concurrency` is the exception: it lives here because cosmic-ray (Python)
 * discards it, but cargo-mutants and Infection DO honour it — so it is filtered
 * per-engine in {@link ignoredOptionsFor} rather than reported unconditionally.
 */
const STRYKER_ONLY_OPTIONS = [
  'lineScope',
  'mutatorAllowlist',
  'mutatorDenylist',
  'concurrency',
  'dryRun',
  'incremental',
  'perMutantTimeoutMs',
] as const;

/**
 * Return the supplied options the resolved engine will ignore. Empty for
 * TypeScript targets (StrykerJS honours all of them). For other engines every
 * option is ignored EXCEPT `concurrency`, which is only reported as ignored for
 * engines whose registry entry sets `honorsConcurrency: false` (cosmic-ray).
 * This prevents falsely telling Rust/PHP callers their concurrency had no effect
 * when the engine actually applied it (audit M1).
 */
function ignoredOptionsFor(projectType: ProjectType, args: ToolArgs): string[] {
  const descriptor = ENGINE_REGISTRY[projectType as SupportedProjectType];
  // StrykerJS (configKey 'stryker') honours every option in the list.
  if (descriptor?.configKey === 'stryker') return [];
  return STRYKER_ONLY_OPTIONS.filter((opt) => {
    if (args[opt] === undefined) return false;
    if (opt === 'concurrency') return descriptor?.honorsConcurrency === false;
    return true;
  });
}

/**
 * Validate the optional tool arguments that are not covered by the JSON schema's
 * coarse typing. Returns an error {@link CallToolResult} on the first failure, or `null`
 * when every provided argument is well-formed.
 *
 * Covers audit findings H5 (concurrency), M5 (lineScope), M7 (ignorePatterns is
 * validated earlier), plus perMutantTimeoutMs and prebuildCommand.
 */
export function validateToolArgs(args: ToolArgs): CallToolResult | null {
  // Each validator returns an error message for the first malformed argument it
  // owns, or null. Run in a fixed order so the first failure reported is stable.
  // Note: `args.key !== undefined` already covers the "absent key" case (an
  // absent key reads as undefined), so a separate `'key' in args` guard would
  // be redundant.
  for (const validate of TOOL_ARG_VALIDATORS) {
    const message = validate(args);
    if (message !== null) return toolError(message);
  }
  return null;
}

/** perMutantTimeoutMs: must be a positive number. */
function validatePerMutantTimeoutMs(args: ToolArgs): string | null {
  if (
    args.perMutantTimeoutMs !== undefined &&
    (typeof args.perMutantTimeoutMs !== 'number' || args.perMutantTimeoutMs <= 0)
  ) {
    return 'perMutantTimeoutMs must be a positive number. Example: 10000.';
  }
  return null;
}

/** prebuildCommand: must be a non-empty string. */
function validatePrebuildCommand(args: ToolArgs): string | null {
  if (
    args.prebuildCommand !== undefined &&
    (typeof args.prebuildCommand !== 'string' ||
      (args.prebuildCommand as string).trim().length === 0)
  ) {
    return 'prebuildCommand must be a non-empty string. Example: "npm run build".';
  }
  return null;
}

/** concurrency: integer 1..64 (H5). */
function validateConcurrencyArg(args: ToolArgs): string | null {
  if (
    args.concurrency !== undefined &&
    (typeof args.concurrency !== 'number' ||
      !Number.isInteger(args.concurrency) ||
      args.concurrency < 1 ||
      args.concurrency > 64)
  ) {
    return 'concurrency must be an integer between 1 and 64 (Stryker workers).';
  }
  return null;
}

/** lineScope: { start: int >= 1, end: int >= start } (M5). */
function validateLineScopeArg(args: ToolArgs): string | null {
  if (args.lineScope === undefined) return null;
  const ls = args.lineScope as Record<string, unknown> | null;
  if (
    ls === null ||
    typeof ls !== 'object' ||
    Array.isArray(ls) ||
    typeof ls.start !== 'number' ||
    typeof ls.end !== 'number' ||
    !Number.isInteger(ls.start) ||
    !Number.isInteger(ls.end) ||
    ls.start < 1 ||
    ls.end < ls.start
  ) {
    return 'lineScope must be { start: integer >= 1, end: integer >= start }. Example: { start: 10, end: 45 }.';
  }
  return null;
}

/** diffBase: non-empty string, not option-like, not combined with lineScope. */
function validateDiffBaseArg(args: ToolArgs): string | null {
  if (args.diffBase === undefined) return null;
  if (typeof args.diffBase !== 'string' || args.diffBase.trim().length === 0) {
    return 'diffBase must be a non-empty string: "HEAD", "staged", or a git ref. Example: "HEAD".';
  }
  if (args.diffBase.startsWith('-')) {
    return 'diffBase must not start with "-" (it would be mistaken for a git option).';
  }
  if (args.lineScope !== undefined) {
    return 'diffBase and lineScope are mutually exclusive — use one or the other, not both.';
  }
  return null;
}

/**
 * baseline (verify mode): object with optional survivors/noCoverage arrays;
 * mutually exclusive with diffBase and lineScope; must hold ≥1 (line, mutator).
 */
function validateBaselineArg(args: ToolArgs): string | null {
  if (args.baseline === undefined) return null;
  const b = args.baseline as Record<string, unknown> | null;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) {
    return 'baseline must be an object with optional "survivors" and "noCoverage" arrays from a prior run.';
  }
  if (args.diffBase !== undefined || args.lineScope !== undefined) {
    return 'baseline is mutually exclusive with diffBase and lineScope — use only one at a time.';
  }
  let pairCount = 0;
  for (const key of ['survivors', 'noCoverage'] as const) {
    const arr = b[key];
    if (arr === undefined) continue;
    if (!Array.isArray(arr)) {
      return `baseline.${key} must be an array of { line, mutators } objects.`;
    }
    for (const g of arr) {
      const entry = g as Record<string, unknown> | null;
      if (
        entry === null ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        !Number.isInteger(entry.line) ||
        (entry.line as number) < 1 ||
        typeof entry.mutators !== 'object' ||
        entry.mutators === null ||
        Array.isArray(entry.mutators)
      ) {
        return 'each baseline entry must be { line: integer >= 1, mutators: object of mutator→count }.';
      }
      pairCount += Object.keys(entry.mutators as Record<string, unknown>).length;
    }
  }
  if (pairCount === 0) {
    return 'baseline must contain at least one (line, mutator) entry across survivors/noCoverage.';
  }
  return null;
}

/** enrich: must be a boolean when present. */
function validateEnrichArg(args: ToolArgs): string | null {
  if (args.enrich !== undefined && typeof args.enrich !== 'boolean') {
    return 'enrich must be a boolean. Example: true.';
  }
  return null;
}

/** maxSurvivors: integer >= 1 when present. */
function validateMaxSurvivorsArg(args: ToolArgs): string | null {
  if (
    args.maxSurvivors !== undefined &&
    (typeof args.maxSurvivors !== 'number' ||
      !Number.isInteger(args.maxSurvivors) ||
      args.maxSurvivors < 1)
  ) {
    return 'maxSurvivors must be an integer >= 1. Example: 20.';
  }
  return null;
}

/** severityFloor: one of high|medium|low when present. */
function validateSeverityFloorArg(args: ToolArgs): string | null {
  if (
    args.severityFloor !== undefined &&
    args.severityFloor !== 'high' &&
    args.severityFloor !== 'medium' &&
    args.severityFloor !== 'low'
  ) {
    return 'severityFloor must be one of "high", "medium", or "low". Example: "high".';
  }
  return null;
}

/** outputFormat: must be "text" or "json" when present (audit L4). */
function validateOutputFormatArg(args: ToolArgs): string | null {
  if (
    args.outputFormat !== undefined &&
    args.outputFormat !== 'text' &&
    args.outputFormat !== 'json'
  ) {
    return 'outputFormat must be one of "text" or "json". Example: "json".';
  }
  return null;
}

/** runId (verify-from-cache): non-empty string, mutually exclusive with baseline/diffBase/lineScope. */
function validateRunIdArg(args: ToolArgs): string | null {
  if (args.runId === undefined) return null;
  if (typeof args.runId !== 'string' || args.runId.trim().length === 0) {
    return 'runId must be a non-empty string returned by a prior audit. Example: "a1b2c3d4".';
  }
  if (args.baseline !== undefined || args.diffBase !== undefined || args.lineScope !== undefined) {
    return 'runId is mutually exclusive with baseline, diffBase, and lineScope — use only one at a time.';
  }
  return null;
}

/** Shared shape validator for suppress/unsuppress arrays; `field` names the arg in errors. */
function validateMutantKeyArray(
  value: unknown,
  field: string,
  allowReason: boolean,
): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) {
    return `${field} must be a non-empty array of { line: integer >= 1, mutator: string${allowReason ? ', reason?: string' : ''} }.`;
  }
  for (const e of value) {
    const entry = e as Record<string, unknown> | null;
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      !Number.isInteger(entry.line) ||
      (entry.line as number) < 1 ||
      typeof entry.mutator !== 'string' ||
      entry.mutator.trim().length === 0 ||
      (allowReason && entry.reason !== undefined && typeof entry.reason !== 'string')
    ) {
      return `each ${field} entry must be { line: integer >= 1, mutator: non-empty string${allowReason ? ', reason?: string' : ''} }.`;
    }
  }
  return null;
}

/** suppress: non-empty array of { line >= 1, mutator, reason? } equivalent-mutant keys. */
function validateSuppressArg(args: ToolArgs): string | null {
  return validateMutantKeyArray(args.suppress, 'suppress', true);
}

/** unsuppress: non-empty array of { line >= 1, mutator } equivalent-mutant keys. */
function validateUnsuppressArg(args: ToolArgs): string | null {
  return validateMutantKeyArray(args.unsuppress, 'unsuppress', false);
}

/** minScore: number in [0, 100] when present. */
function validateMinScoreArg(args: ToolArgs): string | null {
  return validateMinScore(args.minScore);
}

/** Ordered per-field validators run by {@link validateToolArgs}. */
const TOOL_ARG_VALIDATORS: ((args: ToolArgs) => string | null)[] = [
  validatePerMutantTimeoutMs,
  validatePrebuildCommand,
  validateConcurrencyArg,
  validateRunIdArg, // before lineScope/diffBase/baseline so mutual-exclusion is reported first
  validateLineScopeArg,
  validateDiffBaseArg,
  validateBaselineArg,
  validateEnrichArg,
  validateMaxSurvivorsArg,
  validateSeverityFloorArg,
  validateOutputFormatArg,
  validateSuppressArg,
  validateUnsuppressArg,
  validateMinScoreArg,
];

/** Normalise an unknown into a well-formed `{ start, end }` lineScope, or `undefined`. */
function normalizeLineScope(v: unknown): { start: number; end: number } | undefined {
  if (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).start === 'number' &&
    typeof (v as Record<string, unknown>).end === 'number'
  ) {
    const ls = v as { start: number; end: number };
    return { start: ls.start, end: ls.end };
  }
  return undefined;
}

/** True for an integer in StrykerJS's accepted concurrency range (1..64). */
function isValidConcurrency(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 64;
}

/** True for a positive (> 0) duration in milliseconds. */
function isPositiveMs(v: unknown): v is number {
  return typeof v === 'number' && v > 0;
}

/** Concurrency declared on an engine config section, when that section has one. */
function sectionConcurrency(section: unknown): number | undefined {
  return typeof section === 'object' && section !== null && 'concurrency' in section
    ? ((section as { concurrency?: unknown }).concurrency as number | undefined)
    : undefined;
}

/** First valid concurrency among arg then config fallback, else `undefined`. */
function resolveConcurrency(arg: unknown, fallback: unknown): number | undefined {
  if (isValidConcurrency(arg)) return arg;
  if (isValidConcurrency(fallback)) return fallback;
  return undefined;
}

/** First positive-ms value among arg then config fallback, else `undefined`. */
function resolvePositiveMs(arg: unknown, fallback: unknown): number | undefined {
  if (isPositiveMs(arg)) return arg;
  if (isPositiveMs(fallback)) return fallback;
  return undefined;
}

/**
 * Assemble {@link RunOptions} from tool-call arguments merged with config
 * defaults. Tool-call arguments always take precedence over config values.
 */
export function buildRunOptions(
  args: ToolArgs,
  cfg: ChaosConfig,
  env: EnvironmentInfo,
  workDir: string,
  projectType: ProjectType,
): RunOptions {
  // Extract engine-specific config for the current project type.
  // Precedence: args > engine-specific config section > global config defaults.
  const configKey = ENGINE_REGISTRY[projectType as SupportedProjectType]?.configKey;
  const engCfg = configKey ? cfg[configKey] : undefined;

  // testRunner must come from the section that matches the engine being run.
  // Previously stryker.testRunner was consulted first for ALL project types,
  // so a Python audit could receive Stryker's runner (e.g. "vitest") and pass
  // it to mutmut (audit Med#2). Only the Stryker/cosmic-ray sections carry a
  // testRunner; the timeout-only Rust section doesn't (→ undefined, as before).
  const engineTestRunner =
    configKey === 'stryker'
      ? cfg.stryker?.testRunner
      : configKey === 'cosmicray'
        ? cfg.cosmicray?.testRunner
        : undefined;

  return {
    testRunner: engineTestRunner ?? cfg.testRunner ?? env.testRunner,
    workDir,
    timeoutMs:
      typeof args.timeoutMs === 'number' && args.timeoutMs > 0
        ? args.timeoutMs
        : (engCfg?.timeoutMs ?? cfg.defaultTimeoutMs),
    lineScope: normalizeLineScope(args.lineScope),
    // mutatorAllowlist is intentionally NOT propagated. StrykerJS v9 cannot
    // express an allowlist, so the TS engine rejects it; sourcing it here (from
    // args OR config) would make every TS run throw (High#3). Left undefined so
    // the engine's defensive guard never trips. mutatorDenylist is the supported
    // alternative.
    mutatorDenylist: Array.isArray(args.mutatorDenylist)
      ? (args.mutatorDenylist as string[]).filter((v) => typeof v === 'string')
      : (cfg.stryker?.mutatorDenylist ?? cfg.mutatorDenylist),
    // Resolve from the section matching THIS engine (not always stryker): a Rust
    // audit must read rust.concurrency, a PHP audit must not inherit stryker's.
    concurrency: resolveConcurrency(
      args.concurrency,
      sectionConcurrency(engCfg) ?? cfg.concurrency,
    ),
    dryRun: typeof args.dryRun === 'boolean' ? args.dryRun : cfg.stryker?.dryRun,
    outputFormat:
      args.outputFormat === 'text' || args.outputFormat === 'json' ? args.outputFormat : undefined,
    incremental:
      typeof args.incremental === 'boolean' ? args.incremental : cfg.stryker?.incremental,
    perMutantTimeoutMs: resolvePositiveMs(
      args.perMutantTimeoutMs,
      cfg.stryker?.perMutantTimeoutMs ?? cfg.perMutantTimeoutMs,
    ),
    ignorePatterns: Array.isArray(args.ignorePatterns)
      ? (args.ignorePatterns as string[]).filter((v) => typeof v === 'string')
      : undefined,
    // Python (cosmic-ray) only: scope the test-command and bound the mutant
    // count on large projects. Sourced from the cosmicray config section;
    // ignored by the other engines.
    pythonTestSelection: cfg.cosmicray?.testSelection,
    pythonExcludeOperators: cfg.cosmicray?.excludeOperators,
    // PHP (Infection) only: worker count + test-framework passthrough, sourced
    // from the infection config section; ignored by the other engines.
    phpThreads: cfg.infection?.threads !== undefined ? String(cfg.infection.threads) : undefined,
    phpTestFrameworkOptions: cfg.infection?.testFrameworkOptions,
  };
}

const DEFAULT_MAX_SURVIVORS = 10;

/**
 * Resolve the cap on survivor/no-coverage groups returned per run.
 * Precedence: arg > cfg.defaultMaxSurvivors > DEFAULT_MAX_SURVIVORS.
 */
function resolveMaxSurvivors(args: ToolArgs, cfg: ChaosConfig): number {
  if (
    typeof args.maxSurvivors === 'number' &&
    Number.isInteger(args.maxSurvivors) &&
    args.maxSurvivors >= 1
  ) {
    return args.maxSurvivors;
  }
  if (typeof cfg.defaultMaxSurvivors === 'number') return cfg.defaultMaxSurvivors;
  return DEFAULT_MAX_SURVIVORS;
}

/**
 * Resolve the severity floor for survivor reporting.
 * Precedence: arg > cfg.defaultSeverityFloor.
 */
function resolveSeverityFloor(args: ToolArgs, cfg: ChaosConfig): Severity | undefined {
  const a = args.severityFloor;
  if (a === 'high' || a === 'medium' || a === 'low') return a;
  return cfg.defaultSeverityFloor;
}

/**
 * Resolve the prebuild command: explicit args win, then fall back to smart
 * defaults based on the detected package manager / language. Returns `null`
 * when no prebuild is needed.
 */
export function resolvePrebuildCommand(
  args: ToolArgs,
  env: EnvironmentInfo,
  projectType: ProjectType,
): string | null {
  if (typeof args.prebuildCommand === 'string' && args.prebuildCommand.trim().length > 0) {
    return args.prebuildCommand;
  }
  // Python dependency installers (`uv sync` / `poetry install`) are intentionally
  // NOT auto-run: `.venv` is symlinked into the sandbox from the host, so an
  // install would mutate the user's real virtual environment (High#2). The
  // symlinked environment is already populated; callers who genuinely need a
  // rebuild can pass an explicit prebuildCommand. Rust (`cargo check`) declares
  // its auto-prebuild in the engine registry. (PHP has none — Infection needs no build.)
  const prebuild = ENGINE_REGISTRY[projectType as SupportedProjectType]?.prebuild;
  if (prebuild && existsSync(join(env.workspaceRoot, prebuild.marker))) {
    return prebuild.command;
  }
  return null;
}

/**
 * Build the enrichment context for the formatters, or `undefined` when the
 * caller did not opt in. Reads the (already workspace-validated) real-tree
 * source file for context snippets; a read failure degrades to no snippets
 * rather than failing the audit.
 */
export function buildEnrichContext(
  args: ToolArgs,
  resolvedFile: string,
  projectType: SupportedProjectType,
): EnrichContext | undefined {
  if (args.enrich === false) return undefined; // default-on: only an explicit false disables
  let sourceLines: string[] | undefined;
  try {
    sourceLines = readFileSync(resolvedFile, 'utf8').split(/\r?\n/);
  } catch {
    sourceLines = undefined;
  }
  return { projectType, sourceLines };
}

export interface AuditFileInput {
  targetFile: string;
  env: EnvironmentInfo;
  projectType: Exclude<ProjectType, 'unsupported'>;
  engine: BaseEngine;
  args: ToolArgs;
  config: ChaosConfig;
  workDir: string;
  prebuildCmd: string | null;
  lineRanges?: { start: number; end: number }[];
  /** Abort signal forwarded from the MCP request context; kills in-flight subprocesses. */
  signal?: AbortSignal;
}

/**
 * Run a single mutation audit inside an ALREADY-PROVISIONED sandbox `workDir`:
 * build run options, run the (already-resolved/gated) prebuild command, then
 * run the engine. The caller owns the sandbox lifecycle (provision + cleanup).
 * Throws `Prebuild command failed in sandbox: …` if the prebuild fails; engine
 * errors propagate from `engine.run`.
 */
export async function auditFile(input: AuditFileInput): Promise<MutationResult> {
  const { targetFile, env, projectType, engine, args, config, workDir, prebuildCmd, lineRanges } =
    input;
  const runOptions = buildRunOptions(args, config, env, workDir, projectType);
  if (lineRanges) runOptions.lineRanges = lineRanges;
  // Python only: when neither the tool args nor the config scoped the suite,
  // default to the target file's own test module(s). cosmic-ray otherwise runs
  // the WHOLE suite per mutant — impractical on real projects, and a single
  // unrelated failing/slow test breaks the baseline. Discovery is best-effort;
  // an empty result leaves the whole-suite default untouched.
  if (
    projectType === 'python' &&
    (!runOptions.pythonTestSelection || runOptions.pythonTestSelection.length === 0)
  ) {
    const auto = findPythonTestSelection(targetFile, env.workspaceRoot);
    if (auto.length > 0) {
      runOptions.pythonTestSelection = auto;
      if (isVerbose()) log(`PythonEngine: auto-scoped test-command to ${auto.join(' ')}`);
    }
  }
  // Thread the abort signal from the MCP request context into the engine run so
  // in-flight subprocesses are killed when the caller cancels.
  if (input.signal) runOptions.signal = input.signal;

  if (prebuildCmd !== null) {
    if (isVerbose()) {
      const prebuildExplicit =
        typeof args.prebuildCommand === 'string' && args.prebuildCommand.trim().length > 0;
      const autoLabel =
        env.packageManager && env.packageManager !== 'pip' ? env.packageManager : projectType;
      const source = prebuildExplicit ? 'explicit' : `auto (${autoLabel})`;
      log(`Running prebuild command in sandbox [${source}]: ${prebuildCmd}`);
    }
    const prebuildStart = Date.now();
    try {
      await runShellCommand(prebuildCmd, { cwd: workDir, timeoutMs: runOptions.timeoutMs });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Prebuild command failed in sandbox: ${message}`);
    }
    if (isVerbose()) log('Prebuild command completed successfully');
    // Deduct prebuild time so timeoutMs bounds the whole run (audit Med#3).
    if (typeof runOptions.timeoutMs === 'number') {
      const remaining = runOptions.timeoutMs - (Date.now() - prebuildStart);
      runOptions.timeoutMs = remaining > 0 ? remaining : 1;
    }
  }

  return engine.run(targetFile, runOptions);
}

/** Construct the engine for a (supported) project type. */
export function makeEngine(projectType: SupportedProjectType): BaseEngine {
  return ENGINE_REGISTRY[projectType].make();
}

/**
 * The resolved mutation scope for a run, or a ready-to-return tool result when
 * the request should short-circuit (diff errors, or a no-changes skip).
 */
type ScopeResolution =
  | { kind: 'result'; result: CallToolResult }
  | {
      kind: 'scope';
      diffRanges?: { start: number; end: number }[];
      scopeNote?: string;
      baselineKeys?: MutantKey[];
    };

/**
 * Resolve the line scope for a run from the diff-aware ({@link diffBase}, A2)
 * and verify-mode ({@link baseline}, A3) arguments. Runs on the REAL tree
 * before the (expensive) sandbox copy so a "no changes" diff can short-circuit
 * without provisioning. Returns `{ kind: 'result' }` to return immediately
 * (diff error or no-changes skip) or `{ kind: 'scope' }` with the resolved
 * ranges / note / baseline keys to continue. `diffBase` and `baseline` are
 * mutually exclusive (enforced by {@link validateToolArgs}), so they never
 * both produce ranges.
 */
async function computeScope(
  earlyArgs: ToolArgs,
  targetFile: string,
  env: EnvironmentInfo,
  projectType: SupportedProjectType,
  cfg: ChaosConfig,
  relFile: string,
): Promise<ScopeResolution> {
  let diffRanges: { start: number; end: number }[] | undefined;
  let scopeNote: string | undefined;

  const diffBase = typeof earlyArgs.diffBase === 'string' ? earlyArgs.diffBase : undefined;
  if (diffBase) {
    const diff = await computeChangedRanges(targetFile, env.workspaceRoot, diffBase);
    switch (diff.kind) {
      case 'not-a-repo':
        return {
          kind: 'result',
          result: toolError(
            `diffBase requires a git work tree, but "${env.workspaceRoot}" is not one. ` +
              'Remove diffBase or run inside a git repository.',
          ),
        };
      case 'bad-ref':
        return {
          kind: 'result',
          result: toolError(
            `diffBase "${diff.ref}" could not be resolved as a git ref (merge-base failed).`,
          ),
        };
      case 'no-changes': {
        // Short-circuit: nothing changed, so skip the sandbox + engine entirely.
        const empty = {
          target: targetFile,
          totalMutants: 0,
          killed: 0,
          survived: 0,
          mutationScore: '100.00%',
          vulnerabilities: [],
          scopeNote: `No changed lines in ${targetFile} vs ${diffBase}; nothing to mutate.`,
        };
        // enrich context is not available here (built later by buildEnrichContext);
        // the empty result has no survivors/noCoverage so enrichment has no effect.
        const payload = buildResultPayload(empty, {});
        const text =
          earlyArgs.outputFormat === 'text' ? formatResultAsText(empty) : JSON.stringify(payload);
        return {
          kind: 'result',
          result: {
            content: [{ type: 'text', text }],
            structuredContent: payload as unknown as Record<string, unknown>,
          },
        };
      }
      case 'untracked':
        // File is new/untracked — every line is "changed", so mutate the
        // whole file, but tell the caller why it wasn't line-scoped.
        scopeNote = `${targetFile} is untracked in git vs ${diffBase}; mutated the whole file.`;
        break;
      case 'ranges':
        if (ENGINE_REGISTRY[projectType].supportsLineScope) {
          diffRanges = diff.ranges;
        } else {
          scopeNote = `diffBase scoping is not supported for ${projectType}; mutated the whole file.`;
        }
        break;
    }
  }

  // ── Verify mode (A3): parse the prior-run baseline and derive the re-run
  // scope from its lines (TS only; non-TS runs whole-file then filters). ──
  let baselineKeys: MutantKey[] | undefined;
  if (
    earlyArgs.baseline &&
    typeof earlyArgs.baseline === 'object' &&
    !Array.isArray(earlyArgs.baseline)
  ) {
    baselineKeys = parseBaseline(earlyArgs.baseline as BaselineInput);
    if (ENGINE_REGISTRY[projectType].supportsLineScope) {
      // Reuse the A2 scope channel (`diffRanges` → runOptions.lineRanges).
      // baseline is mutually exclusive with diffBase, so this never collides.
      diffRanges = baselineLines(baselineKeys).map((l) => ({ start: l, end: l }));
    }
  }

  // ── Verify mode by cached id (A3-by-runId). Mutually exclusive with
  // baseline/diffBase/lineScope (enforced by validateRunIdArg), so this never
  // collides with the diff path above. Loads the prior run's survivors from the
  // run cache and re-runs the existing verify path against them. ──
  if (typeof earlyArgs.runId === 'string' && earlyArgs.runId.trim().length > 0) {
    const cached = loadRun(earlyArgs.runId, {
      ttlMs: cfg.runCacheTtlMs,
      max: cfg.runCacheMax,
    });
    if (!cached) {
      return {
        kind: 'result',
        result: toolError(
          `runId "${earlyArgs.runId}" not found or expired; re-run audit to get a fresh runId.`,
        ),
      };
    }
    // C2 boundary: the cached run is bound to the file it audited; refuse to
    // verify it against a different target. The cached `file` is the
    // workspace-relative key (same expression triage uses), so compare against
    // `relFile`, not the absolute path.
    if (cached.file !== relFile) {
      return {
        kind: 'result',
        result: toolError(
          `runId "${earlyArgs.runId}" was for ${cached.file}, not ${relFile}; verify against the file it audited.`,
        ),
      };
    }
    baselineKeys = parseBaseline({ survivors: cached.survivors, noCoverage: cached.noCoverage });
    // Mirror the baseline branch: only scope to lines on engines that support it
    // (TS only); others run whole-file then filter (Fix 3 — consistency).
    if (ENGINE_REGISTRY[projectType].supportsLineScope) {
      diffRanges = baselineLines(baselineKeys).map((l) => ({ start: l, end: l }));
    }
  }

  return { kind: 'scope', diffRanges, scopeNote, baselineKeys };
}

/**
 * Format a completed audit into the MCP tool response: verify-mode delta when a
 * baseline was supplied, otherwise the standard report plus a trailing note for
 * any StrykerJS-only options the resolved engine ignored (audit Low#5).
 *
 * The non-verify branch builds the result payload once via `buildResultPayload`,
 * then returns both a text/JSON content block AND `structuredContent: payload`
 * so callers can consume the structured data directly. Verify-mode is UNCHANGED.
 */
function formatAuditOutput(
  auditResults: MutationResult,
  args: ToolArgs,
  projectType: SupportedProjectType,
  baselineKeys: MutantKey[] | undefined,
  targetFile: string,
  enrichCtx: EnrichContext | undefined,
  cfg: ChaosConfig,
  env: EnvironmentInfo,
  suppressedCount: number,
  runId: string | undefined,
  relFromRoot: string,
): CallToolResult {
  if (baselineKeys) {
    // Task 9: filter suppressed equivalent mutants from BOTH the baseline keys
    // AND the re-run result before computing the delta so known-equivalent mutants
    // never appear as "still surviving" or "now killed" — they vanish entirely.
    // Uses the same workspace-relative key (relFromRoot) as the standard audit
    // path (Task 7) so the two modes read identical suppression entries (A9).
    const suppressed = loadSuppressions(env.workspaceRoot, cfg.suppressionsPath).get(relFromRoot);
    const rerun = applySuppressions(auditResults, suppressed).result;
    const keptBaseline = suppressed
      ? baselineKeys.filter((k) => !suppressed.has(`${k.line} ${k.mutator}`))
      : baselineKeys;
    // Whole-file engines (cosmic-ray/cargo-mutants/Infection) re-run the entire
    // file in verify mode, so regressions can land on lines outside the baseline;
    // pass the engine's line-scope capability so those are counted (audit H1).
    const supportsLineScope = ENGINE_REGISTRY[projectType].supportsLineScope;
    const delta = computeVerifyDelta(keptBaseline, rerun, supportsLineScope);
    const verifyText =
      args.outputFormat === 'text'
        ? formatVerifyResultAsText(targetFile, delta)
        : formatVerifyResultAsJson(targetFile, delta);
    // Verify responses must carry `structuredContent` too — the tool declares an
    // `outputSchema` whose `oneOf` includes this verify-delta shape (audit H3).
    const verifyStructured: Record<string, unknown> = {
      target: targetFile,
      mode: 'verify',
      baselineTotal: delta.baselineTotal,
      killedCount: delta.nowKilled.length,
      nowKilled: delta.nowKilled,
      stillSurviving: delta.stillSurviving,
      newSurvivors: delta.newSurvivors,
      note: buildVerifyNote(delta),
    };
    return {
      content: [{ type: 'text', text: verifyText }],
      structuredContent: verifyStructured,
    };
  }

  const enrichOpts = {
    enrich: enrichCtx,
    maxSurvivors: resolveMaxSurvivors(args, cfg),
    severityFloor: resolveSeverityFloor(args, cfg),
  };
  const ignored = ignoredOptionsFor(projectType, args);
  const suggestion =
    auditResults.survived > 0 || auditResults.vulnerabilities.length > 0
      ? suggestTestFile(targetFile, projectType, env.workspaceRoot)
      : undefined;

  const gate =
    typeof args.minScore === 'number'
      ? evaluateGate(auditResults.mutationScore, args.minScore)
      : undefined;

  const payload = buildResultPayload(auditResults, {
    ...enrichOpts,
    suggestedTestFile: suggestion,
    ignoredOptions: ignored.length > 0 ? ignored : undefined,
    runId,
    suppressedCount,
    gate,
  });

  const text =
    args.outputFormat === 'text'
      ? formatResultAsText(auditResults, enrichCtx, enrichOpts)
      : JSON.stringify(payload);

  const content: { type: 'text'; text: string }[] = [{ type: 'text', text }];

  // Surface options the resolved engine silently ignores so the caller knows
  // they had no effect (audit Low#5). Kept as a separate trailing content
  // block so it never corrupts the JSON/text payload above.
  if (ignored.length > 0) {
    content.push({
      type: 'text',
      text: `Note: the following option(s) are not supported by the ${projectType} engine and were ignored: ${ignored.join(', ')}.`,
    });
  }

  return { content, structuredContent: payload as unknown as Record<string, unknown> };
}

/**
 * Handle tool invocations.
 * Dispatches to the appropriate mutation engine based on file extension.
 *
 * Extracted as a named export so it can be unit-tested without starting the server.
 *
 * @param request - The MCP tool call request.
 * @param config - Optional ChaosConfig loaded from a config file. Tool call arguments
 *   override config defaults.
 * @param ctx - Optional per-request context: abort signal + progress reporter.
 *   When omitted (existing callers), all ctx-gated behaviour is no-op.
 */
export async function handleToolCall(
  request: CallToolRequest,
  config?: ChaosConfig,
  ctx?: ToolContext,
): Promise<CallToolResult> {
  if (request.params.name !== 'audit_code_resilience') {
    // Return the standard isError tool-result shape (not a raw throw / JSON-RPC
    // protocol error) so an unknown tool name is reported consistently with every
    // other failure (audit I1).
    return toolError(`Unknown tool: ${request.params.name}`);
  }

  // Abort short-circuit #1 — before any validation work.
  if (ctx?.signal?.aborted) return toolError('Operation cancelled.');

  // Milestone 1: signal that argument validation is beginning.
  ctx?.reportProgress?.(1, 4, 'validating');

  const rawFilePath = request.params.arguments?.filePath;

  // ── Audit C2 — validate filePath before any other work ──
  // Reject missing, non-string, or empty paths with a clear MCP error.
  if (typeof rawFilePath !== 'string' || rawFilePath.length === 0) {
    return toolError(
      'filePath is required and must be a non-empty string. Example: "src/utils/math.ts".',
    );
  }

  // Reject paths that resolve outside the current process cwd — defends
  // against an LLM being tricked into auditing arbitrary host files.
  const rootCwd = resolve(process.cwd());
  const resolvedFile = resolve(rootCwd, rawFilePath);
  if (!isRealPathInside(resolvedFile, rootCwd)) {
    return toolError(
      `Error: filePath must resolve within the workspace (${rootCwd}); received "${rawFilePath}".`,
    );
  }
  const filePath = rawFilePath;

  try {
    const projectType = detectProjectType(filePath);

    if (projectType === 'unsupported') {
      return toolError(`Error: Extension unsupported for file target ${filePath}`);
    }

    // Auto-detect the workspace environment (test runner, workspace root)
    const env = detectEnvironment(filePath);
    const engine = makeEngine(projectType);

    // Re-anchor the target to the detected workspace root. `filePath` is
    // relative to process.cwd(), but the sandbox copies `env.workspaceRoot`
    // (which can be a subdirectory of cwd in a monorepo). Both the sandbox
    // file-exists check and the engine's mutate target must therefore use the
    // path relative to the workspace root, not to cwd. (High#1 / Med#9.)
    // Fall back to the original path when the root is not a real ancestor of
    // the file (defensive — in production the clamp guarantees it is).
    const relFromRoot = relative(env.workspaceRoot, resolvedFile);
    const targetFile =
      relFromRoot.length > 0 && !relFromRoot.startsWith('..') && !isAbsolute(relFromRoot)
        ? relFromRoot
        : filePath;

    // Validate ALL tool arguments before any expensive work. Provisioning the
    // sandbox copies the whole workspace tree; doing it before validation would
    // waste a full copy + cleanup on input we could reject for free (audit Med#8).
    const earlyArgs = request.params.arguments ?? {};

    // Audit finding M7: reject ignorePatterns arrays containing non-string
    // elements explicitly instead of silently filtering them out.
    let earlyIgnorePatterns: string[] | undefined;
    if (earlyArgs.ignorePatterns !== undefined) {
      if (
        !Array.isArray(earlyArgs.ignorePatterns) ||
        earlyArgs.ignorePatterns.some((v) => typeof v !== 'string')
      ) {
        return toolError(
          'ignorePatterns must be an array of strings. Example: [".test.ts", "fixtures/"].',
        );
      }
      earlyIgnorePatterns = earlyArgs.ignorePatterns as string[];
    }

    // Strict argument validation (H5 / M5 / perMutantTimeoutMs / prebuildCommand).
    const argError = validateToolArgs(earlyArgs);
    if (argError) return argError;

    // Resolve the line scope (diff-aware A2 + verify-mode A3) on the REAL tree
    // before the sandbox copy, so a "no changes" diff can short-circuit.
    // Key verify-by-runId by the workspace-relative path (the same expression
    // triage uses: `relative(env.workspaceRoot, resolvedFile)` == relFromRoot),
    // so audit and triage agree on the cache key. Stays within workspaceRoot (C2).
    const scope = await computeScope(
      earlyArgs,
      targetFile,
      env,
      projectType,
      config ?? {},
      relFromRoot,
    );
    if (scope.kind === 'result') {
      // Emit complete only on successful short-circuits (no-changes = no isError).
      if (!scope.result.isError) ctx?.reportProgress?.(4, 4, 'complete');
      return scope.result;
    }
    const { diffRanges, scopeNote, baselineKeys } = scope;

    // Abort short-circuit #2 — after scope resolution, before sandbox provisioning.
    if (ctx?.signal?.aborted) return toolError('Operation cancelled.');

    // Milestone 2: sandbox copy is about to be provisioned.
    ctx?.reportProgress?.(2, 4, 'provisioning sandbox');

    // Provision a sandbox so mutation runs never touch the real workspace tree.
    let sandbox;
    try {
      sandbox = createSandbox(targetFile, env.workspaceRoot, earlyIgnorePatterns);
    } catch {
      return toolError(
        `Chaos Engine Halted: Failed to provision sandbox isolation for ${filePath}. Ensure the file exists and the workspace is accessible.`,
      );
    }

    try {
      const args = request.params.arguments ?? {};
      const cfg = config ?? {};

      if (isVerbose()) {
        const engCfg = cfg[ENGINE_REGISTRY[projectType].configKey];
        log('Tool call: audit_code_resilience');
        log(`  filePath: ${filePath}`);
        log(`  projectType: ${projectType}`);
        log(`  testRunner: ${env.testRunner} (detected: ${env.detectedRunner})`);
        if (env.packageManager) log(`  packageManager: ${env.packageManager}`);
        log(`  workspaceRoot: ${env.workspaceRoot}`);
        log(`  sandboxDir: ${sandbox.workDir}`);
        if (cfg.defaultTimeoutMs) log(`  config.timeoutMs: ${cfg.defaultTimeoutMs}`);
        if (cfg.mutatorDenylist) log(`  config.mutatorDenylist: ${cfg.mutatorDenylist.join(', ')}`);
        if (cfg.perMutantTimeoutMs) log(`  config.perMutantTimeoutMs: ${cfg.perMutantTimeoutMs}`);
        if (engCfg) log(`  engineConfig (${projectType}):`, JSON.stringify(engCfg));
      }

      // Resolve + gate the prebuild command (explicit prebuild is opt-in).
      const prebuildCmd = resolvePrebuildCommand(args, env, projectType);
      if (prebuildCmd !== null) {
        const prebuildExplicit =
          typeof args.prebuildCommand === 'string' && args.prebuildCommand.trim().length > 0;
        if (prebuildExplicit && !isPrebuildAllowed(cfg)) {
          return toolError(
            'prebuildCommand runs an arbitrary shell command that can reach outside the sandbox, ' +
              'so it is disabled by default. Enable it with "allowPrebuild": true in your config ' +
              'file or by setting the CHAOS_MCP_ALLOW_PREBUILD=1 environment variable.',
          );
        }
      }

      // Abort short-circuit #3 — after prebuild gate, before engine run.
      // The sandbox finally-block still cleans up even when we return here.
      if (ctx?.signal?.aborted) return toolError('Operation cancelled.');

      // Milestone 3: mutation engine is about to start.
      ctx?.reportProgress?.(3, 4, 'running mutation engine');

      let auditResults: MutationResult;
      try {
        auditResults = await auditFile({
          targetFile,
          env,
          projectType,
          engine,
          args,
          config: cfg,
          workDir: sandbox.workDir,
          prebuildCmd,
          lineRanges: diffRanges,
          signal: ctx?.signal,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        // A cancel firing DURING the engine run reaches here as a tool-specific
        // failure (each engine misreads the aborted child's null exit as a
        // baseline/report failure). Detect the abort and return the same
        // "Operation cancelled." shape as the phase-boundary checks, so a
        // deliberate cancel never masquerades as a phantom tool bug (audit M5).
        if (
          ctx?.signal?.aborted ||
          (error instanceof ExecFailureError && error.code === 'ABORTED')
        ) {
          return toolError('Operation cancelled.');
        }
        // Prebuild failures keep their specific tool error; engine errors
        // propagate to the outer catch (unchanged behavior).
        if (message.startsWith('Prebuild command failed in sandbox:')) {
          return toolError(message);
        }
        throw error;
      }
      if (scopeNote) auditResults.scopeNote = scopeNote;

      // Suppression writes (explicit user action) happen first so the same
      // call reflects them. Then auto-filter equivalent mutants from the result.
      // C2 boundary: writes land under env.workspaceRoot (or cfg.suppressionsPath),
      // keyed by the WORKSPACE-RELATIVE path (relFromRoot, the same expression
      // triage uses) so the suppressions file is portable/committable and audit
      // and triage agree on the key — never outside the workspace.
      const wsRoot = env.workspaceRoot;
      const supPath = cfg.suppressionsPath;
      try {
        if (Array.isArray(args.suppress) && args.suppress.length > 0) {
          addSuppressions(
            wsRoot,
            relFromRoot,
            args.suppress as { line: number; mutator: string; reason?: string }[],
            supPath,
          );
        }
        if (Array.isArray(args.unsuppress) && args.unsuppress.length > 0) {
          removeSuppressions(
            wsRoot,
            relFromRoot,
            args.unsuppress as { line: number; mutator: string }[],
            supPath,
          );
        }
      } catch (error: unknown) {
        // A write failure surfaces a specific error rather than the generic
        // "Chaos Engine Halted" (Fix 4). Sandbox cleanup still runs via finally.
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to update suppression list: ${message}`);
      }
      // Filter only for non-verify runs. In verify mode (baselineKeys set), the
      // filter is owned by Task 9: removing a now-suppressed mutant from the
      // re-run but NOT from the baseline would make computeVerifyDelta misreport
      // it as "now killed" (Fix 2). Writes above remain ungated (explicit action).
      let suppressedCount = 0;
      if (!baselineKeys) {
        const suppressed = loadSuppressions(wsRoot, supPath).get(relFromRoot);
        const filtered = applySuppressions(auditResults, suppressed);
        auditResults = filtered.result;
        suppressedCount = filtered.suppressedCount;
      }

      // Mint a runId for non-verify runs so the caller can verify later by id.
      // A cache failure is non-fatal: omit the runId rather than fail the audit.
      let mintedRunId: string | undefined;
      if (!baselineKeys) {
        try {
          const compact = buildResultPayload(auditResults, {});
          mintedRunId = saveRun(
            {
              // Workspace-relative key (relFromRoot) so the cached run matches
              // the verify-by-runId check and triage (Task 8) on the same file.
              file: relFromRoot,
              projectType,
              survivors: compact.survivors.map((g) => ({ line: g.line, mutators: g.mutators })),
              noCoverage: compact.noCoverage.map((g) => ({ line: g.line, mutators: g.mutators })),
            },
            { ttlMs: cfg.runCacheTtlMs, max: cfg.runCacheMax },
          );
        } catch {
          mintedRunId = undefined; // cache failure is non-fatal; omit runId
        }
      }

      const enrichCtx = buildEnrichContext(args, resolvedFile, projectType);
      // Milestone 4: every successful terminal path reports complete.
      ctx?.reportProgress?.(4, 4, 'complete');
      return formatAuditOutput(
        auditResults,
        args,
        projectType,
        baselineKeys,
        targetFile,
        enrichCtx,
        cfg,
        env,
        suppressedCount,
        mintedRunId,
        relFromRoot,
      );
    } finally {
      // Always clean up the sandbox, even if the engine threw
      sandbox.cleanup();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`Chaos Engine Halted: ${message}`);
  }
}
