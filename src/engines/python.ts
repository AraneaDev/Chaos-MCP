import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  BaseEngine,
  RunOptions,
  MutationResult,
  Vulnerability,
  formatMutationScore,
} from './base.js';
import { ExecFailureError } from '../utils/exec-error.js';
import { invokeMutationTool, MutationToolStartupError } from '../utils/exec-classify.js';
import { log, isVerbose } from '../utils/logger.js';
import { DEFAULT_TIMEOUT_MS } from '../utils/constants.js';
import { AuditDeadline } from '../utils/deadline.js';

/** Per-mutant test timeout written into the cosmic-ray config (seconds). */
const DEFAULT_PER_MUTANT_TIMEOUT_S = 30;
/**
 * Floor below which starting another cosmic-ray subcommand is pointless — the
 * process would be killed before it finished spawning. Mirrors the engine floor
 * the handler applies to the audit as a whole (`MIN_ENGINE_BUDGET_MS`).
 */
const MIN_STEP_BUDGET_MS = 1_000;
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
 * Thrown when a surviving mutant's work item matches neither cosmic-ray dump
 * shape Chaos-MCP knows how to read. See {@link readMutationSpec}.
 */
export class CosmicRayDumpShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CosmicRayDumpShapeError';
  }
}

/** The two per-mutation fields a survivor's location is built from. */
interface CosmicRayMutationSpec {
  operator_name?: unknown;
  start_pos?: unknown;
}

/**
 * Read `operator_name` + `start_pos` out of one candidate record, or `undefined`
 * when it carries neither.
 *
 * `undefined` — rather than a `{ line: 0, mutator: 'Mutation' }` default — is
 * the whole point. Suppression and verify key survivors on `keyOf(line, mutator)`
 * (`utils/suppression.ts`, `verify.ts`, `audit/apply-suppressions.ts`), so a
 * placeholder collapses EVERY survivor in the file onto the single key
 * `"0 Mutation"`: suppressing one silently suppresses all of them, and a verify
 * re-run reports phantom "now killed" mutants. The killed/survived counts and
 * the mutation score stay correct throughout (they come only from
 * `test_outcome`), which is what made the old failure silent as well as
 * dangerous.
 *
 * A record carrying only ONE of the two fields is still returned: the other half
 * falls back, which loses precision but does not collide across operators/lines
 * the way a fully-empty record does.
 */
function readMutationSpec(source: unknown): { line: number; operator: string } | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const spec = source as CosmicRayMutationSpec;
  const operator = typeof spec.operator_name === 'string' ? spec.operator_name : undefined;
  const line =
    Array.isArray(spec.start_pos) && typeof spec.start_pos[0] === 'number'
      ? spec.start_pos[0]
      : undefined;
  if (operator === undefined && line === undefined) return undefined;
  return { line: line ?? 0, operator: operator ?? 'Mutation' };
}

/**
 * Locate a survivor's mutation record across cosmic-ray's two work-item shapes.
 *
 * cosmic-ray >= 8.4 nests them: `WorkItem { job_id, mutations: MutationSpec[] }`
 * — the multi-mutation shape that supports higher-order mutation (verified
 * against the 8.4.6 `work_item.py` this repo pins in
 * `containers/python/requirements.txt`). Earlier 8.x carried `operator_name` /
 * `start_pos` FLAT on the WorkItem. The container path is pinned, but NATIVE
 * mode runs whatever `pipx install cosmic-ray` produced and nothing probes
 * `cosmic-ray --version`, so both shapes have to be read.
 *
 * @throws {CosmicRayDumpShapeError} when neither shape is present.
 */
