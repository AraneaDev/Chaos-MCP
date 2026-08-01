/**
 * Resolving a caller-supplied path into the target every tool phase downstream
 * needs: project type, workspace environment, and the two workspace-anchored
 * forms of the path.
 *
 * All three entry points — `handler.ts`, `estimate-handler.ts` and
 * `triage/audit-one.ts` — opened with a verbatim copy of the same four steps:
 *
 *   detectProjectType → reject 'unsupported' → detectEnvironment → anchorToWorkspace
 *
 * The individual steps were already extracted (`anchorToWorkspace` exists for
 * exactly this reason, and says so), but the SEQUENCE was not, so each new
 * handler re-derived the order — and the order is load-bearing: `detectEnvironment`
 * must run against the raw caller path, and `anchorToWorkspace` must be given the
 * root that call resolved, not `process.cwd()`.
 *
 * Deliberately NOT included here:
 *
 *  * The unsupported-extension MESSAGE. The audit and estimate tools report
 *    `Error: Extension unsupported for file target <p>`; triage reports
 *    `Unsupported file type for <p>` into a per-file row. Both are pinned by
 *    tests, and unifying them would be an observable behaviour change rather
 *    than a refactor. Callers format their own text from the `null` return.
 *  * The engine instance. `makeEngine` is a constructor call, and the estimate
 *    tool never needs one; building it here would make every estimate pay for
 *    an engine it discards. The two callers that need it construct it from
 *    `target.projectType`.
 */
import { resolve } from 'node:path';
import {
  detectProjectType,
  detectEnvironment,
  type EnvironmentInfo,
  type SupportedProjectType,
} from '../utils/project-detector.js';
import { anchorToWorkspace } from '../utils/workspace-anchor.js';

/** Everything the phases downstream of path validation need about the target. */
export interface ResolvedTarget {
  projectType: SupportedProjectType;
  env: EnvironmentInfo;
  /** Path to mutate, expressed relative to the detected workspace root. */
  targetFile: string;
  /** Workspace-relative key for the run cache and the suppressions file. */
  relFromRoot: string;
}

/**
 * The extension → engine check, as its own step so a caller can interleave its
 * own preconditions between it and the (filesystem-touching) detection below.
 *
 * The estimate tool does exactly that: it rejects a missing target, but only
 * AFTER the unsupported-extension check, so `missing.xyz` reports the extension
 * problem rather than the absence. Folding both steps into one call would
 * silently reorder those two messages.
 */
export function supportedTypeOf(rawPath: string): SupportedProjectType | null {
  const projectType = detectProjectType(rawPath);
  return projectType === 'unsupported' ? null : projectType;
}

/**
 * Detect the workspace environment for an already-typed target and re-anchor
 * the path onto the root that detection found.
 *
 * @param rawPath      The path as the caller supplied it, relative to cwd.
 *   `detectEnvironment` walks up from this form to find the workspace root.
 * @param resolvedFile The same file as an absolute path, used only as the
 *   subject of the re-anchoring.
 */
export function anchorTarget(
  rawPath: string,
  resolvedFile: string,
  projectType: SupportedProjectType,
): ResolvedTarget {
  // Auto-detect the workspace environment (test runner, workspace root).
  const env = detectEnvironment(rawPath);

  // Re-anchor the target to the detected workspace root. `rawPath` is relative
  // to process.cwd(), but the sandbox copies `env.workspaceRoot` (which can be
  // a subdirectory of cwd in a monorepo). Both the sandbox file-exists check
  // and the engine's mutate target must therefore use the path relative to the
  // workspace root, not to cwd. (High#1 / Med#9.)
  const { relFromRoot, targetFile } = anchorToWorkspace(env.workspaceRoot, resolvedFile, rawPath);

  return { projectType, env, targetFile, relFromRoot };
}

/**
 * Resolve `rawPath` into an engine-ready target, or `null` when the extension
 * maps to no engine — {@link supportedTypeOf} followed by {@link anchorTarget},
 * for the callers with no precondition to interleave.
 */
export function resolveAuditTarget(rawPath: string, resolvedFile: string): ResolvedTarget | null {
  const projectType = supportedTypeOf(rawPath);
  if (!projectType) return null;
  return anchorTarget(rawPath, resolvedFile, projectType);
}

/**
 * {@link resolveAuditTarget} for a caller that holds a root to resolve against
 * rather than an already-absolute path — the triage sweep, which walks files
 * discovered under `rootCwd`.
 */
export function resolveAuditTargetIn(rootCwd: string, file: string): ResolvedTarget | null {
  return resolveAuditTarget(file, resolve(rootCwd, file));
}
