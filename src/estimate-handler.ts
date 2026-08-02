import { statSync } from 'fs';
import { cpus } from 'os';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createSandbox } from './utils/sandbox.js';
import {
  toolError,
  mapCreateSandboxError,
  mapHandlerFailure,
  toStructuredContent,
} from './core/tool-result.js';
import { validateFilePath } from './utils/file-path.js';
import { validateTimeoutMs } from './core/tool-args-validation.js';
import { supportedTypeOf, anchorTarget } from './audit/target.js';
import { estimateAudit, estimateNeedsSandbox } from './core/estimate.js';
import type { ChaosConfig } from './utils/config-loader.js';
import type { ToolContext } from './core/tool-context.js';
import { DEFAULT_TIMEOUT_MS } from './utils/constants.js';
import { createExecutionSession } from './utils/execution.js';
import { buildRunOptions, resolveAuditTimeoutMs } from './audit/run-options.js';

export function resolveEstimateConcurrency(cpuCount: number): number {
  return Math.max(1, Math.min(2, cpuCount - 1));
}

/** True when the path exists and is a regular file (a directory is not a target). */
function isReadableFile(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Handle `estimate_audit` tool invocations.
 *
 * Returns a cheap pre-flight estimate (mutant count + optional timing) for a
 * single source file WITHOUT running the full mutation test cycle.
 *
 * Mirrors the opening of handleToolCall: C2 boundary check, projectType
 * detection, detectEnvironment, conditional sandbox, and the same
 * try/catch → toolError wrapping. Sandbox is only provisioned when
 * estimateNeedsSandbox returns true (Rust or withTiming).
 *
 * @param request - The MCP tool call request.
 * @param config  - Optional ChaosConfig loaded from a config file.
 * @param ctx     - Optional per-request context; `ctx.signal` cancels in-flight subprocesses.
 */
export async function handleEstimateCall(
  request: CallToolRequest,
  config?: ChaosConfig,
  ctx?: ToolContext,
): Promise<CallToolResult> {
  // Early abort: return immediately if the caller already cancelled.
  if (ctx?.signal?.aborted) {
    return toolError('Operation cancelled.');
  }

  const args = request.params.arguments ?? {};

  // ── Validate filePath before any other work (C2 — shared via
  //    validateFilePath; audit A3). ──
  const filePathResult = validateFilePath(args.filePath);
  if (!filePathResult.ok) return toolError(filePathResult.message);
  const { resolvedFile, raw: rawFilePath } = filePathResult.value;

  // Validate withTiming: boolean or absent.
  if (args.withTiming !== undefined && typeof args.withTiming !== 'boolean') {
    return toolError('withTiming must be a boolean. Example: true.');
  }

  // ── timeoutMs: the audit tool's own rule, not a second copy of it. ──
  //
  // This handler runs no validator table, so `timeoutMs` reached
  // `resolveAuditTimeoutMs` — which accepts any `number > 0` — completely
  // unchecked. A value past MAX_TIMEOUT_MS is then CLAMPED TO 1ms by Node's
  // timer, so `estimate_audit { timeoutMs: 3e9 }` killed its own subprocess
  // instantly and blamed a "timed out after 3000000000ms"; with `withTiming`
  // the failure degraded further into a bare " (timing unavailable)". Both
  // sibling tools already reject it; borrowing their validator keeps the three
  // from drifting apart again.
  const timeoutError = validateTimeoutMs(args);
  if (timeoutError !== null) return toolError(timeoutError);

  try {
    const projectType = supportedTypeOf(rawFilePath);

    if (!projectType) {
      return toolError(`Error: Extension unsupported for file target ${rawFilePath}`);
    }

    // A missing target must fail loudly. The heuristic degrades a read failure
    // to an empty source, which yields `mutants: 0` — indistinguishable from a
    // genuinely trivial file, so a mistyped path or a wrong workspace reads as
    // "nothing to audit". The audit tool already rejects such a target when it
    // provisions the sandbox; the estimate skips the sandbox and so must check
    // for itself.
    if (!isReadableFile(resolvedFile)) {
      return toolError(
        `Error: file target "${rawFilePath}" was not found, or is not a file. ` +
          'Paths are resolved relative to the workspace root.',
      );
    }

    // Detect the workspace environment and re-anchor the target onto its root
    // (the same step handleToolCall and triage run).
    const { env, targetFile: relFile } = anchorTarget(rawFilePath, resolvedFile, projectType);

    const withTiming = args.withTiming === true;
    const cfg = config ?? {};

    // Resolve worker concurrency used only to project wall-clock time
    // (mutants × baselineMs / concurrency). Reserve one CPU and cap estimates
    // at two workers because command-runner processes amplify system load.
    const concurrency = resolveEstimateConcurrency(cpus().length);

    // Provision a sandbox only when required (Rust needs cargo-mutants --list;
    // withTiming needs a test run). Otherwise skip the expensive workspace copy.
    let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
    if (estimateNeedsSandbox(projectType, withTiming)) {
      try {
        sandbox = await createSandbox(relFile, env.workspaceRoot, undefined, {
          signal: ctx?.signal,
        });
      } catch (error: unknown) {
        return mapCreateSandboxError(error, rawFilePath, ctx);
      }
    }

    try {
      const containerMode = cfg.container?.mode;
      const executor =
        sandbox && containerMode && containerMode !== 'native'
          ? await createExecutionSession(projectType, sandbox.workDir, cfg.container, ctx?.signal)
          : undefined;
      try {
        // ── Grade the estimate against the budget and the runner the AUDIT
        //    would actually use, not an estimate-only approximation of them. ──
        //
        // Both used to be re-derived here and both diverged from
        // audit_code_resilience:
        //
        //  * budget — this read `cfg.defaultTimeoutMs` only, so a config with
        //    `"stryker": { "timeoutMs": 900000 }` over a 60s default graded
        //    `fitsBudget` against 60s and recommended narrowing a run the audit
        //    would have given 900s. `resolveAuditTimeoutMs` is the audit's own
        //    resolver (arg → engine section → global default → DEFAULT).
        //  * runner — estimate.ts compared `env.testRunner` against 'command',
        //    ignoring the config file, so `"stryker": { "testRunner":
        //    "command" }` on a vitest project was audited with the command
        //    runner and estimated with the native constants (~4× low, with
        //    `fitsBudget: true`).
        //
        // The runner comes from `buildRunOptions` — the audit's own resolver —
        // rather than a local copy of its precedence chain: re-implementing it
        // here is exactly the drift this finding is about. `buildRunOptions` is
        // pure precedence logic (audit/run-options.ts), so calling it for one
        // field costs nothing; `workDir` is only carried on the returned object
        // and is unused by the estimate.
        const auditRunOptions = buildRunOptions(
          args,
          cfg,
          env,
          sandbox?.workDir ?? env.workspaceRoot,
          projectType,
          relFile,
        );
        // Keep the defensive numeric guard the estimate has always applied:
        // `resolveAuditTimeoutMs` trusts `cfg.defaultTimeoutMs` verbatim
        // (the config loader validates it), but this handler is also called
        // with hand-built configs, and a `0`/`"90000"` budget would make every
        // estimate report `fitsBudget: false`.
        const resolvedTimeoutMs = resolveAuditTimeoutMs(args, cfg, projectType);
        const result = await estimateAudit({
          absFile: resolvedFile,
          relFile,
          projectType,
          workDir: sandbox?.workDir,
          withTiming,
          env,
          testRunner: auditRunOptions.testRunner,
          concurrency,
          timeoutMs:
            typeof resolvedTimeoutMs === 'number' && resolvedTimeoutMs > 0
              ? resolvedTimeoutMs
              : DEFAULT_TIMEOUT_MS,
          signal: ctx?.signal,
          executor,
        });

        // Defensive post-run cancellation check (audit C1 follow-up).
        //
        // The catch below is the ONLY place `isCancel` runs, and it is never
        // entered when `estimateAudit` returns normally — which it can do even
        // after a cancel, since not every phase throws on abort (the Rust
        // count path degraded a startup failure to a heuristic result, and a
        // signal that flips between the last subprocess and here is never
        // observed at all). Without this, a cancelled `estimate_audit` handed
        // the caller a successful estimate for work it had already abandoned.
        if (ctx?.signal?.aborted) return toolError('Operation cancelled.');

        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: toStructuredContent(result),
        };
      } finally {
        await executor?.dispose();
      }
    } finally {
      // Always clean up the sandbox, even if estimateAudit threw (C2).
      sandbox?.cleanup();
    }
  } catch (error: unknown) {
    // A mid-flight estimateAudit killed by the abort signal, or an AbortError
    // from any other source, reaches here; `mapHandlerFailure` owns the
    // cancel-vs-halt branch shared with the audit and triage tools.
    return mapHandlerFailure(error, ctx);
  }
}
