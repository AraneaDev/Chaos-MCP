import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  suggestTestFile,
  findPythonTestSelection,
  workspaceHasPythonTests,
} from '../core/test-file.js';
import type { SupportedProjectType } from '../utils/project-detector.js';

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

  it('uses the PHPUnit <ClassName>Test.php convention for PHP', () => {
    // Infection drives PHPUnit, whose convention is a capitalised class name.
    // The co-located candidate keeps the file's own casing; the tests/ one is
    // capitalised, which is the only reason the two differ.
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'calculator.php'), '');
    expect(suggestTestFile('src/calculator.php', 'php', root)).toEqual({
      path: 'src/calculatorTest.php',
      exists: false,
    });
  });

  it('finds a capitalised PHP test under tests/ for a lowercase source file', () => {
    // `base.charAt(0).toUpperCase() + base.slice(1)` — every part of that
    // expression matters here: lowercasing it, dropping the charAt, or losing
    // the slice all produce a candidate path that does not exist, and the
    // suggestion silently degrades to "would create".
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'src', 'calculator.php'), '');
    writeFileSync(join(root, 'tests', 'CalculatorTest.php'), '');
    expect(suggestTestFile('src/calculator.php', 'php', root)).toEqual({
      path: 'tests/CalculatorTest.php',
      exists: true,
    });
  });

  it('survives a search root that is a FILE rather than a directory', () => {
    // A stray `tests` FILE at the workspace root passes the existsSync probe and
    // is handed to the recursive collector, where readdir throws ENOTDIR. The
    // collector's catch is the only thing between that and an unhandled
    // TypeError that takes the whole audit down.
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), '');
    writeFileSync(join(root, 'tests'), 'not a directory');

    expect(() => suggestTestFile('src/math.ts', 'typescript', root)).not.toThrow();
    expect(suggestTestFile('src/math.ts', 'typescript', root)).toEqual({
      path: 'src/math.test.ts',
      exists: false,
    });
  });

  it('prefers the shallower match when two found tests tie on directory overlap', () => {
    // The recursive name hunt can surface several same-named test files. They
    // are ranked by shared path segments first, then by path LENGTH — shorter
    // meaning closer to a conventional top-level location. Neither candidate
    // here shares a segment with `src/app`, so the length tie-break is the only
    // thing deciding, and `tests/b/...` must win over the longer `tests/aaa/...`
    // even though readdir yields `aaa` first.
    mkdirSync(join(root, 'src', 'app'), { recursive: true });
    mkdirSync(join(root, 'tests', 'aaa'), { recursive: true });
    mkdirSync(join(root, 'tests', 'b'), { recursive: true });
    writeFileSync(join(root, 'src', 'app', 'math.ts'), '');
    writeFileSync(join(root, 'tests', 'aaa', 'math.test.ts'), '');
    writeFileSync(join(root, 'tests', 'b', 'math.test.ts'), '');

    expect(suggestTestFile('src/app/math.ts', 'typescript', root)).toEqual({
      path: 'tests/b/math.test.ts',
      exists: true,
    });
  });

  it('lets directory overlap outrank a shorter path', () => {
    // Companion to the case above: overlap is the PRIMARY key, so a longer path
    // that shares a segment with the source directory still wins.
    mkdirSync(join(root, 'src', 'app'), { recursive: true });
    mkdirSync(join(root, 'tests', 'app'), { recursive: true });
    mkdirSync(join(root, 'tests', 'x'), { recursive: true });
    writeFileSync(join(root, 'src', 'app', 'math.ts'), '');
    writeFileSync(join(root, 'tests', 'app', 'math.test.ts'), '');
    writeFileSync(join(root, 'tests', 'x', 'math.test.ts'), '');

    expect(suggestTestFile('src/app/math.ts', 'typescript', root)).toEqual({
      path: 'tests/app/math.test.ts',
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

describe('suggestTestFile — search scope', () => {
  /**
   * Directory names the recursive hunt must never descend into. Each is a place
   * a same-named test file can plausibly appear as a COPY — a vendored package,
   * a build output, a coverage artefact — where returning it would point the
   * caller at a file they must not edit.
   */
  const SKIPPED = [
    'node_modules',
    '.git',
    '.venv',
    'venv',
    '__pycache__',
    'dist',
    'build',
    'coverage',
    'target',
    'vendor',
    '.stryker-tmp',
    '.chaos-mcp',
  ];

  it.each(SKIPPED)('never returns a test file found inside %s/', (skipped) => {
    mkdirSync(join(root, 'src', skipped), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), '');
    writeFileSync(join(root, 'src', skipped, 'math.test.ts'), '');

    expect(suggestTestFile('src/math.ts', 'typescript', root)).toEqual({
      path: 'src/math.test.ts',
      exists: false,
    });
  });

  it('hunts the top-level spec/ directory', () => {
    // `spec` is only reachable as a search ROOT — it is not among the fixed
    // candidate paths, so dropping it from the root list makes the file
    // invisible and the suggestion silently becomes "would create".
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'spec'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), '');
    writeFileSync(join(root, 'spec', 'math.test.ts'), '');

    expect(suggestTestFile('src/math.ts', 'typescript', root)).toEqual({
      path: 'spec/math.test.ts',
      exists: true,
    });
  });

  it('hunts a TOP-LEVEL __tests__ directory, not just the co-located one', () => {
    // The fixed candidates cover `src/__tests__/…`; the top-level one exists
    // only in the search-root list.
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '__tests__'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), '');
    writeFileSync(join(root, '__tests__', 'math.test.ts'), '');

    expect(suggestTestFile('src/math.ts', 'typescript', root)).toEqual({
      path: '__tests__/math.test.ts',
      exists: true,
    });
  });

  it("searches the target's TOP-LEVEL segment, not only its own directory", () => {
    // For `src/app/math.ts` the roots include both `src/app` and `src`. The
    // sibling `src/other/…` is reachable only through the latter, which comes
    // from splitting the path on '/' — split on anything else and the segment
    // is a single character that matches no directory.
    mkdirSync(join(root, 'src', 'app'), { recursive: true });
    mkdirSync(join(root, 'src', 'other'), { recursive: true });
    writeFileSync(join(root, 'src', 'app', 'math.ts'), '');
    writeFileSync(join(root, 'src', 'other', 'math.test.ts'), '');

    expect(suggestTestFile('src/app/math.ts', 'typescript', root)).toEqual({
      path: 'src/other/math.test.ts',
      exists: true,
    });
  });

  it('never suggests the tests/ DIRECTORY itself when no PHP test file matches', () => {
    // The third PHP candidate is `tests/<base>Test.php`. Lose the filename half
    // and the candidate collapses to `tests/`, which existsSync happily confirms
    // — so the caller is handed a directory as the file to go and edit.
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'src', 'calculator.php'), '');

    expect(suggestTestFile('src/calculator.php', 'php', root)).toEqual({
      path: 'src/calculatorTest.php',
      exists: false,
    });
  });

  it('prefers the co-located __tests__ candidate over a top-level tests/ one', () => {
    // Candidate ORDER is the contract: `src/__tests__/math.test.ts` is checked
    // before `tests/math.test.ts`, so with both present the co-located one wins.
    mkdirSync(join(root, 'src', '__tests__'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), '');
    writeFileSync(join(root, 'src', '__tests__', 'math.test.ts'), '');
    writeFileSync(join(root, 'tests', 'math.test.ts'), '');

    expect(suggestTestFile('src/math.ts', 'typescript', root)).toEqual({
      path: 'src/__tests__/math.test.ts',
      exists: true,
    });
  });

  it('prefers a top-level test/ candidate over tests/', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.ts'), '');
    writeFileSync(join(root, 'test', 'math.test.ts'), '');
    writeFileSync(join(root, 'tests', 'math.test.ts'), '');

    expect(suggestTestFile('src/math.ts', 'typescript', root)).toEqual({
      path: 'test/math.test.ts',
      exists: true,
    });
  });
});

