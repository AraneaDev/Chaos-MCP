import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { findBunTestSelection } from '../core/related-tests.js';
import { buildBunRelatedCommand } from '../utils/shell-quote.js';

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'chaos-related-'));
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

/** Write one workspace file, creating its directory. */
function put(relPath: string, contents: string): void {
  const full = join(ws, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

describe('findBunTestSelection', () => {
  it('selects the test that imports the target directly', () => {
    put('src/resume.ts', 'export const run = () => 1;\n');
    put('test/resume.test.ts', "import { run } from '../src/resume.js';\nrun();\n");
    put('test/unrelated.test.ts', "import { x } from '../src/other.js';\nx;\n");
    put('src/other.ts', 'export const x = 2;\n');

    expect(findBunTestSelection('src/resume.ts', ws)).toEqual(['test/resume.test.ts']);
  });

  it('selects tests that reach the target through an intermediate module', () => {
    // The case that makes name-mapping wrong: nothing about `cli.test.ts` names
    // `resume`, yet a mutant in resume.ts can only be killed by it.
    put('src/resume.ts', 'export const run = () => 1;\n');
    put('src/cli.ts', "import { run } from './resume.js';\nexport const main = () => run();\n");
    put('test/cli.test.ts', "import { main } from '../src/cli.js';\nmain();\n");

    expect(findBunTestSelection('src/resume.ts', ws)).toEqual(['test/cli.test.ts']);
  });

  it('leaves out tests that cannot reach the target at all', () => {
    put('src/resume.ts', 'export const run = () => 1;\n');
    put('src/other.ts', 'export const x = 2;\n');
    put('test/resume.test.ts', "import { run } from '../src/resume.js';\nrun();\n");
    put('test/other.test.ts', "import { x } from '../src/other.js';\nx;\n");

    expect(findBunTestSelection('src/resume.ts', ws)).toEqual(['test/resume.test.ts']);
  });

  it('treats a test with an unresolvable import as related rather than dropping it', () => {
    // A specifier this module cannot follow might have been the edge to the
    // target. Running the test needlessly costs seconds; skipping it reports a
    // killed mutant as a survivor.
    put('src/resume.ts', 'export const run = () => 1;\n');
    put('test/resume.test.ts', "import { run } from '../src/resume.js';\nrun();\n");
    put('test/dynamic.test.ts', "const mod = await import('../src/generated/thing.js');\nmod;\n");

    expect(findBunTestSelection('src/resume.ts', ws)).toEqual([
      'test/dynamic.test.ts',
      'test/resume.test.ts',
    ]);
  });

  it('resolves a NodeNext .js specifier to the .ts file it was written for', () => {
    put('src/resume.ts', 'export const run = () => 1;\n');
    put('src/__tests__/resume.test.ts', "import { run } from '../resume.js';\nrun();\n");

    expect(findBunTestSelection('src/resume.ts', ws)).toEqual(['src/__tests__/resume.test.ts']);
  });

  it('resolves a directory import through its index file', () => {
    put('src/core/index.ts', "export { run } from './resume.js';\n");
    put('src/core/resume.ts', 'export const run = () => 1;\n');
    put('test/core.test.ts', "import { run } from '../src/core/index.js';\nrun();\n");

    expect(findBunTestSelection('src/core/resume.ts', ws)).toEqual(['test/core.test.ts']);
  });

  it('says "cannot tell" when the target is not a file in the workspace', () => {
    put('test/resume.test.ts', "import { run } from '../src/resume.js';\nrun();\n");
    expect(findBunTestSelection('src/resume.ts', ws)).toEqual([]);
  });

  it('says "cannot tell" when nothing reaches the target', () => {
    // An empty answer must never be read as "no tests cover this file": the
    // caller has to run everything, because the two are indistinguishable here.
    put('src/orphan.ts', 'export const y = 3;\n');
    put('test/other.test.ts', 'expect(1).toBe(1);\n');

    expect(findBunTestSelection('src/orphan.ts', ws)).toEqual([]);
  });

  it('does not descend into dependency or output directories', () => {
    put('src/resume.ts', 'export const run = () => 1;\n');
    put('test/resume.test.ts', "import { run } from '../src/resume.js';\nrun();\n");
    put('node_modules/pkg/index.test.ts', "import '../../src/resume.js';\n");
    put('coverage/report.test.ts', "import '../src/resume.js';\n");

    expect(findBunTestSelection('src/resume.ts', ws)).toEqual(['test/resume.test.ts']);
  });
});

describe('buildBunRelatedCommand', () => {
  it('runs exactly the selected files', () => {
    expect(buildBunRelatedCommand(['test/a.test.ts', 'test/b.test.ts'])).toBe(
      'bun test test/a.test.ts test/b.test.ts',
    );
  });

  it('falls back when the selection is empty', () => {
    expect(buildBunRelatedCommand([])).toBeUndefined();
  });

  it('falls back rather than emitting an unbounded command line', () => {
    const many = Array.from({ length: 65 }, (_, i) => `test/file-${i}.test.ts`);
    expect(buildBunRelatedCommand(many)).toBeUndefined();
  });

  it('quotes a path that would otherwise be split or reinterpreted', () => {
    expect(buildBunRelatedCommand(['test/a b.test.ts'])).toBe("bun test 'test/a b.test.ts'");
  });
});
