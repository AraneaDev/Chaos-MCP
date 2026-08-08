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