function resolveSurvivorLocation(item: unknown): { line: number; operator: string } {
  const nested = Array.isArray((item as { mutations?: unknown })?.mutations)
    ? ((item as { mutations: unknown[] }).mutations[0] as unknown)
    : undefined;
  const spec = readMutationSpec(nested) ?? readMutationSpec(item);
  if (spec) return spec;

  const keys =
    typeof item === 'object' && item !== null ? Object.keys(item).join(', ') : String(item);
  throw new CosmicRayDumpShapeError(
    `cosmic-ray dump shape not recognised — Chaos-MCP supports cosmic-ray >= 8.3; got: ` +
      `${keys || '(no keys)'}. A surviving mutant's work item carried neither a \`mutations[]\` ` +
      `entry (cosmic-ray >= 8.4) nor top-level \`operator_name\`/\`start_pos\` (cosmic-ray 8.3), ` +
      `so its line and operator cannot be identified. Chaos-MCP refuses to substitute a ` +
      `placeholder here because every survivor would then share one suppression key and ` +
      `suppressing one would hide them all. Install a supported cosmic-ray ` +
      `(\`pipx install 'cosmic-ray==8.4.6'\` — the version containers/python pins).`,
  );
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
 * - `test_outcome: null` (or anything unrecognised) → UNSCORED. cosmic-ray's
 *   `WorkResult` carries BOTH `worker_outcome` and `test_outcome`, and the
 *   latter is `None` whenever the worker never reached a test — most importantly
 *   for `worker_outcome == "skipped"`, which is exactly what `cr-filter-operators`
 *   writes for every mutant an `excludeOperators` pattern matched. Counting
 *   those as merely "completed" made the degenerate-run guard misdiagnose a
 *   too-broad operator filter as a missing Python interpreter.
 * - `result === null` → a pending job (exec interrupted); ignored entirely.
 *
 * Returns the result alongside `completed` (mutants that came back with ANY
 * result) and `unscored`. Neither is a field on `MutationResult` (the public
 * payload shape): the engine reads them to tell "no mutants enumerated" (a
 * genuine 100%) from "mutants ran but none were scorable", and to tell WHICH
 * kind of unscorable. See the degenerate-run guard in {@link PythonEngine.run}.
 */
export function parseCosmicRayDump(
  dumpText: string,
  filePath: string,
): { result: MutationResult; completed: number; unscored: number } {
  let killed = 0;
  let survived = 0;
  let incompetent = 0;
  let unscored = 0;
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
    const item: unknown = parsed[0];
    const result = parsed[1] as { test_outcome?: string | null; diff?: string } | null;
    if (!result) continue; // pending job
    completed++;

    const outcome = result.test_outcome;
    if (outcome === 'killed') {
      killed++;
    } else if (outcome === 'survived') {
      survived++;
      const { line, operator } = resolveSurvivorLocation(item);
      const { original, mutated } = extractDiffChange(result.diff ?? '');
      const vuln: Vulnerability = {
        line,
        mutator: operator,
        // cosmic-ray reports killed/survived/incompetent only — it has no
        // "no test reached this line" outcome to distinguish.
        kind: 'survived',
        description: `Surviving mutant (${operator}) at line ${line} bypassed the test suite. Your tests did not catch this change.`,
      };
      if (original !== undefined) vuln.original = original;
      if (mutated !== undefined) vuln.mutated = mutated;
      vulnerabilities.push(vuln);
    } else if (outcome === 'incompetent') {
      // Uncompilable mutation — excluded from the denominator, not a test gap.
      incompetent++;
    } else {
      // null / undefined / an outcome from a future cosmic-ray. The worker never
      // produced a pass/fail, so this mutant is not evidence about the suite in
      // either direction; it is tracked separately so the engine can say WHY.
      unscored++;
    }
  }

  const totalMutants = killed + survived;

  return {
    result: {
      target: filePath,
      totalMutants,
      killed,
      survived,
      mutationScore: formatMutationScore(killed, totalMutants),
      vulnerabilities,
      incompetent,
    },
    completed,
    unscored,
  };
}

/**
 * A bare executable name — letters, digits, and the few punctuation characters
 * that appear in real binary names. Deliberately excludes whitespace and every
 * shell metacharacter (`;`, `|`, `&`, `$`, backticks, redirects, parentheses),
 * so a value matching this can only ever name a program to run: it cannot carry
 * arguments, chain commands, or substitute a subshell.
 */
const BARE_EXECUTABLE_RE = /^[A-Za-z0-9._+-]+$/;

/**
 * An absolute path to an interpreter, POSIX or Windows. Built from the same
 * character class as {@link BARE_EXECUTABLE_RE} plus separators, so it inherits
 * the "no whitespace, no shell metacharacter" property: `/opt/venv/bin/python3.12`
 * and `C:\Python312\python.exe` pass; `/usr/bin/python; rm -rf /` does not.
 */
const ABSOLUTE_INTERPRETER_RE = /^(?:[A-Za-z]:)?[\\/](?:[A-Za-z0-9._+-]+[\\/])*[A-Za-z0-9._+-]+$/;

/** Thrown when `CHAOS_MCP_PYTHON` names something that is not safe to shell. */
export class PythonInterpreterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PythonInterpreterError';
  }
}

