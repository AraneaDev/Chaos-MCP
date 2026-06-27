import { resolve, relative, isAbsolute } from 'path';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { auditFile, makeEngine, resolvePrebuildCommand, isRealPathInside } from './handler.js';
import {
  discoverFiles,
  discoverChangedFiles,
  rankResults,
  buildTriagePayload,
  formatTriageAsText,
  type TriageError,
} from './triage.js';
import { listChangedFiles, computeChangedRanges } from './utils/git-diff.js';
import { detectProjectType, detectEnvironment } from './utils/project-detector.js';
import { createSandbox } from './utils/sandbox.js';
import { ENGINE_REGISTRY } from './engines/registry.js';
import type { ChaosConfig } from './utils/config-loader.js';
import type { MutationResult } from './engines/base.js';

function triageError(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const DEFAULT_MAX_FILES = 25;

/**
 * Batch-triage handler: discover supported source files under `paths`, audit
 * each serially via the shared `auditFile` core, and return a weakest-first
 * ranked leaderboard. Per-file failures are collected, never fatal.
 */
export async function handleTriageCall(
  request: CallToolRequest,
  config?: ChaosConfig,
): Promise<CallToolResult> {
  const args = request.params.arguments ?? {};
  const cfg = config ?? {};

  const hasPaths = Array.isArray(args.paths) && args.paths.length > 0;
  const hasDiffBase = typeof args.diffBase === 'string' && args.diffBase.trim().length > 0;
  if (!hasPaths && !hasDiffBase) {
    return triageError(
      'Provide "paths" (array of workspace-relative files/dirs) or "diffBase" (a git ref) — at least one is required.',
    );
  }
  if (
    hasPaths &&
    (args.paths as unknown[]).some(
      (p) => typeof p !== 'string' || (p as string).trim().length === 0,
    )
  ) {
    return triageError('paths must be an array of non-empty workspace-relative strings.');
  }
  if (args.diffBase !== undefined) {
    if (typeof args.diffBase !== 'string' || args.diffBase.trim().length === 0) {
      return triageError('diffBase must be a non-empty string: "HEAD", "staged", or a git ref.');
    }
    if (args.diffBase.startsWith('-')) {
      return triageError(
        'diffBase must not start with "-" (it would be mistaken for a git option).',
      );
    }
  }
  if (
    args.survivorsPerFile !== undefined &&
    (typeof args.survivorsPerFile !== 'number' ||
      !Number.isInteger(args.survivorsPerFile) ||
      args.survivorsPerFile < 0)
  ) {
    return triageError('survivorsPerFile must be an integer >= 0.');
  }
  if (
    args.fileConcurrency !== undefined &&
    (typeof args.fileConcurrency !== 'number' ||
      !Number.isInteger(args.fileConcurrency) ||
      args.fileConcurrency < 1 ||
      args.fileConcurrency > 64)
  ) {
    return triageError('fileConcurrency must be an integer between 1 and 64.');
  }
  const paths = hasPaths ? (args.paths as string[]) : undefined;

  let maxFiles = cfg.defaultMaxFiles ?? DEFAULT_MAX_FILES;
  if (args.maxFiles !== undefined) {
    if (
      typeof args.maxFiles !== 'number' ||
      !Number.isInteger(args.maxFiles) ||
      args.maxFiles < 1
    ) {
      return triageError('maxFiles must be an integer >= 1.');
    }
    maxFiles = args.maxFiles;
  }

  const rootCwd = resolve(process.cwd());
  if (paths) {
    for (const p of paths) {
      const abs = resolve(rootCwd, p);
      if (!isRealPathInside(abs, rootCwd)) {
        return triageError(
          `Each path must resolve within the workspace (${rootCwd}); received "${p}".`,
        );
      }
    }
  }

  const outputFormat = args.outputFormat === 'text' ? 'text' : 'json';

  let files: string[];
  let discovered: number;
  let skipped: number;
  let scopeNote: string | undefined;

  if (hasDiffBase) {
    const listed = await listChangedFiles(rootCwd, args.diffBase as string);
    if (listed.kind === 'not-a-repo') {
      return triageError(
        `diffBase requires a git work tree, but "${rootCwd}" is not one. Remove diffBase or run inside a git repository.`,
      );
    }
    if (listed.kind === 'bad-ref') {
      return triageError(`diffBase "${listed.ref}" could not be resolved as a git ref.`);
    }
    const sel = discoverChangedFiles(listed.files, paths, maxFiles);
    files = sel.files;
    discovered = sel.discovered;
    skipped = sel.skipped;
    scopeNote = `Scoped to files changed vs ${args.diffBase}. TypeScript files mutated on changed lines; other languages whole-file.`;
  } else {
    const disc = discoverFiles(paths as string[], rootCwd, maxFiles);
    files = disc.files;
    discovered = disc.discovered;
    skipped = disc.skipped;
  }

  if (files.length === 0) {
    const payload = buildTriagePayload([], [], discovered, skipped, scopeNote);
    const text =
      outputFormat === 'text'
        ? formatTriageAsText([], [], discovered, skipped, scopeNote)
        : JSON.stringify(payload);
    return {
      content: [{ type: 'text', text }],
      structuredContent: payload as unknown as Record<string, unknown>,
    };
  }

  const audited: { file: string; result: MutationResult }[] = [];
  const errors: TriageError[] = [];
  const rowScopeNoteMap = new Map<string, string>();

  for (const file of files) {
    try {
      const projectType = detectProjectType(file);
      if (projectType === 'unsupported') {
        errors.push({ file, error: `Unsupported file type for ${file}` });
        continue;
      }
      const env = detectEnvironment(file);
      const engine = makeEngine(projectType);

      const resolvedFile = resolve(rootCwd, file);
      const relFromRoot = relative(env.workspaceRoot, resolvedFile);
      const targetFile =
        relFromRoot.length > 0 && !relFromRoot.startsWith('..') && !isAbsolute(relFromRoot)
          ? relFromRoot
          : file;

      const perFileArgs: Record<string, unknown> = {
        timeoutMs: args.timeoutMs,
        mutatorDenylist: args.mutatorDenylist,
      };
      const prebuildCmd = resolvePrebuildCommand(perFileArgs, env, projectType);

      let lineRanges: { start: number; end: number }[] | undefined;
      let rowScopeNote: string | undefined;
      if (hasDiffBase) {
        if (ENGINE_REGISTRY[projectType].supportsLineScope) {
          const ranges = await computeChangedRanges(
            targetFile,
            env.workspaceRoot,
            args.diffBase as string,
          );
          if (ranges.kind === 'ranges') {
            lineRanges = ranges.ranges;
            rowScopeNote = 'scored on changed lines';
          } else if (ranges.kind === 'untracked') {
            rowScopeNote = 'untracked; whole file';
          }
          // no-changes/bad-ref/not-a-repo: leave whole-file (the file was selected, so this is rare)
        } else {
          rowScopeNote = 'diff scoping unsupported for this language; whole file';
        }
      }
      if (rowScopeNote) rowScopeNoteMap.set(file, rowScopeNote);

      const sandbox = createSandbox(targetFile, env.workspaceRoot, undefined);
      try {
        const result = await auditFile({
          targetFile,
          env,
          projectType,
          engine,
          args: perFileArgs,
          config: cfg,
          workDir: sandbox.workDir,
          prebuildCmd,
          lineRanges,
        });
        audited.push({ file, result });
      } finally {
        sandbox.cleanup();
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ file, error: message });
    }
  }

  const ranking = rankResults(audited);
  for (const row of ranking) {
    const rNote = rowScopeNoteMap.get(row.file);
    if (rNote) row.scopeNote = rNote;
  }
  const payload = buildTriagePayload(ranking, errors, discovered, skipped, scopeNote);
  const text =
    outputFormat === 'text'
      ? formatTriageAsText(ranking, errors, discovered, skipped, scopeNote)
      : JSON.stringify(payload);
  return {
    content: [{ type: 'text', text }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}
