export const MAX_GROUP_SIZE = 4;

export interface GroupCandidate {
  file: string;
  workspaceRoot: string;
  projectType: string;
  /** The resolved runner, for example 'vitest', 'jest', 'command'. */
  runner: string;
}

export type SweepUnit =
  | { kind: 'single'; file: string }
  | { kind: 'group'; files: string[]; workspaceRoot: string; runner: string };

/** Partition targets without crossing a workspace or runner boundary. */
export function planSweepUnits(
  candidates: GroupCandidate[],
  maxGroupSize = MAX_GROUP_SIZE,
): SweepUnit[] {
  const cap = Math.max(2, Math.min(MAX_GROUP_SIZE, Math.floor(maxGroupSize)));
  const units: SweepUnit[] = [];
  let index = 0;
  while (index < candidates.length) {
    const candidate = candidates[index];
    const eligible =
      candidate.projectType === 'typescript' &&
      (candidate.runner === 'vitest' || candidate.runner === 'jest');
    if (!eligible) {
      units.push({ kind: 'single', file: candidate.file });
      index += 1;
      continue;
    }
    const files = [candidate.file];
    let next = index + 1;
    while (
      next < candidates.length &&
      files.length < cap &&
      candidates[next].projectType === 'typescript' &&
      candidates[next].runner === candidate.runner &&
      candidates[next].workspaceRoot === candidate.workspaceRoot
    ) {
      files.push(candidates[next].file);
      next += 1;
    }
    if (files.length === 1) {
      units.push({ kind: 'single', file: candidate.file });
    } else {
      units.push({
        kind: 'group',
        files,
        workspaceRoot: candidate.workspaceRoot,
        runner: candidate.runner,
      });
    }
    index = next;
  }
  return units;
}
