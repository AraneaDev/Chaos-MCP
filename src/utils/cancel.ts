import type { ToolContext } from '../tool-context.js';
import { ExecFailureError } from './exec.js';

/**
 * True when `error` (or the MCP request context's abort signal) signals a
 * deliberate cancellation rather than a system/engine failure.
 *
 * Three shapes count as cancellation, all of which the audit C1 surface has
 * had to handle separately for months — only one of them (`name === 'AbortError'`)
 * was actually a single primitive, while the other two are MCP-specific:
 *
 * 1. `ctx.signal.aborted === true` — the caller flipped the signal before we
 *    reached this branch (or just as we entered it). Always wins so that a
 *    signal flipped DURING engine teardown can override a noisy secondary
 *    error class.
 * 2. `error.name === 'AbortError'` — `fs.cp` mid-call cancellation, or any
 *    platform Promise that observes `AbortSignal`.
 * 3. `ExecFailureError.code === 'ABORTED'` — the engine saw a child process
 *    die because the abort signal reached it.
 *
 * Centralised here so the three handlers (`handler.ts`, `estimate-handler.ts`,
 * `triage-handler.ts`) cannot drift on "what counts as cancelled"; previously
 * each had its own ad-hoc check that over time diverged (audit C1 follow-up).
 */
export function isCancel(error: unknown, ctx?: ToolContext): boolean {
  if (ctx?.signal?.aborted === true) return true;
  if ((error as { name?: string } | null)?.name === 'AbortError') return true;
  if (error instanceof ExecFailureError && error.code === 'ABORTED') return true;
  return false;
}
