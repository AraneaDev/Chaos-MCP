import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { MutationResult } from '../engines/base.js';
import {
  isSupportedSourceFile,
  discoverFiles,
  discoverChangedFiles,
  rankResults,
  formatTriageAsJson,
  formatTriageAsText,
  buildTriagePayload,
  type TriageRow,
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

  it('anchors the `_test.<lang>` / `test_*.py` rules to the file extension end', () => {
    // `_test.go` / `.py` only mark a test when they are the actual extension.
    // Removing the trailing `$` would wrongly flag these as tests.
    expect(isSupportedSourceFile('a_test.go.ts')).toBe(true);
    expect(isSupportedSourceFile('test_x.py.ts')).toBe(true);
  });

  it('matches multi-character python test stems (kills `[^/]*`→`[^/]`)', () => {
    // `test_xy.py` needs the `*` quantifier to span more than one stem char.
    expect(isSupportedSourceFile('test_xy.py')).toBe(false);
    expect(isSupportedSourceFile('dir/test_helpers.py')).toBe(false);
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
    // Kills: ConditionalExpression on `skipped > 0` ternary (line 122) and the
    // drill-down StringLiteral (line 125) by pinning the exact note text — the
    // empty truncation branch must contribute nothing.
    const rows = rankResults([{ file: 'a.ts', result: mr({}) }]);
    const json = JSON.parse(formatTriageAsJson(rows, [], 2, 0));
    expect(json.note).toBe(
      'Ranked weakest-first by mutation score. ' +
        'Drill into a file with audit_code_resilience for survivor detail.',
    );
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
    // Pin the ranked-section header (line 163) and the '\n' line join (line 174).
    expect(text).toContain('Weakest first (score  survived/total  file):');
    expect(text.split('\n').length).toBeGreaterThan(1);
  });

  it('appends a skipped count when skipped > 0', () => {
    // Kills: ConditionalExpression/EqualityOperator on `skipped > 0` (line 160).
    const rows = rankResults([{ file: 'a.ts', result: mr({}) }]);
    const text = formatTriageAsText(rows, [], 3, 2);
    expect(text).toContain('(2 skipped)');
  });

  it('omits the skipped count when skipped = 0', () => {
    // Companion assertion for the skipped > 0 branch. Pin the exact header line
    // so the empty ternary branch (line 160) can't smuggle in extra text.
    const rows = rankResults([{ file: 'a.ts', result: mr({}) }]);
    const text = formatTriageAsText(rows, [], 1, 0);
    expect(text).not.toContain('skipped');
    expect(text.split('\n')[0]).toBe('Chaos-MCP Triage: 1 of 1 files audited');
  });

  it('shows no-source-files message when discovered = 0', () => {
    // Kills: no-coverage on else-if (discovered === 0) block (line 167).
    const text = formatTriageAsText([], [], 0, 0);
    expect(text).toContain('No supported source files');
    expect(text).not.toContain('Weakest first');
  });

  it('shows a diff-mode empty message when scopeNote is set and discovered = 0', () => {
    // Kills the `scopeNote ?` ternary in the empty-discovery branch: the diff-mode
    // note must differ from the paths-mode one so they can be distinguished.
    const text = formatTriageAsText([], [], 0, 0, 'Scoped to files changed vs main.');
    expect(text).toContain('diff base');
    expect(text).not.toContain('given paths');
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
    // Explicit paths given in reverse order must come back sorted — this drives
    // the `.sort()` call directly (kills MethodExpression removing .sort(), line 88).
    const { files } = discoverFiles(['b.py', 'a.ts'], root, 25);
    expect(files).toEqual(['a.ts', 'b.py']);
  });
});

