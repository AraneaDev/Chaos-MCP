/**
 * Mutation testing engine for Python files (cosmic-ray).
 *
 * This module is the ENGINE and nothing else: it sequences one run — write
 * config -> baseline -> init -> exec -> dump -> parse — and owns the budget
 * accounting and subprocess work that sequencing needs. Every phase's substance
 * lives under `engines/python/`:
 *
 *   config.ts      — the generated cosmic-ray TOML (pure)
 *   interpreter.ts — interpreter probing and test-command resolution
 *   report.ts      — dump parsing and scoring (pure)
 *
 * The helpers are re-exported here because that is the surface the test suite
 * already imports; the split moved where they live, not what the module offers.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BaseEngine, RunOptions, MutationResult } from './base.js';
import { ExecFailureError } from '../utils/exec-error.js';
import { invokeMutationTool, MutationToolStartupError } from '../utils/exec-classify.js';
import { log, isVerbose } from '../utils/logger.js';
import { DEFAULT_TIMEOUT_MS } from '../utils/constants.js';
import { AuditDeadline } from '../utils/deadline.js';
import {
  CONFIG_NAME,
  SESSION_NAME,
  DEFAULT_PER_MUTANT_TIMEOUT_S,
  MIN_STEP_BUDGET_MS,
  buildCosmicRayConfig,
} from './python/config.js';
import {
  describeInterpreter,
  probePythonInterpreter,
  resolveTestCommand,
} from './python/interpreter.js';
import { parseCosmicRayDump } from './python/report.js';

export { buildCosmicRayConfig, type CosmicRayConfigOptions } from './python/config.js';
export { CosmicRayDumpShapeError, parseCosmicRayDump } from './python/report.js';
export {
  PythonInterpreterError,
  isRepoTestCommandAllowed,
  resolveTestCommand,
  _resetInterpreterCache,
} from './python/interpreter.js';

/**
 * Mutation testing engine for Python files, backed by the `cosmic-ray` CLI.
 *
 * Flow (all inside the sandbox `workDir`): write a `config.toml` scoped to the
 * target file → `cosmic-ray baseline` (fail fast if the unmutated suite breaks)
 * → `cosmic-ray init` (enumerate mutants) → `cosmic-ray exec` (test each) →
 * `cosmic-ray dump` (structured JSON results) → {@link parseCosmicRayDump}.
 *
 * cosmic-ray emits authoritative operator names + exact line/column + a diff per
 * mutant, so survivors get a real location, change, and severity — no
 * per-mutant follow-up calls. It mutates IN PLACE and runs the test-command from
 * the working directory, so real-app conftests resolve (unlike mutmut's
 * copy-to-`mutants/` model). Line scoping and mutator allow/denylists are not
 * supported (whole-file); `operators` can restrict the mutation set via config.
 */
export class PythonEngine extends BaseEngine {
  /** Per-instance interpreter probe (audit A5). Empty until first {@link run}. */
  private cachedInterpreter: string | undefined;

  /** Lazy, one-time probe. Tests can construct a fresh engine to reset cache. */
  private interpreter(): string {
    if (this.cachedInterpreter) return this.cachedInterpreter;
    this.cachedInterpreter = probePythonInterpreter() ?? 'python3';
    return this.cachedInterpreter;
  }

