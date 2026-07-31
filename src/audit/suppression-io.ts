/**
 * Suppression-file I/O for a single audited file.
 *
 * Extracted from `handler.ts` (Finding 2). Two things live here: applying the
 * `suppress` / `unsuppress` tool arguments (a write), and reading back the key
 * set for one file (a read). Both are keyed by the WORKSPACE-RELATIVE path so
 * the suppressions file stays portable/committable and every reader agrees on
 * the key (Task 7 / Key Contract).
 *
 * `triage-handler.ts` performs the same read against a memoized per-workspace
 * map, which is why {@link loadSuppressedKeys} takes the workspace root rather
 * than a preloaded map: it can adopt this helper without changing its call
 * shape. Wiring triage up is deliberately left to the triage decomposition.
 */
import type { ToolArgs } from '../tool-args-validation.js';
import { loadSuppressions, addSuppressions, removeSuppressions } from '../utils/suppression.js';

/**
 * Apply the caller's explicit suppression edits to the suppressions file.
 *
 * Both writes are awaited so a subsequent run in the same turn cannot race the
 * read-modify-write cycle on the file (audits H3: the write paths are async
 * behind a Promise-chain mutex). Throws whatever the write layer throws; the
 * caller decides how to report it.
 */
export async function applySuppressionArgs(
  args: ToolArgs,
  wsRoot: string,
  relFromRoot: string,
  supPath: string | undefined,
): Promise<void> {
  if (Array.isArray(args.suppress) && args.suppress.length > 0) {
    await addSuppressions(
      wsRoot,
      relFromRoot,
      args.suppress as { line: number; mutator: string; reason?: string }[],
      supPath,
    );
  }
  if (Array.isArray(args.unsuppress) && args.unsuppress.length > 0) {
    await removeSuppressions(
      wsRoot,
      relFromRoot,
      args.unsuppress as { line: number; mutator: string }[],
      supPath,
    );
  }
}

/**
 * The suppressed `"<line> <mutator>"` keys recorded for one file, or
 * `undefined` when the file has no entries.
 */
export function loadSuppressedKeys(
  wsRoot: string,
  relFromRoot: string,
  supPath: string | undefined,
): Set<string> | undefined {
  return loadSuppressions(wsRoot, supPath).get(relFromRoot);
}