describe('discoverFiles ignores build/output/test directories', () => {
  let root: string;
  const IGNORED = ['build', 'dist', '.git', 'coverage', '.stryker-tmp', 'reports', 'tests'];
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'chaos-triage-ignore-'));
    writeFileSync(join(root, 'keep.ts'), '');
    for (const d of IGNORED) {
      mkdirSync(join(root, d));
      writeFileSync(join(root, d, 'x.ts'), '');
    }
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('skips every IGNORE_DIRS directory, keeping only the root source file', () => {
    // Each ignored dir name is a distinct StringLiteral in IGNORE_DIRS (lines 22-29);
    // blanking any one of them would let that dir's x.ts leak into the result.
    const { files } = discoverFiles(['.'], root, 25);
    expect(files).toEqual(['keep.ts']);
  });
});

describe('discoverFiles skips non-file directory entries', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'chaos-triage-symlink-'));
    writeFileSync(join(root, 'real.ts'), '');
    // A symlink's Dirent reports isFile() === false (and isSymbolicLink() === true),
    // so walk's `else if (entry.isFile())` must skip it. Forcing that guard to `true`
    // (line 52 mutant) would wrongly collect the link.
    symlinkSync(join(root, 'real.ts'), join(root, 'link.ts'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('does not collect a symlink even when it points at a supported source file', () => {
    const { files } = discoverFiles(['.'], root, 25);
    expect(files).toEqual(['real.ts']);
    expect(files).not.toContain('link.ts');
  });
});

describe('discoverChangedFiles', () => {
  const changed = ['src/a.ts', 'src/util/b.ts', 'README.md', 'src/a.test.ts', 'pkg/c.go'];

  it('keeps only supported non-test source files', () => {
    const r = discoverChangedFiles(changed, undefined, 25);
    expect(r.files).toEqual(['pkg/c.go', 'src/a.ts', 'src/util/b.ts']);
    expect(r.discovered).toBe(3);
    expect(r.skipped).toBe(0);
  });

  it('intersects with paths prefixes when provided', () => {
    const r = discoverChangedFiles(changed, ['src/util'], 25);
    expect(r.files).toEqual(['src/util/b.ts']);
  });

  it('caps at maxFiles and reports skipped', () => {
    const r = discoverChangedFiles(changed, undefined, 1);
    expect(r.files).toEqual(['pkg/c.go']);
    expect(r.discovered).toBe(3);
    expect(r.skipped).toBe(2);
  });
});

describe('buildTriagePayload', () => {
  it('assembles summary + ranking + note', () => {
    const rows = [
      { file: 'a.ts', mutationScore: '50.00%', total: 4, killed: 2, survived: 2, noCoverage: 0 },
    ];
    const p = buildTriagePayload(rows, [], 1, 0);
    expect(p.mode).toBe('triage');
    expect(p.summary).toEqual({
      filesDiscovered: 1,
      filesAudited: 1,
      filesSkipped: 0,
      filesErrored: 0,
    });
    expect(p.ranking).toEqual(rows);
    expect(typeof p.note).toBe('string');
  });

  it('includes scopeNote when provided', () => {
    const p = buildTriagePayload([], [], 0, 0, 'diff vs main');
    expect(p.scopeNote).toBe('diff vs main');
  });

  it('emits a diffBase-specific note when scopeNote is set and discovered=0', () => {
    // Kills the `diffMode` → false branch: the scopeNote truthy path must yield
    // the diff-specific message, not the paths-mode one.
    const p = buildTriagePayload([], [], 0, 0, 'Scoped to files changed vs main.');
    expect(p.note).toContain('diff base');
    expect(p.note).not.toContain('given paths');
  });

  it('emits the paths-mode note when no scopeNote and discovered=0', () => {
    // Companion assertion: without a scopeNote the paths-mode message must appear.
    const p = buildTriagePayload([], [], 0, 0);
    expect(p.note).toContain('given paths');
    expect(p.note).not.toContain('diff base');
  });
});

