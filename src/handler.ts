import { resolve, isAbsolute, relative, join } from 'path';
import { existsSync } from 'fs';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TypeScriptEngine } from './engines/typescript.js';
import { PythonEngine } from './engines/python.js';
import { GoEngine } from './engines/go.js';
import { RustEngine } from './engines/rust.js';
import { BaseEngine, RunOptions } from './engines/base.js';
import { detectProjectType, detectEnvironment, EnvironmentInfo } from './utils/project-detector.js';
import { createSandbox } from './utils/sandbox.js';
import { runShellCommand } from './utils/exec.js';
import { ChaosConfig } from './utils/config-loader.js';
import { log, isVerbose } from './utils/logger.js';
import { formatResultAsText, formatResultAsJson } from './format.js';
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
function isPrebuildAllowed(cfg: ChaosConfig): boolean {
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
  if (projectType === 'typescript') return [];
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
  // Note: `args.key !== undefined` already covers the "absent key" case (an
  // absent key reads as undefined), so a separate `'key' in args` guard would
  // be redundant.

  // ── perMutantTimeoutMs: must be a positive number ──
  if (
    args.perMutantTimeoutMs !== undefined &&
    (typeof args.perMutantTimeoutMs !== 'number' || args.perMutantTimeoutMs <= 0)
  ) {
    return toolError('perMutantTimeoutMs must be a positive number. Example: 10000.');
  }

  // ── prebuildCommand: must be a non-empty string ──
  if (
    args.prebuildCommand !== undefined &&
    (typeof args.prebuildCommand !== 'string' ||
      (args.prebuildCommand as string).trim().length === 0)
  ) {
    return toolError('prebuildCommand must be a non-empty string. Example: "npm run build".');
  }

  // ── concurrency: integer 1..64 (H5) ──
  if (
    args.concurrency !== undefined &&
    (typeof args.concurrency !== 'number' ||
      !Number.isInteger(args.concurrency) ||
      args.concurrency < 1 ||
      args.concurrency > 64)
  ) {
    return toolError('concurrency must be an integer between 1 and 64 (Stryker workers).');
  }

  // ── lineScope: {start: int >=1, end: int >= start} (M5) ──
  if (args.lineScope !== undefined) {
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
      return toolError(
        'lineScope must be { start: integer >= 1, end: integer >= start }. Example: { start: 10, end: 45 }.',
      );
    }
  }

  // ── diffBase: non-empty string, not option-like, not with lineScope ──
  if (args.diffBase !== undefined) {
    if (typeof args.diffBase !== 'string' || args.diffBase.trim().length === 0) {
      return toolError(
        'diffBase must be a non-empty string: "HEAD", "staged", or a git ref. Example: "HEAD".',
      );
    }
    if (args.diffBase.startsWith('-')) {
      return toolError('diffBase must not start with "-" (it would be mistaken for a git option).');
    }
    if (args.lineScope !== undefined) {
      return toolError(
        'diffBase and lineScope are mutually exclusive — use one or the other, not both.',
      );
    }
  }

  // ── baseline (verify mode): object with survivors/noCoverage arrays; ──
  // mutually exclusive with diffBase and lineScope; must hold ≥1 (line, mutator). ──
  if (args.baseline !== undefined) {
    const b = args.baseline as Record<string, unknown> | null;
    if (b === null || typeof b !== 'object' || Array.isArray(b)) {
      return toolError(
        'baseline must be an object with optional "survivors" and "noCoverage" arrays from a prior run.',
      );
    }
    if (args.diffBase !== undefined || args.lineScope !== undefined) {
      return toolError(
        'baseline is mutually exclusive with diffBase and lineScope — use only one at a time.',
      );
    }
    let pairCount = 0;
    for (const key of ['survivors', 'noCoverage'] as const) {
      const arr = b[key];
      if (arr === undefined) continue;
      if (!Array.isArray(arr)) {
        return toolError(`baseline.${key} must be an array of { line, mutators } objects.`);
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
          return toolError(
            'each baseline entry must be { line: integer >= 1, mutators: object of mutator→count }.',
          );
        }
        pairCount += Object.keys(entry.mutators as Record<string, unknown>).length;
      }
    }
    if (pairCount === 0) {
      return toolError(
        'baseline must contain at least one (line, mutator) entry across survivors/noCoverage.',
      );
    }
  }

  return null;
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
  const engCfg =
    projectType === 'typescript'
      ? cfg.stryker
      : projectType === 'python'
        ? cfg.mutmut
        : projectType === 'go'
          ? cfg.go
          : projectType === 'rust'
            ? cfg.rust
            : undefined;

  // testRunner must come from the section that matches the engine being run.
  // Previously stryker.testRunner was consulted first for ALL project types,
  // so a Python audit could receive Stryker's runner (e.g. "vitest") and pass
  // it to mutmut (audit Med#2). Pick the engine-appropriate section only.
  const engineTestRunner =
    projectType === 'typescript'
      ? cfg.stryker?.testRunner
      : projectType === 'python'
        ? cfg.mutmut?.testRunner
        : undefined;

  return {
    testRunner: engineTestRunner ?? cfg.testRunner ?? env.testRunner,
    workDir,
    timeoutMs:
      typeof args.timeoutMs === 'number' && args.timeoutMs > 0
        ? args.timeoutMs
        : (engCfg?.timeoutMs ?? cfg.defaultTimeoutMs),
    lineScope:
      typeof args.lineScope === 'object' &&
      args.lineScope !== null &&
      !Array.isArray(args.lineScope) &&
      typeof (args.lineScope as Record<string, unknown>).start === 'number' &&
      typeof (args.lineScope as Record<string, unknown>).end === 'number'
        ? {
            start: (args.lineScope as Record<string, number>).start,
            end: (args.lineScope as Record<string, number>).end,
          }
        : undefined,
    // mutatorAllowlist is intentionally NOT propagated. StrykerJS v9 cannot
    // express an allowlist, so the TS engine rejects it; sourcing it here (from
    // args OR config) would make every TS run throw (High#3). Left undefined so
    // the engine's defensive guard never trips. mutatorDenylist is the supported
    // alternative.
    mutatorDenylist: Array.isArray(args.mutatorDenylist)
      ? (args.mutatorDenylist as string[]).filter((v) => typeof v === 'string')
      : (cfg.stryker?.mutatorDenylist ?? cfg.mutatorDenylist),
    concurrency:
      typeof args.concurrency === 'number' &&
      Number.isInteger(args.concurrency) &&
      args.concurrency >= 1 &&
      args.concurrency <= 64
        ? args.concurrency
        : (() => {
            const c = cfg.stryker?.concurrency ?? cfg.concurrency;
            if (typeof c === 'number' && Number.isInteger(c) && c >= 1 && c <= 64) return c;
            return undefined;
          })(),
    dryRun: typeof args.dryRun === 'boolean' ? args.dryRun : cfg.stryker?.dryRun,
    outputFormat:
      args.outputFormat === 'text' || args.outputFormat === 'json' ? args.outputFormat : undefined,
    incremental:
      typeof args.incremental === 'boolean' ? args.incremental : cfg.stryker?.incremental,
    perMutantTimeoutMs:
      typeof args.perMutantTimeoutMs === 'number' && args.perMutantTimeoutMs > 0
        ? args.perMutantTimeoutMs
        : (() => {
            const p = cfg.stryker?.perMutantTimeoutMs ?? cfg.perMutantTimeoutMs;
            if (typeof p === 'number' && p > 0) return p;
            return undefined;
          })(),
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
  // rebuild can pass an explicit prebuildCommand.
  if (projectType === 'go' && existsSync(join(env.workspaceRoot, 'go.mod'))) {
    return 'go mod download';
  }
  if (projectType === 'rust' && existsSync(join(env.workspaceRoot, 'Cargo.toml'))) {
    return 'cargo check';
  }
  return null;
}

