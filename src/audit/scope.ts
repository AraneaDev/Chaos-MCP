/**
 * Mutation-scope resolution: how much of the target file this run should mutate.
 *
 * Extracted from `handler.ts` (Finding 2). Three independent arguments feed the
 * same channel — `diffBase` (A2), `baseline` (A3), and `runId` (A3-by-runId) —
 * and each can also short-circuit the whole call, so they belong together and
 * apart from the orchestration around them.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toolError, toStructuredContent } from '../tool-result.js';
import { ENGINE_REGISTRY, type SupportedProjectType } from '../engines/registry.js';
import type { EnvironmentInfo } from '../utils/project-detector.js';
import type { ChaosConfig } from '../utils/config-loader.js';
import type { ToolArgs } from '../tool-args-validation.js';
import { formatResultAsText, buildResultPayload } from '../format.js';
import { evaluateGate } from '../gate.js';
import { computeChangedRanges, type GitOptions } from '../utils/git-diff.js';
import { loadRun, workspaceFingerprint } from '../utils/run-cache.js';
import { parseBaseline, type BaselineInput, type MutantKey } from '../verify.js';
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
 * Build the terminal result for a request with NOTHING to mutate — the
 * diff-scoped run whose file did not change, and the verify whose baseline
 * holds no uncaught mutants. Both are successes, not errors: the question was
 * answered, the answer is "there is no work here".
 *
 * `gate` is attached whenever `minScore` was supplied (Fix 2). The tool schema
 * documents minScore as "the result reports gate.passed=false (never an
 * error)", and every other terminal path (audit/audit-output.ts) honours that —
 * but this short-circuit built its payload with `{}` and returned NO `gate`
 * key at all. A CI consumer written `if (!result.gate.passed)` threw a
 * TypeError on an untouched file, and one written `result.gate?.passed === true`
 * read the missing key as a FAILED gate. The semantics are unchanged:
 * `evaluateGate('100.00%', n)` passes for every valid minScore (0–100) — only
 * the field's presence is.
 *
 * Diff/verify ERROR short-circuits deliberately keep no gate: they return
 * `isError` results with no payload to hang one on, which is the documented
 * shape for a failed call rather than a graded one.
 */
function nothingToMutateResult(
  targetFile: string,
  scopeNote: string,
  earlyArgs: ToolArgs,
): ScopeResolution {
  const empty = {
    target: targetFile,
    totalMutants: 0,
    killed: 0,
    survived: 0,
    mutationScore: '100.00%',
    vulnerabilities: [],
    scopeNote,
  };
  // enrich context is not available here (built later by buildEnrichContext);
  // the empty result has no survivors/noCoverage so enrichment has no effect.
  const gate =
    typeof earlyArgs.minScore === 'number'
      ? evaluateGate(empty.mutationScore, earlyArgs.minScore)
      : undefined;
  const payload = buildResultPayload(empty, { gate });
  const text =
    earlyArgs.outputFormat === 'text' ? formatResultAsText(empty) : JSON.stringify(payload);
  return {
    kind: 'result',
    result: {
      content: [{ type: 'text', text }],
      structuredContent: toStructuredContent(payload),
    },
  };
}

/**
 * The `{ kind: 'result' }` arm, spelled once. Every scope failure below is a
 * plain tool error with no payload to hang a gate on (see
 * {@link nothingToMutateResult}), so the wrapper carried no information and
 * nine copies of it only made the guard sequence harder to read.
 */
function scopeError(message: string): ScopeResolution {
  return { kind: 'result', result: toolError(message) };
}

/**
 * Resolve the line scope from `diffBase` (A2) by diffing the target against the
 * given base on the REAL tree. Returns `{ kind: 'result' }` when the request
 * should short-circuit (a diff error, or the no-changes skip), or
 * `{ kind: 'scope' }` carrying the ranges / note for the caller to keep. The
 * verify inputs are handled by the caller; this arm never produces baseline keys.
 */
