import { createSandbox } from '../utils/sandbox.js';
import { createExecutionSession } from '../utils/execution.js';
import { makeEngine } from '../engines/registry.js';
import { TypeScriptEngine } from '../engines/typescript.js';
import { buildRunOptions, resolveAuditTimeoutMs } from '../audit/run-options.js';
import { computeFingerprint } from '../utils/reuse/fingerprint.js';
import { resolveAuditTargetIn, type ResolvedTarget } from '../audit/target.js';
import {
  buildTriageRowForResult,
  resolveDiffScope,
  type TriageFileDeps,
  type TriageDiffScope,
} from './audit-one.js';
import type { MutationResult } from '../engines/base.js';
import type { SweepUnit } from './grouping.js';

export type GroupUnit = Extract<SweepUnit, { kind: 'group' }>;

export type GroupOutcome =
  | {
      kind: 'split';
      perFile: Map<string, MutationResult>;
      targets: Map<string, ResolvedTarget>;
      scopes: Map<string, TriageDiffScope>;
    }
  | { kind: 'contain'; reason: string };

/**
 * Run a TypeScript group in one sandbox and one Stryker invocation. This
 * function deliberately returns raw per-file results; the normal row builder
 * then applies each file's suppressions and run-cache identity independently.
 */
export async function auditTriageGroup(
  unit: GroupUnit,
  deps: TriageFileDeps,
): Promise<GroupOutcome> {
  if (unit.files.length < 2) return { kind: 'contain', reason: 'group has fewer than two files' };
  const targets = new Map<string, ResolvedTarget>();
  for (const file of unit.files) {
    const target = resolveAuditTargetIn(deps.rootCwd, file);
    if (
      !target ||
      target.projectType !== 'typescript' ||
      target.env.workspaceRoot !== unit.workspaceRoot ||
      (deps.cfg.stryker?.testRunner ?? deps.cfg.testRunner ?? target.env.testRunner) !== unit.runner
    ) {
      return { kind: 'contain', reason: `group member ${file} is not eligible` };
    }
    targets.set(file, target);
  }

  const first = targets.get(unit.files[0]);
  if (!first) return { kind: 'contain', reason: 'group has no target' };
  const engine = makeEngine('typescript');
  if (
    !(engine instanceof TypeScriptEngine) &&
    typeof (engine as TypeScriptEngine).runGroup !== 'function'
  ) {
    return { kind: 'contain', reason: 'TypeScript engine does not support grouped runs' };
  }
  const remaining = deps.deadline.remainingMs(deps.cleanupReserveMs);
  if (remaining < 1_000) return { kind: 'contain', reason: 'group time budget exhausted' };
  const perFileBudget = resolveAuditTimeoutMs(deps.args, deps.cfg, 'typescript');
  const groupTimeout = Math.min(remaining, perFileBudget * unit.files.length);
  const scopeByFile = new Map<string, TriageDiffScope>();
  for (const file of unit.files) {
    const target = targets.get(file);
    if (!target) return { kind: 'contain', reason: `missing target for ${file}` };
    scopeByFile.set(
      file,
      await resolveDiffScope(target.targetFile, target.env, 'typescript', groupTimeout, deps),
    );
  }

  const controller = new AbortController();
  const abort = () => controller.abort(deps.ctx?.signal?.reason);
  deps.ctx?.signal?.addEventListener('abort', abort, { once: true });
  const handle = deps.watchdog?.register(
    controller,
    (deps.perFileCostBytes ?? 0) * unit.files.length,
  );
  let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
  let executor: Awaited<ReturnType<typeof createExecutionSession>> | undefined;
  try {
    sandbox = await createSandbox(first.targetFile, first.env.workspaceRoot, undefined, {
      signal: controller.signal,
      dependencies: deps.cfg.sandbox?.dependencies,
    });
    const groupArgs = {
      ...deps.args,
      timeoutMs: groupTimeout,
      concurrency: deps.perFileConcurrency,
      innerEnv: deps.innerEnvFor?.('typescript'),
    };
    const runOptions = buildRunOptions(
      groupArgs,
      deps.cfg,
      first.env,
      sandbox.workDir,
      'typescript',
      first.targetFile,
    );
    runOptions.timeoutMs = groupTimeout;
    runOptions.signal = controller.signal;
    const sortedFiles = unit.files.slice().sort();
    runOptions.reuse = {
      key: {
        workspaceRoot: first.env.workspaceRoot,
        engine: 'typescript',
        target: `group:${sortedFiles.join('\0')}`,
        kind: 'incremental',
      },
      fingerprint:
        (await computeFingerprint({
          workspaceRoot: first.env.workspaceRoot,
          paths: sortedFiles,
          extra: { runner: unit.runner, group: sortedFiles.join('\0') },
        })) ?? '',
    };
    const mode = deps.cfg.container?.modes?.typescript ?? deps.cfg.container?.mode ?? 'native';
    executor =
      mode === 'native'
        ? undefined
        : await createExecutionSession(
            'typescript',
            sandbox.workDir,
            first.env.workspaceRoot,
            deps.cfg.sandbox?.dependencies ?? 'link-entries',
            deps.cfg.container,
            controller.signal,
          );
    if (executor) runOptions.executor = executor;
    const rawByTarget = await (engine as TypeScriptEngine).runGroup(
      unit.files.map((file) => ({
        file: targets.get(file)?.targetFile ?? file,
        ranges: scopeByFile.get(file)?.lineRanges,
      })),
      runOptions,
    );
    const perFile = new Map<string, MutationResult>();
    for (const file of unit.files) {
      const result = rawByTarget.get(targets.get(file)?.targetFile ?? file);
      if (result) perFile.set(file, result);
    }
    if (perFile.size !== unit.files.length) {
      return { kind: 'contain', reason: 'group report omitted one or more files' };
    }
    return { kind: 'split', perFile, targets, scopes: scopeByFile };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: 'contain', reason };
  } finally {
    await executor?.dispose();
    sandbox?.cleanup();
    handle?.release();
    deps.ctx?.signal?.removeEventListener('abort', abort);
  }
}

/** Project the raw group result into the exact rows used by single-file runs. */
export function groupRows(
  unit: GroupUnit,
  outcome: Extract<GroupOutcome, { kind: 'split' }>,
  deps: TriageFileDeps,
): Map<string, ReturnType<typeof buildTriageRowForResult>> {
  const rows = new Map<string, ReturnType<typeof buildTriageRowForResult>>();
  for (const file of unit.files) {
    const result = outcome.perFile.get(file);
    const target = outcome.targets.get(file);
    const scope = outcome.scopes.get(file);
    if (!result || !target || !scope) throw new Error(`group result missing ${file}`);
    const row = buildTriageRowForResult(file, target, result, scope, deps);
    row.grouped = true;
    rows.set(file, row);
  }
  return rows;
}
