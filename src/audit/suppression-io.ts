/**
 * Suppression-file I/O for a single audited file.
 *
 * Extracted from `handler.ts` (Finding 2). Two things live here: applying the
 * `suppress` / `unsuppress` tool arguments (a write), and reading back the key
 * set for one file (a read). Both are keyed by the WORKSPACE-RELATIVE path so
 * the suppressions file stays portable/committable and every reader agrees on
 * the key (Task 7 / Key Contract).
 *
 * `triage-handler.ts` performs the same read against a memoized per-workspace
 * map, which is why {@link loadVerifiedSuppressions} takes the workspace root
 * rather than a preloaded map: it can adopt this helper without changing its
 * call shape. Wiring triage up is deliberately left to the triage decomposition.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolArgs } from '../core/tool-args-validation.js';
import type { ToolContext } from '../core/tool-context.js';
import type { MutationResult } from '../engines/base.js';
import type { MutantKey } from '../core/verify.js';
import { toolError } from '../core/tool-result.js';
import { applySuppressions } from './apply-suppressions.js';
import type { RelocationNote, RejectionNote } from '../core/score-semantics.js';
import { warn } from '../utils/logger.js';
import { changeOf } from '../utils/mutant-identity.js';

/**
 * How one file's stored suppressions were resolved for this run: how many were
 * applied, and how many were rejected as drifted / unverified.
 *
 * Declared here rather than beside the formatter that renders it: this module
 * is what produces the counts, and `audit-output.ts` already imports
 * `loadVerifiedSuppressions` from here — so owning the type there too made the
 * two modules import each other. The runtime never saw it (the back-edge was
 * type-only, and erased), but it was a real cycle in the dependency graph and
 * the `new_cycles: 0` budget in knossos.json rejects it.
 */
export interface SuppressionCounts {
  /** Mutants actually excluded from the score. */
  applied: number;
  /** Entries whose content fingerprint no longer matches their source line. */
  drifted: number;
  /** Entries with no fingerprint at all (v1 data), never applied. */
  unverified: number;
  /**
   * Applied entries whose (line, mutator) matched no SURVIVING mutant this run
   * — inert, and previously reported by nothing. Either the mutant is now
   * killed or its identity is gone; a `MutationResult` carries no killed-mutant
   * identities, so the two cannot be told apart here (see `applySuppressions`).
   */
  orphaned: number;
  /**
   * Entries this call's `suppress` argument asked for and the write REFUSED,
   * because the target line is blank or comment-only and no engine reports a
   * mutant there (see `isNonMutableLine` in utils/suppression.ts).
   *
   * Reported because the caller's intent did not land: the entry is not stored,
   * so nothing later will ever mention it again. Silence here is how 40 stored
   * suppressions came to point at comments in this repository's own corpus.
   */
  rejected: number;
  /**
   * Entries applied at a DIFFERENT line than the one stored, because an edit
   * moved them. Tier 2 (the line's content was found elsewhere) cannot be wrong
   * and is only counted; tier 3 (the line itself was rewritten and the mutant
   * was found by its change) is listed in {@link relocations}, because it is the
   * one tier that can re-point an entry onto unrelated code.
   */
  relocated: number;
  /** The tier-3 moves, for the per-entry note. Empty on the common path. */
  relocations: RelocationNote[];
  /** The refused `suppress` requests, with the candidates for an ambiguous one. */
  rejections: RejectionNote[];
}
import {
  loadSuppressions,
  addSuppressions,
  removeSuppressions,
  verifySuppressions,
  restampSuppressions,
  toPortableKey,
  type AddSuppressionsResult,
  type SuppressionInput,
  type SuppressionVerdict,
} from '../utils/suppression.js';

