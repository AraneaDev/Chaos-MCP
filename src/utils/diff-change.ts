/**
 * Reading an `original → mutated` pair out of a unified diff.
 *
 * Both cosmic-ray and Infection report a mutant as a diff rather than as a
 * replacement span. This was a local helper in `engines/python/report.ts`; it
 * moved here so the PHP engine can produce a real `original` instead of storing
 * the whole diff blob in `mutated`, which left its mutants unidentifiable by
 * content — every survivor in a file carried a multi-line string whose leading
 * lines were identical headers.
 *
 * Only the FIRST removed and FIRST added line are taken. A mutation engine
 * changes one expression, so a multi-hunk diff means the tool reported
 * something this parser was not built for; taking the first pair is a
 * best-effort identity, and identity is allowed to be approximate as long as it
 * is stable — the resolver refuses on ambiguity rather than guessing.
 */
export function extractDiffChange(diff: string): { original?: string; mutated?: string } {
  let original: string | undefined;
  let mutated: string | undefined;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('---') || raw.startsWith('+++')) continue; // file headers
    if (original === undefined && raw.startsWith('-')) original = raw.slice(1).trim();
    else if (mutated === undefined && raw.startsWith('+')) mutated = raw.slice(1).trim();
  }
  const out: { original?: string; mutated?: string } = {};
  if (original !== undefined) out.original = original;
  if (mutated !== undefined) out.mutated = mutated;
  return out;
}
