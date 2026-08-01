import { validateMinScore } from './gate.js';
import { MAX_TIMEOUT_MS } from '../utils/constants.js';

/** Tool-call arguments object (untyped MCP payload). */
export type ToolArgs = Record<string, unknown>;

/**
 * timeoutMs: must be a positive number no larger than MAX_TIMEOUT_MS.
 *
 * Previously unvalidated, and the resolver only accepts `number > 0` — so
 * `timeoutMs: -1`, `0`, `NaN`, or `"60000"` silently fell back to the 5-minute
 * default while the caller believed the run was capped. Every other argument
 * here rejects malformed input rather than ignoring it; this one now matches.
 *
 * Exported because `estimate_audit` shares the same `timeoutMs` argument and
 * the same `resolveAuditTimeoutMs` resolver, but runs no validator table of its
 * own. It must not re-derive this rule: a second copy is exactly how the
 * MAX_TIMEOUT_MS clamp gets fixed in one tool and left broken in the other.
 */
export function validateTimeoutMs(args: ToolArgs): string | null {
  if (
    args.timeoutMs !== undefined &&
    (typeof args.timeoutMs !== 'number' || !(args.timeoutMs > 0))
  ) {
    return 'timeoutMs must be a positive number. Example: 120000.';
  }
  if (typeof args.timeoutMs === 'number' && args.timeoutMs > MAX_TIMEOUT_MS) {
    return `timeoutMs must be <= ${MAX_TIMEOUT_MS} (the largest delay a timer accepts; larger values are clamped to 1ms and abort the run immediately). Example: 120000.`;
  }
  return null;
}

/** perMutantTimeoutMs: must be a positive number no larger than MAX_TIMEOUT_MS. */
function validatePerMutantTimeoutMs(args: ToolArgs): string | null {
  if (
    args.perMutantTimeoutMs !== undefined &&
    (typeof args.perMutantTimeoutMs !== 'number' || args.perMutantTimeoutMs <= 0)
  ) {
    return 'perMutantTimeoutMs must be a positive number. Example: 10000.';
  }
  if (typeof args.perMutantTimeoutMs === 'number' && args.perMutantTimeoutMs > MAX_TIMEOUT_MS) {
    return `perMutantTimeoutMs must be <= ${MAX_TIMEOUT_MS} (the largest delay a timer accepts; larger values are clamped to 1ms and abort the run immediately). Example: 10000.`;
  }
  return null;
}

/** prebuildCommand: must be a non-empty string. */
function validatePrebuildCommand(args: ToolArgs): string | null {
  if (
    args.prebuildCommand !== undefined &&
    (typeof args.prebuildCommand !== 'string' ||
      (args.prebuildCommand as string).trim().length === 0)
  ) {
    return 'prebuildCommand must be a non-empty string. Example: "npm run build".';
  }
  return null;
}

/** concurrency: integer 1..64 (H5). */
function validateConcurrencyArg(args: ToolArgs): string | null {
  if (
    args.concurrency !== undefined &&
    (typeof args.concurrency !== 'number' ||
      !Number.isInteger(args.concurrency) ||
      args.concurrency < 1 ||
      args.concurrency > 64)
  ) {
    return 'concurrency must be an integer between 1 and 64 (Stryker workers).';
  }
  return null;
}

/** lineScope: { start: int >= 1, end: int >= start } (M5). */
function validateLineScopeArg(args: ToolArgs): string | null {
  if (args.lineScope === undefined) return null;
  const ls = args.lineScope as Record<string, unknown> | null;
  if (
    ls === null ||
    typeof ls !== 'object' ||
    Array.isArray(ls) ||
    typeof ls.start !== 'number' ||
    typeof ls.end !== 'number' ||
    !Number.isInteger(ls.start) ||
    !Number.isInteger(ls.end)
  ) {
    return 'lineScope must be { start: integer >= 1, end: integer >= start }. Example: { start: 10, end: 45 }.';
  }
  if (ls.start < 1 || ls.start > MAX_LINE_NUMBER) {
    return `lineScope.start must be an integer between 1 and ${MAX_LINE_NUMBER}.`;
  }
  if (ls.end < ls.start || ls.end > MAX_LINE_NUMBER) {
    return `lineScope.end must be an integer between lineScope.start and ${MAX_LINE_NUMBER}.`;
  }
  return null;
}

