import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { suggestTestFile, findPythonTestSelection } from '../test-file.js';

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
});