  async run(filePath: string, options?: RunOptions): Promise<MutationResult> {
    const cwd = options?.workDir ?? process.cwd();
    // `timeoutMs` is the budget for the WHOLE audit of this file, not for each
    // sub-command: the caller already derived it from the audit-wide
    // {@link AuditDeadline} (handler) or from the per-file triage clamp. The five
    // sequential cosmic-ray invocations below therefore share one wall-clock
    // budget — each gets what is left, not a fresh full timeout.
    const budget = new AuditDeadline(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const configPath = join(cwd, CONFIG_NAME);
    const sessionPath = join(cwd, SESSION_NAME);

    const interpreter = this.interpreter();
    const testCommand = resolveTestCommand(interpreter, options);
    const config = buildCosmicRayConfig({
      modulePath: filePath,
      testCommand,
      timeoutSeconds: DEFAULT_PER_MUTANT_TIMEOUT_S,
      excludeOperators: options?.pythonExcludeOperators,
    });
    try {
      writeFileSync(configPath, config, 'utf8');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to write cosmic-ray config: ${message}`);
    }

    if (isVerbose()) {
      log(`PythonEngine: cosmic-ray on ${filePath} (test-command: ${testCommand})`);
    }

    // Step 1: baseline — run the unmutated suite once. A failure here means the
    // test suite is broken before any mutation, which would make every mutant
    // spuriously "killed"; surface it instead of reporting a meaningless 100%.
    // NOTE: no `--session-file` — baseline would otherwise create the session DB,
    // and the subsequent `init` refuses a pre-existing session (exit 65).
    await this.invoke(['baseline', configPath], cwd, this.stepBudget(budget, 'baseline'), {
      onExecFailure: (e) =>
        new Error(
          `cosmic-ray baseline failed (exit ${e.exit}) before mutation testing began. ` +
            `The usual cause is a failing or uncollectable test suite; run the suite directly to confirm. ` +
            `Details: ${(e.stderr || e.message).slice(0, 500)}`,
        ),
      signal: options?.signal,
      executor: options?.executor,
    });

    // Step 2: init — enumerate mutants into the session DB (no tests run).
    await this.invoke(['init', configPath, sessionPath], cwd, this.stepBudget(budget, 'init'), {
      onExecFailure: (e) =>
        new Error(
          `cosmic-ray init failed (exit ${e.exit}): ${(e.stderr || e.message).slice(0, 500)}`,
        ),
      signal: options?.signal,
      executor: options?.executor,
    });

    // Step 2.5: operator filter — mark mutants matching excludeOperators as
    // skipped so exec doesn't run them. cosmic-ray has no operator allowlist and
    // no line-scoping, so this is the lever for bounding the mutant count (hence
    // wall-clock) on large files. `cr-filter-operators <session> <config>` ships
    // with cosmic-ray. Only runs when a list is supplied.
    //
    // A previous comment here claimed "Skipped mutants are omitted from dump, so
    // they simply drop out of the score". That is FALSE, and it was the premise
    // the degenerate-run guard below was built on. Verified against the pinned
    // cosmic-ray 8.4.6 (containers/python/requirements.txt), source + a live
    // session: `cr-filter-operators` calls
    // `work_db.set_result(job_id, WorkResult(worker_outcome=SKIPPED))`, which
    // gives the mutant a RESULT row. `dump` iterates `completed_work_items`
    // (every work item that HAS a result) and only then the pending ones, so a
    // filtered mutant is dumped — with `test_outcome: null`, because
    // `WorkResult.test_outcome` defaults to None and nothing sets it.
    //
    // 8.4.6 additionally cannot serialise that record at all: `cli.py`'s
    // `result_to_dict` does `d["test_outcome"].value` unconditionally and raises
    // `AttributeError: 'NoneType' object has no attribute 'value'`, so the WHOLE
    // dump exits 1 as soon as one mutant was filtered. That surfaces as the
    // dump-step failure below, which is why that message carries an
    // excludeOperators hint. On builds whose dump does emit the null record,
    // parseCosmicRayDump counts it as `unscored` and the degenerate-run guard
    // names the exclude list rather than blaming the interpreter.
    if (options?.pythonExcludeOperators && options.pythonExcludeOperators.length > 0) {
      await this.invoke([sessionPath, configPath], cwd, this.stepBudget(budget, 'filter'), {
        command: 'cr-filter-operators',
        onExecFailure: (e) =>
          new Error(
            `cosmic-ray operator filter failed (exit ${e.exit}): ${(e.stderr || e.message).slice(0, 500)}`,
          ),
        signal: options?.signal,
        executor: options?.executor,
      });
    }

    // Step 3: exec — apply each mutant and run the test-command.
    await this.invoke(['exec', configPath, sessionPath], cwd, this.stepBudget(budget, 'exec'), {
      onExecFailure: (e) =>
        new Error(
          `cosmic-ray exec failed (exit ${e.exit}): ${(e.stderr || e.message).slice(0, 500)}`,
        ),
      signal: options?.signal,
      executor: options?.executor,
    });

    // Step 4: dump — structured JSON results.
    const filtered = (options?.pythonExcludeOperators?.length ?? 0) > 0;
    const dump = await this.invoke(['dump', sessionPath], cwd, this.stepBudget(budget, 'dump'), {
      onExecFailure: (e) =>
        new Error(
          `cosmic-ray dump failed (exit ${e.exit}): ${(e.stderr || e.message).slice(0, 500)}` +
            // cosmic-ray 8.4.6's `dump` crashes on any mutant this run's operator
            // filter skipped (see step 2.5). Without this the operator sees an
            // opaque AttributeError traceback and no link to the option that
            // caused it.
            (filtered
              ? `. NOTE: this run used "cosmicray": { "excludeOperators": [...] }, and cosmic-ray ` +
                `8.4.6's \`dump\` raises AttributeError on any mutant the filter marked skipped ` +
                `(its test_outcome is null). Remove excludeOperators, or use a cosmic-ray whose ` +
                `dump tolerates a null test_outcome, to get results for this file.`
              : ''),
        ),
      signal: options?.signal,
      executor: options?.executor,
    });

    const { result, completed, unscored } = parseCosmicRayDump(dump.stdout, filePath);

    // Degenerate-run guard. cosmic-ray's `baseline` returns exit 0 even when the
    // test binary is missing or collects nothing, so a broken run reaches here
    // looking like a clean one: mutants were enumerated and executed, but none
    // of them produced a killed/survived verdict. parseCosmicRayDump drops those
    // from the denominator, which would otherwise surface as a dangerously
    // misleading `total:0` / `100%` ("caught every mutation") when in truth NO
    // test ever ran. A genuinely tiny file with zero enumerated mutants has
    // `completed === 0` and is untouched.
    //
    // The two unscorable outcomes have OPPOSITE causes and must not share a
    // diagnosis. `incompetent` means the mutated code was executed and the test
    // command produced no real pass/fail → interpreter/test-command. A null
    // `test_outcome` means the worker never ran a test at all → almost always
    // `cr-filter-operators` skipping everything (step 2.5). The guard used to
    // count both as "completed" and blame the interpreter either way, so a
    // too-broad `excludeOperators` produced a confidently wrong message that
    // sent the operator to look at a Python install that was fine.
    if (result.totalMutants === 0 && completed > 0) {
      // `incompetent` is optional on the public MutationResult shape.
      const incompetent = result.incompetent ?? 0;
      if (incompetent > 0) {
        throw new Error(
          `cosmic-ray ran ${completed} mutant(s) on ${filePath} but scored none of them — ` +
            `${incompetent} came back 'incompetent', meaning the test command never ` +
            `produced a real pass/fail. This usually means the Python interpreter or pytest is ` +
            `missing, or the test-command is wrong. Resolved interpreter: ` +
            `${describeInterpreter(interpreter)}. Resolved test-command: "${testCommand}". ` +
            `Verify it runs the suite from the project root before re-auditing.`,
        );
      }
      throw new Error(
        `cosmic-ray ran ${completed} mutant(s) on ${filePath} but scored none of them — ` +
          `${unscored} came back with no test outcome at all, which means no test was ever run ` +
          `for them (cosmic-ray records those with worker_outcome 'skipped' or 'no-test'). The ` +
          `usual cause is an operator filter that excluded every mutation: ` +
          `"cosmicray": { "excludeOperators": [...] }` +
          (filtered ? ` — this run used ${JSON.stringify(options?.pythonExcludeOperators)}` : '') +
          `. Narrow the exclude patterns so some operators survive the filter, then re-audit.`,
      );
    }

    return result;
  }

  /**
   * Wall-clock still available for the next cosmic-ray subcommand.
   *
   * A cosmic-ray audit is five sequential CLI invocations (baseline → init →
   * filter → exec → dump). Handing each the caller's full `timeoutMs` would let
   * one file occupy five times its budget, which defeats both the audit-wide
   * {@link AuditDeadline} and the per-file clamp triage applies before a sweep.
   * Passing the REMAINING budget instead keeps the whole run inside `timeoutMs`.
   *
   * Throws once too little is left to be worth spawning a process, so the
   * failure names the phase that ran out rather than surfacing as an opaque
   * sub-second timeout.
   */
  private stepBudget(budget: AuditDeadline, step: string): number {
    const remaining = budget.remainingMs();
    if (remaining < MIN_STEP_BUDGET_MS) {
      throw new Error(
        `cosmic-ray audit budget exhausted after ${budget.elapsedMs()}ms — only ${remaining}ms ` +
          `left, too little to run \`${step}\`. Raise timeoutMs, or narrow the audit ` +
          `(e.g. "cosmicray": { "excludeOperators": [...] }) so it fits the budget.`,
      );
    }
    return remaining;
  }

  /**
   * Invoke a cosmic-ray subcommand, normalising startup failures (missing
   * binary, timeout, crash) via {@link MutationToolStartupError} and mapping a
   * recoverable non-zero exit through the caller's `onExecFailure`.
   */
  private async invoke(
    args: string[],
    cwd: string,
    timeoutMs: number,
    opts: {
      onExecFailure: (e: ExecFailureError) => Error;
      signal?: AbortSignal;
      command?: string;
      executor?: RunOptions['executor'];
    },
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      // The filter ships with cosmic-ray (`cr-filter-operators`); label it
      // 'cosmic-ray' so a missing binary yields the cosmic-ray install hint.
      return await invokeMutationTool('cosmic-ray', opts.command ?? 'cosmic-ray', args, {
        cwd,
        timeoutMs,
        signal: opts.signal,
        executor: opts.executor,
      });
    } catch (error: unknown) {
      if (error instanceof MutationToolStartupError) throw new Error(error.message);
      if (error instanceof ExecFailureError) throw opts.onExecFailure(error);
      throw error instanceof Error
        ? error
        : new Error(`cosmic-ray execution failed: ${String(error)}`);
    }
  }
}