/**
 * Reasonable upper bound on a source-file line number. ~50k is generous;
 *
 * Exported so `tool-schema.ts` can declare it as the `maximum` on every `line`
 * field instead of hardcoding 100000 — the MCP SDK does not validate arguments
 * against `inputSchema`, so the schema's only job is to let a client PREDICT
 * this rejection, and a second copy of the number is exactly how the two sides
 * drift (audit finding 19d).
 */
export const MAX_LINE_NUMBER = 100_000;

/** Assert every line field is a positive integer ≤ MAX_LINE_NUMBER (H5). */
function assertValidLine(line: unknown): string | null {
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
    return 'line must be an integer >= 1.';
  }
  if (line > MAX_LINE_NUMBER) {
    return `line must be <= ${MAX_LINE_NUMBER}.`;
  }
  return null;
}

/** diffBase: non-empty string, not option-like, not combined with lineScope. */
function validateDiffBaseArg(args: ToolArgs): string | null {
  if (args.diffBase === undefined) return null;
  if (typeof args.diffBase !== 'string' || args.diffBase.trim().length === 0) {
    return 'diffBase must be a non-empty string: "HEAD", "staged", or a git ref. Example: "HEAD".';
  }
  if (args.diffBase.startsWith('-')) {
    return 'diffBase must not start with "-" (it would be mistaken for a git option).';
  }
  if (args.lineScope !== undefined) {
    return 'diffBase and lineScope are mutually exclusive — use one or the other, not both.';
  }
  return null;
}

/**
 * baseline (verify mode): object with optional survivors/noCoverage arrays;
 * mutually exclusive with diffBase and lineScope; must hold ≥1 (line, mutator).
 */
function validateBaselineArg(args: ToolArgs): string | null {
  if (args.baseline === undefined) return null;
  const b = args.baseline as Record<string, unknown> | null;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) {
    return 'baseline must be an object with optional "survivors" and "noCoverage" arrays from a prior run.';
  }
  if (args.diffBase !== undefined || args.lineScope !== undefined) {
    return 'baseline is mutually exclusive with diffBase and lineScope — use only one at a time.';
  }
  let pairCount = 0;
  for (const key of ['survivors', 'noCoverage'] as const) {
    const arr = b[key];
    if (arr === undefined) continue;
    if (!Array.isArray(arr)) {
      return `baseline.${key} must be an array of { line, mutators } objects.`;
    }
    for (const g of arr) {
      const entry = g as Record<string, unknown> | null;
      if (
        entry === null ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        typeof entry.mutators !== 'object' ||
        entry.mutators === null ||
        Array.isArray(entry.mutators)
      ) {
        return 'each baseline entry must be { line: integer >= 1, mutators: object of mutator→count }.';
      }
      const lineErr = assertValidLine(entry.line);
      if (lineErr !== null) return `baseline ${key}: ${lineErr}`;
      // H5 / M9: mutator names must be non-empty and counters positive integers.
      for (const [mutator, cnt] of Object.entries(entry.mutators as Record<string, unknown>)) {
        if (mutator.trim().length === 0) {
          return 'baseline mutator names must be non-empty strings.';
        }
        if (typeof cnt !== 'number' || !Number.isInteger(cnt) || cnt < 1) {
          return 'baseline mutator counts must be positive integers.';
        }
      }
      pairCount += Object.keys(entry.mutators as Record<string, unknown>).length;
    }
  }
  if (pairCount === 0) {
    return 'baseline must contain at least one (line, mutator) entry across survivors/noCoverage.';
  }
  return null;
}

/** mutatorAllowlist: StrykerJS v9 cannot express an allowlist. Reject up-front so
 *  the caller gets a clear error instead of a silent no-op (L1). */
