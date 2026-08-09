/**
 * Rendering a finished audit into the MCP tool response.
 *
 * Extracted from `handler.ts` (Finding 2): everything downstream of "the engine
 * has produced a MutationResult" — the verify-mode delta, the standard payload,
 * the ignored-option note, and the enrichment context the text formatter reads.
 */
import { readFileSync } from 'fs';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { MutationResult } from '../engines/base.js';
import { type SupportedProjectType } from '../engines/registry.js';
import type { EnvironmentInfo } from '../utils/project-detector.js';
import type { ChaosConfig } from '../utils/config-loader.js';
import type { ToolArgs } from '../core/tool-args-validation.js';
import { formatResultAsText, buildResultPayload, type EnrichContext } from '../core/format.js';
import { suppressionDriftNotes } from '../core/score-semantics.js';
import { evaluateGate } from '../core/gate.js';
import { toStructuredContent } from '../core/tool-result.js';
import { suggestTestFile } from '../core/test-file.js';
import { applySuppressions } from './apply-suppressions.js';
import {
  computeVerifyDelta,
  formatVerifyResultAsJson,
  formatVerifyResultAsText,
  buildVerifyNote,
  verifyPayloadFields,
  evaluateVerifyGate,
  type MutantKey,
} from '../core/verify.js';
import { ignoredOptionsFor, resolveMaxSurvivors, resolveSeverityFloor } from './run-options.js';
import { loadVerifiedSuppressions, type SuppressionCounts } from './suppression-io.js';

/**
 * Build the enrichment context for the formatters, or `undefined` when the
 * caller did not opt in. Reads the (already workspace-validated) real-tree
 * source file for context snippets; a read failure degrades to no snippets
 * rather than failing the audit.
 */
export function buildEnrichContext(
  args: ToolArgs,
  resolvedFile: string,
  projectType: SupportedProjectType,
): EnrichContext | undefined {
  if (args.enrich === false) return undefined; // default-on: only an explicit false disables
  let sourceLines: string[] | undefined;
  try {
    sourceLines = readFileSync(resolvedFile, 'utf8').split(/\r?\n/);
  } catch {
    sourceLines = undefined;
  }
  return { projectType, sourceLines };
}

/** What {@link formatVerifyOutput} needs — a strict subset of the audit output. */
interface VerifyOutputOptions {
  /** The verify RE-RUN's result, before suppressions are re-applied to it. */
  auditResults: MutationResult;
  args: ToolArgs;
  /** The baseline mutant keys; their presence is what selects verify mode. */
  baselineKeys: MutantKey[];
  targetFile: string;
  cfg: ChaosConfig;
  env: EnvironmentInfo;
  relFromRoot: string;
}

/** What {@link formatStandardOutput} needs — the other, disjoint subset. */
interface StandardOutputOptions {
  auditResults: MutationResult;
  args: ToolArgs;
  projectType: SupportedProjectType;
  targetFile: string;
  enrichCtx: EnrichContext | undefined;
  cfg: ChaosConfig;
  env: EnvironmentInfo;
  /** Counts from the handler's suppression phase; verify mode has none. */
  suppression: SuppressionCounts;
  runId: string | undefined;
}

/**
 * Verify mode: the baseline-vs-re-run delta.
 *
 * Shares no state with {@link formatStandardOutput} and returns a completely
 * different `structuredContent` key set (`mode` / `baselineTotal` / `nowKilled`
 * / `stillSurviving` / `newSurvivors`), which is why the two are separate
 * functions behind one entry point.
 *
 * This is the ONLY place verify-mode suppressions are read: the handler's
 * suppression phase deliberately skips the auto-filter when `baselineKeys` is
 * set (see `applyAndCountSuppressions`), because filtering the re-run without
 * also filtering the baseline would misreport a newly suppressed mutant as
 * "now killed". So the read below is not a duplicate of the standard path's —
 * it is the load that path's counterpart skipped.
 */
