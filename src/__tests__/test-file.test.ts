import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { suggestTestFile, findPythonTestSelection, workspaceHasPythonTests } from '../test-file.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chaos-suggest-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('suggestTestFile', () => {
  it('returns an existing co-located TS test with exists:true', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), '');
    writeFileSync(join(root, 'src', 'math.test.ts'), '');
    expect(suggestTestFile('src/math.ts', 'typescript', root)).toEqual({
      path: 'src/math.test.ts',
      exists: true,
    });
  });

  it('falls back to the conventional candidate with exists:false', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), '');
    expect(suggestTestFile('src/math.ts', 'typescript', root)).toEqual({
      path: 'src/math.test.ts',
      exists: false,
    });
  });

  it('uses Python test_ convention and finds it under tests/', () => {
    mkdirSync(join(root, 'app'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'app', 'calc.py'), '');
    writeFileSync(join(root, 'tests', 'test_calc.py'), '');
    expect(suggestTestFile('app/calc.py', 'python', root)).toEqual({
      path: 'tests/test_calc.py',
      exists: true,
    });
  });

  // ── Unsupported project type → no candidates (kills `cands.length === 0`
  //    forced-false and the `default: return []` arm) ──
  it('returns undefined for an unsupported project type (empty candidate list)', () => {
    expect(suggestTestFile('src/x.cpp', 'unsupported' as never, root)).toBeUndefined();
  });

  // ── Root-level target: dirname is '.', so the leading './' must be stripped
  //    (kills the `.replace(/^\.\//, '')` string mutation). ──
  it('strips the leading "./" for a workspace-root file', () => {
    expect(suggestTestFile('math.ts', 'typescript', root)).toEqual({
      path: 'math.test.ts',
      exists: false,
    });
  });

  // ── Probe order: each later TS candidate must be reachable, which pins the
  //    exact '__tests__' / 'test' / 'tests' path segments (kills those string
  //    literal mutations on lines 21–23). ──
  it('falls through to the co-located .spec candidate', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), '');
    writeFileSync(join(root, 'src', 'math.spec.ts'), '');
    expect(suggestTestFile('src/math.ts', 'typescript', root)).toEqual({
      path: 'src/math.spec.ts',
      exists: true,
    });
  });

  it('falls through to the __tests__ sibling directory', () => {
    mkdirSync(join(root, 'src', '__tests__'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), '');
    writeFileSync(join(root, 'src', '__tests__', 'math.test.ts'), '');
    expect(suggestTestFile('src/math.ts', 'typescript', root)).toEqual({
      path: 'src/__tests__/math.test.ts',
      exists: true,
    });
  });

  it('falls through to a top-level test/ directory', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), '');
    writeFileSync(join(root, 'test', 'math.test.ts'), '');
    expect(suggestTestFile('src/math.ts', 'typescript', root)).toEqual({
      path: 'test/math.test.ts',
      exists: true,
    });
  });

  it('falls through to a top-level tests/ directory', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), '');
    writeFileSync(join(root, 'tests', 'math.test.ts'), '');
    expect(suggestTestFile('src/math.ts', 'typescript', root)).toEqual({
      path: 'tests/math.test.ts',
      exists: true,
    });
  });

  // ── Rust convention: the source file itself is candidate #1, with a
  //    tests/<base>.rs fallback (kills the rust case + array contents). ──
  it('suggests the Rust source file itself when it exists', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'lib.rs'), '');
    expect(suggestTestFile('src/lib.rs', 'rust', root)).toEqual({
      path: 'src/lib.rs',
      exists: true,
    });
  });

  it('falls back to tests/<base>.rs for Rust when the source file is absent', () => {
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'tests', 'lib.rs'), '');
    expect(suggestTestFile('src/lib.rs', 'rust', root)).toEqual({
      path: 'tests/lib.rs',
      exists: true,
    });
  });

  it('returns the first Rust candidate (the source file) with exists:false when nothing exists', () => {
    expect(suggestTestFile('src/lib.rs', 'rust', root)).toEqual({
      path: 'src/lib.rs',
      exists: false,
    });
  });

  // ── Defensive catch: a non-string target makes path.dirname throw inside
  //    candidates(); the catch must swallow it and return undefined (kills the
  //    emptied catch block on line 47). ──
  it('returns undefined when candidate computation throws', () => {
    expect(suggestTestFile(null as never, 'typescript', root)).toBeUndefined();
  });

  // ── Recursive discovery: fixed candidates miss nested layouts like
  //    tests/unit/<pkg>/<base>.test.ts; a bounded recursive hunt of the common
  //    test roots must find them and report exists:true. ──
  it('discovers a nested test under tests/unit/... via recursive search', () => {
    mkdirSync(join(root, 'src', 'utils'), { recursive: true });
    mkdirSync(join(root, 'tests', 'unit', 'utils'), { recursive: true });
    writeFileSync(join(root, 'src', 'utils', 'error-handler.ts'), '');
    writeFileSync(join(root, 'tests', 'unit', 'utils', 'error-handler.test.ts'), '');
    expect(suggestTestFile('src/utils/error-handler.ts', 'typescript', root)).toEqual({
      path: 'tests/unit/utils/error-handler.test.ts',
      exists: true,
    });
  });

  it('discovers a nested .spec test via recursive search', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'test', 'deep'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), '');
    writeFileSync(join(root, 'test', 'deep', 'math.spec.ts'), '');
    expect(suggestTestFile('src/math.ts', 'typescript', root)).toEqual({
      path: 'test/deep/math.spec.ts',
      exists: true,
    });
  });

  it('prefers the nested test sharing the most source directory segments', () => {
    mkdirSync(join(root, 'src', 'utils'), { recursive: true });
    mkdirSync(join(root, 'tests', 'unit', 'utils'), { recursive: true });
    mkdirSync(join(root, 'tests', 'unit', 'other'), { recursive: true });
    writeFileSync(join(root, 'src', 'utils', 'config.ts'), '');
    writeFileSync(join(root, 'tests', 'unit', 'other', 'config.test.ts'), '');
    writeFileSync(join(root, 'tests', 'unit', 'utils', 'config.test.ts'), '');
    expect(suggestTestFile('src/utils/config.ts', 'typescript', root)).toEqual({
      path: 'tests/unit/utils/config.test.ts',
      exists: true,
    });
  });

  it('prefers a nested .test match over a nested .spec match', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'tests', 'a'), { recursive: true });
    mkdirSync(join(root, 'tests', 'b'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), '');
    writeFileSync(join(root, 'tests', 'a', 'math.spec.ts'), '');
    writeFileSync(join(root, 'tests', 'b', 'math.test.ts'), '');
    expect(suggestTestFile('src/math.ts', 'typescript', root)).toEqual({
      path: 'tests/b/math.test.ts',
      exists: true,
    });
  });

  it('discovers a nested Python test module via recursive search', () => {
    mkdirSync(join(root, 'core'), { recursive: true });
    mkdirSync(join(root, 'tests', 'unit', 'core'), { recursive: true });
    writeFileSync(join(root, 'core', 'calc.py'), '');
    writeFileSync(join(root, 'tests', 'unit', 'core', 'test_calc.py'), '');
    expect(suggestTestFile('core/calc.py', 'python', root)).toEqual({
      path: 'tests/unit/core/test_calc.py',
      exists: true,
    });
  });

  it('ignores decoys inside node_modules during recursive search', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'tests', 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), '');
    writeFileSync(join(root, 'tests', 'node_modules', 'pkg', 'math.test.ts'), '');
    expect(suggestTestFile('src/math.ts', 'typescript', root)).toEqual({
      path: 'src/math.test.ts',
      exists: false,
    });
  });

  it('does not recursively hunt for Rust targets (in-file test convention)', () => {
    mkdirSync(join(root, 'tests', 'deep'), { recursive: true });
    writeFileSync(join(root, 'tests', 'deep', 'lib.rs'), '');
    expect(suggestTestFile('src/lib.rs', 'rust', root)).toEqual({
      path: 'src/lib.rs',
      exists: false,
    });
  });

  // ── The '.' search root must be skipped for a workspace-root target;
  //    otherwise the hunt would scan the whole workspace and surface tests
  //    from unrelated directories. ──
  it('does not scan the workspace root itself for a root-level target', () => {
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'math.ts'), '');
    writeFileSync(join(root, 'lib', 'math.test.ts'), '');
    expect(suggestTestFile('math.ts', 'typescript', root)).toEqual({
      path: 'math.test.ts',
      exists: false,
    });
  });

  // ── Tie-breaks: equal segment overlap → shorter path wins; equal length →
  //    lexicographic order wins (deterministic suggestions). ──
  it('prefers the shorter path when segment overlap ties', () => {
    mkdirSync(join(root, 'src', 'utils'), { recursive: true });
    mkdirSync(join(root, 'tests', 'aa', 'utils'), { recursive: true });
    mkdirSync(join(root, 'tests', 'bbbb', 'utils'), { recursive: true });
    writeFileSync(join(root, 'src', 'utils', 'config.ts'), '');
    writeFileSync(join(root, 'tests', 'aa', 'utils', 'config.test.ts'), '');
    writeFileSync(join(root, 'tests', 'bbbb', 'utils', 'config.test.ts'), '');
    expect(suggestTestFile('src/utils/config.ts', 'typescript', root)).toEqual({
      path: 'tests/aa/utils/config.test.ts',
      exists: true,
    });
  });

  it('prefers the lexicographically first path when overlap and length tie', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'tests', 'ab'), { recursive: true });
    mkdirSync(join(root, 'tests', 'aa'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), '');
    writeFileSync(join(root, 'tests', 'ab', 'math.test.ts'), '');
    writeFileSync(join(root, 'tests', 'aa', 'math.test.ts'), '');
    expect(suggestTestFile('src/math.ts', 'typescript', root)).toEqual({
      path: 'tests/aa/math.test.ts',
      exists: true,
    });
  });
});

