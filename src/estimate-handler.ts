import { resolve, relative, isAbsolute } from 'path';
import { cpus } from 'os';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { detectProjectType, detectEnvironment } from './utils/project-detector.js';
import { createSandbox } from './utils/sandbox.js';
import { isRealPathInside, toolError } from './handler.js';
import { estimateAudit, estimateNeedsSandbox } from './estimate.js';
import type { ChaosConfig } from './utils/config-loader.js';

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
 */
export async function handleEstimateCall(
  request: CallToolRequest,
  config?: ChaosConfig,
): Promise<CallToolResult> {
  const args = request.params.arguments ?? {};

  // ── Validate filePath before any other work (C2) ──
  const rawFilePath = args.filePath;
  if (typeof rawFilePath !== 'string' || rawFilePath.length === 0) {
    return toolError(
      'filePath is required and must be a non-empty string. Example: "src/math.ts".',
    );
  }

  // Reject paths that resolve outside the current process cwd (C2).
  const rootCwd = resolve(process.cwd());
  const resolvedFile = resolve(rootCwd, rawFilePath);
  if (!isRealPathInside(resolvedFile, rootCwd)) {
    return toolError(
      `Error: filePath must resolve within the workspace (${rootCwd}); received "${rawFilePath}".`,
    );
  }

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
    // (mutants × baselineMs / concurrency). Match triage-handler: cpus-1 floored at 1.
    const concurrency = Math.max(1, cpus().length - 1);

    // Provision a sandbox only when required (Rust needs cargo-mutants --list;
    // withTiming needs a test run). Otherwise skip the expensive workspace copy.
    let sandbox: ReturnType<typeof createSandbox> | undefined;
    if (estimateNeedsSandbox(projectType, withTiming)) {
      try {
        sandbox = createSandbox(relFile, env.workspaceRoot);
      } catch {
        return toolError(
          `Chaos Engine Halted: Failed to provision sandbox isolation for ${rawFilePath}. Ensure the file exists and the workspace is accessible.`,
        );
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
            : undefined,
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
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`Chaos Engine Halted: ${message}`);
  }
}
