/**
 * Option resolution for a mutation audit: everything that turns
 * (tool arguments + config file + detected environment) into the {@link RunOptions}
 * an engine consumes, plus the sibling resolvers that answer the same
 * "arg, then config, then default" question for the reporting caps and for the
 * prebuild opt-in.
 *
 * Extracted verbatim from `handler.ts` (Finding 2). Nothing here touches the
 * MCP protocol, the sandbox, or the filesystem: it is pure precedence logic,
 * which is why it was the largest cohesive block in the old handler.
 */
import type { RunOptions } from '../engines/base.js';
import {
  ENGINE_REGISTRY,
  resolvePrebuildCommand,
  type SupportedProjectType,
} from '../engines/registry.js';
import type { detectProjectType, EnvironmentInfo } from '../utils/project-detector.js';
import type { ChaosConfig } from '../utils/config-loader.js';
import type { ToolArgs } from '../tool-args-validation.js';
import type { Severity } from '../enrich.js';
import { incrementalCachePath } from '../utils/incremental-cache.js';
import { buildVitestRelatedCommand } from '../utils/shell-quote.js';
import { DEFAULT_TIMEOUT_MS } from '../utils/constants.js';

/** The project types `detectProjectType` can report, including `'unsupported'`. */
export type ProjectType = ReturnType<typeof detectProjectType>;

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

/**
 * The caller-supplied `prebuildCommand` tool argument, or `undefined` when
 * absent or blank (a whitespace-only string is treated as "not supplied", and
 * the value is returned VERBATIM — untrimmed — when it is supplied).
 *
 * This is the one place the argument's spelling is read. It used to live inside
 * `resolvePrebuildCommand` in engines/registry.ts, which meant the engine layer
 * imported `ToolArgs` from the handler layer for a `Record<string, unknown>`
 * index access: no type safety whatsoever, and renaming the schema property
 * would have silently stopped honouring it with no compile error. Two callers
 * need the answer — the resolver below and the `allowPrebuild` gate — so both
 * take it from here and cannot disagree about what "explicit" means.
 */
function explicitPrebuildCommand(args: ToolArgs): string | undefined {
  return typeof args.prebuildCommand === 'string' && args.prebuildCommand.trim().length > 0
    ? args.prebuildCommand
    : undefined;
}

/**
 * Resolve the prebuild command and apply the opt-in gate: an EXPLICIT
 * `prebuildCommand` runs an arbitrary shell command that can reach outside the
 * sandbox, so it is refused unless the operator enabled it (see
 * {@link isPrebuildAllowed}). Auto-resolved prebuilds (from the engine registry)
 * are not gated.
 */
export function resolveGatedPrebuild(
  args: ToolArgs,
  env: EnvironmentInfo,
  projectType: SupportedProjectType,
  cfg: ChaosConfig,
): { ok: true; prebuildCmd: string | null } | { ok: false; message: string } {
  const explicit = explicitPrebuildCommand(args);
  const prebuildCmd = resolvePrebuildCommand(explicit, env, projectType);
  if (prebuildCmd !== null) {
    const prebuildExplicit = explicit !== undefined;
    if (prebuildExplicit && !isPrebuildAllowed(cfg)) {
      return {
        ok: false,
        message:
          'prebuildCommand runs an arbitrary shell command that can reach outside the sandbox, ' +
          'so it is disabled by default. Enable it with "allowPrebuild": true in your config ' +
          'file or by setting the CHAOS_MCP_ALLOW_PREBUILD=1 environment variable.',
      };
    }
  }
  return { ok: true, prebuildCmd };
}

/**
 * StrykerJS-only tool options that the other engines silently ignore.
 *
 * `concurrency` is the exception: it lives here because cosmic-ray (Python)
 * discards it, but cargo-mutants and Infection DO honour it — so it is filtered
 * per-engine in {@link ignoredOptionsFor} rather than reported unconditionally.
 */
export const STRYKER_ONLY_OPTIONS = [
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
export function ignoredOptionsFor(projectType: ProjectType, args: ToolArgs): string[] {
  const descriptor = ENGINE_REGISTRY[projectType as SupportedProjectType];
  // StrykerJS (configKey 'stryker') honours every option in the list.
  if (descriptor?.configKey === 'stryker') return [];
  return STRYKER_ONLY_OPTIONS.filter((opt) => {
    if (args[opt] === undefined) return false;
    if (opt === 'concurrency') return descriptor?.honorsConcurrency === false;
    return true;
  });
}

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

/** Resolve the single wall-clock budget shared by every phase of an audit. */
export function resolveAuditTimeoutMs(
  args: ToolArgs,
  cfg: ChaosConfig,
  projectType: ProjectType,
): number {
  const configKey = ENGINE_REGISTRY[projectType as SupportedProjectType]?.configKey;
  const engCfg = configKey ? cfg[configKey] : undefined;
  return typeof args.timeoutMs === 'number' && args.timeoutMs > 0
    ? args.timeoutMs
    : (engCfg?.timeoutMs ?? cfg.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
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
  targetFile?: string,
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
  const testRunner = engineTestRunner ?? cfg.testRunner ?? env.testRunner;
  // Trusted iff it came from the operator's config file rather than from
  // scanning the audited workspace. The Python engine executes this string as a
  // shell command, and workspace detection can source it from the project's own
  // pyproject.toml — see isRepoTestCommandAllowed in engines/python.ts.
  const testRunnerTrusted = engineTestRunner !== undefined || cfg.testRunner !== undefined;

  return {
    testRunner,
    testRunnerTrusted,
    commandRunnerCommand:
      projectType === 'typescript' &&
      testRunner === 'command' &&
      env.detectedRunner === 'vitest' &&
      targetFile
        ? buildVitestRelatedCommand(targetFile)
        : undefined,
    workDir,
    timeoutMs: resolveAuditTimeoutMs(args, cfg, projectType),
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
    // Home for the incremental file OUTSIDE the disposable sandbox — resolved
    // here because only the handler knows the workspace root. Without it the
    // `incremental` option cannot do anything (utils/incremental-cache.ts).
    incrementalCachePath: targetFile
      ? incrementalCachePath(env.workspaceRoot, targetFile)
      : undefined,
    perMutantTimeoutMs: resolvePositiveMs(
      args.perMutantTimeoutMs,
      cfg.stryker?.perMutantTimeoutMs ?? cfg.perMutantTimeoutMs,
    ),
    // `ignorePatterns` is deliberately NOT forwarded: it governs what the
    // SANDBOX COPY excludes and is consumed by createSandbox directly (see
    // handleToolCall). Carrying it on RunOptions too implied engines filtered
    // on it as well, which none ever did.
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
export function resolveMaxSurvivors(args: ToolArgs, cfg: ChaosConfig): number {
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
export function resolveSeverityFloor(args: ToolArgs, cfg: ChaosConfig): Severity | undefined {
  const a = args.severityFloor;
  if (a === 'high' || a === 'medium' || a === 'low') return a;
  return cfg.defaultSeverityFloor;
}