describe('buildTriagePayload gate computation', () => {
  it('computes a gate over ranked rows when minScore is given', () => {
    const rows = [
      { file: 'a.ts', mutationScore: '90.00%', total: 10, killed: 9, survived: 1, noCoverage: 0 },
      { file: 'b.ts', mutationScore: '50.00%', total: 10, killed: 5, survived: 5, noCoverage: 0 },
    ];
    const payload = buildTriagePayload(rows, [], 2, 0, undefined, 80);
    expect(payload.gate).toEqual({ minScore: 80, passed: false, failingFiles: ['b.ts'] });
    expect(payload.ranking.find((r) => r.file === 'a.ts')?.passed).toBe(true);
    expect(payload.ranking.find((r) => r.file === 'b.ts')?.passed).toBe(false);
  });

  it('omits gate when minScore is absent', () => {
    const payload = buildTriagePayload(
      [{ file: 'a.ts', mutationScore: '90.00%', total: 1, killed: 1, survived: 0, noCoverage: 0 }],
      [],
      1,
      0,
    );
    expect(payload.gate).toBeUndefined();
  });

  it('gate passes when all rows meet the threshold', () => {
    const rows = [
      { file: 'a.ts', mutationScore: '90.00%', total: 10, killed: 9, survived: 1, noCoverage: 0 },
      { file: 'b.ts', mutationScore: '85.00%', total: 10, killed: 8, survived: 2, noCoverage: 0 },
    ];
    const payload = buildTriagePayload(rows, [], 2, 0, undefined, 80);
    expect(payload.gate).toEqual({ minScore: 80, passed: true, failingFiles: [] });
    expect(payload.ranking.every((r) => r.passed === true)).toBe(true);
  });

  it('failingFiles are sorted alphabetically', () => {
    const rows = [
      { file: 'z.ts', mutationScore: '10.00%', total: 10, killed: 1, survived: 9, noCoverage: 0 },
      { file: 'a.ts', mutationScore: '20.00%', total: 10, killed: 2, survived: 8, noCoverage: 0 },
    ];
    const payload = buildTriagePayload(rows, [], 2, 0, undefined, 80);
    expect(payload.gate?.failingFiles).toEqual(['a.ts', 'z.ts']);
  });

  it('appends an errored-files note to the gate note when errors are present', () => {
    const rows = [
      { file: 'a.ts', mutationScore: '90.00%', total: 10, killed: 9, survived: 1, noCoverage: 0 },
    ];
    const payload = buildTriagePayload(
      rows,
      [{ file: 'b.ts', error: 'boom' }],
      2,
      0,
      undefined,
      80,
    );
    expect(payload.note).toContain('errored');
    expect(payload.note).toContain('1');
  });
});

describe('TriageRow optional runId and suppressedCount fields', () => {
  it('carries runId and suppressedCount through buildTriagePayload into ranking', () => {
    // RED: TriageRow lacks runId/suppressedCount; payload omits them.
    // GREEN: after adding the fields to the interface and wiring in triage-handler.
    const row: TriageRow = {
      file: 'a.ts',
      mutationScore: '50.00%',
      total: 4,
      killed: 2,
      survived: 2,
      noCoverage: 0,
      runId: 'deadbeef',
      suppressedCount: 1,
    };
    const payload = buildTriagePayload([row], [], 1, 0);
    expect(payload.ranking[0].runId).toBe('deadbeef');
    expect(payload.ranking[0].suppressedCount).toBe(1);
  });

  it('omits suppressedCount from ranking when not set', () => {
    // Confirms suppressedCount is truly optional (undefined rows still round-trip cleanly).
    const row: TriageRow = {
      file: 'b.ts',
      mutationScore: '75.00%',
      total: 4,
      killed: 3,
      survived: 1,
      noCoverage: 0,
    };
    const payload = buildTriagePayload([row], [], 1, 0);
    expect(payload.ranking[0].suppressedCount).toBeUndefined();
    expect(payload.ranking[0].runId).toBeUndefined();
  });
});