/**
 * Argument list that answers "is this interpreter Python 3?" — not merely "does
 * it start?".
 *
 * `--version` exiting 0 proves only that SOMETHING ran. On the distributions
 * where `/usr/bin/python` is still Python 2 it exits 0 happily, and every mutant
 * then runs `python -m pytest` under Python 2 against a Python 3 suite: all of
 * them come back `incompetent`, `totalMutants` is 0, and the degenerate-run
 * guard blames a missing interpreter while echoing a command that looks correct.
 * Asserting the major version instead makes the probe answer the question the
 * caller actually has.
 */
const PY3_PROBE_ARGS = ['-c', 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)'];

/**
 * Probe which Python interpreter is available on PATH. The result is cached
 * for the lifetime of the engine instance — earlier versions of this code
 * used a module-global cache (`let cachedInterpreter`), but module globals
 * couple tests to one another (a test that runs once with `CHAOS_MCP_PYTHON=x`
 * poisoned the cache for every subsequent test in the same Node process —
 * audit A5).
 *
 * Precedence: the `CHAOS_MCP_PYTHON` env override (deterministic, used by
 * tests) → `python` when it is actually a Python 3 on PATH (back-compat) →
 * `python3`.
 *
 * The override is VALIDATED rather than trusted. Its doc comment used to call it
 * "deterministic, used by tests", but nothing enforced that: the value is
 * string-concatenated into `${interpreter} -m pytest -x -q` and written into the
 * cosmic-ray config as `test-command`, which cosmic-ray executes THROUGH A SHELL
 * once per mutant. `CHAOS_MCP_PYTHON='python3; curl … | sh #'` therefore ran.
 * The elaborate {@link isRepoTestCommandAllowed} gate guarded the RUNNER half of
 * that string and left the INTERPRETER half wide open; this closes it with the
 * same machinery.
 *
 * @throws {PythonInterpreterError} when the override is neither a bare
 * executable name nor an absolute path.
 */
