import { describe, it, expect } from 'vitest';
import { resolveTestCommand } from '../engines/python/interpreter.js';

/**
 * cosmic-ray 8.4.6 runs `test-command` as `subprocess.run(shlex.split(cmd))`.
 * An unquoted path with whitespace is therefore split into two argv entries,
 * and one containing a quote character makes shlex.split raise — which
 * cosmic-ray records as `incompetent` for every mutant. Both inputs arrive from
 * the AUDITED repository via findPythonTestSelection, so neither is under this
 * server's control.
 */
describe('resolveTestCommand: selection quoting', () => {
  it('quotes a path containing a space so it survives shlex splitting', () => {
    const cmd = resolveTestCommand('python3', {
      pythonTestSelection: ['tests/my dir/test_a.py'],
    });
    expect(cmd).toBe("python3 -m pytest -x -q 'tests/my dir/test_a.py'");
  });

  it('escapes an embedded single quote rather than unbalancing the command', () => {
    const cmd = resolveTestCommand('python3', {
      pythonTestSelection: ["tests/john's/test_a.py"],
    });
    expect(cmd).toBe("python3 -m pytest -x -q 'tests/john'\\''s/test_a.py'");
  });

  it('leaves an ordinary path unquoted', () => {
    const cmd = resolveTestCommand('python3', {
      pythonTestSelection: ['tests/test_a.py', 'tests/test_b.py'],
    });
    expect(cmd).toBe('python3 -m pytest -x -q tests/test_a.py tests/test_b.py');
  });

  it('quotes operator-supplied selections too', () => {
    const cmd = resolveTestCommand('python3', {
      testRunner: 'pytest',
      pythonTestSelection: ['-m', 'not slow and not flaky'],
    });
    expect(cmd).toBe("python3 -m pytest -x -q -m 'not slow and not flaky'");
  });
});

/**
 * The interpreter is the FIRST token of the same string, and it needs the same
 * treatment for a different `shlex` reason. `shlex.split` is POSIX, so an
 * unquoted backslash is the escape character and is consumed:
 *
 *   >>> shlex.split(r'C:\Python312\python.exe -m pytest')
 *   ['C:Python312python.exe', '-m', 'pytest']
 *
 * ABSOLUTE_INTERPRETER_RE deliberately accepts that Windows form (its docblock
 * names it), so the value reaching cosmic-ray was a path that does not exist —
 * the interpreter cannot start and every mutant is recorded incompetent.
 * "One argv token" was the property the regex guaranteed; "one INTACT argv
 * token" was not.
 */
describe('resolveTestCommand: interpreter quoting', () => {
  it('quotes a Windows interpreter path so shlex cannot eat its separators', () => {
    const cmd = resolveTestCommand('C:\\Python312\\python.exe');
    expect(cmd).toBe("'C:\\Python312\\python.exe' -m pytest -x -q");
  });

  it('quotes it on the unittest base command too', () => {
    // Both bases interpolate the interpreter; quoting one and not the other
    // would leave the defect reachable through `testRunner: 'unittest'`.
    const cmd = resolveTestCommand('C:\\Python312\\python.exe', { testRunner: 'unittest' });
    expect(cmd).toBe("'C:\\Python312\\python.exe' -m unittest");
  });

  it('leaves a POSIX interpreter path and a bare name untouched', () => {
    // quoteCommandArg's safe class covers `/`, letters, digits and `._-`, so
    // the overwhelmingly common forms are byte-for-byte what they were.
    expect(resolveTestCommand('/opt/venv/bin/python3.12')).toBe(
      '/opt/venv/bin/python3.12 -m pytest -x -q',
    );
    expect(resolveTestCommand('python3')).toBe('python3 -m pytest -x -q');
  });

  it('does not quote a custom runner string, which is a whole command', () => {
    // The custom-runner branch replaces the base outright; the interpreter is
    // not part of it, so quoting must not leak into it and break the argv.
    expect(
      resolveTestCommand('C:\\Python312\\python.exe', {
        testRunner: 'python -m pytest --no-cov',
        testRunnerTrusted: true,
      }),
    ).toBe('python -m pytest --no-cov');
  });
});