/**
 * Whether a `MutationResult` enumerated the WHOLE file — the only condition
 * under which an applied-but-unmatched suppression is worth reporting as
 * orphaned rather than as a scope artifact.
 *
 * Shared by {@link applyAndCountSuppressions} (the audit path) and the triage
 * sweep (`triage/audit-one.ts`), which both gate their orphan count on it: a
 * lineScope- or diffBase-scoped audit legitimately generates no mutant for a
 * suppressed line outside its range, and calling that an orphan would cry
 * wolf.
 *
 * `complete === false` disqualifies a run regardless of `scopeKind`.
 * `scopeKind` records the REQUESTED scope (see its docblock in
 * `engines/base.ts`), and `mergeBatchResults` (`engines/typescript/batches.ts`)
 * stamps `'whole-file'` even when a time budget stopped the run after 3 of 7
 * batches. Every suppression whose `(line, mutator)` lives in a batch that
 * never ran would then be reported as orphaned — the exact cry-wolf failure
 * this gate exists to prevent, on the one engine that batches by default.
 *
 * TRANSITIONAL, twin of `hasNoMutableLogic`'s conjunct 2 in
 * `core/score-semantics.ts` (see the note there): only the TypeScript engine
 * emits `scopeKind` today, so gating on `=== 'whole-file'` alone would
 * hard-wire this to `false` for every Rust, Python and PHP run — exactly the
 * Rust-upgrade case this whole feature exists for. The fallback (`scopeKind`
 * unset AND no `scopeNote`) is safe rather than an approximation: Python,
 * Rust and PHP set `supportsLineScope: false` in `engines/registry.ts`, so a
 * run of theirs is ALWAYS whole-file and there is no scoped case for the
 * fallback to misjudge. TypeScript, the one engine that can be scoped, always
 * sets `scopeKind` explicitly and so never reaches it. Delete this fallback
 * alongside that one once every engine sets `scopeKind`.
 */
export function isWholeFileRun(result: MutationResult): boolean {
  if (result.complete === false) return false;
  return result.scopeKind === 'whole-file' || (result.scopeKind === undefined && !result.scopeNote);
}

/**
 * Apply the caller's explicit suppression edits to the suppressions file.
 *
 * Both writes are awaited so a subsequent run in the same turn cannot race the
 * read-modify-write cycle on the file (audits H3: the write paths are async
 * behind a Promise-chain mutex). Throws whatever the write layer throws; the
 * caller decides how to report it.
 *
 * Returns what the add actually recorded. An `unstamped` entry is one whose
 * source line could not be read, so it was stored without a fingerprint and
 * will NOT be applied — visible to the caller here, and visible in the same
 * response as an `unverified` count, because this call happens before the
 * re-load that produces those counts.
 */
export async function applySuppressionArgs(
  args: ToolArgs,
  wsRoot: string,
  relFromRoot: string,
  supPath: string | undefined,
  auditResults: MutationResult,
): Promise<AddSuppressionsResult> {
  const survivors = auditResults.vulnerabilities;
  let added: AddSuppressionsResult = { stamped: 0, unstamped: 0, rejected: [] };
  if (Array.isArray(args.suppress) && args.suppress.length > 0) {
    const requested = args.suppress as {
      line: number;
      mutator: string;
      reason?: string;
      change?: string;
    }[];
    const resolved: SuppressionInput[] = [];
    const ambiguous: AddSuppressionsResult['rejected'] = [];
    for (const r of requested) {
      if (r.change !== undefined) {
        resolved.push(r);
        continue;
      }
      // No change given: derive it from this run's mutants. This is the ONLY
      // place that can — the storage layer never sees a MutationResult — and it
      // keeps the ordinary two-field call working.
      const candidates = [
        ...new Set(
          survivors
            .filter((v) => v.line === r.line && v.mutator === r.mutator)
            .map((v) => changeOf(v))
            .filter((c): c is string => c !== undefined),
        ),
      ].sort();
      if (candidates.length > 1) {
        // Refuse rather than suppress all of them. Filing this entry is exactly
        // how an equivalent mutant takes a KILLED sibling's coverage signal down
        // with it — three survivors in this repository were left unsuppressed
        // for months to avoid that trade, and this is what removes it.
        ambiguous.push({ line: r.line, mutator: r.mutator, cause: 'ambiguous', candidates });
        continue;
      }
      if (candidates.length === 1) {
        resolved.push({ ...r, change: candidates[0] });
        continue;
      }
      // Zero candidates. On a COMPLETE run that means the mutant does not exist
      // — killed, or gone — and filing the entry changeless preserves the
      // caller's reason under mutator-only identity, which is the pre-v3
      // behaviour and the only identity cargo-mutants can offer anyway.
      //
      // On an INCOMPLETE run it means nothing at all: the mutant may sit in a
      // batch that never ran. Storing a broader entry than the caller asked for,
      // on the strength of a run that did not look, is exactly the silent
      // over-suppression this schema exists to end.
      if (auditResults.complete === false) {
        ambiguous.push({ line: r.line, mutator: r.mutator, cause: 'unresolved' });
        continue;
      }
      resolved.push(r);
    }
    if (resolved.length > 0) {
      added = await addSuppressions(wsRoot, relFromRoot, resolved, supPath);
    }
    added = { ...added, rejected: [...added.rejected, ...ambiguous] };
  }
  if (Array.isArray(args.unsuppress) && args.unsuppress.length > 0) {
    await removeSuppressions(
      wsRoot,
      relFromRoot,
      args.unsuppress as { line: number; mutator: string; change?: string }[],
      supPath,
    );
  }
  return added;
}

