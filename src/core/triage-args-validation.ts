/**
 * Per-argument validation rules for the `triage_test_coverage` tool.
 *
 * The audit tool has expressed its rules as a table of small
 * `(args) => string | null` functions since `tool-args-validation.ts` was
 * extracted; triage never adopted the idiom and kept a 113-line inline prelude
 * at the top of `handleTriageCall` instead (Finding 3). The rules below are
 * that prelude, moved verbatim — every message is byte-identical, and the table
 * order reproduces the order the prelude checked them in.
 *
 * ORDER IS OBSERVABLE. Unlike `TOOL_ARG_VALIDATORS`, whose driver accumulates
 * every failure into one combined message (M2), triage's driver stops at the
 * FIRST failure — the prelude returned early, and several tests pin the exact
 * single-message body for arguments that are malformed alongside others. See
 * `validateTriageArgs` in `triage-handler.ts`.
 */
import { resolve } from 'path';
import { validateMinScore } from './gate.js';
import { isPathPermitted } from '../utils/path-safety.js';
import { describeBoundary } from '../utils/file-path.js';
import { MAX_TIMEOUT_MS } from '../utils/constants.js';
import type { ToolArgs } from './tool-args-validation.js';

/**
 * True when `paths` is a usable target list: an array with at least one entry.
 *
 * A non-array or empty `paths` is NOT "malformed paths" — it means the caller
 * supplied no path target at all, which is only an error when `diffBase` is
 * missing too. Element validity is a separate rule.
 */
export function hasTriagePaths(args: ToolArgs): boolean {
  return Array.isArray(args.paths) && args.paths.length > 0;
}

/**
 * True when `diffBase` is a usable git ref: a string with non-blank content.
 *
 * The trim matters. A blank `diffBase` with no `paths` must read as "you gave
 * no target", not "your git ref is malformed" — two different fixes.
 */
export function hasTriageDiffBase(args: ToolArgs): boolean {
  return typeof args.diffBase === 'string' && args.diffBase.trim().length > 0;
}

/** At least one target selector is required: `paths`, `diffBase`, or both. */
function validateTargetPresence(args: ToolArgs): string | null {
  if (!hasTriagePaths(args) && !hasTriageDiffBase(args)) {
    return 'Provide "paths" (array of workspace-relative files/dirs) or "diffBase" (a git ref) — at least one is required.';
  }
  return null;
}

/** paths: every element must be a non-empty string (checked only when supplied). */
function validatePathsArg(args: ToolArgs): string | null {
  if (
    hasTriagePaths(args) &&
    (args.paths as unknown[]).some(
      (p) => typeof p !== 'string' || (p as string).trim().length === 0,
    )
  ) {
    return 'paths must be an array of non-empty workspace-relative strings.';
  }
  return null;
}

/** diffBase: non-empty string, and not option-like. */
function validateDiffBaseArg(args: ToolArgs): string | null {
  if (args.diffBase === undefined) return null;
  if (typeof args.diffBase !== 'string' || args.diffBase.trim().length === 0) {
    return 'diffBase must be a non-empty string: "HEAD", "staged", or a git ref.';
  }
  if (args.diffBase.startsWith('-')) {
    return 'diffBase must not start with "-" (it would be mistaken for a git option).';
  }
  return null;
}

/** survivorsPerFile: integer >= 0. Zero is the default (scores-only leaderboard). */
function validateSurvivorsPerFileArg(args: ToolArgs): string | null {
  if (
    args.survivorsPerFile !== undefined &&
    (typeof args.survivorsPerFile !== 'number' ||
      !Number.isInteger(args.survivorsPerFile) ||
      args.survivorsPerFile < 0)
  ) {
    return 'survivorsPerFile must be an integer >= 0.';
  }
  return null;
}

/** fileConcurrency: integer 1..64 (the triage pool size). */
function validateFileConcurrencyArg(args: ToolArgs): string | null {
  if (
    args.fileConcurrency !== undefined &&
    (typeof args.fileConcurrency !== 'number' ||
      !Number.isInteger(args.fileConcurrency) ||
      args.fileConcurrency < 1 ||
      args.fileConcurrency > 64)
  ) {
    return 'fileConcurrency must be an integer between 1 and 64.';
  }
  return null;
}

/**
 * totalTimeoutMs: positive number no larger than MAX_TIMEOUT_MS (the whole-sweep
 * wall-clock budget).
 *
 * The upper bound matters as much as the lower one: Node clamps a delay above
 * the 32-bit maximum to **1 ms**, so an over-large budget aborts the sweep
 * immediately instead of granting more time (see utils/constants.ts). The
 * schema declares `maximum`, but the MCP SDK does not validate arguments
 * against `inputSchema` — nothing enforced it at runtime until here. Matches
 * the audit tool's rule in `tool-args-validation.ts`.
 */
