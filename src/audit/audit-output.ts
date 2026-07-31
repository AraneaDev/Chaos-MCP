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
import { ENGINE_REGISTRY, type SupportedProjectType } from '../engines/registry.js';
import type { EnvironmentInfo } from '../utils/project-detector.js';
import type { ChaosConfig } from '../utils/config-loader.js';
import type { ToolArgs } from '../tool-args-validation.js';
import { formatResultAsText, buildResultPayload, type EnrichContext } from '../format.js';
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
import { loadSuppressedKeys } from './suppression-io.js';

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
  suppressedCount: number,
  runId: string | undefined,
  relFromRoot: string,
): CallToolResult {
  if (baselineKeys) {
    // Task 9: filter suppressed equivalent mutants from BOTH the baseline keys
    // AND the re-run result before computing the delta so known-equivalent mutants
    // never appear as "still surviving" or "now killed" — they vanish entirely.
    // Uses the same workspace-relative key (relFromRoot) as the standard audit
    // path (Task 7) so the two modes read identical suppression entries (A9).
    const suppressed = loadSuppressedKeys(env.workspaceRoot, relFromRoot, cfg.suppressionsPath);
    const rerun = applySuppressions(auditResults, suppressed).result;
    const keptBaseline = suppressed
      ? baselineKeys.filter((k) => !suppressed.has(`${k.line} ${k.mutator}`))
      : baselineKeys;
    // Whole-file engines (cosmic-ray/cargo-mutants/Infection) re-run the entire
    // file in verify mode, so regressions can land on lines outside the baseline;
    // pass the engine's line-scope capability so those are counted (audit H1).
    const supportsLineScope = ENGINE_REGISTRY[projectType].supportsLineScope;
    const delta = computeVerifyDelta(keptBaseline, rerun, supportsLineScope);
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
    return {
      content: [{ type: 'text', text: verifyText }],
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
    suppressedCount,
    gate,
  });

  const text =
    args.outputFormat === 'text'
      ? formatResultAsText(auditResults, enrichCtx, enrichOpts)
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
