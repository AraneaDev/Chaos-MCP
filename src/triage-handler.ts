import { resolve, relative, isAbsolute } from 'path';
import { cpus } from 'os';
import { readFileSync } from 'fs';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { auditFile, makeEngine, resolvePrebuildCommand, isRealPathInside } from './handler.js';
import {
  discoverFiles,
  discoverChangedFiles,
  compareTriageRows,
  buildTriagePayload,
  formatTriageAsText,
  type TriageRow,
  type TriageError,
} from './triage.js';
import { listChangedFiles, computeChangedRanges } from './utils/git-diff.js';
import { detectProjectType, detectEnvironment } from './utils/project-detector.js';
import { createSandbox } from './utils/sandbox.js';
import { ENGINE_REGISTRY } from './engines/registry.js';
import { mapPool } from './utils/pool.js';
import { buildResultPayload } from './format.js';
import type { ChaosConfig } from './utils/config-loader.js';
import type { MutationResult } from './engines/base.js';
import { saveRun } from './utils/run-cache.js';
import { loadSuppressions, applySuppressions } from './utils/suppression.js';

function triageError(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const DEFAULT_MAX_FILES = 25;

/** Per-file StrykerJS worker cap so parallel triage doesn't oversubscribe CPU.
 *  Clamped to 1–64 to stay within StrykerJS's documented concurrency range. */
export function resolveStrykerConcurrency(poolSize: number, cpuCount: number): number | undefined {
  if (poolSize <= 1) return undefined;
  return Math.min(64, Math.max(1, Math.floor((cpuCount - 1) / poolSize)));
}

/**
 * Batch-triage handler: discover supported source files under `paths`, audit
 * each in bounded-parallel via the shared `auditFile` core, and return a
 * weakest-first ranked leaderboard. Per-file failures are collected, never fatal.
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

  const cpuCount = cpus().length;
  const poolSize =
    typeof args.fileConcurrency === 'number' && Number.isInteger(args.fileConcurrency)
      ? (args.fileConcurrency as number)
      : (cfg.defaultFileConcurrency ?? Math.max(1, Math.min(4, cpuCount - 1)));
  const strykerConcurrency = resolveStrykerConcurrency(poolSize, cpuCount);
  const survivorsPerFile =
    typeof args.survivorsPerFile === 'number' && Number.isInteger(args.survivorsPerFile)
      ? (args.survivorsPerFile as number)
      : 0;

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
    // Defense-in-depth: git normally only reports workspace-relative paths, but
    // filter any path whose realpath resolves outside the workspace root. (C2 parity)
    files = sel.files.filter((file) => isRealPathInside(resolve(rootCwd, file), rootCwd));
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

  const errors: TriageError[] = [];

  // Load suppressions per workspaceRoot (memoized) — not once from rootCwd — so
  // that monorepo packages whose workspaceRoot differs from rootCwd read the right
  // suppressions file. Keys are workspace-relative paths (relFromRoot), matching
  // the key used by audit_code_resilience (Task 7 / Key Contract).
  const suppressionCache = new Map<string, Map<string, Set<string>>>();

  type AuditOutcome = { row: TriageRow } | { error: TriageError };

  const auditOne = async (file: string): Promise<AuditOutcome> => {
    try {
      const projectType = detectProjectType(file);
      if (projectType === 'unsupported') {
        return { error: { file, error: `Unsupported file type for ${file}` } };
      }
      const env = detectEnvironment(file);
      let suppressionMap = suppressionCache.get(env.workspaceRoot);
      if (suppressionMap === undefined) {
        suppressionMap = loadSuppressions(env.workspaceRoot, cfg.suppressionsPath);
        suppressionCache.set(env.workspaceRoot, suppressionMap);
      }
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
      // A2: include Stryker concurrency cap only for TypeScript files and only
      // when the pool size is > 1 (strykerConcurrency is defined).
      if (strykerConcurrency !== undefined && projectType === 'typescript') {
        perFileArgs.concurrency = strykerConcurrency;
      }
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

      const sandbox = createSandbox(targetFile, env.workspaceRoot, undefined);
      let result: MutationResult;
      try {
        result = await auditFile({
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
      } finally {
        sandbox.cleanup();
      }

      // Apply equivalent-mutant suppression before building the row. The key is
      // relFromRoot — byte-identical to the key used by audit_code_resilience (Key
      // Contract) so suppressions added via audit are honored in triage.
      const sup = applySuppressions(result, suppressionMap.get(relFromRoot));
      const cleanResult = sup.result;

      const row: TriageRow = {
        file,
        mutationScore: cleanResult.mutationScore,
        total: cleanResult.totalMutants,
        killed: cleanResult.killed,
        survived: cleanResult.survived,
        noCoverage: Math.max(0, cleanResult.vulnerabilities.length - cleanResult.survived),
      };
      if (rowScopeNote) row.scopeNote = rowScopeNote;
      if (sup.suppressedCount > 0) row.suppressedCount = sup.suppressedCount;

      // Mint a per-row runId so the caller can verify survivors from a triage result
      // without re-auditing. A cache failure is non-fatal: omit the runId rather than
      // fail the whole triage row.
      let rowRunId: string | undefined;
      try {
        const compact = buildResultPayload(cleanResult, {});
        rowRunId = saveRun(
          {
            file: relFromRoot,
            projectType,
            survivors: compact.survivors.map((g) => ({ line: g.line, mutators: g.mutators })),
            noCoverage: compact.noCoverage.map((g) => ({ line: g.line, mutators: g.mutators })),
          },
          { ttlMs: cfg.runCacheTtlMs, max: cfg.runCacheMax },
        );
      } catch {
        rowRunId = undefined;
      }
      if (rowRunId !== undefined) row.runId = rowRunId;

      // Enrich with inline survivors when the caller asked for them.
      // Source-read failure is non-fatal: enrichment works without source lines
      // (severity comes from mutator type, not the code text).
      if (survivorsPerFile > 0) {
        let sourceLines: string[] | undefined;
        try {
          sourceLines = readFileSync(resolve(rootCwd, file), 'utf8').split(/\r?\n/);
        } catch {
          sourceLines = undefined;
        }
        const payload = buildResultPayload(cleanResult, {
          enrich: { projectType, sourceLines },
          maxSurvivors: survivorsPerFile,
        });
        if (payload.survivors.length > 0) row.survivors = payload.survivors;
        if (payload.noCoverage.length > 0) row.noCoverageGroups = payload.noCoverage;
        if (payload.summary.worstSeverity) row.worstSeverity = payload.summary.worstSeverity;
      }

      return { row };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: { file, error: message } };
    }
  };

  const outcomes = await mapPool(files, poolSize, (file) => auditOne(file));
  const auditedRows: TriageRow[] = [];
  for (const o of outcomes) {
    if (o instanceof Error) {
      // Safety-net slot from mapPool — auditOne never throws, but guard defensively.
      errors.push({ file: '(unknown)', error: o.message });
      continue;
    }
    if ('error' in o) {
      errors.push(o.error);
    } else {
      auditedRows.push(o.row);
    }
  }

  const ranking = auditedRows.slice().sort(compareTriageRows);
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