/**
 * The suppression verdict for one file: which `"<line> <mutator>"` keys may be
 * applied (their fingerprint still matches the source line), plus how many were
 * rejected as `drifted` or `unverified`.
 *
 * Verification happens here — one source read for the one file being audited —
 * rather than inside `loadSuppressions`, which would otherwise read every
 * suppressed file in the workspace on every single audit.
 *
 * The lookup goes through `toPortableKey` because `loadSuppressions` keys its
 * map by the POSIX form. `anchorToWorkspace` already hands us a normalised
 * `relFromRoot`, so this is idempotent for the real call sites — it is here so
 * a caller that computes its own `relative()` cannot reintroduce the
 * backslash-key miss, which fails silently (a missing key is an EMPTY verdict:
 * zero applied, zero drifted, zero unverified, no signal at all).
 */
export function loadVerifiedSuppressions(
  wsRoot: string,
  relFromRoot: string,
  supPath: string | undefined,
): SuppressionVerdict {
  const key = toPortableKey(relFromRoot);
  return verifySuppressions(wsRoot, relFromRoot, loadSuppressions(wsRoot, supPath).get(key));
}

/**
 * The suppression phase of one audit: apply the caller's explicit edits, then
 * filter the equivalent mutants out of the engine's result.
 *
 * Suppression writes (explicit user action) happen first so the same call
 * reflects them. Then auto-filter equivalent mutants from the result.
 * C2 boundary: writes land under `wsRoot` (or `cfg.suppressionsPath`), keyed by
 * the WORKSPACE-RELATIVE path (`relFromRoot`, the same expression triage uses)
 * so the suppressions file is portable/committable and audit and triage agree
 * on the key — never outside the workspace.
 *
 * Returns the (possibly filtered) result plus the counts to report, or a
 * ready-to-return {@link CallToolResult} when the phase must short-circuit —
 * the same `{ ok }` shape the handler's other phase helpers use. Sandbox
 * cleanup still runs on every one of those returns, via the handler's `finally`.
 */
export async function applyAndCountSuppressions(
  args: ToolArgs,
  auditResults: MutationResult,
  baselineKeys: MutantKey[] | undefined,
  wsRoot: string,
  relFromRoot: string,
  supPath: string | undefined,
  ctx?: ToolContext,
): Promise<
  | { ok: true; result: MutationResult; counts: SuppressionCounts }
  | { ok: false; result: CallToolResult }
