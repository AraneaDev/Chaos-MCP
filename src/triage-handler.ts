import { resolve, relative, isAbsolute } from 'path';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { auditFile, makeEngine, resolvePrebuildCommand, isRealPathInside } from './handler.js';
import {
  discoverFiles,
  rankResults,
  buildTriagePayload,
  formatTriageAsText,
  type TriageError,
} from './triage.js';
import { detectProjectType, detectEnvironment } from './utils/project-detector.js';
import { createSandbox } from './utils/sandbox.js';
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

  if (
    !Array.isArray(args.paths) ||
    args.paths.length === 0 ||
    args.paths.some((p) => typeof p !== 'string' || p.trim().length === 0)
  ) {
    return triageError(
      'paths is required and must be a non-empty array of workspace-relative file/directory strings.',
    );
  }
  const paths = args.paths as string[];

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
  for (const p of paths) {
    const abs = resolve(rootCwd, p);
    if (!isRealPathInside(abs, rootCwd)) {
      return triageError(
        `Each path must resolve within the workspace (${rootCwd}); received "${p}".`,
      );
    }
  }

  const outputFormat = args.outputFormat === 'text' ? 'text' : 'json';

  const { files, discovered, skipped } = discoverFiles(paths, rootCwd, maxFiles);
  if (files.length === 0) {
    const scopeNote: string | undefined = undefined;
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
  const scopeNote: string | undefined = undefined;
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