function validateTotalTimeoutMsArg(args: ToolArgs): string | null {
  if (
    args.totalTimeoutMs !== undefined &&
    (typeof args.totalTimeoutMs !== 'number' || args.totalTimeoutMs <= 0)
  ) {
    return 'totalTimeoutMs must be a positive number. Example: 900000.';
  }
  if (typeof args.totalTimeoutMs === 'number' && args.totalTimeoutMs > MAX_TIMEOUT_MS) {
    return `totalTimeoutMs must be <= ${MAX_TIMEOUT_MS} (the largest delay a timer accepts; larger values are clamped to 1ms and abort the run immediately). Example: 900000.`;
  }
  return null;
}

/** timeoutMs: positive number <= MAX_TIMEOUT_MS. Distinct wording from totalTimeoutMs — different budgets. */
function validateTimeoutMsArg(args: ToolArgs): string | null {
  if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== 'number' || args.timeoutMs <= 0)) {
    return 'timeoutMs must be a positive number. Example: 300000.';
  }
  if (typeof args.timeoutMs === 'number' && args.timeoutMs > MAX_TIMEOUT_MS) {
    return `timeoutMs must be <= ${MAX_TIMEOUT_MS} (the largest delay a timer accepts; larger values are clamped to 1ms and abort the run immediately). Example: 300000.`;
  }
  return null;
}

/** minScore: number in [0, 100] when present (shared with the audit tool's gate). */
function validateMinScoreArg(args: ToolArgs): string | null {
  return validateMinScore(args.minScore);
}

/** maxFiles: integer >= 1 when present (otherwise config/built-in default applies). */
function validateMaxFilesArg(args: ToolArgs): string | null {
  if (
    args.maxFiles !== undefined &&
    (typeof args.maxFiles !== 'number' || !Number.isInteger(args.maxFiles) || args.maxFiles < 1)
  ) {
    return 'maxFiles must be an integer >= 1.';
  }
  return null;
}

/**
 * Every `paths` entry must resolve inside the workspace boundary (C2).
 *
 * Resolves against `process.cwd()` exactly as the handler does, so a path that
 * escapes the workspace is rejected before discovery walks the filesystem.
 */
function validatePathsWithinWorkspace(args: ToolArgs): string | null {
  if (!hasTriagePaths(args)) return null;
  const rootCwd = resolve(process.cwd());
  for (const p of args.paths as string[]) {
    const abs = resolve(rootCwd, p);
    if (!isPathPermitted(abs)) {
      return `Each path must resolve within the workspace (${describeBoundary(rootCwd)}); received "${p}".`;
    }
  }
  return null;
}

/**
 * outputFormat: "text" or "json" when present.
 *
 * Rejected rather than silently coerced to json, matching the other enum
 * validators (audit L4).
 */
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
 * Ordered per-field validators for `triage_test_coverage`.
 *
 * The order is the order the inline prelude checked in, and it is load-bearing
 * because the driver returns the FIRST message (see the module note): the
 * target-presence rule must precede the `paths`/`diffBase` shape rules, and the
 * workspace-boundary rule must follow them so a blank entry is reported as a
 * blank entry rather than as an escaping path.
 */
export const TRIAGE_ARG_VALIDATORS: ((args: ToolArgs) => string | null)[] = [
  validateTargetPresence,
  validatePathsArg,
  validateDiffBaseArg,
  validateSurvivorsPerFileArg,
  validateFileConcurrencyArg,
  validateTotalTimeoutMsArg,
  validateTimeoutMsArg,
  validateMinScoreArg,
  validateMaxFilesArg,
  validatePathsWithinWorkspace,
  validateOutputFormatArg,
];

/**
 * Per-file worker cap so parallel triage doesn't oversubscribe CPU. Clamped to
 * 1–64, which is within every engine's documented concurrency range.
 *
 * Applied to each engine that declares `honorsConcurrency` (StrykerJS's
 * `--concurrency`, cargo-mutants' `-j`, Infection's `--threads`) — see
 * `buildPerFileArgs` in triage/audit-one.ts, which used to apply it to
 * TypeScript alone and left cargo-mutants running its own default of 2 jobs per
 * file underneath a pool of 4.
 *
 * This bounds only the SECOND of three multiplying layers. The full product is
 * `fileConcurrency × perFileConcurrency × testRunnerWorkers`, and this function
 * has no say over the third: for StrykerJS each mutant's test run is a fresh
 * `npx vitest`, which forks its own pool. That third factor used to be
 * unbounded, which is how a correctly-computed cap of 1 still put ~80 node
 * processes and ~6 GB on an 8 GB box. It is now pinned to a single worker at the
 * command itself — see `VITEST_SINGLE_WORKER` in utils/shell-quote.ts. Keep the
 * two in mind together; capping either one alone does not bound the total.
 *
 * The third layer is pinned for vitest ONLY. `cargo test` and `cargo build`
 * parallelise internally across all cores and take no instruction from here, so
 * a Rust sweep's true ceiling is still `fileConcurrency` concurrent cargo
 * builds, each free to use the machine. That is the honest reason the schema no
 * longer claims the three layers multiply out to the core count.
 */
export function resolvePerFileConcurrency(poolSize: number, cpuCount: number): number | undefined {
  if (poolSize <= 1) return undefined;
  return Math.min(64, Math.max(1, Math.floor((cpuCount - 1) / poolSize)));
}
