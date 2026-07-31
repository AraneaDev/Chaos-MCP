/**
 * Shared workspace boundary validator (audit A3).
 *
 * Every tool handler (audit_code_resilience, estimate_audit, triage_test_coverage)
 * previously reimplemented the same C2-boundary check: reject missing,
 * non-string, or empty filePath; reject paths resolving outside the current
 * process cwd; defensively resolve symlinks. This module consolidates that
 * logic so the three callers cannot drift on the security boundary.
 */
import { allowedWorkspaceRoots, isPathPermitted } from './path-safety.js';
import { resolve } from 'node:path';

/**
 * The validated, boundary-checked values for a `filePath` argument. Every
 * handler re-anchors against {@link detectedEnvironment}.workspaceRoot for
 * monorepos where process.cwd() ≠ workspaceRoot, so callers MUST re-derive
 * the workspace-root-relative path themselves — this helper intentionally
 * does NOT expose a relFromRoot, since a cwd-relative field would always be
 * the wrong one to use (audit A3 review: dead field risked confusing callers
 * into passing it to engines that expected workspace-relative keys).
 */
export interface ValidatedFilePath {
  /** Absolute path to the user-supplied file. */
  resolvedFile: string;
  /** Absolute path to process.cwd() at validation time. */
  rootCwd: string;
  /** The original user-supplied path string (echoed in errors). */
  raw: string;
}

/**
 * A rejection carries the user-facing `message` only — NOT an MCP
 * `CallToolResult`. This validator is a path check, so an MCP-only caller would
 * otherwise be the only kind it could have: `cli.ts` or a future CI mode would
 * have to learn the protocol envelope to ask whether a path is in-bounds. The
 * three MCP call sites wrap the message with `toolError` from `tool-result.ts`.
 */
export type FilePathValidation =
  | { ok: true; value: ValidatedFilePath }
  | { ok: false; message: string };

/**
 * Validate and resolve a tool-call `filePath` argument against the C2 workspace
 * boundary. Mirrors the order of checks previously inlined in handleToolCall.
 *
 * Order of rejections (stable across callers):
 *   1. Missing / non-string / empty
 *   2. Escapes the current process cwd (C2)
 *   3. Contains a comma (unscopeable by the mutation engines)
 *
 * The comma check runs last of the three so the C2 security boundary keeps the
 * first word: an out-of-bounds path must read as out-of-bounds, not as a naming
 * complaint. Everything in-bounds then still has to be expressible to an engine.
 */
export function validateFilePath(rawFilePath: unknown, argName = 'filePath'): FilePathValidation {
  if (typeof rawFilePath !== 'string' || rawFilePath.length === 0) {
    return {
      ok: false,
      message: `${argName} is required and must be a non-empty string. Example: "src/utils/math.ts".`,
    };
  }

  const rootCwd = resolve(process.cwd());
  const resolvedFile = resolve(rootCwd, rawFilePath);
  if (!isPathPermitted(resolvedFile)) {
    return {
      ok: false,
      message: `Error: ${argName} must resolve within the workspace (${describeBoundary(rootCwd)}); received "${rawFilePath}".`,
    };
  }

  // ── 3. A comma cannot be scoped to one file by any engine we drive. ──
  // StrykerJS registers `-m, --mutate` with a comma splitter, and Infection's
  // `--filter` is likewise a comma-separated list, so `src/tax,vat.ts` is split
  // into two globs that match nothing: Stryker mutates zero files, exits 0, and
  // an empty report scores 100.00% — a clean bill of health for a file that was
  // never opened. Reject it here rather than let a silent pass reach the user.
  if (rawFilePath.includes(',')) {
    return {
      ok: false,
      message:
        `Error: ${argName} must not contain a comma — StrykerJS and Infection take ` +
        `comma-separated file lists, so a comma in the path cannot be scoped to one ` +
        `file. Rename the file. Received "${rawFilePath}".`,
    };
  }

  return {
    ok: true,
    value: {
      resolvedFile,
      rootCwd,
      raw: rawFilePath,
    },
  };
}

/**
 * The boundary as the operator configured it: the working directory, plus any
 * roots named in CHAOS_ALLOWED_ROOTS. A rejection that named only cwd left the
 * caller unable to tell a missing grant from a mistyped one.
 */
export function describeBoundary(rootCwd: string): string {
  const extra = allowedWorkspaceRoots();
  return extra.length === 0 ? rootCwd : [rootCwd, ...extra].join(' or ');
}
