/**
 * Auditing ONE file inside a triage sweep.
 *
 * This was a 201-line closure inside `handleTriageCall` that captured a dozen
 * outer variables (Finding 3). Lifting it to the top level with an explicit
 * `deps` object makes the sweep's per-file contract visible — and testable —
 * without changing a single message, budget, or ordering decision.
 *
 * The three phases are split so no block nests deeper than two levels:
 * {@link resolveDiffScope} decides what part of the file is in scope,
 * `auditTriageFile` runs the engine inside the sandbox lifetime, and
 * {@link buildTriageRow} assembles the leaderboard row from the result.
 */
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { auditFile } from '../audit/audit-file.js';
import { createSandbox } from '../utils/sandbox.js';
import type { EnvironmentInfo, SupportedProjectType } from '../utils/project-detector.js';
import { ENGINE_REGISTRY, makeEngine, resolvePrebuildCommand } from '../engines/registry.js';
import { computeChangedRanges } from '../utils/git-diff.js';
import { resolveAuditTargetIn } from '../audit/target.js';
import { loadSuppressions, verifySuppressions, type StoredEntry } from '../utils/suppression.js';
import { applySuppressions } from '../audit/apply-suppressions.js';
import { mintRunId } from '../utils/run-cache.js';
import { buildResultPayload, displayMutationScore, hasNoMutableLogic } from '../format.js';
import { mapCreateSandboxError, failureText } from '../tool-result.js';
import type { MutationResult } from '../engines/base.js';
import type { ChaosConfig } from '../utils/config-loader.js';
import type { ToolContext } from '../tool-context.js';
import type { ToolArgs } from '../tool-args-validation.js';
import type { AuditDeadline } from '../utils/deadline.js';
import type { TriageRow, TriageError } from '../triage.js';

/**
 * What one file contributed to the sweep: a ranked row, a per-file failure, or
 * nothing at all because the sweep's budget ran out before it started.
 *
 * "Unaudited" is deliberately neither of the other two — nothing went wrong and
 * nothing was measured, so the caller can re-run for the remainder instead of
 * reading the ranking as covering everything they asked for.
 */
export type TriageAuditOutcome =
  | { row: TriageRow }
  | { error: TriageError }
  | { unaudited: string };

/** Everything one file's audit needs from the sweep that owns it. */
export interface TriageFileDeps {
  /** Directory the caller's paths resolve against (the server's cwd). */
  rootCwd: string;
  cfg: ChaosConfig;
  /** The raw tool arguments; `timeoutMs` and `mutatorDenylist` are read per file. */
  args: ToolArgs;
  /** Validated git ref when the sweep is diff-scoped, else `undefined`. */
  diffBase: string | undefined;
  /** Per-file StrykerJS worker cap, or `undefined` when the pool is serial. */
  strykerConcurrency: number | undefined;
  /** How many survivors to inline per row; 0 means scores only. */
  survivorsPerFile: number;
  /**
   * Suppressions memoized per workspaceRoot — NOT once from rootCwd — so that
   * monorepo packages whose workspaceRoot differs from rootCwd read the right
   * suppressions file. Keys are workspace-relative paths (relFromRoot),
   * matching the key used by audit_code_resilience (Task 7 / Key Contract).
   *
   * The cache holds the STORED entries, not a key set: fingerprint verification
   * needs the entries, and is done per audited file so the sweep reads only the
   * source files it actually audits.
   */
  suppressionCache: Map<string, Map<string, StoredEntry[]>>;
  /** The sweep-wide wall-clock budget every file spends from. */
  deadline: AuditDeadline;
  /** Reserve left unspent so ranking/formatting can finish after the last file. */
  cleanupReserveMs: number;
  ctx?: ToolContext;
  /** Advance the sweep's progress counter (called once per file, always). */
  onProgress: () => void;
}

/** The line scope for one file, plus the note explaining it on the row. */
interface DiffScope {
  lineRanges?: { start: number; end: number }[];
  scopeNote?: string;
}

