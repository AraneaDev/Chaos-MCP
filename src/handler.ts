/**
 * The `audit_code_resilience` tool entry point.
 *
 * This module is the ORCHESTRATOR and nothing else: it sequences the phases of
 * one audit — validate → scope → sandbox → audit → suppress → format — and owns
 * the per-phase early returns (abort checks, budget exhaustion, sandbox
 * cleanup) that make the order load-bearing. Every phase's substance lives in
 * a dedicated module under `src/audit/` (Finding 2).
 */
import { cpus } from 'node:os';
import { validateFilePath } from './utils/file-path.js';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext } from './core/tool-context.js';
import { toolError, mapCreateSandboxError, mapHandlerFailure } from './core/tool-result.js';
import type { MutationResult } from './engines/base.js';
import { ENGINE_REGISTRY, makeEngine, type SupportedProjectType } from './engines/registry.js';
import { EnvironmentInfo } from './utils/project-detector.js';
import { resolveAuditTarget } from './audit/target.js';
import { createSandbox } from './utils/sandbox.js';
import { isCancel } from './utils/cancel.js';
import { isResourceExhausted } from './utils/resources/errors.js';
import { ChaosConfig } from './utils/config-loader.js';
import { log, isVerbose } from './utils/logger.js';
import { ToolArgs, TOOL_ARG_VALIDATORS } from './core/tool-args-validation.js';
import { mintRunIdSafely } from './audit/run-id.js';
import { AuditDeadline } from './utils/deadline.js';
import {
  resolveAuditTimeoutMs,
  resolveConfiguredConcurrency,
  resolveGatedPrebuild,
} from './audit/run-options.js';
import { auditFile, assertPythonHasTests, type AuditFileInput } from './audit/audit-file.js';
import { computeScope } from './audit/scope.js';
import { buildEnrichContext, formatAuditOutput } from './audit/audit-output.js';
import { applyAndCountSuppressions } from './audit/suppression-io.js';
import { createResourceContext, type ResourcesPayload } from './core/resource-context.js';

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

/**
 * The `concurrency` value to forward to an engine that honours it, or
 * `undefined` when none should be passed at all.
 *
 * Mirrors the clamp `buildPerFileArgs` (triage/audit-one.ts) already applies:
 * memory governance must never RAISE what the engine's own default already
 * is, so the budgeted worker count is capped at `defaultWorkers(cpuCount)`
 * for an engine that declares one. cargo-mutants' own low default answers a
 * memory question, not a CPU one, so a pool of 8 cores would otherwise raise
 * it from its own `-j 2` to as much as 7 — a ceiling that can raise the thing
 * it bounds is not a ceiling.
 *
 * When the caller configured nothing explicit AND the probe could not read
 * the machine, this returns `undefined` outright, so a single-file audit is
 * byte-identical to pre-governance behaviour: no `--concurrency` for
 * StrykerJS (which auto-scales to the core count) and no `-j` for
 * cargo-mutants (which falls back to its own low default).
 */
