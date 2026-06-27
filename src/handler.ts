import { resolve, isAbsolute, relative, join } from 'path';
import { existsSync, realpathSync, readFileSync } from 'fs';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BaseEngine, RunOptions, MutationResult } from './engines/base.js';
import { ENGINE_REGISTRY, type SupportedProjectType } from './engines/registry.js';
import { detectProjectType, detectEnvironment, EnvironmentInfo } from './utils/project-detector.js';
import { createSandbox } from './utils/sandbox.js';
import { runShellCommand } from './utils/exec.js';
import { ChaosConfig } from './utils/config-loader.js';
import { log, isVerbose } from './utils/logger.js';
import { formatResultAsText, formatResultAsJson, type EnrichContext } from './format.js';
import { computeChangedRanges } from './utils/git-diff.js';
import {
  parseBaseline,
  baselineLines,
  computeVerifyDelta,
  formatVerifyResultAsJson,
  formatVerifyResultAsText,
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
function toolError(text: string): CallToolResult {
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

/** StrykerJS-only tool options that the other engines silently ignore. */
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
 * Return the StrykerJS-only options the caller supplied that the resolved engine
 * will ignore. Empty for TypeScript targets (the engine that supports them).
 */
function ignoredOptionsFor(projectType: ProjectType, args: ToolArgs): string[] {
  // StrykerJS (the TypeScript engine, configKey 'stryker') is the only engine
  // that honours these options; every other engine silently ignores them.
  if (ENGINE_REGISTRY[projectType as SupportedProjectType]?.configKey === 'stryker') return [];
  return STRYKER_ONLY_OPTIONS.filter((opt) => args[opt] !== undefined);
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

/** Ordered per-field validators run by {@link validateToolArgs}. */
const TOOL_ARG_VALIDATORS: ((args: ToolArgs) => string | null)[] = [
  validatePerMutantTimeoutMs,
  validatePrebuildCommand,
  validateConcurrencyArg,
  validateLineScopeArg,
  validateDiffBaseArg,
  validateBaselineArg,
  validateEnrichArg,
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
  // it to mutmut (audit Med#2). Only the Stryker/Mutmut sections carry a
  // testRunner; the timeout-only Go/Rust sections don't (→ undefined, as before).
  const engineTestRunner =
    configKey === 'stryker'
      ? cfg.stryker?.testRunner
      : configKey === 'mutmut'
        ? cfg.mutmut?.testRunner
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
    concurrency: resolveConcurrency(args.concurrency, cfg.stryker?.concurrency ?? cfg.concurrency),
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
  };
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
  // rebuild can pass an explicit prebuildCommand. Go (`go mod download`) and
  // Rust (`cargo check`) declare their auto-prebuild in the engine registry.
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
  if (args.enrich !== true) return undefined;
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
        const text =
          earlyArgs.outputFormat === 'text' ? formatResultAsText(empty) : formatResultAsJson(empty);
        return { kind: 'result', result: { content: [{ type: 'text', text }] } };
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

  return { kind: 'scope', diffRanges, scopeNote, baselineKeys };
}

/**
 * Format a completed audit into the MCP tool response: verify-mode delta when a
 * baseline was supplied, otherwise the standard report plus a trailing note for
 * any StrykerJS-only options the resolved engine ignored (audit Low#5).
 */
function formatAuditOutput(
  auditResults: MutationResult,
  args: ToolArgs,
  projectType: SupportedProjectType,
  baselineKeys: MutantKey[] | undefined,
  targetFile: string,
  enrichCtx: EnrichContext | undefined,
): CallToolResult {
  if (baselineKeys) {
    // verify-mode delta keeps its own formatters; enrichment is not applied here.
    const delta = computeVerifyDelta(baselineKeys, auditResults);
    const verifyText =
      args.outputFormat === 'text'
        ? formatVerifyResultAsText(targetFile, delta)
        : formatVerifyResultAsJson(targetFile, delta);
    return { content: [{ type: 'text', text: verifyText }] };
  }

  const text =
    args.outputFormat === 'text'
      ? formatResultAsText(auditResults, enrichCtx)
      : formatResultAsJson(auditResults, enrichCtx);

  const content: { type: 'text'; text: string }[] = [{ type: 'text', text }];

  // Surface options the resolved engine silently ignores so the caller knows
  // they had no effect (audit Low#5). Kept as a separate trailing content
  // block so it never corrupts the JSON/text payload above.
  const ignored = ignoredOptionsFor(projectType, args);
  if (ignored.length > 0) {
    content.push({
      type: 'text',
      text: `Note: the following option(s) are StrykerJS-only and were ignored for this ${projectType} target: ${ignored.join(', ')}.`,
    });
  }

  return { content };
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
 */
export async function handleToolCall(
  request: CallToolRequest,
  config?: ChaosConfig,
): Promise<CallToolResult> {
  if (request.params.name !== 'audit_code_resilience') {
    throw new Error(`Method unrecognized: ${request.params.name}`);
  }

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
    const scope = await computeScope(earlyArgs, targetFile, env, projectType);
    if (scope.kind === 'result') return scope.result;
    const { diffRanges, scopeNote, baselineKeys } = scope;

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
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        // Prebuild failures keep their specific tool error; engine errors
        // propagate to the outer catch (unchanged behavior).
        if (message.startsWith('Prebuild command failed in sandbox:')) {
          return toolError(message);
        }
        throw error;
      }
      if (scopeNote) auditResults.scopeNote = scopeNote;
      const enrichCtx = buildEnrichContext(args, resolvedFile, projectType);
      return formatAuditOutput(
        auditResults,
        args,
        projectType,
        baselineKeys,
        targetFile,
        enrichCtx,
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
