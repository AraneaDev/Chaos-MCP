/**
 * MCP `CallToolResult` constructors shared by the three tool handlers.
 *
 * These lived in `handler.ts` (the `audit_code_resilience` implementation), so
 * `estimate-handler.ts` had to import the whole audit pipeline's module graph to
 * build a three-line error envelope. They are protocol-shaping helpers, not
 * audit logic, so they live beside `tool-context.ts` instead.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext } from './tool-context.js';
import { isCancel } from './utils/cancel.js';

export function toolError(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Map a `createSandbox` rejection to a consistent {@link toolError} so the three
 * callers (handler, estimate, triage) cannot drift on the cancel/error shapes
 * (C1 follow-up).
 *
 * - Cancellation (audit C1 mid-call cancel OR `ctx.signal.aborted` flipped JUST
 *   as we entered the catch) → `'Operation cancelled.'` so every cancel path
 *   surfaces the SAME message — phase-boundary checks, sandbox rejection, and
 *   engine-run cancellation all map to one string the caller can branch on
 *   without parsing the source.
 * - Any other rejection → `'Chaos Engine Halted: Failed to provision sandbox
 *   isolation for <filePath>: <message>. Ensure the file exists and the
 *   workspace is accessible.'` (colon-separated, not parenthesised — the
 *   previous `(message). Ensure…` read like a citation, not a sentence).
 */
export function mapCreateSandboxError(
  error: unknown,
  filePath: string,
  ctx?: ToolContext,
): CallToolResult {
  if (isCancel(error, ctx)) {
    return toolError('Operation cancelled.');
  }
  const message = error instanceof Error ? error.message : String(error);
  return toolError(
    `Chaos Engine Halted: Failed to provision sandbox isolation for ${filePath}: ${message}. Ensure the file exists and the workspace is accessible.`,
  );
}
