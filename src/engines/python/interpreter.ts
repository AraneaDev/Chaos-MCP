/**
 * Choosing the Python interpreter and the test command cosmic-ray shells.
 *
 * Both are security-relevant: the interpreter name and the repo-supplied runner
 * end up inside a shell command executed once per mutant, so the validation
 * here is the gate that keeps a config-file string from becoming arbitrary
 * execution.
 */
import { spawnSync } from 'node:child_process';
import type { RunOptions } from '../base.js';
import { quoteCommandArg } from '../../utils/shell-quote.js';

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
export function probePythonInterpreter(): string | undefined {
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
export function describeInterpreter(interpreter: string): string {
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

  // Quote each entry individually. cosmic-ray splits `test-command` with
  // `shlex.split` (8.4.6, testing.py:46), so an unquoted path containing
  // whitespace becomes two argv entries — pytest then gets two paths that do
  // not exist, exits 4, and `cosmic-ray baseline` reports the project's test
  // suite as broken. A path containing a quote character is worse: shlex.split
  // raises, cosmic-ray records `incompetent` for every mutant, and the
  // degenerate-run guard blames the Python interpreter.
  //
  // These strings are the ONE contributor to this command that is not otherwise
  // validated: when the operator has not configured `cosmicray.testSelection`,
  // `findPythonTestSelection` (core/test-file.ts) fills it from paths it found
  // by walking the AUDITED repository's tests/ tree.
  const selection = options?.pythonTestSelection;
  if (selection && selection.length > 0) {
    base += ` ${selection.map(quoteCommandArg).join(' ')}`;
  }
  return base;
}

/** Reset the cached interpreter probe. Exported for tests only. */
export function _resetInterpreterCache(): void {
  // No-op kept for source-level compatibility with existing tests; the cache
  // now lives on the engine instance (see PythonEngine.constructor) and is
  // reset by constructing a fresh engine. (Audit A5.)
}
