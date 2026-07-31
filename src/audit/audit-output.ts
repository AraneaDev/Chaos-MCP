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
import type { ToolArgs } from '../tool-args-validation.js';
import {
  formatResultAsText,
  buildResultPayload,
  suppressionDriftNotes,
  type EnrichContext,
} from '../format.js';
import { evaluateGate } from '../gate.js';
import { suggestTestFile } from '../test-file.js';
import { applySuppressions } from './apply-suppressions.js';
import {
  computeVerifyDelta,
  formatVerifyResultAsJson,
  formatVerifyResultAsText,
  buildVerifyNote,
  type MutantKey,
} from '../verify.js';
import { ignoredOptionsFor, resolveMaxSurvivors, resolveSeverityFloor } from './run-options.js';
import { loadVerifiedSuppressions } from './suppression-io.js';

/**
 * How one file's stored suppressions were resolved for this run: how many were
 * applied, and how many were rejected as drifted / unverified.
 */
export interface SuppressionCounts {
  /** Mutants actually excluded from the score. */
  applied: number;
  /** Entries whose content fingerprint no longer matches their source line. */
  drifted: number;
  /** Entries with no fingerprint at all (v1 data), never applied. */
  unverified: number;
}

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

/**
 * Format a completed audit into the MCP tool response: verify-mode delta when a
 * baseline was supplied, otherwise the standard report plus a trailing note for
 * any StrykerJS-only options the resolved engine ignored (audit Low#5).
 *
 * The non-verify branch builds the result payload once via `buildResultPayload`,
 * then returns both a text/JSON content block AND `structuredContent: payload`
 * so callers can consume the structured data directly. Verify-mode is UNCHANGED.
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
  if (baselineKeys) {
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
    const verifyText =
      args.outputFormat === 'text'
        ? formatVerifyResultAsText(targetFile, delta)
        : formatVerifyResultAsJson(targetFile, delta);
    // Verify responses must carry `structuredContent` too — the tool declares an
    // `outputSchema` whose `oneOf` includes this verify-delta shape (audit H3).
    const verifyStructured: Record<string, unknown> = {
      target: targetFile,
      mode: 'verify',
      baselineTotal: delta.baselineTotal,
      killedCount: delta.nowKilled.length,
      nowKilled: delta.nowKilled,
      stillSurviving: delta.stillSurviving,
      newSurvivors: delta.newSurvivors,
      note: buildVerifyNote(delta),
    };
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
    gate,
  });

  const text =
    args.outputFormat === 'text'
      ? formatResultAsText(auditResults, enrichCtx, {
          ...enrichOpts,
          driftedSuppressions: suppression.drifted,
          unverifiedSuppressions: suppression.unverified,
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

  return { content, structuredContent: payload as unknown as Record<string, unknown> };
}
