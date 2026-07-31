/**
 * The `triage_test_coverage` tool entry point.
 *
 * This module is the ORCHESTRATOR and nothing else: it sequences the phases of
 * one sweep — validate → discover → audit-in-parallel → partition → rank →
 * format — and owns the wall-clock budget and abort checks that make the order
 * load-bearing. Argument rules live in `triage-args-validation.ts`, target
 * selection in `triage/discover-targets.ts`, and the per-file audit in
 * `triage/audit-one.ts` (Finding 3).
 */
import { resolve } from 'path';
import { cpus } from 'os';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  compareTriageRows,
  buildTriagePayload,
  formatTriageAsText,
  type TriageRow,
  type TriageError,
} from './triage.js';
import { mapPool } from './utils/pool.js';
import type { ChaosConfig } from './utils/config-loader.js';
import type { ToolContext } from './tool-context.js';
import type { ToolArgs } from './tool-args-validation.js';
import {
  TRIAGE_ARG_VALIDATORS,
  hasTriagePaths,
  hasTriageDiffBase,
  resolveStrykerConcurrency,
} from './triage-args-validation.js';
import { resolveTriageTargets } from './triage/discover-targets.js';
import { auditTriageFile, type TriageFileDeps } from './triage/audit-one.js';
import { AuditDeadline } from './utils/deadline.js';

