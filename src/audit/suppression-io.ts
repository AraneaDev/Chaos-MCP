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
   * Applied entries whose (line, mutator) matched no mutant this run — inert,
   * and previously reported by nothing.
   */
  orphaned: number;
}
import {
  loadSuppressions,
  addSuppressions,
  removeSuppressions,
  verifySuppressions,
  toPortableKey,
  type AddSuppressionsResult,
  type SuppressionVerdict,
} from '../utils/suppression.js';

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
): Promise<AddSuppressionsResult> {
  let added: AddSuppressionsResult = { stamped: 0, unstamped: 0 };
  if (Array.isArray(args.suppress) && args.suppress.length > 0) {
    added = await addSuppressions(
      wsRoot,
      relFromRoot,
      args.suppress as { line: number; mutator: string; reason?: string }[],
      supPath,
    );
  }
  if (Array.isArray(args.unsuppress) && args.unsuppress.length > 0) {
    await removeSuppressions(
      wsRoot,
      relFromRoot,
      args.unsuppress as { line: number; mutator: string }[],
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
  try {
    // CodeRabbit finding: if the request aborts after auditFile resolves
    // but before these writes, a cancelled call could still mutate the
    // suppressions file. Guard the write block so cancellation stays
    // side-effect free.
    if (ctx?.signal?.aborted) return { ok: false, result: toolError('Operation cancelled.') };
    await applySuppressionArgs(args, wsRoot, relFromRoot, supPath);
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
  const counts: SuppressionCounts = { applied: 0, drifted: 0, unverified: 0, orphaned: 0 };
  if (!baselineKeys) {
    const verdict = loadVerifiedSuppressions(wsRoot, relFromRoot, supPath);
    const filtered = applySuppressions(result, verdict.applied);
    result = filtered.result;
    counts.applied = filtered.suppressedCount;
    counts.drifted = verdict.drifted;
    counts.unverified = verdict.unverified;
    // Only meaningful for a run that enumerated the whole file: a lineScope- or
    // diffBase-scoped audit legitimately generates no mutant for a suppressed
    // line outside its range, and calling that an orphan would cry wolf.
    //
    // TRANSITIONAL, twin of `hasNoMutableLogic`'s conjunct 2 in
    // `core/score-semantics.ts` (see the note there): only the TypeScript
    // engine emits `scopeKind` today, so gating on `=== 'whole-file'` alone
    // would hard-wire this counter to 0 for every Rust, Python and PHP run —
    // exactly the Rust-upgrade case this whole feature exists for. The
    // fallback (`scopeKind` unset AND no `scopeNote`) is safe rather than an
    // approximation: Python, Rust and PHP set `supportsLineScope: false` in
    // `engines/registry.ts`, so a run of theirs is ALWAYS whole-file and there
    // is no scoped case for the fallback to misjudge. TypeScript, the one
    // engine that can be scoped, always sets `scopeKind` explicitly and so
    // never reaches it. Delete this fallback alongside that one once every
    // engine sets `scopeKind`.
    const isWholeFileRun =
      result.scopeKind === 'whole-file' || (result.scopeKind === undefined && !result.scopeNote);
    counts.orphaned = isWholeFileRun ? filtered.orphanedKeys.length : 0;
  }
  return { ok: true, result, counts };
}