> {
  let result = auditResults;
  let added: AddSuppressionsResult = { stamped: 0, unstamped: 0, rejected: [] };
  try {
    // CodeRabbit finding: if the request aborts after auditFile resolves
    // but before these writes, a cancelled call could still mutate the
    // suppressions file. Guard the write block so cancellation stays
    // side-effect free.
    if (ctx?.signal?.aborted) return { ok: false, result: toolError('Operation cancelled.') };
    added = await applySuppressionArgs(args, wsRoot, relFromRoot, supPath, auditResults);
  } catch (error: unknown) {
    // A write failure surfaces a specific error rather than the generic
    // "Chaos Engine Halted" (Fix 4). Sandbox cleanup still runs via finally.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, result: toolError(`Failed to update suppression list: ${message}`) };
  }
  // Filter only for non-verify runs. In verify mode (baselineKeys set), the
  // filter is owned by Task 9: removing a now-suppressed mutant from the
  // re-run but NOT from the baseline would make computeVerifyDelta misreport
  // it as "now killed" (Fix 2). Writes above remain ungated (explicit action).
  //
  // Only fingerprint-verified entries filter the result. Drifted and
  // unverified entries are counted and reported instead — including the
  // entries just written above whose source line could not be read, which
  // land in `unverified` in this very response.
  const counts: SuppressionCounts = {
    applied: 0,
    drifted: 0,
    unverified: 0,
    orphaned: 0,
    rejected: added.rejected.length,
    relocated: 0,
    relocations: [],
    rejections: added.rejected,
  };
  if (!baselineKeys) {
    // Evaluated on the PRE-suppression result, before `result` is reassigned
    // to `filtered.result` below. "Was this run whole-file?" is a property of
    // what the engine enumerated, not of what is left after suppression
    // filtering — but `applySuppressions` can SYNTHESISE a scopeNote when
    // suppression drives `totalMutants` to exactly 0 (every mutant suppressed
    // as equivalent), and `isWholeFileRun`'s fallback branch reads `scopeNote`.
    // Gating on the post-suppression result let that synthesised note flip a
    // scope answer and mask a real orphan in exactly the case this counter
    // exists for: every mutant in the file declared equivalent, one of those
    // declarations gone stale. `triage/audit-one.ts` already evaluates this on
    // the pre-suppression result; this must match it so the two tools cannot
    // disagree about the same underlying fact.
    const wholeFileRun = isWholeFileRun(result);
    const verdict = loadVerifiedSuppressions(wsRoot, relFromRoot, supPath);
    const filtered = applySuppressions(result, verdict);
    result = filtered.result;
    counts.applied = filtered.suppressedCount;
    counts.drifted = filtered.drifted;
    counts.unverified = verdict.unverified;
    // See `isWholeFileRun` above for why the count is gated on it (a scoped
    // audit legitimately generates no mutant for a suppressed line outside its
    // range, and calling that an orphan would cry wolf).
    counts.orphaned = wholeFileRun ? filtered.orphaned : 0;
    counts.relocated = filtered.relocated.length;
    counts.relocations = filtered.relocated
      .filter((r) => r.tier === 3)
      .map((r) => ({
        storedLine: r.storedLine,
        line: r.line,
        mutator: r.mutator,
        ...(r.reason === undefined ? {} : { reason: r.reason }),
      }));
    // Heal the corpus. An entry resolved to a new line keeps the old one on
    // disk unless it is written back, so every later run would re-search and
    // every later reader would see a number that is simply wrong. A failure
    // here must not fail the audit: the score is already correct, and only the
    // healing is lost.
    if (filtered.relocated.length > 0) {
      try {
        await restampSuppressions(
          wsRoot,
          relFromRoot,
          filtered.relocated.map((r) => ({
            mutator: r.mutator,
            line: r.line,
            ...(r.change === undefined ? {} : { change: r.change }),
          })),
          supPath,
        );
      } catch (error: unknown) {
        warn(
          `Could not write relocated suppressions for ${relFromRoot}: ${
            error instanceof Error ? error.message : String(error)
          } — the score is unaffected, but the stored line numbers stay stale.`,
        );
      }
    }
  }
  return { ok: true, result, counts };
}