/** Construct the engine for a (supported) project type. */
function makeEngine(projectType: Exclude<ProjectType, 'unsupported'>): BaseEngine {
  return projectType === 'typescript'
    ? new TypeScriptEngine()
    : projectType === 'python'
      ? new PythonEngine()
      : projectType === 'go'
        ? new GoEngine()
        : new RustEngine();
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
  if (!isPathInside(resolvedFile, rootCwd)) {
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

    // ── Diff-aware scoping (A2): compute changed ranges on the REAL tree
    // before the (expensive) sandbox copy, so "no changes" can short-circuit.
    let diffRanges: { start: number; end: number }[] | undefined;
    let scopeNote: string | undefined;
    const diffBase = typeof earlyArgs.diffBase === 'string' ? earlyArgs.diffBase : undefined;
    if (diffBase) {
      const diff = await computeChangedRanges(targetFile, env.workspaceRoot, diffBase);
      switch (diff.kind) {
        case 'not-a-repo':
          return toolError(
            `diffBase requires a git work tree, but "${env.workspaceRoot}" is not one. ` +
              'Remove diffBase or run inside a git repository.',
          );
        case 'bad-ref':
          return toolError(
            `diffBase "${diff.ref}" could not be resolved as a git ref (merge-base failed).`,
          );
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
            earlyArgs.outputFormat === 'text'
              ? formatResultAsText(empty)
              : formatResultAsJson(empty);
          return { content: [{ type: 'text', text }] };
        }
        case 'untracked':
          // File is new/untracked — every line is "changed", so mutate the
          // whole file, but tell the caller why it wasn't line-scoped.
          scopeNote = `${targetFile} is untracked in git vs ${diffBase}; mutated the whole file.`;
          break;
        case 'ranges':
          if (projectType === 'typescript') {
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
      if (projectType === 'typescript') {
        // Reuse the A2 scope channel (`diffRanges` → runOptions.lineRanges).
        // baseline is mutually exclusive with diffBase, so this never collides.
        diffRanges = baselineLines(baselineKeys).map((l) => ({ start: l, end: l }));
      }
    }

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
        const engCfg =
          projectType === 'typescript'
            ? cfg.stryker
            : projectType === 'python'
              ? cfg.mutmut
              : projectType === 'go'
                ? cfg.go
                : cfg.rust;
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

      const runOptions = buildRunOptions(args, cfg, env, sandbox.workDir, projectType);
      if (diffRanges) runOptions.lineRanges = diffRanges;

      // ── Run prebuild command in the sandbox (before any mutation tool) ──
      const prebuildCmd = resolvePrebuildCommand(args, env, projectType);
      if (prebuildCmd !== null) {
        // An explicit prebuildCommand runs an arbitrary shell command that can
        // reach outside the sandbox, so it must be opted into (audit Med#10).
        // Auto-detected prebuilds (go mod download, cargo check) are a fixed,
        // known-safe set and are not gated.
        const prebuildExplicit =
          typeof args.prebuildCommand === 'string' && args.prebuildCommand.trim().length > 0;
        if (prebuildExplicit && !isPrebuildAllowed(cfg)) {
          return toolError(
            'prebuildCommand runs an arbitrary shell command that can reach outside the sandbox, ' +
              'so it is disabled by default. Enable it with "allowPrebuild": true in your config ' +
              'file or by setting the CHAOS_MCP_ALLOW_PREBUILD=1 environment variable.',
          );
        }
        try {
          if (isVerbose()) {
            const autoLabel =
              env.packageManager && env.packageManager !== 'pip' ? env.packageManager : projectType;
            const source = prebuildExplicit ? 'explicit' : `auto (${autoLabel})`;
            log(`Running prebuild command in sandbox [${source}]: ${prebuildCmd}`);
          }
          const prebuildStart = Date.now();
          await runShellCommand(prebuildCmd, {
            cwd: sandbox.workDir,
            timeoutMs: runOptions.timeoutMs, // prebuild may use up to the full budget
          });
          if (isVerbose()) log('Prebuild command completed successfully');
          // Deduct the time the prebuild consumed so `timeoutMs` bounds the WHOLE
          // run, not each phase independently (audit Med#3). Floors at 1ms so a
          // long prebuild still lets the engine start (it will time out quickly).
          if (typeof runOptions.timeoutMs === 'number') {
            const remaining = runOptions.timeoutMs - (Date.now() - prebuildStart);
            runOptions.timeoutMs = remaining > 0 ? remaining : 1;
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return toolError(`Prebuild command failed in sandbox: ${message}`);
        }
      }

      // Apply output format to the final response
      const auditResults = await engine.run(targetFile, runOptions);
      if (scopeNote) auditResults.scopeNote = scopeNote;
      if (baselineKeys) {
        const delta = computeVerifyDelta(baselineKeys, auditResults);
        const verifyText =
          runOptions.outputFormat === 'text'
            ? formatVerifyResultAsText(targetFile, delta)
            : formatVerifyResultAsJson(targetFile, delta);
        return { content: [{ type: 'text', text: verifyText }] };
      }
      const text =
        runOptions.outputFormat === 'text'
          ? formatResultAsText(auditResults)
          : formatResultAsJson(auditResults);

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
    } finally {
      // Always clean up the sandbox, even if the engine threw
      sandbox.cleanup();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`Chaos Engine Halted: ${message}`);
  }
}
