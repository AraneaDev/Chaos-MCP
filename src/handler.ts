/**
 * The `audit_code_resilience` tool entry point.
 *
 * This module is the ORCHESTRATOR and nothing else: it sequences the phases of
 * one audit — validate → scope → sandbox → audit → suppress → format — and owns
 * the per-phase early returns (abort checks, budget exhaustion, sandbox
 * cleanup) that make the order load-bearing. Every phase's substance lives in
 * a dedicated module under `src/audit/` (Finding 2).
 */
import { validateFilePath } from './utils/file-path.js';
import { anchorToWorkspace } from './utils/workspace-anchor.js';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext } from './tool-context.js';
import { toolError, mapCreateSandboxError } from './tool-result.js';
import type { BaseEngine, MutationResult } from './engines/base.js';
import { ENGINE_REGISTRY, makeEngine, type SupportedProjectType } from './engines/registry.js';
import { detectProjectType, detectEnvironment, EnvironmentInfo } from './utils/project-detector.js';
import { createSandbox } from './utils/sandbox.js';
import { isCancel } from './utils/cancel.js';
import { ChaosConfig } from './utils/config-loader.js';
import { log, isVerbose } from './utils/logger.js';
import { ToolArgs, TOOL_ARG_VALIDATORS } from './tool-args-validation.js';
import { mintRunId } from './utils/run-cache.js';
import { buildResultPayload } from './format.js';
import { applySuppressions } from './audit/apply-suppressions.js';
import { AuditDeadline } from './utils/deadline.js';
import { resolveAuditTimeoutMs, resolveGatedPrebuild } from './audit/run-options.js';
import { auditFile, assertPythonHasTests, type AuditFileInput } from './audit/audit-file.js';
import { computeScope } from './audit/scope.js';
import {
  buildEnrichContext,
  formatAuditOutput,
  type SuppressionCounts,
} from './audit/audit-output.js';
import { applySuppressionArgs, loadVerifiedSuppressions } from './audit/suppression-io.js';

/**
 * Validate the optional tool arguments that are not covered by the JSON schema's
 * coarse typing. Returns an error {@link CallToolResult} combining ALL failures
 * (M2), or `null` when every provided argument is well-formed.
 *
 * The per-argument rules themselves live in `tool-args-validation.ts`; this is
 * only the MCP-shaped wrapper around them.
 */
export function validateToolArgs(args: ToolArgs): CallToolResult | null {
  const errors: string[] = [];
  for (const validate of TOOL_ARG_VALIDATORS) {
    const message = validate(args);
    if (message !== null) errors.push(message);
  }
  if (errors.length === 0) return null;
  if (errors.length === 1) return toolError(errors[0]);
  return toolError(`Multiple argument errors (${errors.length}):\n  - ${errors.join('\n  - ')}`);
}

/** Everything the phases downstream of path validation need about the target. */
interface AuditTarget {
  projectType: SupportedProjectType;
  env: EnvironmentInfo;
  engine: BaseEngine;
  /** Path to mutate, expressed relative to the detected workspace root. */
  targetFile: string;
  /** Workspace-relative key for the run cache and the suppressions file. */
  relFromRoot: string;
}

/**
 * Resolve the audited file into an engine + environment + workspace-relative
 * target, or a ready-to-return error for an unsupported extension.
 *
 * Takes the ALREADY-validated path rather than the raw request: `validateFilePath`
 * runs outside `handleToolCall`'s try/catch (it reports its own rejections and
 * must not be re-labelled "Chaos Engine Halted"), whereas everything here
 * touches the filesystem and is deliberately inside it.
 */
function resolveTarget(
  filePath: string,
  resolvedFile: string,
): { kind: 'error'; result: CallToolResult } | { kind: 'target'; target: AuditTarget } {
  const projectType = detectProjectType(filePath);

  if (projectType === 'unsupported') {
    return {
      kind: 'error',
      result: toolError(`Error: Extension unsupported for file target ${filePath}`),
    };
  }

  // Auto-detect the workspace environment (test runner, workspace root)
  const env = detectEnvironment(filePath);
  const engine = makeEngine(projectType);

  // Re-anchor the target to the detected workspace root. `filePath` is
  // relative to process.cwd(), but the sandbox copies `env.workspaceRoot`
  // (which can be a subdirectory of cwd in a monorepo). Both the sandbox
  // file-exists check and the engine's mutate target must therefore use the
  // path relative to the workspace root, not to cwd. (High#1 / Med#9.)
  // Shared with estimate + triage via `anchorToWorkspace` — the three copies of
  // this expression could otherwise drift.
  const { relFromRoot, targetFile } = anchorToWorkspace(env.workspaceRoot, resolvedFile, filePath);

  return { kind: 'target', target: { projectType, env, engine, targetFile, relFromRoot } };
}

