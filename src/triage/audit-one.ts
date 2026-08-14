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
import { cpus } from 'node:os';
import { auditFile } from '../audit/audit-file.js';
import { createSandbox } from '../utils/sandbox.js';
import type { EnvironmentInfo, SupportedProjectType } from '../utils/project-detector.js';
import { ENGINE_REGISTRY, makeEngine, resolvePrebuildCommand } from '../engines/registry.js';
import { computeChangedRanges } from '../utils/git-diff.js';
import { resolveAuditTargetIn } from '../audit/target.js';
import { loadSuppressions, verifySuppressions, type StoredEntry } from '../utils/suppression.js';
import { applySuppressions } from '../audit/apply-suppressions.js';
import { isWholeFileRun } from '../audit/suppression-io.js';
import { mintRunId } from '../utils/run-cache.js';
import { buildResultPayload } from '../core/format.js';
import { displayMutationScore, hasNoMutableLogic } from '../core/score-semantics.js';
import { mapCreateSandboxError, failureText } from '../core/tool-result.js';
import type { MutationResult } from '../engines/base.js';
import type { ChaosConfig } from '../utils/config-loader.js';
import type { ToolContext } from '../core/tool-context.js';
import type { ToolArgs } from '../core/tool-args-validation.js';
import type { AuditDeadline } from '../utils/deadline.js';
import type { TriageRow, TriageError } from '../core/triage.js';

