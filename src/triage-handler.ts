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
} from './core/triage.js';
import { mapPool } from './utils/pool.js';
import type { ChaosConfig } from './utils/config-loader.js';
import type { ToolContext } from './core/tool-context.js';
import type { ToolArgs } from './core/tool-args-validation.js';
import {
  TRIAGE_ARG_VALIDATORS,
  hasTriagePaths,
  hasTriageDiffBase,
  resolvePerFileConcurrency,
} from './core/triage-args-validation.js';
import { resolveTriageTargets } from './triage/discover-targets.js';
import { toolError, mapHandlerFailure, toStructuredContent } from './core/tool-result.js';
import {
  auditTriageFile,
  type TriageFileDeps,
  type TriageAuditOutcome,
} from './triage/audit-one.js';
import { AuditDeadline } from './utils/deadline.js';
import {
  createResourceContext,
  type ResourceContext,
  type ResourcesPayload,
} from './core/resource-context.js';
import { resolveAuditTargetIn } from './audit/target.js';
import { isBaselineFailureMessage } from './utils/baseline-failure.js';

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
 * The smallest slice of the sweep's budget worth starting the retry pass with
 * (Task 8). Mirrors `MIN_ENGINE_BUDGET_MS` in `triage/audit-one.ts`, restated
 * here because that constant is private to a module this one does not import
 * for it alone.
 */
const MIN_RETRY_BUDGET_MS = 1_000;

/**
 * The wording for a file that never produced a score after the watchdog
 * stopped its run for memory (Task 8): either the single requeue also
 * exhausted, or the sweep was cancelled or ran out of time before the requeue
 * could start. Reported as an error row rather than dropped, so nothing a
 * sweep selects ever goes unaccounted for.
 */
const RESOURCE_EXHAUSTED_ROW_MESSAGE =
  'Stopped to avoid exhausting memory and could not be completed on the ' +
  'single requeue. Lower fileConcurrency or concurrency, or raise the machine memory.';

/**
 * Appended to a file's ORIGINAL failure message when a baseline/initial-run
 * failure (see `utils/baseline-failure.ts`) is still a failure on its single
 * requeue. The original message is preserved verbatim rather than replaced by
 * whatever the retry itself produced, so the caller sees the real cause once,
 * plus the fact that contention was already ruled out by a clean retry.
 */
const RETRIED_BASELINE_FAILURE_NOTE = '(Retried once at file concurrency 1; failed again.)';

/**
 * One file queued for the single requeue pass, and why: the watchdog stopped
 * it for memory, or its failure looked like a baseline/initial-run failure in
 * a sweep that ran more than one file at a time. `originalMessage` is only
 * carried for the latter, so a second baseline failure can report the first
 * one's real message rather than whatever the retry itself produced.
 */
type RetryTarget =
  | { file: string; index: number; reason: 'exhausted' }
  | { file: string; index: number; reason: 'baseline-failure'; originalMessage: string };

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
    if (message !== null) return toolError(message);
  }
  return null;
}

/** Everything one sweep is parameterised by, after tool args and config merge. */
interface TriageOptions {
  paths: string[] | undefined;
  diffBase: string | undefined;
  minScore: number | undefined;
  maxFiles: number;
  outputFormat: 'text' | 'json';
  poolSize: number;
  survivorsPerFile: number;
  deadline: AuditDeadline;
}

/**
 * Resolve every knob of a sweep from the tool arguments, the loaded config and
 * the host's CPU count.
 *
 * The precedence is tool argument → config → built-in default, uniformly: an
 * explicit argument always wins, `chaos.config.json` supplies the fallback where
 * it has an opinion, and the constant at the top of this module is the last
 * resort. Arguments are already known well-formed here (`validateTriageArgs`
 * ran first); the `typeof`/`Number.isInteger` checks are the type narrowing the
 * `unknown`-valued `ToolArgs` bag needs, not a second validation pass.
 */