describe('findPythonTestSelection', () => {
  it('finds the conventional module under a nested tests/ layout', () => {
    mkdirSync(join(root, 'core', 'auth'), { recursive: true });
    mkdirSync(join(root, 'tests', 'unit', 'core'), { recursive: true });
    writeFileSync(join(root, 'core', 'auth', 'secret_box.py'), '');
    writeFileSync(join(root, 'tests', 'unit', 'core', 'test_secret_box.py'), '');
    expect(findPythonTestSelection('core/auth/secret_box.py', root)).toEqual([
      'tests/unit/core/test_secret_box.py',
    ]);
  });

  it('includes a co-located test module and dedupes', () => {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'calc.py'), '');
    writeFileSync(join(root, 'pkg', 'test_calc.py'), '');
    expect(findPythonTestSelection('pkg/calc.py', root)).toEqual(['pkg/test_calc.py']);
  });

  it('returns [] when no matching test module exists (whole-suite fallback)', () => {
    mkdirSync(join(root, 'app'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'app', 'widget.py'), '');
    expect(findPythonTestSelection('app/widget.py', root)).toEqual([]);
  });

  it('skips venv/node_modules when searching tests/', () => {
    mkdirSync(join(root, 'tests', 'venv'), { recursive: true });
    mkdirSync(join(root, 'tests', 'unit'), { recursive: true });
    writeFileSync(join(root, 'mod.py'), '');
    // A decoy inside venv must be ignored; the real one under unit/ is found.
    writeFileSync(join(root, 'tests', 'venv', 'test_mod.py'), '');
    writeFileSync(join(root, 'tests', 'unit', 'test_mod.py'), '');
    expect(findPythonTestSelection('mod.py', root)).toEqual(['tests/unit/test_mod.py']);
  });

  it('does not recurse from a test_ source file name', () => {
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'tests', 'test_thing.py'), '');
    expect(findPythonTestSelection('tests/test_thing.py', root)).toEqual([]);
  });

  // ── collectByName bounds: the walk must stop at depth 8 and cap results
  //    at 16 so it stays cheap on pathological trees. ──
  it('finds a module at the deepest scanned level but not below the depth cap', () => {
    writeFileSync(join(root, 'mod.py'), '');
    // tests/ is scanned at depth 0; d2..d9 land at depths 1..8; d10 would be
    // entered at depth 9 and is pruned by the `depth > 8` guard.
    const nine = join(root, 'tests', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9');
    mkdirSync(join(nine, 'd10'), { recursive: true });
    writeFileSync(join(nine, 'test_mod.py'), '');
    expect(findPythonTestSelection('mod.py', root)).toEqual([
      'tests/d2/d3/d4/d5/d6/d7/d8/d9/test_mod.py',
    ]);
    rmSync(join(nine, 'test_mod.py'));
    writeFileSync(join(nine, 'd10', 'test_mod.py'), '');
    expect(findPythonTestSelection('mod.py', root)).toEqual([]);
  });

  it('caps recursive matches at 16 results', () => {
    writeFileSync(join(root, 'mod.py'), '');
    for (let i = 1; i <= 20; i++) {
      const dir = join(root, 'tests', `d${String(i).padStart(2, '0')}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'test_mod.py'), '');
    }
    expect(findPythonTestSelection('mod.py', root)).toHaveLength(16);
  });
});

describe('workspaceHasPythonTests', () => {
  it('returns false for a workspace with Python sources but no tests', () => {
    mkdirSync(join(root, 'workers', 'python', 'bin'), { recursive: true });
    writeFileSync(
      join(root, 'workers', 'python', 'bin', 'worker.py'),
      'def run():\n    return 1\n',
    );
    expect(workspaceHasPythonTests(root)).toBe(false);
  });

  it('finds test_*.py under a tests directory', () => {
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'tests', 'test_worker.py'), 'def test_x():\n    assert True\n');
    expect(workspaceHasPythonTests(root)).toBe(true);
  });

  it('finds a co-located *_test.py', () => {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'worker_test.py'), 'def test_x():\n    assert True\n');
    expect(workspaceHasPythonTests(root)).toBe(true);
  });

  it('ignores test files inside ignored directories', () => {
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'x', 'test_thing.py'),
      'def test_x():\n    assert True\n',
    );
    mkdirSync(join(root, '.venv', 'lib'), { recursive: true });
    writeFileSync(join(root, '.venv', 'lib', 'test_dep.py'), 'def test_x():\n    assert True\n');
    expect(workspaceHasPythonTests(root)).toBe(false);
  });
});