/**
 * Split what is left of the audit budget between the engine and the tail work.
 *
 * Reserves a small slice for report parsing, response formatting, and sandbox
 * cleanup; the engine and any prebuild share the remainder. Returns the
 * exhaustion message when too little is left for the engine to achieve anything.
 */
function reserveEngineBudget(
  deadline: AuditDeadline,
): { ok: true; remainingMs: number } | { ok: false; message: string } {
  const CLEANUP_RESERVE_MS = 2_000;
  const MIN_ENGINE_BUDGET_MS = 1_000;
  const remainingMs = deadline.remainingMs(CLEANUP_RESERVE_MS);
  if (remainingMs < MIN_ENGINE_BUDGET_MS) {
    return {
      ok: false,
      message: `Audit time budget exhausted before mutation execution after ${deadline.elapsedMs()}ms.`,
    };
  }
  return { ok: true, remainingMs };
}

/** Dump the resolved run context when verbose logging is on. */
function logAuditContext(
  filePath: string,
  projectType: SupportedProjectType,
  env: EnvironmentInfo,
  sandboxDir: string,
  cfg: ChaosConfig,
): void {
  const engCfg = cfg[ENGINE_REGISTRY[projectType].configKey];
  log('Tool call: audit_code_resilience');
  log(`  filePath: ${filePath}`);
  log(`  projectType: ${projectType}`);
  log(`  testRunner: ${env.testRunner} (detected: ${env.detectedRunner})`);
  if (env.packageManager) log(`  packageManager: ${env.packageManager}`);
  log(`  workspaceRoot: ${env.workspaceRoot}`);
  log(`  sandboxDir: ${sandboxDir}`);
  if (cfg.defaultTimeoutMs) log(`  config.timeoutMs: ${cfg.defaultTimeoutMs}`);
  if (cfg.mutatorDenylist) log(`  config.mutatorDenylist: ${cfg.mutatorDenylist.join(', ')}`);
  if (cfg.perMutantTimeoutMs) log(`  config.perMutantTimeoutMs: ${cfg.perMutantTimeoutMs}`);
  if (engCfg) log(`  engineConfig (${projectType}):`, JSON.stringify(engCfg));
}

/**
 * Run the engine and triage the failure modes that are NOT bugs: a cancel that
 * lands mid-run, and a prebuild failure (which keeps its specific message).
 * Anything else is rethrown to the outer "Chaos Engine Halted" handler.
 */