function formatVerifyOutput({
  auditResults,
  args,
  baselineKeys,
  targetFile,
  cfg,
  env,
  relFromRoot,
}: VerifyOutputOptions): CallToolResult {
  // Task 9: filter suppressed equivalent mutants from BOTH the baseline keys
  // AND the re-run result before computing the delta so known-equivalent mutants
  // never appear as "still surviving" or "now killed" — they vanish entirely.
  // Uses the same workspace-relative key (relFromRoot) as the standard audit
  // path (Task 7) so the two modes read identical suppression entries (A9).
  // Only FINGERPRINT-VERIFIED suppressions filter the delta. A drifted or
  // unverified entry leaves its mutant in both sides of the comparison, where
  // it shows up as "still surviving" — visible, and explained by the note
  // appended below.
  const verdict = loadVerifiedSuppressions(env.workspaceRoot, relFromRoot, cfg.suppressionsPath);
  const suppressed = verdict.applied;
  const rerun = applySuppressions(auditResults, suppressed).result;
  const keptBaseline = baselineKeys.filter((k) => !suppressed.has(`${k.line} ${k.mutator}`));
  // EVERY engine re-runs the whole file in verify mode now — StrykerJS
  // included, since single-line scoping silently dropped multi-line mutants
  // and `computeVerifyDelta` then read their absence as "killed" (see
  // `audit/scope.ts`). Regressions can therefore land on lines outside the
  // baseline on any engine, and all of them are counted (audit H1).
  const delta = computeVerifyDelta(keptBaseline, rerun);
  // `minScore` is accepted in verify mode — nothing makes it mutually exclusive
  // with `runId`/`baseline` — and the schema promises a `gate` on the result
  // whenever it is supplied. This path emitted none, which is the same defect
  // `audit/scope.ts` documents as already fixed for the no-changes
  // short-circuit. `evaluateVerifyGate` owns the rule (including failing closed
  // on a partial re-run); it is evaluated ONCE and the same GateResult is handed
  // to the payload and to the renderer, so the two cannot disagree.
  const gate =
    typeof args.minScore === 'number' ? evaluateVerifyGate(args.minScore, delta) : undefined;
  const verifyText =
    args.outputFormat === 'text'
      ? formatVerifyResultAsText(targetFile, delta, gate)
      : formatVerifyResultAsJson(targetFile, delta, gate);
  // Verify responses must carry `structuredContent` too — the tool declares an
  // `outputSchema` whose `oneOf` includes this verify-delta shape (audit H3).
  //
  // The delta fields come from `verifyPayloadFields`, the same helper the JSON
  // renderer spreads, so the structured payload cannot drift from the text/JSON
  // block beside it. That is how `notReChecked` and the `complete` /
  // `batchesCompleted` / `batchesPlanned` / `stoppedReason` provenance reach
  // this object: a caller reading only `structuredContent` previously had no way
  // to tell a whole-file re-run from one that stopped a third of the way in, and
  // therefore no way to know `nowKilled` was inferred from batches that never
  // ran.
  const verifyStructured: Record<string, unknown> = {
    target: targetFile,
    mode: 'verify',
    ...verifyPayloadFields(delta),
    note: buildVerifyNote(delta),
  };
  if (gate) verifyStructured.gate = gate;
  // Verify mode reports the same drift the standard report does — otherwise a
  // stale suppression makes a mutant reappear as "still surviving" with no
  // explanation anywhere in the response.
  const verifyDrift = suppressionDriftNotes(verdict.drifted, verdict.unverified);
  const verifyContent: { type: 'text'; text: string }[] = [{ type: 'text', text: verifyText }];
  if (verifyDrift.length > 0) {
    if (verdict.drifted > 0) verifyStructured.driftedSuppressions = verdict.drifted;
    if (verdict.unverified > 0) verifyStructured.unverifiedSuppressions = verdict.unverified;
    verifyStructured.note = `${verifyStructured.note as string} ${verifyDrift.join(' ')}`;
    verifyContent.push({ type: 'text', text: verifyDrift.map((n) => `Note: ${n}`).join('\n') });
  }
  return {
    content: verifyContent,
    structuredContent: verifyStructured,
  };
}