function triageError(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const DEFAULT_MAX_FILES = 25;

/**
 * Default wall-clock ceiling for an entire triage sweep (15 minutes).
 *
 * Chosen to sit under the request timeout typical MCP clients apply, so a large
 * sweep returns the ranking it managed to produce instead of being cut off with
 * nothing. Raise it with the `totalTimeoutMs` argument for a deliberate long run.
 */
const DEFAULT_TOTAL_TIMEOUT_MS = 900_000;

/**
 * Wall-clock left unspent so the ranking, payload, and response can be built
 * after the last file finishes.
 */
const TRIAGE_CLEANUP_RESERVE_MS = 2_000;

/**
 * Validate the tool arguments, returning the FIRST failure as an error result
 * or `null` when everything provided is well-formed.
 *
 * Deliberately first-failure-wins, NOT the combined "Multiple argument errors"
 * report `validateToolArgs` produces for `audit_code_resilience` (M2): the
 * inline prelude this replaces returned on the first bad argument, tests pin
 * those exact single messages, and switching triage to aggregate reporting
 * would be an observable change of behaviour rather than a refactor. The rules
 * themselves are shaped identically to the audit tool's, so the two can be
 * unified later as a deliberate decision.
 */
function validateTriageArgs(args: ToolArgs): CallToolResult | null {
  for (const validate of TRIAGE_ARG_VALIDATORS) {
    const message = validate(args);
    if (message !== null) return triageError(message);
  }
  return null;
}

/**
 * Batch-triage handler: discover supported source files under `paths`, audit
 * each in bounded-parallel via the shared `auditFile` core, and return a
 * weakest-first ranked leaderboard. Per-file failures are collected, never fatal.
 */
export async function handleTriageCall(
  request: CallToolRequest,
  config?: ChaosConfig,
  ctx?: ToolContext,
): Promise<CallToolResult> {
  const args = request.params.arguments ?? {};
  const cfg = config ?? {};

  const argError = validateTriageArgs(args);
  if (argError) return argError;

  const rootCwd = resolve(process.cwd());
  const paths = hasTriagePaths(args) ? (args.paths as string[]) : undefined;
  const diffBase = hasTriageDiffBase(args) ? (args.diffBase as string) : undefined;
  const minScore = typeof args.minScore === 'number' ? args.minScore : undefined;
  const maxFiles =
    args.maxFiles !== undefined
      ? (args.maxFiles as number)
      : (cfg.defaultMaxFiles ?? DEFAULT_MAX_FILES);
  const outputFormat = args.outputFormat === 'text' ? 'text' : 'json';

  const cpuCount = cpus().length;
  const poolSize =
    typeof args.fileConcurrency === 'number' && Number.isInteger(args.fileConcurrency)
      ? (args.fileConcurrency as number)
      : (cfg.defaultFileConcurrency ?? Math.max(1, Math.min(4, cpuCount - 1)));
  const survivorsPerFile =
    typeof args.survivorsPerFile === 'number' && Number.isInteger(args.survivorsPerFile)
      ? (args.survivorsPerFile as number)
      : 0;

  // One wall-clock budget for the WHOLE sweep. `timeoutMs` is per file, so
  // without this a default triage could run maxFiles × timeoutMs (25 × 5 min)
  // — long past any MCP client's own request timeout, at which point the work
  // is orphaned and nothing is returned. Files that never start are reported as
  // unaudited rather than silently omitted.
  const deadline = new AuditDeadline(
    typeof args.totalTimeoutMs === 'number' ? args.totalTimeoutMs : DEFAULT_TOTAL_TIMEOUT_MS,
  );

  // Early abort before hitting the network (git) or filesystem (discovery). (Task 6)
  if (ctx?.signal?.aborted) return triageError('Operation cancelled.');

  const targets = await resolveTriageTargets({
    rootCwd,
    paths,
    diffBase,
    maxFiles,
    deadline,
    cleanupReserveMs: TRIAGE_CLEANUP_RESERVE_MS,
    signal: ctx?.signal,
  });
  if (targets.kind === 'error') return triageError(targets.message);
  const { files, discovered, skipped, scopeNote } = targets;

  if (files.length === 0) {
    return triageResult([], [], [], discovered, skipped, scopeNote, minScore, outputFormat);
  }

  // Per-file progress tracking (Task 6). Single-threaded JS: `++done` over the
  // concurrent pool is race-free (completions arrive one event-loop turn at a time).
  let done = 0;
  const total = files.length;

  const deps: TriageFileDeps = {
    rootCwd,
    cfg,
    args,
    diffBase,
    strykerConcurrency: resolveStrykerConcurrency(poolSize, cpuCount),
    survivorsPerFile,
    suppressionCache: new Map(),
    deadline,
    cleanupReserveMs: TRIAGE_CLEANUP_RESERVE_MS,
    ctx,
    onProgress: () => ctx?.reportProgress?.(++done, total, `audited ${done}/${total}`),
  };

  // Second abort check: skip the pool entirely if already cancelled before we start.
  // (Task 6 — mirrors the pre-discovery check above.)
  if (ctx?.signal?.aborted) return triageError('Operation cancelled.');

  const outcomes = await mapPool(files, poolSize, (file) => auditTriageFile(file, deps));
  const auditedRows: TriageRow[] = [];
  const errors: TriageError[] = [];
  const unaudited: string[] = [];
  for (const o of outcomes) {
    if (o instanceof Error) {
      // Safety-net slot from mapPool — auditTriageFile never throws, but guard defensively.
      errors.push({ file: '(unknown)', error: o.message });
      continue;
    }
    if ('unaudited' in o) {
      unaudited.push(o.unaudited);
    } else if ('error' in o) {
      errors.push(o.error);
    } else {
      auditedRows.push(o.row);
    }
  }

  const ranking = auditedRows.slice().sort(compareTriageRows);
  return triageResult(
    ranking,
    errors,
    unaudited.sort(),
    discovered,
    skipped,
    scopeNote,
    minScore,
    outputFormat,
  );
}

/**
 * Render the sweep's outcome in the requested format, with `structuredContent`
 * and the JSON text block both driven by the same payload.
 *
 * `unaudited` is passed to the text renderer as-is and to the payload sorted by
 * the caller — the empty-discovery path has neither, so it passes `[]`.
 */
function triageResult(
  ranking: TriageRow[],
  errors: TriageError[],
  unaudited: string[],
  discovered: number,
  skipped: number,
  scopeNote: string | undefined,
  minScore: number | undefined,
  outputFormat: 'text' | 'json',
): CallToolResult {
  const payload = buildTriagePayload(
    ranking,
    errors,
    discovered,
    skipped,
    scopeNote,
    minScore,
    unaudited,
  );
  const text =
    outputFormat === 'text'
      ? formatTriageAsText(ranking, errors, discovered, skipped, scopeNote, unaudited)
      : JSON.stringify(payload);
  return {
    content: [{ type: 'text', text }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}
