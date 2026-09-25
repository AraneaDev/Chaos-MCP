import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runShell } from '../exec.js';

export interface FingerprintInput {
  workspaceRoot: string;
  /** Workspace-relative paths whose content must match for reuse to be sound. */
  paths: string[];
  /** Anything else that can change a verdict: tool version, generated config, diff scope. */
  extra: Record<string, string>;
  run?: (args: string[], cwd: string) => Promise<{ stdout: string }>;
  readFile?: (absPath: string) => string | undefined;
}

const GIT_TIMEOUT_MS = 15_000;

function defaultReadFile(absPath: string): string | undefined {
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return undefined;
  }
}

function defaultRun(args: string[], cwd: string): Promise<{ stdout: string }> {
  return runShell('git', args, {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    killTree: true,
  });
}

function parseTrackedFiles(output: string): Map<string, string> {
  const tracked = new Map<string, string>();
  for (const line of output.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const fields = line.slice(0, tab).trim().split(/\s+/);
    const blob = fields[1];
    const path = line.slice(tab + 1);
    if (blob && path) tracked.set(path, blob);
  }
  return tracked;
}

/** A hex digest, or undefined when a sound fingerprint cannot be computed. */
export async function computeFingerprint(input: FingerprintInput): Promise<string | undefined> {
  const paths = [...new Set(input.paths)].sort();
  const run = input.run ?? defaultRun;
  const read = input.readFile ?? defaultReadFile;

  try {
    // Both calls print paths relative to the cwd, so they match `paths` even
    // when the workspace is a subdirectory of the repository. `git status`
    // prints repository-root-relative paths and never matched there.
    // `ls-files -m` lists files whose worktree differs from the index,
    // deletions included; staged edits already show up as a new index blob.
    const [lsFiles, modified] = await Promise.all([
      run(['ls-files', '-s', '--', ...paths], input.workspaceRoot),
      run(['ls-files', '-m', '--', ...paths], input.workspaceRoot),
    ]);
    const tracked = parseTrackedFiles(lsFiles.stdout);
    const changed = new Set(modified.stdout.split('\n').filter((line) => line.length > 0));
    const hash = createHash('sha256');
    for (const path of paths) {
      hash.update(`path\0${path}\0`);
      const blob = tracked.get(path);
      if (blob !== undefined && !changed.has(path)) {
        hash.update(`blob\0${blob}\0`);
        continue;
      }
      const content = read(join(input.workspaceRoot, path));
      if (content === undefined) return undefined;
      hash.update(`content\0${content}\0`);
    }
    for (const key of Object.keys(input.extra).sort()) {
      hash.update(`extra\0${key}\0${input.extra[key]}\0`);
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}
