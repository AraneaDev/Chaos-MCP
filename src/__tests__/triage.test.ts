import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { MutationResult } from '../engines/base.js';
import {
  isSupportedSourceFile,
  discoverFiles,
  rankResults,
  formatTriageAsJson,
  formatTriageAsText,
} from '../triage.js';

const mr = (over: Partial<MutationResult>): MutationResult => ({
  target: 'f',
  totalMutants: 10,
  killed: 8,
  survived: 2,
  mutationScore: '80.00%',
  vulnerabilities: [],
  ...over,
});

describe('isSupportedSourceFile', () => {
  it('accepts supported extensions', () => {
    for (const f of ['a.ts', 'a.js', 'a.tsx', 'a.jsx', 'a.py', 'a.go', 'a.rs']) {
      expect(isSupportedSourceFile(f)).toBe(true);
    }
  });
  it('rejects unsupported extensions and test files', () => {
    for (const f of ['a.md', 'a.test.ts', 'a.spec.js', 'x_test.go', 'test_x.py', 'x_test.rs']) {
      expect(isSupportedSourceFile(f)).toBe(false);
    }
  });
});

describe('rankResults', () => {
  it('ranks weakest-first: score asc, then survived desc, then file asc', () => {
    const rows = rankResults([
      { file: 'b.ts', result: mr({ mutationScore: '80.00%', survived: 2 }) },
      { file: 'a.ts', result: mr({ mutationScore: '50.00%', survived: 5 }) },
      { file: 'c.ts', result: mr({ mutationScore: '80.00%', survived: 9 }) },
    ]);
    expect(rows.map((r) => r.file)).toEqual(['a.ts', 'c.ts', 'b.ts']);
  });

  it('derives noCoverage = vulnerabilities.length - survived (clamped >= 0)', () => {
    const [row] = rankResults([
      {
        file: 'a.ts',
        result: mr({
          survived: 1,
          vulnerabilities: [
            { line: 1, mutator: 'M', description: 'no test reached' },
            { line: 2, mutator: 'M', description: 'survived' },
            { line: 3, mutator: 'M', description: 'survived' },
          ],
        }),
      },
    ]);
    expect(row.noCoverage).toBe(2);
  });
});

describe('formatTriageAsJson', () => {
  it('emits the triage shape with summary, ranking, errors', () => {
    const rows = rankResults([{ file: 'a.ts', result: mr({}) }]);
    const json = JSON.parse(formatTriageAsJson(rows, [{ file: 'b.ts', error: 'boom' }], 3, 1));
    expect(json.mode).toBe('triage');
    expect(json.summary).toEqual({
      filesDiscovered: 3,
      filesAudited: 1,
      filesSkipped: 1,
      filesErrored: 1,
    });
    expect(json.ranking[0].file).toBe('a.ts');
    expect(json.errors).toEqual([{ file: 'b.ts', error: 'boom' }]);
    expect(json.note).toContain('weakest-first');
    expect(json.note).toContain('skipped');
  });

  it('emits an empty-discovery note when nothing was found', () => {
    const json = JSON.parse(formatTriageAsJson([], [], 0, 0));
    expect(json.ranking).toEqual([]);
    expect(json.note).toContain('No supported source files');
  });
});

describe('formatTriageAsJson note branch', () => {
  it('omits the maxFiles truncation note when skipped=0', () => {
    // Kills: ConditionalExpression on `skipped > 0` ternary (line 122).
    const rows = rankResults([{ file: 'a.ts', result: mr({}) }]);
    const json = JSON.parse(formatTriageAsJson(rows, [], 2, 0));
    expect(json.note).not.toContain('skipped by maxFiles');
    expect(json.note).toContain('weakest-first');
  });
});

