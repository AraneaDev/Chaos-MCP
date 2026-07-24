import { relative, isAbsolute } from 'path';
import { cpus } from 'os';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { detectProjectType, detectEnvironment } from './utils/project-detector.js';
import { createSandbox } from './utils/sandbox.js';
import { toolError, mapCreateSandboxError } from './handler.js';
import { validateFilePath } from './utils/file-path.js';
import { estimateAudit, estimateNeedsSandbox } from './estimate.js';
import type { ChaosConfig } from './utils/config-loader.js';
import type { ToolContext } from './tool-context.js';
import { isCancel } from './utils/cancel.js';
import { DEFAULT_TIMEOUT_MS } from './utils/constants.js';

export function resolveEstimateConcurrency(cpuCount: number): number {
  return Math.max(1, Math.min(2, cpuCount - 1));
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
  if (!filePathResult.ok) return filePathResult.error;
  const { resolvedFile, raw: rawFilePath } = filePathResult.value;

  // Validate withTiming: boolean or absent.
  if (args.withTiming !== undefined && typeof args.withTiming !== 'boolean') {
    return toolError('withTiming must be a boolean. Example: true.');
  }

  try {
    const projectType = detectProjectType(rawFilePath);

    if (projectType === 'unsupported') {
      return toolError(`Error: Extension unsupported for file target ${rawFilePath}`);
    }

    // Auto-detect the workspace environment (test runner, workspace root).
    const env = detectEnvironment(rawFilePath);

    // Re-anchor the target to the detected workspace root (matches the same
    // expression handleToolCall and triage-handler use).
    const relFromRoot = relative(env.workspaceRoot, resolvedFile);
    const relFile =
      relFromRoot.length > 0 && !relFromRoot.startsWith('..') && !isAbsolute(relFromRoot)
        ? relFromRoot
        : rawFilePath;

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
      const result = await estimateAudit({
        absFile: resolvedFile,
        relFile,
        projectType,
        workDir: sandbox?.workDir,
        withTiming,
        env,
        concurrency,
        timeoutMs:
          typeof cfg.defaultTimeoutMs === 'number' && cfg.defaultTimeoutMs > 0
            ? cfg.defaultTimeoutMs
            : DEFAULT_TIMEOUT_MS,
        signal: ctx?.signal,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } finally {
      // Always clean up the sandbox, even if estimateAudit threw (C2).
      sandbox?.cleanup();
    }
  } catch (error: unknown) {
    // Audit C1 follow-up: cancellation (mid-flight estimateAudit killed by
    // the abort signal, or an AbortError from any other source) must surface
    // as 'Operation cancelled.' — never as 'Chaos Engine Halted' — so the
    // caller can reliably branch on the message. Otherwise a deliberate
    // cancel from the MCP client looks identical to a real engine failure.
    if (isCancel(error, ctx)) {
      return toolError('Operation cancelled.');
    }
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`Chaos Engine Halted: ${message}`);
  }
}
