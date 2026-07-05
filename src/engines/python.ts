import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BaseEngine, RunOptions, MutationResult, Vulnerability } from './base.js';
import { ExecFailureError } from '../utils/exec.js';
import { invokeMutationTool, MutationToolStartupError } from '../utils/exec-classify.js';
import { log, isVerbose } from '../utils/logger.js';
import { DEFAULT_TIMEOUT_MS } from '../utils/constants.js';

/** Per-mutant test timeout written into the cosmic-ray config (seconds). */
const DEFAULT_PER_MUTANT_TIMEOUT_S = 30;
/** Sandbox-relative names for the generated config + session DB. */
const CONFIG_NAME = 'chaos-cosmic-ray.toml';
const SESSION_NAME = 'chaos-cosmic-ray.sqlite';

export interface CosmicRayConfigOptions {
  /** Workspace-relative file to mutate (cosmic-ray `module-path`). */
  modulePath: string;
  /** Shell command cosmic-ray runs to execute the test suite per mutant. */
  testCommand: string;
  /** Per-mutant test timeout in seconds. */
  timeoutSeconds: number;
  /**
   * Operator-name regexes to exclude (read by `cr-filter-operators`). cosmic-ray
   * always enumerates its full operator set, so this is how the mutant count is
   * bounded on large files — matching mutants are marked skipped before exec.
   */
  excludeOperators?: string[];
}

/**
 * Build a cosmic-ray `config.toml`. cosmic-ray (unlike mutmut) mutates files in
 * place and runs the test-command from the project root, so a real app's
 * conftest (`from main import app`) resolves normally.
 *
 * Note: cosmic-ray always enumerates its full operator set (the
 * `[cosmic-ray.operators]` section only parameterizes operators, it is NOT an
 * allowlist). To bound the mutant count on large files, supply `excludeOperators`
 * — `cr-filter-operators` marks matching mutants skipped (see {@link PythonEngine}).
 */
export function buildCosmicRayConfig(opts: CosmicRayConfigOptions): string {
  const lines = [
    '[cosmic-ray]',
    `module-path = ${JSON.stringify(opts.modulePath)}`,
    `timeout = ${opts.timeoutSeconds}`,
    `test-command = ${JSON.stringify(opts.testCommand)}`,
    '',
    '[cosmic-ray.distributor]',
    'name = "local"',
  ];
  if (opts.excludeOperators && opts.excludeOperators.length > 0) {
    lines.push(
      '',
      '[cosmic-ray.filters.operators-filter]',
      `exclude-operators = [${opts.excludeOperators.map((o) => JSON.stringify(o)).join(', ')}]`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Extract original→mutated source from a cosmic-ray unified `diff`. */
function extractDiffChange(diff: string): { original?: string; mutated?: string } {
  let original: string | undefined;
  let mutated: string | undefined;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('---') || raw.startsWith('+++')) continue; // file headers
    if (original === undefined && raw.startsWith('-')) original = raw.slice(1).trim();
    else if (mutated === undefined && raw.startsWith('+')) mutated = raw.slice(1).trim();
  }
  return { original, mutated };
}

/**
 * Parse cosmic-ray `dump` output (one `[WorkItem, WorkResult]` JSON pair per
 * line) into a MutationResult.
 *
 * - `test_outcome: "killed"` → caught by the suite.
 * - `test_outcome: "survived"` → a coverage hole (becomes a vulnerability with
 *   the exact line from `start_pos`, the authoritative `operator_name`, and the
 *   original/mutated source from the `diff`).
 * - `test_outcome: "incompetent"` → the mutation produced uncompilable code; it
 *   is excluded from the denominator (not a real test gap), mirroring how
 *   StrykerJS handles compile errors.
 * - `result === null` → a pending job (exec interrupted); ignored.
 */
export function parseCosmicRayDump(dumpText: string, filePath: string): MutationResult {
  let killed = 0;
  let survived = 0;
  let incompetent = 0;
  let completed = 0;
  const vulnerabilities: Vulnerability[] = [];

  for (const raw of dumpText.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // malformed line — skip defensively
    }
    if (!Array.isArray(parsed) || parsed.length < 2) continue;
    const item = parsed[0] as {
      mutations?: { operator_name?: string; start_pos?: [number, number] }[];
    };
    const result = parsed[1] as { test_outcome?: string; diff?: string } | null;
    if (!result) continue; // pending job
    completed++;

    const outcome = result.test_outcome;
    if (outcome === 'incompetent') incompetent++;
    if (outcome === 'killed') {
      killed++;
    } else if (outcome === 'survived') {
      survived++;
      const m = item?.mutations?.[0] ?? {};
      const line = Array.isArray(m.start_pos) ? m.start_pos[0] : 0;
      const operator = m.operator_name ?? 'Mutation';
      const { original, mutated } = extractDiffChange(result.diff ?? '');
      const vuln: Vulnerability = {
        line,
        mutator: operator,
        description: `Surviving mutant (${operator}) at line ${line} bypassed the test suite. Your tests did not catch this change.`,
      };
      if (original !== undefined) vuln.original = original;
      if (mutated !== undefined) vuln.mutated = mutated;
      vulnerabilities.push(vuln);
    }
    // 'incompetent' (and any other outcome) → excluded from the denominator.
  }

  const totalMutants = killed + survived;
  const score = totalMutants > 0 ? ((killed / totalMutants) * 100).toFixed(2) : '100.00';

  return {
    target: filePath,
    totalMutants,
    killed,
    survived,
    mutationScore: `${score}%`,
    vulnerabilities,
    incompetent,
    // `completed` rides along on the result so the engine can distinguish
    // "no mutants enumerated" (genuine 100%) from "mutants ran but none were
    // scorable" (broken test command). Not part of the public payload.
    ...(completed > 0 ? { _completed: completed } : {}),
  } as MutationResult & { _completed?: number };
}

