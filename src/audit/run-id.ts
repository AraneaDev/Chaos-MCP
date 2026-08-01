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
import type { MutantKey } from '../verify.js';
import { mintRunId } from '../utils/run-cache.js';
import { buildResultPayload } from '../format.js';

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