function probePythonInterpreter(): string | undefined {
  const override = process.env.CHAOS_MCP_PYTHON?.trim();
  if (override) {
    if (!BARE_EXECUTABLE_RE.test(override) && !ABSOLUTE_INTERPRETER_RE.test(override)) {
      throw new PythonInterpreterError(
        `Refusing to use CHAOS_MCP_PYTHON="${override}" as the Python interpreter. ` +
          `It is concatenated into cosmic-ray's \`test-command\`, which is executed through a ` +
          `shell once per mutant, so only a bare executable name ("python3", "python3.12") or an ` +
          `absolute path with no whitespace or shell metacharacters ("/opt/venv/bin/python3.12") ` +
          `is accepted. Point it at the interpreter itself, not at a command line.`,
      );
    }
    return override;
  }
  try {
    const probe = spawnSync('python', PY3_PROBE_ARGS, { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) return 'python';
  } catch {
    // fall through to python3
  }
  return 'python3';
}

/**
 * Human-readable identification of the interpreter, for diagnostics only.
 *
 * Called exclusively from the degenerate-run error path (never on the happy
 * path), because "every mutant was incompetent" is almost always an interpreter
 * problem and the operator cannot act on a bare name: `python3` resolving to a
 * 3.7 that pytest refuses to run under looks identical to a correct one in the
 * error message. `spawnSync` without a shell, on a value that has already passed
 * {@link BARE_EXECUTABLE_RE}/{@link ABSOLUTE_INTERPRETER_RE}.
 */
function describeInterpreter(interpreter: string): string {
  try {
    const probe = spawnSync(interpreter, ['--version'], { encoding: 'utf8' });
    if (probe.error) return `"${interpreter}" (not runnable: ${probe.error.message})`;
    // Python < 3.4 writes `--version` to stderr; later versions use stdout.
    const reported = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim().split('\n')[0];
    if (reported) return `"${interpreter}" (${reported})`;
  } catch {
    // fall through to the unknown-version form
  }
  return `"${interpreter}" (version unavailable)`;
}

/**
 * Whether a test-runner string sourced from the AUDITED PROJECT may be used as
 * a shell command verbatim.
 *
 * cosmic-ray executes `test-command` through a shell once per mutant, and one
 * source of that string is the audited repository's own
 * `pyproject.toml [tool.mutmut] runner` key — content Chaos-MCP does not
 * control. Mutation testing inherently runs the project's test suite, so
 * naming a test binary is in scope; accepting an arbitrary shell line from repo
 * content is not, and it is the same hazard `prebuildCommand` is gated behind
 * `allowPrebuild` for.
 *
 * A bare executable name is therefore accepted (the shape the mutmut key is
 * meant to hold — `nose2`, `ward`, `green`); anything carrying arguments or
 * shell syntax requires an explicit operator opt-in, via the
 * `cosmicray.testRunner` config key (which is trusted, being the operator's own
 * file) or `CHAOS_MCP_ALLOW_REPO_TEST_COMMAND=1`.
 */
export function isRepoTestCommandAllowed(runner: string): boolean {
  if (BARE_EXECUTABLE_RE.test(runner)) return true;
  const flag = process.env.CHAOS_MCP_ALLOW_REPO_TEST_COMMAND;
  return flag === '1' || flag === 'true';
}

/**
 * Resolve the shell test-command cosmic-ray runs per mutant.
 *
 * Exactly three inputs are treated as "not a project-declared command": absent,
 * the sentinel `'pytest'`, and the sentinel `'unittest'`. Those are the values
 * `detectPythonTestRunner` (utils/project-detector.ts) synthesises from
 * workspace SIGNALS (a
 * `pytest.ini`, a `conftest.py`, a `tox.ini`) rather than reading out of the
 * project's files, so they name a runner without carrying a command line.
 * Everything else is a string the audited repository authored and is subjected
 * to {@link isRepoTestCommandAllowed}.
 *
 * There used to be a fourth case — `!runner.includes('pytest')` — and it was the
 * bug this doc comment claims the function exists to prevent. Any
 * pytest-FLAVOURED command (`python -m pytest --no-cov -p no:randomly`, the real
 * shape of a `[tool.mutmut] runner` key) failed that test, skipped the gate
 * branch entirely, fell through to the default, and had the project's declared
 * command THROWN AWAY and replaced by a bare `pytest -x -q`. No throw, no
 * warning. A project that had deliberately disabled pytest-randomly (order
 * dependent tests) or pytest-cov (coverage-plugin conflicts) then had those
 * plugins re-enabled under every per-mutant invocation, and mutants were scored
 * "killed" by failures that had nothing to do with the mutation. The score was
 * wrong in both directions and nothing reported it.
 *
 * Throws when the resolved runner came from the audited project and is not a
 * bare executable name — see {@link isRepoTestCommandAllowed}. Failing loudly
 * beats silently substituting pytest, which would run a different suite than
 * the project declared and quietly change what "survived" means.
 */
export function resolveTestCommand(interpreter: string, options?: RunOptions): string {
  const runner = options?.testRunner;
  let base: string;
  if (runner === 'unittest') {
    base = `${interpreter} -m unittest`;
  } else if (!runner || runner === 'pytest') {
    base = `${interpreter} -m pytest -x -q`;
  } else {
    // A custom runner string is used verbatim as the command — after the gate.
    // `testRunnerTrusted` marks a runner that came from the operator's own
    // config (`chaos-mcp.config.json`) rather than from the workspace scan; only
    // the untrusted, workspace-sourced half is gated, so an operator who wrote
    // `"cosmicray": { "testRunner": "python -m pytest --no-cov" }` still gets
    // exactly that command. See run-options.ts, which sets the flag.
    if (options?.testRunnerTrusted !== true && !isRepoTestCommandAllowed(runner)) {
      throw new Error(
        `Refusing to run the test command "${runner}" declared by the audited project ` +
          `(pyproject.toml [tool.mutmut] runner). cosmic-ray executes it through a shell once per ` +
          `mutant, and only a bare executable name is accepted from project files. ` +
          `Set "cosmicray": { "testRunner": "…" } in your chaos-mcp.config.json to run it ` +
          `deliberately, or set CHAOS_MCP_ALLOW_REPO_TEST_COMMAND=1 to trust project-declared ` +
          `commands in this workspace.`,
      );
    }
    base = runner;
  }

  const selection = options?.pythonTestSelection;
  if (selection && selection.length > 0) base += ` ${selection.join(' ')}`;
  return base;
}

/** Reset the cached interpreter probe. Exported for tests only. */
export function _resetInterpreterCache(): void {
  // No-op kept for source-level compatibility with existing tests; the cache
  // now lives on the engine instance (see PythonEngine.constructor) and is
  // reset by constructing a fresh engine. (Audit A5.)
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