async function resolveDiffScope(
  diffBase: string,
  earlyArgs: ToolArgs,
  targetFile: string,
  env: EnvironmentInfo,
  projectType: SupportedProjectType,
  gitCtx?: { signal?: AbortSignal; deadline?: AuditDeadline },
): Promise<ScopeResolution> {
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
      return scopeError(
        `diffBase requires a git work tree, but "${env.workspaceRoot}" is not one. ` +
          'Remove diffBase or run inside a git repository.',
      );
    case 'bad-ref':
      return scopeError(
        `diffBase "${diff.ref}" could not be resolved as a git ref (merge-base failed).`,
      );
    case 'git-failed':
      // The git call never got an answer — a timeout, a missing binary, or an
      // unclassifiable rejection (utils/git-diff.ts). Before this branch
      // existed the variant fell through the switch with `diffRanges` unset
      // and NO note, so a failed git call silently produced a WHOLE-FILE
      // mutation run that the caller could not distinguish from a deliberate
      // one. Scoping was explicitly requested, so failing to scope is a
      // failure of the request: surface it, like every other kind here.
      return scopeError(
        `diffBase scoping failed: git could not be run (${diff.reason}). ${diff.message} ` +
          'Remove diffBase to mutate the whole file, or retry once git is available.',
      );
    case 'no-changes':
      // Short-circuit: nothing changed, so skip the sandbox + engine entirely.
      return nothingToMutateResult(
        targetFile,
        `No changed lines in ${targetFile} vs ${diffBase}; nothing to mutate.`,
        earlyArgs,
      );
    case 'untracked':
      // File is new/untracked — every line is "changed", so mutate the
      // whole file, but tell the caller why it wasn't line-scoped.
      return {
        kind: 'scope',
        scopeNote: `${targetFile} is untracked in git vs ${diffBase}; mutated the whole file.`,
      };
    case 'ranges':
      if (ENGINE_REGISTRY[projectType].supportsLineScope) {
        return { kind: 'scope', diffRanges: diff.ranges };
      }
      return {
        kind: 'scope',
        scopeNote: `diffBase scoping is not supported for ${projectType}; mutated the whole file.`,
      };
    default: {
      // Exhaustiveness guard, in the spirit of `assertNeverProjectType`
      // (utils/project-detector.ts, audit F15): `diff` narrows to `never`
      // here, so ADDING a DiffResult variant without handling it above is a
      // COMPILE error rather than a silent fallthrough. That fallthrough is
      // not hypothetical — it is exactly how `git-failed` arrived and turned
      // a failed git call into a whole-file run.
      //
      // Unlike the project-type guard this one is not a no-op at runtime: the
      // fallback here is "mutate everything", so an unrecognised kind fails
      // CLOSED instead of quietly running the most expensive thing we could
      // possibly do.
      const unhandled: never = diff;
      return scopeError(
        `diffBase scoping returned an unrecognised git result: ${JSON.stringify(unhandled)}.`,
      );
    }
  }
}

/**
 * Verify mode by cached id (A3-by-runId): load the prior run's survivors from
 * the run cache and hand back its baseline keys.
 *
 * This is a SECURITY boundary rather than scope computation. The cache
 * directory is shared by every workspace this host has ever audited from, and
 * the id is caller-supplied, so an entry is only usable once it has been shown
 * to describe THIS file, in THIS workspace, for THIS engine. The order of the
 * four guards below is load-bearing: it decides which of the four messages a
 * caller sees. Returns `{ kind: 'scope' }` with the parsed keys on success.
 */