/**
 * Resolve which Python interpreter the generated test-command should invoke.
 *
 * Hardcoding `python` is a silent failure on the many modern systems that ship
 * only `python3` (Debian/Ubuntu without `python-is-python3`, most CI images):
 * cosmic-ray's `baseline` returns exit 0 even when the test binary is missing,
 * and every mutant is then marked `incompetent` — which {@link parseCosmicRayDump}
 * drops from the denominator, yielding a meaningless `total:0` / `100%`.
 *
 * Precedence: the `CHAOS_MCP_PYTHON` env override (deterministic, used by tests)
 * → `python` when it is actually on PATH (back-compat) → `python3`. Cached after
 * the first probe.
 */
let cachedInterpreter: string | undefined;
function resolvePythonInterpreter(): string {
  if (cachedInterpreter) return cachedInterpreter;
  const override = process.env.CHAOS_MCP_PYTHON?.trim();
  if (override) {
    cachedInterpreter = override;
    return override;
  }
  try {
    const probe = spawnSync('python', ['--version'], { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) {
      cachedInterpreter = 'python';
      return 'python';
    }
  } catch {
    // fall through to python3
  }
  cachedInterpreter = 'python3';
  return cachedInterpreter;
}

/** Reset the cached interpreter probe. Exported for tests only. */
export function _resetInterpreterCache(): void {
  cachedInterpreter = undefined;
}

/** Resolve the shell test-command cosmic-ray runs per mutant. */
function resolveTestCommand(options?: RunOptions): string {
  const runner = options?.testRunner;
  const py = resolvePythonInterpreter();
  // A custom non-pytest/unittest runner string is used verbatim as the command.
  let base: string;
  if (runner === 'unittest') base = `${py} -m unittest`;
  else if (runner && runner !== 'pytest' && !runner.includes('pytest')) base = runner;
  else base = `${py} -m pytest -x -q`;

  const selection = options?.pythonTestSelection;
  if (selection && selection.length > 0) base += ` ${selection.join(' ')}`;
  return base;
}

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
  async run(filePath: string, options?: RunOptions): Promise<MutationResult> {
    const cwd = options?.workDir ?? process.cwd();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const configPath = join(cwd, CONFIG_NAME);
    const sessionPath = join(cwd, SESSION_NAME);

    const config = buildCosmicRayConfig({
      modulePath: filePath,
      testCommand: resolveTestCommand(options),
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
      log(`PythonEngine: cosmic-ray on ${filePath} (test-command: ${resolveTestCommand(options)})`);
    }

    // Step 1: baseline — run the unmutated suite once. A failure here means the
    // test suite is broken before any mutation, which would make every mutant
    // spuriously "killed"; surface it instead of reporting a meaningless 100%.
    // NOTE: no `--session-file` — baseline would otherwise create the session DB,
    // and the subsequent `init` refuses a pre-existing session (exit 65).
    await this.invoke(['baseline', configPath], cwd, timeoutMs, {
      onExecFailure: (e) =>
        new Error(
          `cosmic-ray baseline failed (exit ${e.exit}). The test suite fails before mutation testing begins. ` +
            `Fix the failing tests first. Details: ${(e.stderr || e.message).slice(0, 500)}`,
        ),
      signal: options?.signal,
    });

    // Step 2: init — enumerate mutants into the session DB (no tests run).
    await this.invoke(['init', configPath, sessionPath], cwd, timeoutMs, {
      onExecFailure: (e) =>
        new Error(
          `cosmic-ray init failed (exit ${e.exit}): ${(e.stderr || e.message).slice(0, 500)}`,
        ),
      signal: options?.signal,
    });

    // Step 2.5: operator filter — mark mutants matching excludeOperators as
    // skipped so exec doesn't run them. cosmic-ray has no operator allowlist and
    // no line-scoping, so this is the lever for bounding the mutant count (hence
    // wall-clock) on large files. `cr-filter-operators <session> <config>` ships
    // with cosmic-ray. Skipped mutants are omitted from `dump`, so they simply
    // drop out of the score (a scoped audit). Only runs when a list is supplied.
    if (options?.pythonExcludeOperators && options.pythonExcludeOperators.length > 0) {
      await this.invoke([sessionPath, configPath], cwd, timeoutMs, {
        command: 'cr-filter-operators',
        onExecFailure: (e) =>
          new Error(
            `cosmic-ray operator filter failed (exit ${e.exit}): ${(e.stderr || e.message).slice(0, 500)}`,
          ),
        signal: options?.signal,
      });
    }

    // Step 3: exec — apply each mutant and run the test-command.
    await this.invoke(['exec', configPath, sessionPath], cwd, timeoutMs, {
      onExecFailure: (e) =>
        new Error(
          `cosmic-ray exec failed (exit ${e.exit}): ${(e.stderr || e.message).slice(0, 500)}`,
        ),
      signal: options?.signal,
    });

    // Step 4: dump — structured JSON results.
    const dump = await this.invoke(['dump', sessionPath], cwd, timeoutMs, {
      onExecFailure: (e) =>
        new Error(
          `cosmic-ray dump failed (exit ${e.exit}): ${(e.stderr || e.message).slice(0, 500)}`,
        ),
      signal: options?.signal,
    });

    const result = parseCosmicRayDump(dump.stdout, filePath) as MutationResult & {
      _completed?: number;
    };

    // Degenerate-run guard. cosmic-ray's `baseline` returns exit 0 even when the
    // test binary is missing or collects nothing, so a broken run reaches here
    // looking like a clean one: mutants were enumerated and executed, but every
    // result was `incompetent` (the mutated code never reached a real pass/fail).
    // parseCosmicRayDump drops `incompetent` from the denominator, which would
    // otherwise surface as a dangerously misleading `total:0` / `100%` ("caught
    // every mutation") when in truth NO test ever ran. Detect it — mutants
    // completed, none were scorable — and fail loudly with the resolved command
    // so the operator can fix the interpreter / test-command. A genuinely tiny
    // file with zero enumerated mutants has `_completed === 0` and is untouched.
    const completed = result._completed ?? 0;
    delete result._completed;
    if (result.totalMutants === 0 && completed > 0) {
      throw new Error(
        `cosmic-ray ran ${completed} mutant(s) on ${filePath} but scored none of them — ` +
          `every mutation came back 'incompetent', meaning the test command never produced a ` +
          `real pass/fail. This usually means the Python interpreter or pytest is missing, or ` +
          `the test-command is wrong. Resolved test-command: "${resolveTestCommand(options)}". ` +
          `Verify it runs the suite from the project root before re-auditing.`,
      );
    }

    return result;
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
    },
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      // The filter ships with cosmic-ray (`cr-filter-operators`); label it
      // 'cosmic-ray' so a missing binary yields the cosmic-ray install hint.
      return await invokeMutationTool('cosmic-ray', opts.command ?? 'cosmic-ray', args, {
        cwd,
        timeoutMs,
        signal: opts.signal,
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