describe('findPythonTestSelection — self-selection guard', () => {
  it('returns nothing for a target that is itself a test file', () => {
    // Without the `test_` guard the scoping becomes `test_test_foo.py` — a real
    // file in suites that mirror their own layout — so auditing a test file
    // would silently mutate it against a DIFFERENT test file's assertions.
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'tests', 'test_foo.py'), '');
    writeFileSync(join(root, 'tests', 'test_test_foo.py'), '');

    expect(findPythonTestSelection('tests/test_foo.py', root)).toEqual([]);
  });

  it('returns no selection, and does not throw, for a non-string target', () => {
    // `extname`/`basename` throw a TypeError on a non-string, and this runs on
    // an untyped MCP payload. The guard must degrade to "no scoping" — falling
    // back to the whole suite — rather than returning a bogus selection that
    // cosmic-ray would then be told to run.
    expect(findPythonTestSelection(null as unknown as string, root)).toEqual([]);
    expect(findPythonTestSelection(42 as unknown as string, root)).toEqual([]);
  });

  it('looks under tests/, not at the workspace root, for the second probe', () => {
    // The two fixed probes are `<dir>/test_x.py` and `tests/test_x.py`. Blank
    // the `tests` half and the second probe points at the workspace ROOT, so an
    // unrelated top-level `test_x.py` would be handed to cosmic-ray as the
    // scoped suite for `app/x.py`.
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'app', 'x.py'), '');
    writeFileSync(join(root, 'test_x.py'), '');

    expect(findPythonTestSelection('app/x.py', root)).toEqual([]);
  });

  it('still scopes an ordinary module whose name merely contains "test"', () => {
    // The guard is a PREFIX check: `latest.py` and `contest.py` are production
    // modules, not test files, and must still get a selection.
    mkdirSync(join(root, 'app'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'app', 'latest.py'), '');
    writeFileSync(join(root, 'tests', 'test_latest.py'), '');

    expect(findPythonTestSelection('app/latest.py', root)).toEqual(['tests/test_latest.py']);
  });
});