/**
 * Narrow a diff-scoped sweep down to the changed lines of ONE file.
 *
 * Whole-file (`{}`) for a sweep that is not diff-scoped. Languages whose engine
 * cannot take a line scope say so on the row: their score covers more than the
 * diff, and an unlabelled 60% would read as "your changed lines are 60%
 * covered".
 */
async function resolveDiffScope(
  targetFile: string,
  env: EnvironmentInfo,
  projectType: SupportedProjectType,
  fileBudgetMs: number,
  deps: TriageFileDeps,
): Promise<DiffScope> {
  if (deps.diffBase === undefined) return {};
  if (!ENGINE_REGISTRY[projectType].supportsLineScope) {
    return { scopeNote: 'diff scoping unsupported for this language; whole file' };
  }
  const diff = await computeChangedRanges(targetFile, env.workspaceRoot, deps.diffBase, {
    signal: deps.ctx?.signal,
    timeoutMs: fileBudgetMs,
  });
  switch (diff.kind) {
    case 'ranges':
      return { lineRanges: diff.ranges, scopeNote: 'scored on changed lines' };
    case 'untracked':
      return { scopeNote: 'untracked; whole file' };
    case 'git-failed':
      // The git call never got an ANSWER — a timeout, a missing binary, or an
      // unclassifiable rejection (utils/git-diff.ts). Before this branch existed
      // the variant fell out of the bottom of this function with no ranges and
      // NO note, so the file was mutated WHOLE-FILE and the row's score was
      // presented as though the sweep had never been diff-scoped at all.
      //
      // Degrade-with-a-note, NOT an error row — deliberately different from the
      // sibling in `audit/scope.ts`, which returns a tool error:
      //  * There, `diffBase` is the caller's request about THE one file, so
      //    failing to scope is failing the request, and there is nothing else in
      //    flight to protect.
      //  * Here, `diffBase` already did its main job — it SELECTED the file set
      //    (`listChangedFiles`, which succeeded, or the sweep would have errored
      //    out before any file was audited). Per-file line scoping is a
      //    refinement of a score that is still meaningful without it.
      //  * The dominant cause is our own clamp: `timeoutMs: fileBudgetMs` shrinks
      //    as the sweep's wall-clock budget drains, so the tail of a long sweep
      //    is exactly where timeouts appear. Erroring the row would convert
      //    "running low on time" into a run of empty `errors[]` entries and throw
      //    away every score the sweep had left to give — for a sweep whose whole
      //    contract is "a per-file failure is a row, never fatal" (see
      //    `auditTriageFile`).
      // What is NOT acceptable is the silent version, so the reason travels onto
      // the row and the caller can see the number is broader than they asked for.
      return { scopeNote: `git could not scope this file (${diff.reason}); whole file` };
    case 'no-changes':
    case 'not-a-repo':
    case 'bad-ref':
      // The file was SELECTED by the same diffBase, so these are rare and say
      // nothing useful per row: leave it whole-file and unlabelled (unchanged
      // behaviour). Listed explicitly rather than left to a fallthrough so the
      // guard below can do its job.
      return {};
    default: {
      // Exhaustiveness guard, mirroring `audit/scope.ts` (audit F15 style):
      // `diff` narrows to `never` here, so ADDING a DiffResult variant without
      // handling it above is a COMPILE error. That is not hypothetical — it is
      // precisely how `git-failed` arrived and silently turned a failed git call
      // into an unlabelled whole-file row.
      const unhandled: never = diff;
      return {
        scopeNote: `diff scoping returned an unrecognised git result (${JSON.stringify(unhandled)}); whole file`,
      };
    }
  }
}

/** The already-suppression-filtered facts a row is assembled from. */
interface RowInput {
  file: string;
  result: MutationResult;
  relFromRoot: string;
  /**
   * The workspace root `relFromRoot` is relative to (`env.workspaceRoot`).
   *
   * Carried on the row input purely so the minted runId can be bound to it
   * (audit M10). `relFromRoot` is a workspace-RELATIVE key, and until the
   * fingerprint was stamped alongside it a triage-minted runId for workspace
   * A's `src/index.ts` satisfied the verify path's `cached.file === relFile`
   * check while pointed at workspace B's `src/index.ts`. A sweep resolves the
   * root PER FILE (`detectEnvironment(file)`), so this cannot be hoisted onto
   * {@link TriageFileDeps}: one sweep can legitimately span several monorepo
   * package roots.
   */
  workspaceRoot: string;
  projectType: SupportedProjectType;
  scopeNote?: string;
  suppressedCount: number;
  /** Stored suppressions rejected because their fingerprint no longer matches. */
  driftedSuppressions: number;
  /** Stored suppressions rejected because they carry no fingerprint (v1 data). */
  unverifiedSuppressions: number;
}