/**
 * What one file contributed to the sweep: a ranked row, a per-file failure, or
 * nothing at all because the sweep's budget ran out before it started.
 *
 * "Unaudited" is deliberately neither of the other two — nothing went wrong and
 * nothing was measured, so the caller can re-run for the remainder instead of
 * reading the ranking as covering everything they asked for.
 *
 * It covers two moments, both "never started": before any work was done for the
 * file, and after provisioning (diff scoping + the sandbox copy) spent what was
 * left, which is why the budget is re-read once the sandbox exists rather than
 * trusted from before it.
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
  /**
   * Per-file worker cap for engines that honour one, or `undefined` when the
   * pool is serial and no cap is needed. Named for what it bounds rather than
   * for StrykerJS: it applies to every engine with `honorsConcurrency`, which is
   * cargo-mutants' `-j` and Infection's `--threads` as well as Stryker's
   * `--concurrency`.
   */
  perFileConcurrency: number | undefined;
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
  /**
   * Applied suppressions whose (line, mutator) matched no SURVIVING mutant this
   * run, gated on {@link isWholeFileRun} the same way the audit tool gates it.
   */
  orphanedSuppressions: number;
  /**
   * Applied suppressions placed at a different line than the one stored,
   * because an edit moved them. The count only — the per-entry tier-3 notes
   * belong to a single-file audit, not a leaderboard over hundreds of files.
   */
  relocatedSuppressions: number;
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
  if (input.orphanedSuppressions > 0) row.orphanedSuppressions = input.orphanedSuppressions;
  if (input.relocatedSuppressions > 0) row.relocatedSuppressions = input.relocatedSuppressions;

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
  //
  // NOT minted for a SCOPED row (Finding 3). `triage_test_coverage { diffBase }`
  // audits each file on its CHANGED LINES only, and a runId's only use is as a
  // verify baseline — but verify re-runs the whole file and reports every fresh
  // survivor that is not in the baseline as a `newSurvivor`, worded "your change
  // introduced these uncaught mutants" (`core/prompts.ts`, the `triage_changes`
  // flow). Handing back a line-scoped baseline therefore libels every
  // PRE-EXISTING survivor on an unchanged line as a regression the caller just
  // caused. Withholding the id is the honest answer: the row still carries its
  // score and survivors, and the caller can re-audit the file whole-file to get
  // a baseline that can be verified. Same rule, same reasoning and the same
  // `scopeKind === 'scoped'` test as `audit/run-id.ts` — see the long comment
  // there for why that test is exact rather than approximate.
  let rowRunId: string | undefined;
  try {
    if (result.scopeKind !== 'scoped') {
      rowRunId = mintRunId(buildResultPayload(result, {}), input.relFromRoot, projectType, {
        ttlMs: deps.cfg.runCacheTtlMs,
        max: deps.cfg.runCacheMax,
        workspaceRoot: input.workspaceRoot,
      });
    }
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

/**
 * The smallest slice of the sweep's budget worth starting an engine with.
 *
 * Mirrors `MIN_ENGINE_BUDGET_MS` in `handler.ts`, which applies the same floor
 * to the single-file audit tool. It is restated rather than imported because
 * that constant is local to `reserveEngineBudget` and the handler is not a
 * dependency of this module.
 */
const MIN_ENGINE_BUDGET_MS = 1_000;

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
  // A2: cap the per-file worker count when the sweep runs more than one file at
  // a time (`perFileConcurrency` is defined only then).
  //
  // Gated on the ENGINE's own `honorsConcurrency` flag, not on `=== 'typescript'`.
  // The old spelling left the cap unapplied for every other language, and the
  // one where that hurts is Rust: cargo-mutants was left at its own default of
  // `-j 2`, so a default sweep ran fileConcurrency 4 × 2 cargo jobs = 8
  // concurrent cargo builds, each wanting its own multi-GB target directory,
  // while the tool schema promised the three layers multiplied out to roughly
  // the core count. cosmic-ray has no worker flag at all and is excluded by the
  // same registry field that already excludes it from the ignored-options report.
  //
  // `Math.min` with the engine's own default is what makes this a CAP rather
  // than an instruction. `perFileConcurrency` divides the CORE count across the
  // pool, which is the right ceiling for an engine whose default is core-scaled
  // (Stryker auto-detects cores; Infection asks for `--threads=max`). It is the
  // wrong number for cargo-mutants, whose low default answers a MEMORY question
  // instead — each job wants its own target directory — so on an 8-core box a
  // pool of 2 computes a cap of 3 and would have RAISED cargo from 2 jobs to 3.
  // A ceiling that can raise the thing it bounds is not a ceiling.
  const engine = ENGINE_REGISTRY[projectType];
  if (deps.perFileConcurrency !== undefined && engine.honorsConcurrency) {
    const ownDefault = engine.defaultWorkers?.(cpus().length);
    perFileArgs.concurrency =
      ownDefault === undefined
        ? deps.perFileConcurrency
        : Math.min(deps.perFileConcurrency, ownDefault);
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
    //
    // This is the FIRST of two reads. It only bounds the pre-engine work (the
    // git calls in `resolveDiffScope`); the engine's own timeout comes from a
    // SECOND read taken after the sandbox copy, because everything between the
    // two — up to four git calls and a full workspace copy — spends wall-clock
    // this number does not know about. See the re-read below.
    const fileBudgetMs = deps.deadline.remainingMs(deps.cleanupReserveMs);
    if (fileBudgetMs <= 0) return { unaudited: file };
    const target = resolveAuditTargetIn(deps.rootCwd, file);
    if (!target) {
      return { error: { file, error: `Unsupported file type for ${file}` } };
    }
    const { projectType, env, relFromRoot, targetFile } = target;
    const suppressionMap = suppressionsFor(env.workspaceRoot, deps);
    const engine = makeEngine(projectType);

    // `undefined`, not a value off the args bag: triage has never accepted a
    // caller-supplied prebuildCommand — `buildPerFileArgs` constructs the bag
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
        dependencies: deps.cfg.sandbox?.dependencies,
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
      // Re-read the budget now that provisioning is done (audit Med#9). The
      // first read happened before up to four git calls (each clamped to
      // min(15s, fileBudgetMs)) and before the whole untimed workspace copy, so
      // handing it to the engine promised time the sweep no longer has —
      // multiplied by every worker in flight. This read is the one the engine
      // is actually held to.
      //
      // Falling under the floor lands in the SAME "unaudited" bucket as a file
      // that never started: nothing went wrong and nothing was measured, so the
      // caller can re-run for the remainder rather than read the ranking as
      // covering everything it asked for. Starting an engine that provably
      // cannot finish would instead spend the reserve and report a failure.
      // The `finally` below still cleans the sandbox up on this path.
      const engineBudgetMs = deps.deadline.remainingMs(deps.cleanupReserveMs);
      if (engineBudgetMs < MIN_ENGINE_BUDGET_MS) return { unaudited: file };
      const perFileArgs = buildPerFileArgs(engineBudgetMs, projectType, deps);
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
    const sup = applySuppressions(result, verdict);

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
          driftedSuppressions: sup.drifted,
          unverifiedSuppressions: verdict.unverified,
          // The COUNT only. A leaderboard over hundreds of files would drown in
          // the per-entry tier-3 notes; those belong to a single-file audit,
          // where there is room to act on them.
          relocatedSuppressions: sup.relocated.length,
          // Gated on the PRE-suppression `result`, not `sup.result`.
          // `applySuppressions` returns a new object and never reassigns this
          // one, so `result` is still the engine's own snapshot — which
          // matters because filtering CAN synthesise a `scopeNote`
          // (`apply-suppressions.ts`, when suppression drives `totalMutants`
          // to 0) and `isWholeFileRun`'s fallback branch reads `scopeNote`.
          // Gating on the filtered result would flip the scope answer and mask
          // a real orphan in exactly the case this counter exists for.
          // `applyAndCountSuppressions` evaluates it on the same pre-filter
          // snapshot for the same reason, so the two tools cannot disagree.
          orphanedSuppressions: isWholeFileRun(result) ? sup.orphaned : 0,
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