describe('workspaceHasPythonTests', () => {
  it('returns false for a workspace with Python sources but no tests', () => {
    mkdirSync(join(root, 'workers', 'python', 'bin'), { recursive: true });
    writeFileSync(
      join(root, 'workers', 'python', 'bin', 'worker.py'),
      'def run():\n    return 1\n',
    );
    expect(workspaceHasPythonTests(root)).toEqual({ found: false, depthLimited: false });
  });

  it('finds test_*.py under a tests directory', () => {
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'tests', 'test_worker.py'), 'def test_x():\n    assert True\n');
    expect(workspaceHasPythonTests(root)).toEqual({ found: true, depthLimited: false });
  });

  it('finds a co-located *_test.py', () => {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'worker_test.py'), 'def test_x():\n    assert True\n');
    expect(workspaceHasPythonTests(root)).toEqual({ found: true, depthLimited: false });
  });

  it('finds a test file deeper than the old 6-level bound', () => {
    // 10 levels down: a realistic deep monorepo layout that the previous cap
    // reported as "no tests at all".
    const deep = join(root, ...Array.from({ length: 10 }, (_, i) => `lvl${i}`));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'test_deep.py'), 'def test_x():\n    assert True\n');
    expect(workspaceHasPythonTests(root)).toEqual({ found: true, depthLimited: false });
  });

  /** Directories the Python scan must not descend into. */
  const PY_IGNORED = [
    'node_modules',
    '.git',
    '.venv',
    'venv',
    '__pycache__',
    'build',
    'dist',
    '.tox',
    'site-packages',
  ];

  it.each(PY_IGNORED)('does not count a test file inside %s/ as project tests', (ignored) => {
    // These hold installed or generated copies of OTHER projects' tests. Counting
    // one makes an untested project look tested, and the Python pre-flight then
    // reads pytest's exit-5 ("no tests collected") as a broken suite instead.
    mkdirSync(join(root, ignored), { recursive: true });
    writeFileSync(join(root, ignored, 'test_vendored.py'), 'def test_x():\n    assert True\n');

    expect(workspaceHasPythonTests(root)).toEqual({ found: false, depthLimited: false });
  });

  it('does not descend into hidden directories', () => {
    // `entry.name.startsWith('.')` — as `endsWith('.')` no hidden directory is
    // ever skipped, and caches like `.pytest_cache` start counting as tests.
    mkdirSync(join(root, '.hidden'), { recursive: true });
    writeFileSync(join(root, '.hidden', 'test_x.py'), 'def test_x():\n    assert True\n');

    expect(workspaceHasPythonTests(root)).toEqual({ found: false, depthLimited: false });
  });

  it('requires the .py extension, not merely a test_ prefix', () => {
    // `name.endsWith('.py') && …` — blank the extension and `endsWith('')` is
    // always true, so `test_data.json` or `test_fixture.txt` counts as a test.
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'tests', 'test_fixture.txt'), 'not python');
    writeFileSync(join(root, 'tests', 'test_data.json'), '{}');

    expect(workspaceHasPythonTests(root)).toEqual({ found: false, depthLimited: false });
  });

  it('still reaches a test file sitting exactly ON the depth bound', () => {
    // Boundary: the walk aborts at `depth > maxDepth`, so depth === maxDepth is
    // the last level it may still read. With `>=` the bound loses a level and a
    // project whose tests live at exactly that depth reports "no tests" — which
    // the Python pre-flight turns into a refusal to audit at all.
    mkdirSync(join(root, 'a'), { recursive: true });
    writeFileSync(join(root, 'a', 'test_edge.py'), 'def test_x():\n    assert True\n');
    expect(workspaceHasPythonTests(root, 1)).toEqual({ found: true, depthLimited: false });
  });

  it('reports not-found (not found) when the root cannot be read at all', () => {
    // A workspace root that is a FILE makes readdir throw. That must read as
    // "no tests seen", never as "tests found" — the caller uses this to decide
    // whether a pytest exit-5 means a broken suite or an empty one.
    const notADir = join(root, 'a-file');
    writeFileSync(notADir, 'x');
    expect(workspaceHasPythonTests(notADir)).toEqual({ found: false, depthLimited: false });
  });

  it('reports depthLimited when the walk is cut off before exhausting the tree', () => {
    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'test_deep.py'), 'def test_x():\n    assert True\n');
    // Tree is deeper than the bound and holds no shallower test: inconclusive.
    expect(workspaceHasPythonTests(root, 1)).toEqual({ found: false, depthLimited: true });
    // Tree fully walked and still nothing: conclusive.
    rmSync(join(deep, 'test_deep.py'));
    expect(workspaceHasPythonTests(root)).toEqual({ found: false, depthLimited: false });
  });

  it('ignores test files inside ignored directories', () => {
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'x', 'test_thing.py'),
      'def test_x():\n    assert True\n',
    );
    mkdirSync(join(root, '.venv', 'lib'), { recursive: true });
    writeFileSync(join(root, '.venv', 'lib', 'test_dep.py'), 'def test_x():\n    assert True\n');
    expect(workspaceHasPythonTests(root)).toEqual({ found: false, depthLimited: false });
  });
});

describe('suggestTestFile — per-language coverage (audit F15)', () => {
  const SUPPORTED: SupportedProjectType[] = ['typescript', 'python', 'rust', 'php'];

  it.each(SUPPORTED)('produces a "would create" suggestion for %s', (projectType) => {
    // The switch behind this used to fall through to `return []` for anything it
    // did not recognise, so a newly supported language silently lost its
    // suggestion. A `never` guard now makes that a compile error; this pins the
    // runtime half — every supported language must yield a non-empty path.
    const ext = { typescript: 'ts', python: 'py', rust: 'rs', php: 'php' }[projectType];
    const suggestion = suggestTestFile(`src/widget.${ext}`, projectType, root);
    expect(suggestion).toBeDefined();
    expect(suggestion?.path).not.toBe('');
    expect(suggestion?.exists).toBe(false);
  });
});
