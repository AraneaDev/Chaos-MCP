/**
 * Minting the runId that lets a caller verify this audit later by id.
 *
 * Extracted from `handler.ts` (Finding 2). It lives beside the other audit
 * phases rather than in `suppression-io.ts` (a different subject entirely) or
 * in `utils/run-cache.ts`: the cache is a leaf util that may NOT import the
 * domain-layer `format` module, and building the compact payload is exactly
 * what this wrapper adds on top of it.
 */
import type { MutationResult } from '../engines/base.js';
import type { SupportedProjectType } from '../engines/registry.js';
import type { ChaosConfig } from '../utils/config-loader.js';
import type { MutantKey } from '../core/verify.js';
import { mintRunId } from '../utils/run-cache.js';
import { buildResultPayload } from '../core/format.js';

/**
 * Mint a runId for non-verify runs so the caller can verify later by id.
 * Keyed by `relFromRoot` so the cached run matches the verify-by-runId
 * check and triage (Task 8) on the same file.
 *
 * The compact payload is built HERE, not inside mintRunId: run-cache.ts is
 * a leaf util and may not import the domain-layer format module. The
 * try/catch keeps mintRunId's old contract intact — it used to swallow a
 * payload-construction failure too, and minting a runId must never cost
 * the caller the audit it asked for.
 *
 * `workspaceRoot` stamps the entry's workspace fingerprint (audit M10).
 * `relFromRoot` alone is a workspace-RELATIVE key, so without it a runId
 * minted for workspace A's `src/index.ts` satisfied the verify path's
 * `cached.file === relFile` check while pointed at workspace B's
 * `src/index.ts` — a different file — and the verify graded B's code
 * against A's mutants. `audit/scope.ts` now REFUSES an entry that carries
 * no hash, so omitting this here would break verify-by-runId outright.
 *
 * ── NO runId FOR A SCOPED RUN (Finding 3) ──
 *
 * A runId exists for exactly one purpose: to be handed back as a verify
 * baseline. Verify re-runs the WHOLE FILE on every engine (see the long comment
 * in `audit/scope.ts`) and `computeVerifyDelta` counts every fresh survivor that
 * is not in the baseline as a `newSurvivor`, under the note "your change
 * introduced these uncaught mutants". That is sound only if the baseline was
 * whole-file too. Minted from a `lineScope`/`diffBase`-scoped audit it is not:
 * every PRE-EXISTING survivor on a line the audit never looked at comes back
 * libelled as a regression the caller just caused.
 *
 * There is no honest way to grade such a baseline here, so no id is minted and
 * the unsound verify cannot be started. The alternative — recording the run's
 * line ranges on the cache entry and filtering `newSurvivors` by them — is the
 * better answer but needs the ranges at this call site, and they are not here:
 * the signature carries the RESULT, not the request, and the ranges live in
 * `handler.ts`'s `diffRanges` / `args.lineScope`.
 *
 * `scopeKind === 'scoped'` is exactly the unsound set, not an approximation.
 * StrykerJS is the only engine with `supportsLineScope: true`, so it is the only
 * engine whose runs can be scoped at all — the other three mutate the whole file
 * and say so in a `scopeNote` even when `diffBase` was requested, which leaves
 * their baselines whole-file and their verifies sound. And a BATCHED whole-file
 * TypeScript run reports `'whole-file'` (batching is an implementation detail of
 * covering the file, see `engines/typescript/batches.ts`), so large files keep
 * their runIds.
 */
export function mintRunIdSafely(
  auditResults: MutationResult,
  baselineKeys: MutantKey[] | undefined,
  relFromRoot: string,
  projectType: SupportedProjectType,
  workspaceRoot: string,
  cfg: ChaosConfig,
): string | undefined {
  if (baselineKeys) return undefined;
  if (auditResults.scopeKind === 'scoped') return undefined;
  try {
    return mintRunId(buildResultPayload(auditResults, {}), relFromRoot, projectType, {
      ttlMs: cfg.runCacheTtlMs,
      max: cfg.runCacheMax,
      workspaceRoot,
    });
  } catch {
    return undefined;
  }
}