function resolveTriageOptions(args: ToolArgs, cfg: ChaosConfig, cpuCount: number): TriageOptions {
  return {
    paths: hasTriagePaths(args) ? (args.paths as string[]) : undefined,
    diffBase: hasTriageDiffBase(args) ? (args.diffBase as string) : undefined,
    minScore: typeof args.minScore === 'number' ? args.minScore : undefined,
    maxFiles:
      args.maxFiles !== undefined
        ? (args.maxFiles as number)
        : (cfg.defaultMaxFiles ?? DEFAULT_MAX_FILES),
    outputFormat: args.outputFormat === 'text' ? 'text' : 'json',
    poolSize:
      typeof args.fileConcurrency === 'number' && Number.isInteger(args.fileConcurrency)
        ? (args.fileConcurrency as number)
        : (cfg.defaultFileConcurrency ?? Math.max(1, Math.min(4, cpuCount - 1))),
    survivorsPerFile:
      typeof args.survivorsPerFile === 'number' && Number.isInteger(args.survivorsPerFile)
        ? (args.survivorsPerFile as number)
        : 0,
    // One wall-clock budget for the WHOLE sweep. `timeoutMs` is per file, so
    // without this a default triage could run maxFiles × timeoutMs (25 × 5 min)
    // — long past any MCP client's own request timeout, at which point the work
    // is orphaned and nothing is returned. Files that never start are reported as
    // unaudited rather than silently omitted.
    deadline: new AuditDeadline(
      typeof args.totalTimeoutMs === 'number' ? args.totalTimeoutMs : DEFAULT_TOTAL_TIMEOUT_MS,
    ),
  };
}

/** The three disjoint buckets a finished pool of per-file audits sorts into. */
interface TriageOutcomes {
  rows: TriageRow[];
  errors: TriageError[];
  unaudited: string[];
}

/**
 * Demultiplex the per-file audit outcomes into rows, errors and unaudited files.
 *
 * `mapPool` yields one of five things per file: the `Error` safety-net slot, an
 * `{ unaudited }` marker for a file the sweep never reached, an `{ error }`
 * record for one that failed, the `{ row }` of a successful audit, or an
 * `{ exhausted }` marker (Task 8) that reaches here only when the file's single
 * requeue also could not complete, or never ran because the sweep was
 * cancelled or out of time. That marker is reported as an error row rather
 * than dropped.
 */