function loadBaselineFromRunId(
  runId: string,
  env: EnvironmentInfo,
  projectType: SupportedProjectType,
  cfg: ChaosConfig,
  relFile: string,
): ScopeResolution {
  const cached = loadRun(runId, {
    ttlMs: cfg.runCacheTtlMs,
    max: cfg.runCacheMax,
  });
  if (!cached) {
    return scopeError(`runId "${runId}" not found or expired; re-run audit to get a fresh runId.`);
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
    return scopeError(
      `runId "${runId}" was recorded for a different file than ${relFile}; verify against the file it audited.`,
    );
  }
  // Same boundary, second axis (audit M10): the cache directory is shared by
  // every workspace this host has ever audited from, and `file` is a
  // workspace-RELATIVE key — so workspace A's `src/index.ts` matched the
  // check above while sitting in workspace B, and the verify graded B's file
  // against A's mutants. `workspaceHash` binds the entry to the tree it was
  // minted from; a mismatch is refused rather than silently mis-verified.
  //
  // BOTH mint sites now pass `workspaceRoot` (audit/run-id.ts for
  // `audit_code_resilience`, triage/audit-one.ts for `triage_test_coverage`),
  // so a hash-less entry is REFUSED rather than accepted. The earlier
  // accept-and-fall-through was a deliberate, temporary bridge: while the mint
  // sites still omitted the root, rejecting would have broken verify-by-runId
  // permanently — the re-run the error told the caller to do would have minted
  // another hash-less entry and failed identically. With the mints stamped,
  // rejecting costs at most ONE re-run (for an id minted by a pre-fix server
  // still sitting in the temp directory), and that re-run now succeeds.
  //
  // Refused, not merely un-checked: an entry whose workspace is UNKNOWN cannot
  // be shown to describe THIS tree, and "unknown" must never be read as "any".
  // The `cacheDir` partition makes cross-workspace leakage unlikely, not
  // impossible — one server process can serve several roots via
  // CHAOS_ALLOWED_ROOTS while sharing a single cwd, which is the exact case
  // the fingerprint exists to close.
  if (cached.workspaceHash === undefined) {
    // Same disclosure rule as the file/projectType checks below and above: the
    // entry's own contents are not echoed.
    return scopeError(
      `runId "${runId}" was recorded without a workspace identity and cannot be ` +
        `matched to ${env.workspaceRoot}; re-run the audit here to get a runId for this workspace.`,
    );
  }
  if (cached.workspaceHash !== workspaceFingerprint(env.workspaceRoot)) {
    return scopeError(
      `runId "${runId}" was recorded in a different workspace than ${env.workspaceRoot}; ` +
        're-run the audit here to get a runId for this workspace.',
    );
  }
  // `projectType` has been written onto every entry since the cache existed
  // and was never read. Two workspaces (or two files) can share a relative
  // path across languages, and a baseline's mutator names are engine-specific
  // — verifying a cosmic-ray baseline through StrykerJS reports every mutant
  // as "now killed" because none of the names can ever match.
  if (cached.projectType !== projectType) {
    // Deliberately does not echo the CACHED type, for the same reason the
    // cached file name is withheld above: it is content read from a path
    // derived from a caller-supplied id.
    return scopeError(
      `runId "${runId}" was recorded for a different project type than ${projectType}; ` +
        'verify against the project that produced it.',
    );
  }
  return {
    kind: 'scope',
    baselineKeys: parseBaseline({ survivors: cached.survivors, noCoverage: cached.noCoverage }),
  };
}

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
    const diffScope = await resolveDiffScope(
      diffBase,
      earlyArgs,
      targetFile,
      env,
      projectType,
      gitCtx,
    );
    if (diffScope.kind === 'result') return diffScope;
    diffRanges = diffScope.diffRanges;
    scopeNote = diffScope.scopeNote;
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
  }

  // ── Verify mode by cached id (A3-by-runId). Mutually exclusive with
  // baseline/diffBase/lineScope (enforced by validateRunIdArg), so this never
  // collides with the diff path above. Loads the prior run's survivors from the
  // run cache and re-runs the existing verify path against them. ──
  if (typeof earlyArgs.runId === 'string' && earlyArgs.runId.trim().length > 0) {
    const cachedScope = loadBaselineFromRunId(earlyArgs.runId, env, projectType, cfg, relFile);
    if (cachedScope.kind === 'result') return cachedScope;
    baselineKeys = cachedScope.baselineKeys;
  }

  // ── One treatment for both verify inputs (audit High#1 / Fix 1) ──
  //
  // An EMPTY baseline has no lines to scope to, and mapping it produced an
  // empty `lineRanges` array — which every consumer downstream reads as "no
  // scope given", i.e. the WHOLE FILE. So the cheapest, most common verify
  // there is — "I fixed everything, confirm it" against a run that recorded
  // zero survivors — quietly escalated into a full-file mutation run whose
  // findings were then diffed against an empty baseline: every survivor it
  // found on an unrelated line was reported as a `newSurvivor`, or (on
  // line-scoped engines) silently dropped.
  //
  // `mintRunId` is unconditional for non-verify runs, INCLUDING for a perfectly
  // clean file, and the `harden_file` prompt tells the agent to loop on exactly
  // that runId — so this is the documented happy path, not a corner case.
  //
  // Answer it honestly instead: nothing was recorded, so there is nothing to
  // re-check and no engine needs to run at all.
  if (baselineKeys !== undefined) {
    if (baselineKeys.length === 0) {
      return nothingToMutateResult(
        targetFile,
        `The baseline for ${targetFile} recorded no uncaught mutants, so there is nothing to verify; no mutants were run.`,
        earlyArgs,
      );
    }
    // Verify deliberately does NOT line-scope the re-run, on ANY engine.
    //
    // It used to on StrykerJS, via one single-line range per baseline line:
    //   baselineLines(baselineKeys).map((l) => ({ start: l, end: l }))
    // Stryker's `--mutate file:A-B` only includes a mutant whose ENTIRE span
    // lies within [A,B], and plenty of mutants span several lines — a `case`
    // arm with its body, a block statement, an arrow function. Every one of
    // those was silently EXCLUDED from the re-run. `computeVerifyDelta` infers
    // "killed" from ABSENCE, so a multi-line mutant that was never re-tested
    // came back reported as `nowKilled`: a false "you fixed it" on the single
    // question verify exists to answer.
    //
    // Found by running this server against its own source. A baseline of 8
    // survivors in src/estimate-heuristic.ts reported 2 "now killed" with no
    // source change between the two runs, reproducibly. Both were multi-line
    // ConditionalExpression mutants; re-auditing with `lineScope {44,48}`
    // showed them alive, and with `lineScope {44,44}` showed them not generated
    // at all — the mutant spans lines 44-47.
    //
    // Widening the ranges cannot be made provably safe: a mutant's span has no
    // upper bound, so no amount of padding guarantees containment. Verify
    // therefore runs whole-file and filters by baseline key afterwards, exactly
    // as the non-line-scoping engines have always done (Fix 3 — consistency,
    // now genuinely uniform). Absence from a whole-file re-run means the mutant
    // really is not a survivor.
    //
    // `baseline`, `runId` and `diffBase` are mutually exclusive
    // (validateToolArgs / validateRunIdArg), so this never collides with the
    // diff path above, which keeps its line scoping — a diff range comes from
    // git and is not claimed to contain any particular mutant.
  }

  return { kind: 'scope', diffRanges, scopeNote, baselineKeys };
}