function resolveSingleFileConcurrency(
  projectType: SupportedProjectType,
  perFileWorkers: number,
  configuredConcurrency: number | undefined,
  probeSource: ResourcesPayload['source'],
): number | undefined {
  if (configuredConcurrency === undefined && probeSource === 'unavailable') return undefined;
  const ownDefault = ENGINE_REGISTRY[projectType].defaultWorkers?.(cpus().length);
  return ownDefault === undefined ? perFileWorkers : Math.min(perFileWorkers, ownDefault);
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
    // The watchdog's own abort reason must be checked BEFORE isCancel: the
    // controller it aborts is not the request's ctx.signal, but the killed
    // child process still misreads as an AbortError/ExecFailureError the same
    // way a user cancel does, so isCancel would otherwise report a memory stop
    // as "Operation cancelled." and hide what to lower.
    const abortReason = input.signal?.reason;
    if (isResourceExhausted(abortReason)) {
      // `.message` only (not `String(error)`, which prefixes the class name):
      // the caller needs "Stopped to avoid exhausting memory: ..." verbatim,
      // not "ResourceExhaustedError: ...".
      return {
        ok: false,
        result: toolError(abortReason instanceof Error ? abortReason.message : String(abortReason)),
      };
    }
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
    // `validateFilePath` ran outside this try/catch (it reports its own
    // rejections and must not be re-labelled "Chaos Engine Halted"); everything
    // from here touches the filesystem and is deliberately inside it.
    const target = resolveAuditTarget(filePath, resolvedFile);
    if (!target) return toolError(`Error: Extension unsupported for file target ${filePath}`);
    const { projectType, env, targetFile, relFromRoot } = target;
    const engine = makeEngine(projectType);

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

    // Size this one-file run to the memory the machine actually has: never
    // RAISES what the CPU-only math already chose (resolveBudget), only
    // lowers it, and the watchdog stops the newest run rather than letting it
    // exhaust memory. Created BEFORE sandbox provisioning (IMPORTANT 5) so a
    // trip during the copy uses the same abort path as a cancel — creating it
    // only once the sandbox already existed left that whole phase outside the
    // governed window, unable to be stopped by the watchdog at all. Torn down
    // in the same finally as the sandbox below so a long-lived server never
    // accumulates timers or abort listeners across requests.
    // The value that would reach the engine without governance (explicit tool
    // argument, else engine config section, else global config default) is
    // treated as the EXPLICIT setting Budget always honours; only the absence
    // of one falls back to a cpu-derived baseline that memory may lower.
    const configuredConcurrency = resolveConfiguredConcurrency(earlyArgs, cfg, projectType);
    const resources = createResourceContext({
      projectType,
      cpuFileConcurrency: 1,
      cpuPerFileWorkers: configuredConcurrency ?? cpus().length - 1,
      requested:
        configuredConcurrency === undefined ? undefined : { perFileWorkers: configuredConcurrency },
      watchdogEnabled: cfg.resources?.watchdog,
      admissionFloorBytes: cfg.resources?.admissionFloorBytes,
      criticalFloorBytes: cfg.resources?.criticalFloorBytes,
    });
    // Linked to the request's own signal (a user cancel must still stop this
    // run) but distinct from it, so a watchdog-triggered abort never flips
    // `ctx.signal.aborted` and is never mistaken for a user cancel downstream.
    const controller = new AbortController();
    const abortRequest = () => controller.abort(ctx?.signal?.reason);
    ctx?.signal?.addEventListener('abort', abortRequest, { once: true });
    // No cost argument: a single-file audit never admits against this
    // watchdog (the admission gate exists only on the triage path, IMPORTANT
    // 4), so there is nothing here for an in-flight reservation to protect.
    const handle = resources.watchdog.register(controller);

    try {
      // Milestone 2: sandbox copy is about to be provisioned.
      ctx?.reportProgress?.(2, 4, 'provisioning sandbox');

      // Provision a sandbox so mutation runs never touch the real workspace
      // tree. audit C1: createSandbox is async (event-loop-friendly fs.cp);
      // the GOVERNED controller's signal is forwarded (IMPORTANT 5) — linked
      // to the request's own signal via `abortRequest` above — so a mid-copy
      // cancel OR a watchdog trip during the copy both clean up the same way.
      let sandbox;
      try {
        sandbox = await createSandbox(targetFile, env.workspaceRoot, earlyIgnorePatterns, {
          signal: controller.signal,
          dependencies: cfg.sandbox?.dependencies,
        });
      } catch (error: unknown) {
        // Same ordering rule as `runEngine`: a watchdog trip must be reported
        // as a memory stop, never mistaken for the user cancel `isCancel`
        // (inside `mapCreateSandboxError`) would otherwise read `ctx.signal`
        // as unrelated to this run's own controller.
        if (isResourceExhausted(controller.signal.reason)) {
          return toolError(
            controller.signal.reason instanceof Error
              ? controller.signal.reason.message
              : String(controller.signal.reason),
          );
        }
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
        // Only for engines that honour `concurrency` (M1): cosmic-ray has no
        // worker-count flag, so forcing a value there would misreport as an
        // ignored option no caller ever asked for (ignoredOptionsFor). Clamped
        // (and possibly omitted outright) by resolveSingleFileConcurrency so
        // governance can only ever LOWER what the engine would otherwise do.
        const singleFileConcurrency = ENGINE_REGISTRY[projectType].honorsConcurrency
          ? resolveSingleFileConcurrency(
              projectType,
              resources.budget.perFileWorkers,
              configuredConcurrency,
              resources.report().source,
            )
          : undefined;
        const args: ToolArgs = {
          ...(request.params.arguments ?? {}),
          timeoutMs: budget.remainingMs,
          ...(singleFileConcurrency === undefined ? {} : { concurrency: singleFileConcurrency }),
          innerEnv: resources.innerEnv,
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
            signal: controller.signal,
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

        // Suppression phase: explicit writes, then the auto-filter (audit/suppression-io.ts).
        const suppressed = await applyAndCountSuppressions(
          args,
          auditResults,
          baselineKeys,
          env.workspaceRoot,
          relFromRoot,
          cfg.suppressionsPath,
          ctx,
        );
        if (!suppressed.ok) return suppressed.result;
        auditResults = suppressed.result;
        const suppression = suppressed.counts;

        // Mint a runId for non-verify runs so the caller can verify later by id
        // (audit/run-id.ts owns the swallowed-failure contract).
        const mintedRunId = mintRunIdSafely(
          auditResults,
          baselineKeys,
          relFromRoot,
          projectType,
          env.workspaceRoot,
          cfg,
        );

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
          resources.report(),
        );
      } finally {
        // Always clean up the sandbox, even if the engine threw
        sandbox.cleanup();
      }
    } finally {
      // Same rule for the resource context: release this run's watchdog slot,
      // stop its sampler, and drop the listener on the request's own signal, so
      // a long-lived server does not accumulate either across requests.
      handle.release();
      resources.dispose();
      ctx?.signal?.removeEventListener('abort', abortRequest);
    }
  } catch (error: unknown) {
    // The reachable path is `computeScope`, whose git calls run BEFORE the
    // sandbox exists and re-throw an abort instead of flattening it into a
    // `DiffResult`; the engine-run and sandbox cancels are already caught by
    // `runEngine` and `mapCreateSandboxError` above. `mapHandlerFailure` owns
    // the cancel-vs-halt branch for all three tools.
    return mapHandlerFailure(error, ctx);
  }
}