function validateMutatorAllowlistArg(args: ToolArgs): string | null {
  if (args.mutatorAllowlist === undefined) return null;
  if (!Array.isArray(args.mutatorAllowlist)) {
    return 'mutatorAllowlist must be an array of strings. (StrykerJS v9 has no allowlist — use mutatorDenylist.)';
  }
  if (args.mutatorAllowlist.length === 0) {
    return 'mutatorAllowlist is not supported in StrykerJS v9 — pass mutatorDenylist instead.';
  }
  if (!args.mutatorAllowlist.every((v) => typeof v === 'string' && v.trim().length > 0)) {
    return 'mutatorAllowlist entries must be non-empty strings.';
  }
  // A non-empty allowlist is itself a configuration error in v9.
  return 'mutatorAllowlist is not supported in StrykerJS v9 — use mutatorDenylist instead, or supply your own stryker.config.json with explicit mutator settings.';
}

/** enrich: must be a boolean when present. */
function validateEnrichArg(args: ToolArgs): string | null {
  if (args.enrich !== undefined && typeof args.enrich !== 'boolean') {
    return 'enrich must be a boolean. Example: true.';
  }
  return null;
}

/**
 * dryRun: must be a boolean when present.
 *
 * `resolveRunOptions` reads it as `typeof args.dryRun === 'boolean' ? … : cfg`,
 * so a near-miss like `"true"` (a plausible client emission for a boolean
 * flag) falls through to config → undefined → `--dryRunOnly` is never passed.
 * The caller who asked for a cheap pre-flight then silently pays for a FULL
 * mutation run with no error to explain it. Rejecting here turns the most
 * expensive possible misread into an immediate, fixable message.
 */
function validateDryRunArg(args: ToolArgs): string | null {
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') {
    return 'dryRun must be a boolean. Example: true.';
  }
  return null;
}

/**
 * incremental: must be a boolean when present.
 *
 * Same silent-fallback shape as `dryRun` above — a non-boolean drops to config
 * → undefined, so the incremental cache is never engaged and the caller pays
 * full price for a run they expected to reuse prior results.
 */
function validateIncrementalArg(args: ToolArgs): string | null {
  if (args.incremental !== undefined && typeof args.incremental !== 'boolean') {
    return 'incremental must be a boolean. Example: true.';
  }
  return null;
}

/** maxSurvivors: integer >= 1 when present. */
function validateMaxSurvivorsArg(args: ToolArgs): string | null {
  if (
    args.maxSurvivors !== undefined &&
    (typeof args.maxSurvivors !== 'number' ||
      !Number.isInteger(args.maxSurvivors) ||
      args.maxSurvivors < 1)
  ) {
    return 'maxSurvivors must be an integer >= 1. Example: 20.';
  }
  return null;
}

/** severityFloor: one of high|medium|low when present. */
function validateSeverityFloorArg(args: ToolArgs): string | null {
  if (
    args.severityFloor !== undefined &&
    args.severityFloor !== 'high' &&
    args.severityFloor !== 'medium' &&
    args.severityFloor !== 'low'
  ) {
    return 'severityFloor must be one of "high", "medium", or "low". Example: "high".';
  }
  return null;
}

/** outputFormat: must be "text" or "json" when present (audit L4). */
function validateOutputFormatArg(args: ToolArgs): string | null {
  if (
    args.outputFormat !== undefined &&
    args.outputFormat !== 'text' &&
    args.outputFormat !== 'json'
  ) {
    return 'outputFormat must be one of "text" or "json". Example: "json".';
  }
  return null;
}

/**
 * The exact shape `saveRun` mints: the first 8 characters of a UUID, so
 * lowercase hex only. Pinning it here keeps a caller-supplied id from being
 * used as a path fragment — `loadRun` interpolates it into a filename, and a
 * value like `../../etc/whatever` would otherwise escape the cache directory
 * and read an arbitrary JSON file (verified reproducible before this guard).
 */
const RUN_ID_RE = /^[0-9a-f]{8}$/;