describe('formatTriageAsText', () => {
  it('includes a ranked line and an errors section', () => {
    const rows = rankResults([
      { file: 'a.ts', result: mr({ mutationScore: '50.00%', survived: 5 }) },
    ]);
    const text = formatTriageAsText(rows, [{ file: 'b.ts', error: 'boom' }], 2, 0);
    expect(text).toContain('Chaos-MCP Triage');
    expect(text).toContain('a.ts');
    expect(text).toContain('50.00%');
    expect(text).toContain('Errors:');
    expect(text).toContain('b.ts: boom');
  });

  it('appends a skipped count when skipped > 0', () => {
    // Kills: ConditionalExpression/EqualityOperator on `skipped > 0` (line 160).
    const rows = rankResults([{ file: 'a.ts', result: mr({}) }]);
    const text = formatTriageAsText(rows, [], 3, 2);
    expect(text).toContain('(2 skipped)');
  });

  it('omits the skipped count when skipped = 0', () => {
    // Companion assertion for the skipped > 0 branch.
    const rows = rankResults([{ file: 'a.ts', result: mr({}) }]);
    const text = formatTriageAsText(rows, [], 1, 0);
    expect(text).not.toContain('skipped');
  });

  it('shows no-source-files message when discovered = 0', () => {
    // Kills: no-coverage on else-if (discovered === 0) block (line 167).
    const text = formatTriageAsText([], [], 0, 0);
    expect(text).toContain('No supported source files');
    expect(text).not.toContain('Weakest first');
  });

  it('shows no ranking header or errors section when rows and errors are empty but files were discovered', () => {
    // Kills: ConditionalExpression on `rows.length > 0` (line 162) and
    // `errors.length > 0` (line 170).
    const text = formatTriageAsText([], [], 2, 0);
    expect(text).not.toContain('Weakest first');
    expect(text).not.toContain('Errors:');
    expect(text).not.toContain('No supported source files');
  });
});

describe('discoverFiles (real temp tree)', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'chaos-triage-'));
    mkdirSync(join(root, 'sub'));
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, '__tests__'));
    writeFileSync(join(root, 'a.ts'), '');
    writeFileSync(join(root, 'b.py'), '');
    writeFileSync(join(root, 'a.test.ts'), '');
    writeFileSync(join(root, 'readme.md'), '');
    writeFileSync(join(root, 'sub', 'c.go'), '');
    writeFileSync(join(root, 'node_modules', 'd.ts'), '');
    writeFileSync(join(root, '__tests__', 'e.ts'), '');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('recurses a directory, keeping supported non-test source files', () => {
    const { files, discovered, skipped } = discoverFiles(['.'], root, 25);
    expect(files.sort()).toEqual(['a.ts', 'b.py', 'sub/c.go'].sort());
    expect(discovered).toBe(3);
    expect(skipped).toBe(0);
  });

  it('passes through explicit files and dedupes against a directory', () => {
    const { files } = discoverFiles(['a.ts', '.'], root, 25);
    expect(files.filter((f) => f === 'a.ts')).toHaveLength(1);
  });

  it('caps at maxFiles and reports skipped', () => {
    const { files, discovered, skipped } = discoverFiles(['.'], root, 2);
    expect(files).toHaveLength(2);
    expect(discovered).toBe(3);
    expect(skipped).toBe(1);
  });

  it('collects an explicit file path (not a directory)', () => {
    // Covers readdirSyncIsDir returning false for a file and the else-branch
    // collecting it. Kills: BooleanLiteral (return false→true) at line 65,
    // ConditionalExpression (readdirSyncIsDir branch) at line 81,
    // BlockStatement (else body) at line 83.
    const { files, discovered, skipped } = discoverFiles(['a.ts'], root, 25);
    expect(files).toEqual(['a.ts']);
    expect(discovered).toBe(1);
    expect(skipped).toBe(0);
  });

  it('rejects an explicit non-source file path', () => {
    // Covers isSupportedSourceFile(rel) guard in else-branch (line 85).
    const { files } = discoverFiles(['readme.md'], root, 25);
    expect(files).toHaveLength(0);
  });

  it('returns files in sorted order (not insertion order)', () => {
    // Contract: discoverFiles guarantees sorted output. (Note: on this filesystem
    // readdirSync already returns sorted entries, so this asserts the contract
    // rather than exercising the .sort() call specifically.)
    const { files } = discoverFiles(['.'], root, 25);
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
  });
});