/**
 * Assemble one leaderboard row: score, counts, partial-audit state, runId, and
 * (when asked for) inlined survivors.
 */
function buildTriageRow(input: RowInput, deps: TriageFileDeps): TriageRow {
  const { file, result, projectType } = input;
  const row: TriageRow = {
    file,
    // Substitute "n/a" for a no-mutable-logic file so it is not ranked as a
    // genuine 100% (audit M3) — shared with audit_code_resilience via format.ts.
    mutationScore: displayMutationScore(result),
    total: result.totalMutants,
    killed: result.killed,
    survived: result.survived,
    noCoverage: Math.max(0, result.vulnerabilities.length - result.survived),
  };
  if (hasNoMutableLogic(result)) row.noMutableLogic = true;
  if (input.scopeNote) row.scopeNote = input.scopeNote;
  // Carry partial-audit state onto the row so the leaderboard and the gate
  // can tell "scored 92% over the whole file" from "scored 92% over the
  // third of it we had time for".
  if (result.complete === false) {
    row.complete = false;
    if (result.batchesCompleted !== undefined) row.batchesCompleted = result.batchesCompleted;
    if (result.batchesPlanned !== undefined) row.batchesPlanned = result.batchesPlanned;
  }
  if (input.suppressedCount > 0) row.suppressedCount = input.suppressedCount;
  // Un-applied suppressions are per-file facts, so they ride on the row; the
  // sweep-level note in buildTriagePayload aggregates them.
  if (input.driftedSuppressions > 0) row.driftedSuppressions = input.driftedSuppressions;
  if (input.unverifiedSuppressions > 0) row.unverifiedSuppressions = input.unverifiedSuppressions;

  // Mint a per-row runId so the caller can verify survivors from a triage result
  // without re-auditing. A cache failure is non-fatal (mintRunId swallows it):
  // omit the runId rather than fail the whole triage row.
  //
  // The compact payload is built here rather than inside mintRunId (run-cache.ts
  // is a leaf util and may not import format.js); the try preserves the swallow
  // that used to cover the construction too. It is deliberately a separate,
  // uncapped `{}` build from the enriched one below — reusing that one would
  // cache only `survivorsPerFile` survivors, and a later verify would read the
  // truncated-away ones as fixed.
  //
  // `workspaceRoot` binds the entry to the tree it was minted from (audit M10),
  // exactly as the audit tool's mint site does — the two tools share this cache
  // and `audit_code_resilience` must be able to verify a triage-minted runId
  // (the documented cross-tool flow). `audit/scope.ts` now refuses a hash-less
  // entry, so a row minted without this would hand the caller a runId that no
  // verify could ever accept.
  let rowRunId: string | undefined;
  try {
    rowRunId = mintRunId(buildResultPayload(result, {}), input.relFromRoot, projectType, {
      ttlMs: deps.cfg.runCacheTtlMs,
      max: deps.cfg.runCacheMax,
      workspaceRoot: input.workspaceRoot,
    });
  } catch {
    rowRunId = undefined;
  }
  if (rowRunId !== undefined) row.runId = rowRunId;

  // Enrich with inline survivors when the caller asked for them.
  // Source-read failure is non-fatal: enrichment works without source lines
  // (severity comes from mutator type, not the code text).
  // Skip the synchronous read when the call has already been cancelled:
  // burning CPU on a cancelled triage row is wasted work (audit M5).
  if (deps.survivorsPerFile > 0 && !deps.ctx?.signal?.aborted) {
    let sourceLines: string[] | undefined;
    try {
      sourceLines = readFileSync(resolve(deps.rootCwd, file), 'utf8').split(/\r?\n/);
    } catch {
      sourceLines = undefined;
    }
    const payload = buildResultPayload(result, {
      enrich: { projectType, sourceLines },
      maxSurvivors: deps.survivorsPerFile,
    });
    if (payload.survivors.length > 0) row.survivors = payload.survivors;
    if (payload.noCoverage.length > 0) row.noCoverageGroups = payload.noCoverage;
    if (payload.summary.worstSeverity) row.worstSeverity = payload.summary.worstSeverity;
  }

  return row;
}