/**
 * Standard (non-verify) mode: the full report, plus a trailing note for any
 * StrykerJS-only options the resolved engine ignored (audit Low#5).
 *
 * Builds the result payload once via `buildResultPayload`, then returns both a
 * text/JSON content block AND `structuredContent: payload` so callers can
 * consume the structured data directly.
 *
 * Suppressions are NOT re-read here: the handler's suppression phase already
 * applied them to `auditResults` and handed back the counts this function
 * reports.
 */
function formatStandardOutput({
  auditResults,
  args,
  projectType,
  targetFile,
  enrichCtx,
  cfg,
  env,
  suppression,
  runId,
}: StandardOutputOptions): CallToolResult {
  const enrichOpts = {
    enrich: enrichCtx,
    maxSurvivors: resolveMaxSurvivors(args, cfg),
    severityFloor: resolveSeverityFloor(args, cfg),
  };
  const ignored = ignoredOptionsFor(projectType, args);
  const suggestion =
    auditResults.survived > 0 || auditResults.vulnerabilities.length > 0
      ? suggestTestFile(targetFile, projectType, env.workspaceRoot)
      : undefined;

  // A partial (time-budget-truncated) batch run scores only the batches that
  // finished, so `complete` is forwarded: the gate must not pass a file on the
  // strength of a fraction of it.
  const gate =
    typeof args.minScore === 'number'
      ? evaluateGate(auditResults.mutationScore, args.minScore, auditResults.complete !== false)
      : undefined;

  const payload = buildResultPayload(auditResults, {
    ...enrichOpts,
    suggestedTestFile: suggestion,
    ignoredOptions: ignored.length > 0 ? ignored : undefined,
    runId,
    suppressedCount: suppression.applied,
    driftedSuppressions: suppression.drifted,
    unverifiedSuppressions: suppression.unverified,
    orphanedSuppressions: suppression.orphaned,
    gate,
  });

  const text =
    args.outputFormat === 'text'
      ? formatResultAsText(auditResults, enrichCtx, {
          ...enrichOpts,
          driftedSuppressions: suppression.drifted,
          unverifiedSuppressions: suppression.unverified,
          orphanedSuppressions: suppression.orphaned,
          // The SAME GateResult the payload carries, not a second evaluation:
          // text output previously rendered no verdict at all, so a caller
          // reading only the text block saw a clean report for a failing gate.
          gate,
        })
      : JSON.stringify(payload);

  const content: { type: 'text'; text: string }[] = [{ type: 'text', text }];

  // Surface options the resolved engine silently ignores so the caller knows
  // they had no effect (audit Low#5). Kept as a separate trailing content
  // block so it never corrupts the JSON/text payload above.
  if (ignored.length > 0) {
    content.push({
      type: 'text',
      text: `Note: the following option(s) are not supported by the ${projectType} engine and were ignored: ${ignored.join(', ')}.`,
    });
  }

  return { content, structuredContent: toStructuredContent(payload) };
}

/**
 * Format a completed audit into the MCP tool response: verify-mode delta when a
 * baseline was supplied, otherwise the standard report.
 *
 * The two modes share no state and produce different `structuredContent` shapes,
 * so each lives in its own function above; this is the single entry point the
 * handler calls, and its positional signature is unchanged. Verify-mode output
 * is UNCHANGED.
 */
export function formatAuditOutput(
  auditResults: MutationResult,
  args: ToolArgs,
  projectType: SupportedProjectType,
  baselineKeys: MutantKey[] | undefined,
  targetFile: string,
  enrichCtx: EnrichContext | undefined,
  cfg: ChaosConfig,
  env: EnvironmentInfo,
  suppression: SuppressionCounts,
  runId: string | undefined,
  relFromRoot: string,
): CallToolResult {
  return baselineKeys
    ? formatVerifyOutput({ auditResults, args, baselineKeys, targetFile, cfg, env, relFromRoot })
    : formatStandardOutput({
        auditResults,
        args,
        projectType,
        targetFile,
        enrichCtx,
        cfg,
        env,
        suppression,
        runId,
      });
}