export function partitionOutcomes(outcomes: TriageAuditOutcome[]): TriageOutcomes {
  const rows: TriageRow[] = [];
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
    } else if ('exhausted' in o) {
      errors.push({ file: o.exhausted, error: RESOURCE_EXHAUSTED_ROW_MESSAGE });
    } else if ('error' in o) {
      errors.push(o.error);
    } else {
      rows.push(o.row);
    }
  }
  return { rows, errors, unaudited };
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

  // Mirrored into this OUTER binding right after creation, below, so the
  // outer catch can still read it: the inner `const resources` is block-scoped
  // to the try and invisible to its own catch (see the identical fix in
  // handler.ts). Kept as a separate variable, rather than hoisting `resources`
  // itself out of the try, because `resources` is read from closures further
  // down (`admit`, the requeue pass) that TS cannot narrow from `T | undefined`
  // to `T` across a closure boundary; the inner `const` keeps every existing
  // use fully typed and this mirror exists ONLY for the catch. `undefined`
  // until that assignment runs, which is exactly the failures that predate it
  // (e.g. `resolveTriageTargets`) having no resources context to report,
  // correctly.
  let resourcesForCatch: ResourceContext | undefined;
  try {
    const rootCwd = resolve(process.cwd());
    const cpuCount = cpus().length;
    const {
      paths,
      diffBase,
      minScore,
      maxFiles,
      outputFormat,
      poolSize,
      survivorsPerFile,
      deadline,
    } = resolveTriageOptions(args, cfg, cpuCount);

    // Early abort before hitting the network (git) or filesystem (discovery). (Task 6)
    if (ctx?.signal?.aborted) return toolError('Operation cancelled.');

    const targets = await resolveTriageTargets({
      rootCwd,
      paths,
      diffBase,
      maxFiles,
      deadline,
      cleanupReserveMs: TRIAGE_CLEANUP_RESERVE_MS,
      signal: ctx?.signal,
    });
    if (targets.kind === 'error') return toolError(targets.message);
    const { files, discovered, skipped, scopeNote } = targets;

    if (files.length === 0) {
      return triageResult([], [], [], discovered, skipped, scopeNote, minScore, outputFormat);
    }

    // Per-file progress tracking (Task 6). Single-threaded JS: `++done` over the
    // concurrent pool is race-free (completions arrive one event-loop turn at a time).
    let done = 0;
    const total = files.length;

    // Size this sweep to the memory the machine actually has (Task 8): never
    // RAISES what the CPU-only math already chose (poolSize / the per-file
    // worker cap below), only lowers it, and the watchdog stops the newest
    // run rather than letting the sweep exhaust memory. `projectType` is read
    // from the first selected file: a sweep almost always spans one language,
    // and a mixed one still gets a real (if approximate) per-worker cost
    // rather than none. `resources.dispose()` in the `finally` below tears
    // down the sampler once the sweep is done, same as the single-file audit
    // (Task 7).
    // Resolved once here and handed to the pool as `deps.primaryTarget` below,
    // so the file the pool audits at `files[0]` does not run the same
    // workspace detection a second time (it would otherwise: `auditTriageFile`
    // resolves every file's target itself, this one included).
    const primaryTarget = resolveAuditTargetIn(rootCwd, files[0]);
    const primaryProjectType = primaryTarget?.projectType ?? 'typescript';
    // The engine-worker cap this sweep would use with no memory pressure at
    // all. `undefined` when the pool is serial, matching the existing "no cap
    // needed for one file at a time" rule `buildPerFileArgs` already applies;
    // preserved here rather than forced to a number so that rule keeps
    // holding when the probe is unavailable (Budget then reproduces whatever
    // baseline it was given, unchanged).
    const cpuPerFileWorkers = resolvePerFileConcurrency(poolSize, cpuCount);
    const resources = createResourceContext({
      projectType: primaryProjectType,
      cpuFileConcurrency: poolSize,
      cpuPerFileWorkers: cpuPerFileWorkers ?? 1,
      requested: args.fileConcurrency === undefined ? undefined : { fileConcurrency: poolSize },
      watchdogEnabled: cfg.resources?.watchdog,
      admissionFloorBytes: cfg.resources?.admissionFloorBytes,
      criticalFloorBytes: cfg.resources?.criticalFloorBytes,
    });
    resourcesForCatch = resources;

    try {
      // Estimated memory one file's engine run will hold: the engine's fixed
      // per-file cost (parent process plus dry run) plus its worker cost
      // times how many workers that file gets (`resources.perFileCostBytes`,
      // per the 2026-09-12 cost-model amendment). Same figure the
      // single-file audit charges its own watchdog registration with
      // (Task 7 / handler.ts); the watchdog's real-time trip, not this
      // estimate, is what actually protects the machine.
      // Computed before `deps` so it can be handed to BOTH the admission gate
      // below and `watchdog.register` (via `deps.perFileCostBytes`), which
      // charges it against admission for every other file from the moment
      // this one starts (IMPORTANT 4), rather than leaving the gate to rely
      // on the OS probe catching up with what the run actually allocates.
      const perFileCost = resources.perFileCostBytes;
      const deps: TriageFileDeps = {
        rootCwd,
        cfg,
        args,
        diffBase,
        perFileConcurrency: cpuPerFileWorkers === undefined ? undefined : resources.budget.perFileWorkers,
        survivorsPerFile,
        suppressionCache: new Map(),
        deadline,
        cleanupReserveMs: TRIAGE_CLEANUP_RESERVE_MS,
        ctx,
        watchdog: resources.watchdog,
        innerEnv: resources.innerEnv,
        perFileCostBytes: perFileCost,
        primaryTarget: primaryTarget ? { file: files[0], target: primaryTarget } : undefined,
        // Progress stops the moment the request is abandoned. A cancelled sweep
        // still runs one `onProgress` per file, `auditTriageFile` reports in a
        // `finally`, and the files it skips on the abort check report too, so
        // without this gate a cancelled request keeps receiving `audited N/25`
        // notifications for work nobody is waiting for, right up to 25/25.
        onProgress: () => {
          if (ctx?.signal?.aborted) return;
          ctx?.reportProgress?.(++done, total, `audited ${done}/${total}`);
        },
      };

      // Second abort check: skip the pool entirely if already cancelled before we start.
      // (Task 6, mirrors the pre-discovery check above.)
      if (ctx?.signal?.aborted) return toolError('Operation cancelled.', resources.report());
      // `watchdog.admit` only ever resolves from a `tick()` (memory freed up)
      // or a `stop()` (the sweep is over), both of which happen downstream of
      // the very `mapPool` call this feeds. Under sustained external memory
      // pressure with no in-flight run left to release memory, neither ever
      // fires, and a waiter with only `ctx?.signal` attached blocks forever:
      // `mapPool`'s turnstile serializes admission across every worker, so one
      // stuck waiter stalls the WHOLE pool, not just its own file (CRITICAL 2).
      //
      // Recomputed on every call rather than once, so the deadline is honoured
      // freshly for each file (including the requeue pass below, which reuses
      // this same closure): `deadline.remainingMs` shrinks as the sweep
      // proceeds, and `AbortSignal.timeout` needs the CURRENT remaining
      // duration, not the one computed when the sweep started.
      const admit = () => {
        const remainingMs = deadline.remainingMs(TRIAGE_CLEANUP_RESERVE_MS);
        if (remainingMs <= 0) return Promise.resolve('cancelled' as const);
        const deadlineSignal = AbortSignal.timeout(remainingMs);
        const signal = ctx?.signal ? AbortSignal.any([ctx.signal, deadlineSignal]) : deadlineSignal;
        return resources.watchdog.admit(perFileCost, signal);
      };

      // Governance lowers `poolSize` down to `resources.budget.fileConcurrency`
      // (never raises it) and gates each file's start on free memory. A file
      // the gate declines leaves its slot UNSET (utils/pool.ts: `results[i]` is
      // never assigned, a sparse-array hole rather than an explicit
      // `undefined`), so it is filled in below as `unaudited`, the same bucket
      // a deadline miss already uses, rather than silently missing from the
      // ranking. Read out with `Array.from` rather than `.map`: `.map` skips a
      // hole entirely (it never invokes the callback for an unassigned
      // index), which would leave the hole in the result too.
      const rawOutcomes = await mapPool(
        files,
        resources.budget.fileConcurrency,
        (file) => auditTriageFile(file, deps),
        { admit },
      );
      const outcomes: TriageAuditOutcome[] = Array.from(
        { length: files.length },
        (_, i) => rawOutcomes[i] ?? { unaudited: files[i] },
      );

      // Defensive post-run cancellation check (Finding 6), the sibling of the one
      // in estimate-handler.ts.
      //
      // The catch below is the ONLY place `isCancel` runs, and a cancel landing
      // DURING the pool can never enter it: `mapPool` does not reject (it stores a
      // throw in the result slot, utils/pool.ts) and `auditTriageFile` is
      // documented never to throw, it turns a per-file cancel into an `{ error }`
      // outcome. So the sweep fell straight through to the ranking below and
      // handed the caller a NON-isError leaderboard, gate verdict included,
      // computed over only the files that happened to finish before the stop.
      // A partial gate is worse than no gate: `gate.passed` would be read as a
      // verdict on the whole selection.
      if (ctx?.signal?.aborted) return toolError('Operation cancelled.', resources.report());

      // Requeue once, at fileConcurrency 1, every file the watchdog stopped for
      // memory, PLUS (new) every file whose failure was specifically its
      // baseline/initial-run failing (`utils/baseline-failure.ts`) in a sweep
      // that actually ran more than one file at a time. Both share this one
      // pass and the same "at most once" contract: a file lands here for
      // whichever reason first applied to it, and nothing re-queues it a
      // second time (the loop below never runs again after this pass).
      //
      // The concurrency check reads the sweep's RESOLVED `fileConcurrency`
      // (`resources.budget.fileConcurrency`, already clamped by memory
      // governance), not the caller's requested value: a request for 4 that
      // governance dropped to 1 is exactly as serial as an explicit request
      // for 1, and contention between files that never overlapped is not a
      // plausible cause for either. A serial sweep still requeues its
      // memory-stopped files (unrelated to this check) but never a baseline
      // failure, so a genuinely broken suite is reported once, immediately.
      const firstPassWasParallel = resources.budget.fileConcurrency > 1;
      const retryTargets: RetryTarget[] = outcomes.flatMap((outcome, index): RetryTarget[] => {
        if ('exhausted' in outcome) {
          return [{ file: files[index], index, reason: 'exhausted' }];
        }
        if (
          firstPassWasParallel &&
          'error' in outcome &&
          isBaselineFailureMessage(outcome.error.error)
        ) {
          return [
            {
              file: files[index],
              index,
              reason: 'baseline-failure',
              originalMessage: outcome.error.error,
            },
          ];
        }
        return [];
      });
      if (
        retryTargets.length > 0 &&
        !ctx?.signal?.aborted &&
        deadline.remainingMs(TRIAGE_CLEANUP_RESERVE_MS) > MIN_RETRY_BUDGET_MS
      ) {
        // A no-op `onProgress` for the retry pass (MINOR 7): the original
        // pass already counted every one of these files once (`auditTriageFile`
        // reports in a `finally` regardless of outcome, `exhausted` included),
        // so counting again here double-reports the retried files and can
        // print "audited 26/25" for a 25-file sweep.
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        const retryDeps: TriageFileDeps = { ...deps, onProgress: () => {} };
        const retried = await mapPool(
          retryTargets.map((t) => t.file),
          1,
          (file) => auditTriageFile(file, retryDeps),
          { admit },
        );
        retryTargets.forEach((target, i) => {
          const outcome = retried[i];
          // A declined admission on the retry itself leaves this slot
          // undefined too; keep the original marker (`{ exhausted }` or the
          // first `{ error }`) rather than overwrite it with nothing, so it
          // still becomes an error row below instead of disappearing.
          if (outcome === undefined) return;
          // A baseline-failure retry that fails again reports the ORIGINAL
          // message (requirement: nothing silently swallowed, the real cause
          // stays visible) plus a short note that it was retried, rather than
          // whatever text the second attempt happened to produce. A retry
          // that instead exhausts memory or runs unaudited falls through to
          // the generic assignment below and reports as that outcome, and a
          // retry that SUCCEEDS falls through too and is scored normally.
          if (target.reason === 'baseline-failure' && 'error' in outcome) {
            outcomes[target.index] = {
              error: {
                file: target.file,
                error: `${target.originalMessage} ${RETRIED_BASELINE_FAILURE_NOTE}`,
              },
            };
            return;
          }
          outcomes[target.index] = outcome;
        });

        if (ctx?.signal?.aborted) return toolError('Operation cancelled.', resources.report());
      }

      const { rows, errors, unaudited } = partitionOutcomes(outcomes);

      const ranking = rows.slice().sort(compareTriageRows);
      return triageResult(
        ranking,
        errors,
        unaudited.sort(),
        discovered,
        skipped,
        scopeNote,
        minScore,
        outputFormat,
        resources.report(),
      );
    } finally {
      resources.dispose();
    }
  } catch (error: unknown) {
    // Nothing inside a sweep is allowed to escape as a raw rejection: the MCP
    // SDK turns a thrown error into a JSON-RPC protocol error, which is a
    // DIFFERENT shape from the `isError` tool result every other failure here
    // uses, and the caller loses the ranking's error channel entirely. The
    // reachable path is `resolveTriageTargets`, whose `listChangedFiles` call
    // re-throws a cancel — and a timeout / missing `git` binary — rather than
    // libelling the workspace as "not a git work tree" (utils/git-diff.ts);
    // per-file failures are already collected by `auditTriageFile`.
    //
    // A cancel keeps the one string every abort path in this codebase reports,
    // so a deliberate stop never reads as an engine failure — `mapHandlerFailure`
    // is the same branch handler.ts and estimate-handler.ts use.
    //
    // Unlike handler.ts's outer catch, `resources` is genuinely `undefined`
    // here in practice: `resolveTriageTargets` is the only reachable path (it
    // runs before `resources` is assigned below) because `auditTriageFile`
    // never throws and `mapPool` never rejects, so a per-file engine failure
    // can never surface here. Passed anyway, for the same reason it is typed
    // as optional everywhere else: the rule is "pass it when you have it," not
    // "special-case the one caller that today never does."
    //
    // INVARIANT (no test covers `resourcesForCatch` carrying a value into this
    // catch, because nothing can currently put one there): every statement
    // between `resourcesForCatch = resources` (above) and the end of the try
    // either cannot throw or has its throw absorbed before it escapes:
    //   - `mapPool` (utils/pool.ts) never rejects — every worker's `await
    //     admit(...)` and `await fn(...)` is wrapped in its own try/catch that
    //     stores the failure in the result slot instead of propagating it.
    //   - `auditTriageFile` (triage/audit-one.ts) is documented "NEVER
    //     throws"; its whole body is one try/catch/finally whose catch always
    //     returns a row and whose finally only calls `deps.onProgress`, itself
    //     a no-throw closure — and even if either did throw, mapPool's own
    //     wrapper above would still absorb it.
    //   - The post-pool steps (`partitionOutcomes`, `compareTriageRows`,
    //     `buildTriagePayload`, `formatTriageAsText`) are pure functions over
    //     the already-shaped outcome/row data with no I/O and no unguarded
    //     parsing (`evaluateGate`/`scoreNum` are NaN- and no-match-safe).
    // If any of those stop holding, for example `mapPool` starts letting a
    // rejection through, `auditTriageFile` grows a path that rethrows instead
    // of returning an error row, or a post-pool step starts throwing on
    // malformed row data, THIS catch becomes reachable with a real resource
    // context and needs the end-to-end test this comment stands in for
    // (assert the failure result carries the `Resources:` line).
    return mapHandlerFailure(error, ctx, resourcesForCatch?.report());
  }
}