async function runEngine(
  input: AuditFileInput,
  ctx?: ToolContext,
): Promise<{ ok: true; results: MutationResult } | { ok: false; result: CallToolResult }> {
  try {
    return { ok: true, results: await auditFile(input) };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // A cancel firing DURING the engine run reaches here as a tool-specific
    // failure (each engine misreads the aborted child's null exit as a
    // baseline/report failure). Detect the abort via the shared
    // `isCancel` predicate so the message is identical to the phase-boundary
    // cancel paths; a deliberate cancel never masquerades as a phantom
    // tool bug (audit M5 / C1 follow-up).
    if (isCancel(error, ctx)) {
      return { ok: false, result: toolError('Operation cancelled.') };
    }
    // Prebuild failures keep their specific tool error; engine errors
    // propagate to the outer catch (unchanged behavior).
    if (message.startsWith('Prebuild command failed in sandbox:')) {
      return { ok: false, result: toolError(message) };
    }
    throw error;
  }
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

  // ── Audit C2 — validate filePath before any other work (now shared via
  //    validateFilePath; audit A3). ──
  const filePathResult = validateFilePath(request.params.arguments?.filePath);
  if (!filePathResult.ok) return toolError(filePathResult.message);
  const { resolvedFile, raw: filePath } = filePathResult.value;

  try {
    const resolved = resolveTarget(filePath, resolvedFile);
    if (resolved.kind === 'error') return resolved.result;
    const { projectType, env, engine, targetFile, relFromRoot } = resolved.target;

    // Validate ALL tool arguments before any expensive work. Provisioning the
    // sandbox copies the whole workspace tree; doing it before validation would
    // waste a full copy + cleanup on input we could reject for free (audit Med#8).
    const earlyArgs = request.params.arguments ?? {};

    // Strict argument validation (H5 / M5 / ignorePatterns M7 /
    // perMutantTimeoutMs / prebuildCommand).
    const argError = validateToolArgs(earlyArgs);
    if (argError) return argError;
    // Validated above as an array of strings, so the cast is a narrowing only.
    const earlyIgnorePatterns = earlyArgs.ignorePatterns as string[] | undefined;
    const cfg = config ?? {};
    const deadline = new AuditDeadline(resolveAuditTimeoutMs(earlyArgs, cfg, projectType));

    // Resolve the line scope (diff-aware A2 + verify-mode A3) on the REAL tree
    // before the sandbox copy, so a "no changes" diff can short-circuit.
    // Key verify-by-runId by the workspace-relative path (the same expression
    // triage uses: `relative(env.workspaceRoot, resolvedFile)` == relFromRoot),
    // so audit and triage agree on the cache key. Stays within workspaceRoot (C2).
    // The git calls run before the sandbox exists, so they get the request's
    // abort signal (a cancel must kill them, not orphan them) and what remains
    // of the audit's wall-clock budget (they spend from the same clock).
    const scope = await computeScope(earlyArgs, targetFile, env, projectType, cfg, relFromRoot, {
      signal: ctx?.signal,
      deadline,
    });
    if (scope.kind === 'result') {
      // Emit complete only on successful short-circuits (no-changes = no isError).
      if (!scope.result.isError) ctx?.reportProgress?.(4, 4, 'complete');
      return scope.result;
    }
    const { diffRanges, scopeNote, baselineKeys } = scope;
    if (deadline.expired()) {
      return toolError(
        `Audit time budget exhausted during scope resolution after ${deadline.elapsedMs()}ms.`,
      );
    }

    // Abort short-circuit #2 — after scope resolution, before sandbox provisioning.
    if (ctx?.signal?.aborted) return toolError('Operation cancelled.');

    // Python only: refuse a workspace with no test suite BEFORE the sandbox copy.
    if (projectType === 'python') {
      const noTests = assertPythonHasTests(env, config);
      if (noTests) return toolError(noTests);
    }

    // Milestone 2: sandbox copy is about to be provisioned.
    ctx?.reportProgress?.(2, 4, 'provisioning sandbox');

    // Provision a sandbox so mutation runs never touch the real workspace tree.
    // audit C1: createSandbox is async (event-loop-friendly fs.cp); abort
    // signal is forwarded so a mid-copy cancel from the MCP client cleans up.
    let sandbox;
    try {
      sandbox = await createSandbox(targetFile, env.workspaceRoot, earlyIgnorePatterns, {
        signal: ctx?.signal,
      });
    } catch (error: unknown) {
      return mapCreateSandboxError(error, filePath, ctx);
    }

    try {
      if (deadline.expired()) {
        return toolError(
          `Audit time budget exhausted during sandbox provisioning after ${deadline.elapsedMs()}ms.`,
        );
      }
      const budget = reserveEngineBudget(deadline);
      if (!budget.ok) return toolError(budget.message);
      const args: ToolArgs = {
        ...(request.params.arguments ?? {}),
        timeoutMs: budget.remainingMs,
      };

      if (isVerbose()) logAuditContext(filePath, projectType, env, sandbox.workDir, cfg);

      // Resolve + gate the prebuild command (explicit prebuild is opt-in).
      const prebuild = resolveGatedPrebuild(args, env, projectType, cfg);
      if (!prebuild.ok) return toolError(prebuild.message);

      // Abort short-circuit #3 — after prebuild gate, before engine run.
      // The sandbox finally-block still cleans up even when we return here.
      if (ctx?.signal?.aborted) return toolError('Operation cancelled.');

      // Milestone 3: mutation engine is about to start.
      ctx?.reportProgress?.(3, 4, 'running mutation engine');

      const engineRun = await runEngine(
        {
          targetFile,
          env,
          projectType,
          engine,
          args,
          config: cfg,
          workDir: sandbox.workDir,
          prebuildCmd: prebuild.prebuildCmd,
          lineRanges: diffRanges,
          signal: ctx?.signal,
        },
        ctx,
      );
      if (!engineRun.ok) return engineRun.result;
      let auditResults = engineRun.results;
      // Append rather than replace: the engine may already have set a scope
      // note of its own (e.g. "Partial audit: completed 3 of 7 batches"), and
      // overwriting it silently dropped the fact that the run was incomplete
      // from the text output, which prints only this one field.
      if (scopeNote) {
        auditResults.scopeNote = auditResults.scopeNote
          ? `${auditResults.scopeNote} ${scopeNote}`
          : scopeNote;
      }

      // Suppression writes (explicit user action) happen first so the same
      // call reflects them. Then auto-filter equivalent mutants from the result.
      // C2 boundary: writes land under env.workspaceRoot (or cfg.suppressionsPath),
      // keyed by the WORKSPACE-RELATIVE path (relFromRoot, the same expression
      // triage uses) so the suppressions file is portable/committable and audit
      // and triage agree on the key — never outside the workspace.
      const wsRoot = env.workspaceRoot;
      const supPath = cfg.suppressionsPath;
      try {
        // CodeRabbit finding: if the request aborts after auditFile resolves
        // but before these writes, a cancelled call could still mutate the
        // suppressions file. Guard the write block so cancellation stays
        // side-effect free.
        if (ctx?.signal?.aborted) return toolError('Operation cancelled.');
        await applySuppressionArgs(args, wsRoot, relFromRoot, supPath);
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
      //
      // Only fingerprint-verified entries filter the result. Drifted and
      // unverified entries are counted and reported instead — including the
      // entries just written above whose source line could not be read, which
      // land in `unverified` in this very response.
      const suppression: SuppressionCounts = { applied: 0, drifted: 0, unverified: 0 };
      if (!baselineKeys) {
        const verdict = loadVerifiedSuppressions(wsRoot, relFromRoot, supPath);
        const filtered = applySuppressions(auditResults, verdict.applied);
        auditResults = filtered.result;
        suppression.applied = filtered.suppressedCount;
        suppression.drifted = verdict.drifted;
        suppression.unverified = verdict.unverified;
      }

      // Mint a runId for non-verify runs so the caller can verify later by id.
      // Keyed by relFromRoot so the cached run matches the verify-by-runId
      // check and triage (Task 8) on the same file.
      // The compact payload is built HERE, not inside mintRunId: run-cache.ts is
      // a leaf util and may not import the domain-layer format module. The
      // try/catch keeps mintRunId's old contract intact — it used to swallow a
      // payload-construction failure too, and minting a runId must never cost
      // the caller the audit it asked for.
      //
      // `workspaceRoot` stamps the entry's workspace fingerprint (audit M10).
      // `relFromRoot` alone is a workspace-RELATIVE key, so without it a runId
      // minted for workspace A's `src/index.ts` satisfied the verify path's
      // `cached.file === relFile` check while pointed at workspace B's
      // `src/index.ts` — a different file — and the verify graded B's code
      // against A's mutants. `audit/scope.ts` now REFUSES an entry that carries
      // no hash, so omitting this here would break verify-by-runId outright.
      let mintedRunId: string | undefined;
      if (!baselineKeys) {
        try {
          mintedRunId = mintRunId(buildResultPayload(auditResults, {}), relFromRoot, projectType, {
            ttlMs: cfg.runCacheTtlMs,
            max: cfg.runCacheMax,
            workspaceRoot: env.workspaceRoot,
          });
        } catch {
          mintedRunId = undefined;
        }
      }

      const enrichCtx =
        // Skip the synchronous source read for verify-mode re-runs: the
        // formatAuditOutput verify branch never consumes the enrichment
        // context, and verify-mode callers pay twice (here AND in
        // buildEnrichContext) without it producing any output (audit A2).
        baselineKeys ? undefined : buildEnrichContext(args, resolvedFile, projectType);
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
        suppression,
        mintedRunId,
        relFromRoot,
      );
    } finally {
      // Always clean up the sandbox, even if the engine threw
      sandbox.cleanup();
    }
  } catch (error: unknown) {
    // Audit C1 follow-up: cancellation must surface as 'Operation cancelled.' —
    // never as 'Chaos Engine Halted' — so the caller can reliably branch on the
    // message; otherwise a deliberate cancel from the MCP client is
    // indistinguishable from a real engine failure. The reachable path is
    // `computeScope`, whose git calls run BEFORE the sandbox exists and now
    // re-throw an abort instead of flattening it into a `DiffResult`; the
    // engine-run and sandbox cancels are already caught by `runEngine` and
    // `mapCreateSandboxError` above. Matches estimate-handler.ts and
    // triage/audit-one.ts, which carry the identical branch.
    if (isCancel(error, ctx)) {
      return toolError('Operation cancelled.');
    }
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`Chaos Engine Halted: ${message}`);
  }
}