/**
 * The suppressions for `workspaceRoot`, loading (and memoizing) them on first use.
 *
 * NOT `audit/suppression-io.ts#loadSuppressedKeys`, deliberately: that helper
 * reads and re-parses the suppressions file on every call, which is right for
 * the audit tool (one file per call) and wrong here (up to `maxFiles` files per
 * sweep, all usually under one workspace root). Adopting it would trade this
 * memoization for N synchronous reads and parses per sweep. The two agree on
 * everything that matters — same loader, same workspace root, same
 * workspace-relative key — so the Key Contract holds either way.
 */
function suppressionsFor(workspaceRoot: string, deps: TriageFileDeps): Map<string, StoredEntry[]> {
  const cached = deps.suppressionCache.get(workspaceRoot);
  if (cached !== undefined) return cached;
  const loaded = loadSuppressions(workspaceRoot, deps.cfg.suppressionsPath);
  deps.suppressionCache.set(workspaceRoot, loaded);
  return loaded;
}

/** The per-file arguments handed to the shared `auditFile` core. */
function buildPerFileArgs(
  fileBudgetMs: number,
  projectType: SupportedProjectType,
  deps: TriageFileDeps,
): ToolArgs {
  const perFileArgs: ToolArgs = {
    // Clamp the per-file timeout to what is left of the sweep's budget, so
    // one slow file cannot consume time the remaining files need.
    timeoutMs:
      typeof deps.args.timeoutMs === 'number'
        ? Math.min(deps.args.timeoutMs, fileBudgetMs)
        : fileBudgetMs,
    mutatorDenylist: deps.args.mutatorDenylist,
  };
  // A2: include Stryker concurrency cap only for TypeScript files and only
  // when the pool size is > 1 (strykerConcurrency is defined).
  if (deps.strykerConcurrency !== undefined && projectType === 'typescript') {
    perFileArgs.concurrency = deps.strykerConcurrency;
  }
  return perFileArgs;
}

/**
 * Audit one file and return its outcome. NEVER throws: a per-file failure is a
 * row in `errors[]`, never fatal to the sweep.
 */