/**
 * Render the sweep's outcome in the requested format, with `structuredContent`,
 * the JSON text block and the TEXT block all driven by the same payload.
 *
 * The text renderer used to receive the raw ranking/errors/counts instead of the
 * payload, which meant it could not see `payload.gate` — so `outputFormat:
 * 'text'` silently dropped the gate verdict and behaved like a feature toggle
 * rather than a rendering choice (audit M-gateText). One payload, three
 * projections: they cannot disagree.
 *
 * A FAILING GATE DELIBERATELY DOES NOT SET `isError`. Both tools promise this in
 * their input schemas — `tool-schema.ts` documents the audit tool's minScore as
 * "the result reports gate.passed=false (never an error)" and the triage tool's
 * as "the result reports gate.passed=false and lists the failing files. Never
 * causes an error." Flipping `isError` would also throw away the ranking's error
 * channel semantics: every other `isError: true` here means the sweep could not
 * be performed, not that it was performed and the code scored badly. The gate
 * verdict is instead made unmissable in the text block itself (first line).
 *
 * `unaudited` is sorted by the caller — the empty-discovery path has none, so it
 * passes `[]`.
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
  resources?: ResourcesPayload,
): CallToolResult {
  const payload = buildTriagePayload(
    ranking,
    errors,
    discovered,
    skipped,
    scopeNote,
    minScore,
    unaudited,
    resources,
  );
  const text = outputFormat === 'text' ? formatTriageAsText(payload) : JSON.stringify(payload);
  return {
    content: [{ type: 'text', text }],
    structuredContent: toStructuredContent(payload),
  };
}
