/**
 * Mutation-scope resolution: how much of the target file this run should mutate.
 *
 * Extracted from `handler.ts` (Finding 2). Three independent arguments feed the
 * same channel — `diffBase` (A2), `baseline` (A3), and `runId` (A3-by-runId) —
 * and each can also short-circuit the whole call, so they belong together and
 * apart from the orchestration around them.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toolError } from '../tool-result.js';
import { ENGINE_REGISTRY, type SupportedProjectType } from '../engines/registry.js';
import type { EnvironmentInfo } from '../utils/project-detector.js';
import type { ChaosConfig } from '../utils/config-loader.js';
import type { ToolArgs } from '../tool-args-validation.js';
import { formatResultAsText, buildResultPayload } from '../format.js';
import { computeChangedRanges, type GitOptions } from '../utils/git-diff.js';
import { loadRun } from '../utils/run-cache.js';
import { parseBaseline, baselineLines, type BaselineInput, type MutantKey } from '../verify.js';
import type { AuditDeadline } from '../utils/deadline.js';

/**
 * The resolved mutation scope for a run, or a ready-to-return tool result when
 * the request should short-circuit (diff errors, or a no-changes skip).
 */
export type ScopeResolution =
  | { kind: 'result'; result: CallToolResult }
  | {
      kind: 'scope';
      diffRanges?: { start: number; end: number }[];
      scopeNote?: string;
      baselineKeys?: MutantKey[];
    };

/**
 * Resolve the line scope for a run from the diff-aware ({@link diffBase}, A2)
 * and verify-mode ({@link baseline}, A3) arguments. Runs on the REAL tree
 * before the (expensive) sandbox copy so a "no changes" diff can short-circuit
 * without provisioning. Returns `{ kind: 'result' }` to return immediately
 * (diff error or no-changes skip) or `{ kind: 'scope' }` with the resolved
 * ranges / note / baseline keys to continue. `diffBase` and `baseline` are
 * mutually exclusive (enforced by `validateToolArgs`), so they never
 * both produce ranges.
 */
export async function computeScope(
  earlyArgs: ToolArgs,
  targetFile: string,
  env: EnvironmentInfo,
  projectType: SupportedProjectType,
  cfg: ChaosConfig,
  relFile: string,
  gitCtx?: { signal?: AbortSignal; deadline?: AuditDeadline },
): Promise<ScopeResolution> {
  let diffRanges: { start: number; end: number }[] | undefined;
  let scopeNote: string | undefined;

  const diffBase = typeof earlyArgs.diffBase === 'string' ? earlyArgs.diffBase : undefined;
  if (diffBase) {
    // Built here, not by the caller: reading the deadline consumes a clock
    // sample, and there is no reason to take one on the far more common path
    // where no diffBase was supplied and no git call happens at all.
    const git: GitOptions = {
      signal: gitCtx?.signal,
      timeoutMs: gitCtx?.deadline?.remainingMs(),
    };
    const diff = await computeChangedRanges(targetFile, env.workspaceRoot, diffBase, git);
    switch (diff.kind) {
      case 'not-a-repo':
        return {
          kind: 'result',
          result: toolError(
            `diffBase requires a git work tree, but "${env.workspaceRoot}" is not one. ` +
              'Remove diffBase or run inside a git repository.',
          ),
        };
      case 'bad-ref':
        return {
          kind: 'result',
          result: toolError(
            `diffBase "${diff.ref}" could not be resolved as a git ref (merge-base failed).`,
          ),
        };
      case 'no-changes': {
        // Short-circuit: nothing changed, so skip the sandbox + engine entirely.
        const empty = {
          target: targetFile,
          totalMutants: 0,
          killed: 0,
          survived: 0,
          mutationScore: '100.00%',
          vulnerabilities: [],
          scopeNote: `No changed lines in ${targetFile} vs ${diffBase}; nothing to mutate.`,
        };
        // enrich context is not available here (built later by buildEnrichContext);
        // the empty result has no survivors/noCoverage so enrichment has no effect.
        const payload = buildResultPayload(empty, {});
        const text =
          earlyArgs.outputFormat === 'text' ? formatResultAsText(empty) : JSON.stringify(payload);
        return {
          kind: 'result',
          result: {
            content: [{ type: 'text', text }],
            structuredContent: payload as unknown as Record<string, unknown>,
          },
        };
      }
      case 'untracked':
        // File is new/untracked — every line is "changed", so mutate the
        // whole file, but tell the caller why it wasn't line-scoped.
        scopeNote = `${targetFile} is untracked in git vs ${diffBase}; mutated the whole file.`;
        break;
      case 'ranges':
        if (ENGINE_REGISTRY[projectType].supportsLineScope) {
          diffRanges = diff.ranges;
        } else {
          scopeNote = `diffBase scoping is not supported for ${projectType}; mutated the whole file.`;
        }
        break;
    }
  }

  // ── Verify mode (A3): parse the prior-run baseline and derive the re-run
  // scope from its lines (TS only; non-TS runs whole-file then filters). ──
  let baselineKeys: MutantKey[] | undefined;
  if (
    earlyArgs.baseline &&
    typeof earlyArgs.baseline === 'object' &&
    !Array.isArray(earlyArgs.baseline)
  ) {
    baselineKeys = parseBaseline(earlyArgs.baseline as BaselineInput);
    if (ENGINE_REGISTRY[projectType].supportsLineScope) {
      // Reuse the A2 scope channel (`diffRanges` → runOptions.lineRanges).
      // baseline is mutually exclusive with diffBase, so this never collides.
      diffRanges = baselineLines(baselineKeys).map((l) => ({ start: l, end: l }));
    }
  }

  // ── Verify mode by cached id (A3-by-runId). Mutually exclusive with
  // baseline/diffBase/lineScope (enforced by validateRunIdArg), so this never
  // collides with the diff path above. Loads the prior run's survivors from the
  // run cache and re-runs the existing verify path against them. ──
  if (typeof earlyArgs.runId === 'string' && earlyArgs.runId.trim().length > 0) {
    const cached = loadRun(earlyArgs.runId, {
      ttlMs: cfg.runCacheTtlMs,
      max: cfg.runCacheMax,
    });
    if (!cached) {
      return {
        kind: 'result',
        result: toolError(
          `runId "${earlyArgs.runId}" not found or expired; re-run audit to get a fresh runId.`,
        ),
      };
    }
    // C2 boundary: the cached run is bound to the file it audited; refuse to
    // verify it against a different target. The cached `file` is the
    // workspace-relative key (same expression triage uses), so compare against
    // `relFile`, not the absolute path.
    if (cached.file !== relFile) {
      // The cached file name is deliberately NOT echoed: it is content read
      // from a file path derived from a caller-supplied id, and reflecting it
      // would make the error message a read primitive for whatever the id
      // resolved to.
      return {
        kind: 'result',
        result: toolError(
          `runId "${earlyArgs.runId}" was recorded for a different file than ${relFile}; verify against the file it audited.`,
        ),
      };
    }
    baselineKeys = parseBaseline({ survivors: cached.survivors, noCoverage: cached.noCoverage });
    // Mirror the baseline branch: only scope to lines on engines that support it
    // (TS only); others run whole-file then filter (Fix 3 — consistency).
    if (ENGINE_REGISTRY[projectType].supportsLineScope) {
      diffRanges = baselineLines(baselineKeys).map((l) => ({ start: l, end: l }));
    }
  }

  return { kind: 'scope', diffRanges, scopeNote, baselineKeys };
}