export async function auditTriageFile(
  file: string,
  deps: TriageFileDeps,
): Promise<TriageAuditOutcome> {
  const ctx = deps.ctx;
  try {
    // Skip not-yet-started files quickly when already cancelled. (Task 6)
    if (ctx?.signal?.aborted) {
      return { error: { file, error: 'Operation cancelled.' } };
    }
    // The sweep's budget is spent. A file that never started is neither an
    // error (nothing went wrong) nor a result (nothing was measured) — report
    // it as unaudited so the caller can re-run for the remainder rather than
    // read the ranking as covering everything it asked for.
    const fileBudgetMs = deps.deadline.remainingMs(deps.cleanupReserveMs);
    if (fileBudgetMs <= 0) return { unaudited: file };
    const target = resolveAuditTargetIn(deps.rootCwd, file);
    if (!target) {
      return { error: { file, error: `Unsupported file type for ${file}` } };
    }
    const { projectType, env, relFromRoot, targetFile } = target;
    const suppressionMap = suppressionsFor(env.workspaceRoot, deps);
    const engine = makeEngine(projectType);

    const perFileArgs = buildPerFileArgs(fileBudgetMs, projectType, deps);
    // `undefined`, not `perFileArgs.prebuildCommand`: triage has never accepted
    // a caller-supplied prebuildCommand — `buildPerFileArgs` constructs the bag
    // from scratch with three keys and that is not one of them — so only the
    // registry's auto-prebuild (Rust's `cargo check`) can apply here. Reading it
    // off the bag would have been dead code that implied an ungated path for an
    // argument `resolveGatedPrebuild` gates everywhere else (audit Med#10).
    const prebuildCmd = resolvePrebuildCommand(undefined, env, projectType);
    const scope = await resolveDiffScope(targetFile, env, projectType, fileBudgetMs, deps);

    // audit C1: await the async createSandbox; forward the abort signal so
    // a mid-copy cancel from the MCP client propagates into the file copy.
    // Wrapped in try/catch so a sandbox-failure row can be returned to the
    // pooling caller (instead of being thrown to the outer catch and aborting
    // other in-flight audits via tool-promise rejection).
    let sandbox: Awaited<ReturnType<typeof createSandbox>>;
    try {
      sandbox = await createSandbox(targetFile, env.workspaceRoot, undefined, {
        signal: ctx?.signal,
      });
    } catch (error: unknown) {
      // Cancellation (mid-CP reject or pre-aborted signal) must surface as a
      // row with `error: 'Operation cancelled.'` so the caller can distinguish
      // it from a real provisioning failure (which surfaces the file's `raw`
      // error message). `mapCreateSandboxError` owns both strings for all three
      // tools; unwrap its CallToolResult back into this row's error text.
      return { error: { file, error: sandboxErrorText(error, file, ctx) } };
    }
    let result: MutationResult;
    try {
      result = await auditFile({
        targetFile,
        env,
        projectType,
        engine,
        args: perFileArgs,
        config: deps.cfg,
        workDir: sandbox.workDir,
        prebuildCmd,
        lineRanges: scope.lineRanges,
        signal: ctx?.signal, // Task 6: thread abort signal so in-flight subprocesses are killed
      });
    } finally {
      sandbox.cleanup();
    }

    // Apply equivalent-mutant suppression before building the row. The key is
    // relFromRoot — byte-identical to the key used by audit_code_resilience (Key
    // Contract) so suppressions added via audit are honored in triage.
    //
    // Verification happens here, once per audited file, against the memoized
    // per-workspace entries: the suppressions FILE is still read once per
    // workspace, never once per file.
    const verdict = verifySuppressions(
      env.workspaceRoot,
      relFromRoot,
      suppressionMap.get(relFromRoot),
    );
    const sup = applySuppressions(result, verdict.applied);

    return {
      row: buildTriageRow(
        {
          file,
          result: sup.result,
          relFromRoot,
          // Same `env` the suppressions, the sandbox and the diff scope were
          // resolved against, so the minted runId is fingerprinted for the
          // workspace `relFromRoot` is actually relative to (audit M10).
          workspaceRoot: env.workspaceRoot,
          projectType,
          scopeNote: scope.scopeNote,
          suppressedCount: sup.suppressedCount,
          driftedSuppressions: verdict.drifted,
          unverifiedSuppressions: verdict.unverified,
        },
        deps,
      ),
    };
  } catch (error: unknown) {
    // An in-flight cancel (subprocess killed by the abort signal →
    // ExecFailureError('ABORTED'), OR the signal flipped JUST as we entered
    // this catch) must surface as 'Operation cancelled.' — NOT as the raw
    // `'ABORT_ERR ...'` engine stderr text the caller can't branch on.
    // `failureText` is the shared cancel-or-message rule; unlike the three
    // CallToolResult handlers, a per-file row carries no 'Chaos Engine Halted'
    // prefix, so it uses that rule directly rather than `mapHandlerFailure`.
    return { error: { file, error: failureText(error, ctx) } };
  } finally {
    // Advance progress counter in finally so even errored files are counted. (Task 6)
    deps.onProgress();
  }
}

/**
 * The sandbox-failure text for a triage row, taken from the shared
 * {@link mapCreateSandboxError} so triage cannot drift from the audit and
 * estimate tools on the cancel/provisioning wording (that is the whole point of
 * the helper). Triage reports per file rather than per call, so the shared
 * `CallToolResult` is unwrapped back to its message here.
 */
function sandboxErrorText(error: unknown, file: string, ctx?: ToolContext): string {
  const mapped = mapCreateSandboxError(error, file, ctx);
  return (mapped.content as { text: string }[])[0].text;
}