/** runId (verify-from-cache): minted-shape id, mutually exclusive with baseline/diffBase/lineScope. */
function validateRunIdArg(args: ToolArgs): string | null {
  if (args.runId === undefined) return null;
  if (typeof args.runId !== 'string' || args.runId.trim().length === 0) {
    return 'runId must be a non-empty string returned by a prior audit. Example: "a1b2c3d4".';
  }
  // Mutual exclusion is reported before the format check: when a caller passes
  // both runId and baseline, "use only one at a time" is the actionable
  // message, and complaining about the id's shape first would send them off
  // fixing the wrong argument.
  if (args.baseline !== undefined || args.diffBase !== undefined || args.lineScope !== undefined) {
    return 'runId is mutually exclusive with baseline, diffBase, and lineScope — use only one at a time.';
  }
  if (!RUN_ID_RE.test(args.runId)) {
    return 'runId must be an 8-character lowercase hex id returned by a prior audit. Example: "a1b2c3d4".';
  }
  return null;
}

/** Shared shape validator for suppress/unsuppress arrays; `field` names the arg in errors. */
function validateMutantKeyArray(
  value: unknown,
  field: string,
  allowReason: boolean,
): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) {
    return `${field} must be a non-empty array of { line: integer >= 1, mutator: string${allowReason ? ', reason?: string' : ''} }.`;
  }
  for (const e of value) {
    const entry = e as Record<string, unknown> | null;
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      typeof entry.mutator !== 'string' ||
      entry.mutator.trim().length === 0 ||
      (allowReason && entry.reason !== undefined && typeof entry.reason !== 'string')
    ) {
      return `each ${field} entry must be { line: integer >= 1, mutator: non-empty string${allowReason ? ', reason?: string' : ''} }.`;
    }
    const lineErr = assertValidLine(entry.line);
    if (lineErr !== null) return `${field}: ${lineErr}`;
  }
  return null;
}

/** suppress: non-empty array of { line >= 1, mutator, reason? } equivalent-mutant keys. */
function validateSuppressArg(args: ToolArgs): string | null {
  return validateMutantKeyArray(args.suppress, 'suppress', true);
}

/** unsuppress: non-empty array of { line >= 1, mutator } equivalent-mutant keys. */
function validateUnsuppressArg(args: ToolArgs): string | null {
  return validateMutantKeyArray(args.unsuppress, 'unsuppress', false);
}

/** minScore: number in [0, 100] when present. */
function validateMinScoreArg(args: ToolArgs): string | null {
  return validateMinScore(args.minScore);
}

/**
 * ignorePatterns: an array of strings (M7).
 *
 * Non-string elements are rejected explicitly rather than silently filtered
 * out — a caller who passes `[".test.ts", 123]` otherwise gets a sandbox that
 * quietly ignores half of what they asked for. This rule used to be inlined in
 * `handleToolCall`, ahead of the validator loop; it now lives with every other
 * per-argument rule. Kept FIRST in the list so it still leads the combined
 * message when several arguments are malformed at once.
 */
function validateIgnorePatternsArg(args: ToolArgs): string | null {
  if (args.ignorePatterns === undefined) return null;
  if (
    !Array.isArray(args.ignorePatterns) ||
    args.ignorePatterns.some((v) => typeof v !== 'string')
  ) {
    return 'ignorePatterns must be an array of strings. Example: [".test.ts", "fixtures/"].';
  }
  return null;
}

/** Ordered per-field validators run by `validateToolArgs`.
 *  Each validator returns an error message OR null; `validateToolArgs`
 *  accumulates ALL failures (M2) and returns a single combined message so the
 *  caller doesn't have to fix-retry one error at a time. */
export const TOOL_ARG_VALIDATORS: ((args: ToolArgs) => string | null)[] = [
  validateIgnorePatternsArg, // first: it was checked ahead of this loop before it moved here
  validateTimeoutMs,
  validatePerMutantTimeoutMs,
  validatePrebuildCommand,
  validateConcurrencyArg,
  validateMutatorAllowlistArg,
  validateRunIdArg, // before lineScope/diffBase/baseline so mutual-exclusion is reported first
  validateLineScopeArg,
  validateDiffBaseArg,
  validateBaselineArg,
  validateEnrichArg,
  validateDryRunArg,
  validateIncrementalArg,
  validateMaxSurvivorsArg,
  validateSeverityFloorArg,
  validateOutputFormatArg,
  validateSuppressArg,
  validateUnsuppressArg,
  validateMinScoreArg,
];
