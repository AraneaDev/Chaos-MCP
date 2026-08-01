import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { MutationResult } from '../engines/base.js';
import {
  isSupportedSourceFile,
  discoverFiles,
  discoverChangedFiles,
} from '../triage/discover-files.js';
import {
  rankResults,
  compareTriageRows,
  formatTriageAsJson,
  formatTriageAsText,
  buildTriagePayload,
  type TriageRow,
  type TriageError,
} from '../core/triage.js';
import { supportedSourceExtensions, detectProjectType } from '../utils/project-detector.js';

const mr = (over: Partial<MutationResult>): MutationResult => ({
  target: 'f',
  totalMutants: 10,
  killed: 8,
  survived: 2,
  mutationScore: '80.00%',
  vulnerabilities: [],
  ...over,
});

/**
 * Text-render helper keeping the loose-argument call style these tests were
 * written with.
 *
 * `formatTriageAsText` now takes the whole `TriagePayload` instead of six
 * positional arguments: the old signature had no way to express the gate
 * verdict, so `outputFormat: 'text'` silently dropped it (audit M-gateText).
 * Routing through `buildTriagePayload` is also what the handler does, so these
 * assertions now cover the real production path rather than a parallel one.
 */
const textOf = (
  rows: TriageRow[],
  errors: TriageError[] = [],
  discovered = rows.length,
  skipped = 0,
  scopeNote?: string,
  unaudited: string[] = [],
  minScore?: number,
): string =>
  formatTriageAsText(
    buildTriagePayload(rows, errors, discovered, skipped, scopeNote, minScore, unaudited),
  );

describe('isSupportedSourceFile', () => {
  it('accepts supported extensions', () => {
    for (const f of ['a.ts', 'a.js', 'a.tsx', 'a.jsx', 'a.py', 'a.rs']) {
      expect(isSupportedSourceFile(f)).toBe(true);
    }
  });
  it('anchors the PHPUnit `Test.php` rule to the END of the path', () => {
    // Without the `$`, any path merely CONTAINING "Test.php" is misread as a
    // test file and silently dropped from the triage — so a production source
    // file would never be audited and nothing would say why.
    expect(isSupportedSourceFile('src/FooTest.phpunit.php')).toBe(true);
    expect(isSupportedSourceFile('src/FooTest.php')).toBe(false);
  });

  it('rejects unsupported extensions and test files', () => {
    for (const f of ['a.md', 'a.test.ts', 'a.spec.js', 'test_x.py', 'x_test.rs']) {
      expect(isSupportedSourceFile(f)).toBe(false);
    }
  });

  it('anchors the `_test.<lang>` / `test_*.py` rules to the file extension end', () => {
    // `_test.rs` / `test_*.py` only mark a test when they are the actual extension.
    // Removing the trailing `$` would wrongly flag these as tests.
    expect(isSupportedSourceFile('a_test.rs.ts')).toBe(true);
    expect(isSupportedSourceFile('test_x.py.ts')).toBe(true);
  });

  it('matches multi-character python test stems (kills `[^/]*`→`[^/]`)', () => {
    // `test_xy.py` needs the `*` quantifier to span more than one stem char.
    expect(isSupportedSourceFile('test_xy.py')).toBe(false);
    expect(isSupportedSourceFile('dir/test_helpers.py')).toBe(false);
  });

  it('discovers every extension the detection registry supports (audit F15)', () => {
    // Discovery used to work off a hand-copied extension array, so a newly
    // supported language was invisible to triage with no compile error to say
    // so — the tool just returned an empty leaderboard. It now derives from the
    // same registry the engines do, and this asserts the two agree.
    const exts = supportedSourceExtensions();
    expect(exts).toEqual([
      '.ts',
      '.js',
      '.tsx',
      '.jsx',
      '.mjs',
      '.cjs',
      '.mts',
      '.cts',
      '.py',
      '.rs',
      '.php',
    ]);
    for (const ext of exts) {
      expect(isSupportedSourceFile(`src/widget${ext}`)).toBe(true);
    }
  });

  it('discovers exactly what an audit accepts, for any path', () => {
    // The structural guarantee that replaces the old hand-kept list: discovery
    // and `audit_code_resilience` now ask `detectProjectType` the same
    // question, so neither can advertise a file the other refuses. Includes the
    // ESM/CJS variants, which used to be auditable but undiscoverable.
    const names = [
      'src/a.ts',
      'src/a.mts',
      'src/a.cts',
      'src/a.mjs',
      'src/a.cjs',
      'src/a.jsx',
      'src/a.py',
      'src/a.rs',
      'src/a.php',
      'src/a.go',
      'src/a.md',
      'README',
    ];
    const auditable = names.map((n) => detectProjectType(n) !== 'unsupported');
    const discoverable = names.map((n) => isSupportedSourceFile(n));
    expect(discoverable).toEqual(auditable);
  });

  it('does not widen discovery beyond the registry', () => {
    // `.mjs` used to be in this list, which encoded the bug as intent: it IS in
    // the registry (`matches` accepts it), so refusing to discover it made
    // triage disagree with the audit tool about which files exist.
    for (const ext of ['.go', '.rb', '.java', '.md']) {
      expect(isSupportedSourceFile(`src/widget${ext}`)).toBe(false);
    }
  });
});

describe('rankResults — partial-audit fields', () => {
  it('carries the partial flag and batch counts onto the row', () => {
    // A row scored from only some of its batches describes a fraction of the
    // file. `complete: false` is what makes it fail a gate and what the text
    // report prints as "(partial: x/y batches)"; without the counts the caller
    // cannot tell a nearly-finished audit from one that barely started.
    const [row] = rankResults([
      {
        file: 'a.ts',
        result: mr({ complete: false, batchesCompleted: 2, batchesPlanned: 5 }),
      },
    ]);
    expect(row.complete).toBe(false);
    expect(row.batchesCompleted).toBe(2);
    expect(row.batchesPlanned).toBe(5);
  });

  it('leaves the partial fields off a complete result entirely', () => {
    // Not `complete: undefined`: the gate reads `r.complete !== false`, and the
    // row is serialised into the response, so an invented key changes the shape
    // every consumer sees.
    const [row] = rankResults([{ file: 'a.ts', result: mr({}) }]);
    expect(Object.keys(row)).not.toContain('complete');
    expect(Object.keys(row)).not.toContain('batchesCompleted');
    expect(Object.keys(row)).not.toContain('batchesPlanned');
  });

  it('records the partial flag even when the engine reported no batch counts', () => {
    // Non-StrykerJS engines mark a run partial without batching it, so the
    // counts are genuinely absent — and must stay absent rather than becoming
    // `undefined` keys next to a real `complete: false`.
    const [row] = rankResults([{ file: 'a.ts', result: mr({ complete: false }) }]);
    expect(row.complete).toBe(false);
    expect(Object.keys(row)).not.toContain('batchesCompleted');
    expect(Object.keys(row)).not.toContain('batchesPlanned');
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

  it('substitutes "n/a" and flags noMutableLogic for a zero-mutant file (audit M3)', () => {
    const [row] = rankResults([
      {
        file: 'a.ts',
        // No mutable logic: zero mutants, no scope note. A raw "100.00%" would
        // rank it as "safest" indistinguishably from a genuine perfect score.
        result: mr({ totalMutants: 0, killed: 0, survived: 0, mutationScore: '100.00%' }),
      },
    ]);
    expect(row.mutationScore).toBe('n/a');
    expect(row.noMutableLogic).toBe(true);
  });

  it('does NOT substitute "n/a" when a zero-mutant result carries a scopeNote', () => {
    const [row] = rankResults([
      {
        file: 'a.ts',
        result: mr({ totalMutants: 0, mutationScore: '100.00%', scopeNote: 'no changed lines' }),
      },
    ]);
    // A scoped zero (e.g. diff no-change) is a real run, left as-is.
    expect(row.mutationScore).toBe('100.00%');
    expect(row.noMutableLogic).toBeUndefined();
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
    const text = textOf(rows, [{ file: 'b.ts', error: 'boom' }], 2, 0);
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
    const text = textOf(rows, [], 3, 2);
    expect(text).toContain('(2 skipped)');
  });

  it('omits the skipped count when skipped = 0', () => {
    // Companion assertion for the skipped > 0 branch. Pin the exact header line
    // so the empty ternary branch (line 160) can't smuggle in extra text.
    const rows = rankResults([{ file: 'a.ts', result: mr({}) }]);
    const text = textOf(rows, [], 1, 0);
    expect(text).not.toContain('skipped');
    expect(text.split('\n')[0]).toBe('Chaos-MCP Triage: 1 of 1 files audited');
  });

  it('shows no-source-files message when discovered = 0', () => {
    // Kills: no-coverage on else-if (discovered === 0) block (line 167).
    const text = textOf([], [], 0, 0);
    expect(text).toContain('No supported source files');
    expect(text).not.toContain('Weakest first');
  });

  it('shows a diff-mode empty message when scopeNote is set and discovered = 0', () => {
    // Kills the `scopeNote ?` ternary in the empty-discovery branch: the diff-mode
    // note must differ from the paths-mode one so they can be distinguished.
    const text = textOf([], [], 0, 0, 'Scoped to files changed vs main.');
    expect(text).toContain('diff base');
    expect(text).not.toContain('given paths');
  });

  it('prints the scope note as its own line, and prints nothing when there is none', () => {
    // The truthiness guard is all that stops `lines.push(undefined)` — which
    // `join('\n')` renders as a literal "undefined" line in the report.
    const rows = rankResults([{ file: 'a.ts', result: mr({}) }]);
    const scoped = textOf(rows, [], 1, 0, 'Scoped to files changed vs main.');
    expect(scoped.split('\n')[1]).toBe('Scoped to files changed vs main.');

    const plain = textOf(rows, [], 1, 0);
    expect(plain).not.toContain('undefined');
    expect(plain.split('\n')[1]).toBe('Weakest first (score  survived/total  file):');
  });

  it('marks a partially-audited row inline, and leaves a complete row unmarked', () => {
    // A partial row's score describes only part of the file. Tagging every row
    // as partial is just as wrong as tagging none: both make the marker useless
    // for telling the two apart.
    const partialRow = {
      file: 'partial.ts',
      mutationScore: '80.00%',
      total: 10,
      killed: 8,
      survived: 2,
      noCoverage: 0,
      complete: false as const,
      batchesCompleted: 2,
      batchesPlanned: 5,
    };
    const completeRow = {
      file: 'complete.ts',
      mutationScore: '90.00%',
      total: 10,
      killed: 9,
      survived: 1,
      noCoverage: 0,
    };
    const text = textOf([partialRow, completeRow], [], 2, 0);
    const line = (file: string) => text.split('\n').find((l) => l.includes(file)) ?? '';
    expect(line('partial.ts')).toBe('  80.00%  2/10  partial.ts  (partial: 2/5 batches)');
    // Exact, not `not.toContain('partial')`: the empty else-branch must append
    // NOTHING, and any other suffix would still pass a substring check.
    expect(line('complete.ts')).toBe('  90.00%  1/10  complete.ts');
  });

  it('renders "?" for batch counts an engine did not report', () => {
    // Non-StrykerJS engines mark a run partial without batching it. Blanking
    // the `?` fallback yields "(partial: / batches)", which reads as a
    // formatting bug rather than as missing information.
    const row = {
      file: 'partial.ts',
      mutationScore: '80.00%',
      total: 10,
      killed: 8,
      survived: 2,
      noCoverage: 0,
      complete: false as const,
    };
    expect(textOf([row], [], 1, 0)).toContain('(partial: ?/? batches)');
  });

  it('omits the unaudited section when nothing was left unaudited', () => {
    const rows = rankResults([{ file: 'a.ts', result: mr({}) }]);
    expect(textOf(rows, [], 1, 0)).not.toContain('Not audited');
  });

  it('shows no ranking header or errors section when rows and errors are empty but files were discovered', () => {
    // Kills: ConditionalExpression on `rows.length > 0` (line 162) and
    // `errors.length > 0` (line 170).
    const text = textOf([], [], 2, 0);
    expect(text).not.toContain('Weakest first');
    expect(text).not.toContain('Errors:');
    expect(text).not.toContain('No supported source files');
  });
});

/**
 * Audit M-gateText: `buildTriagePayload` computed `gate` (and, after Wave 1, its
 * `reason` and `notGraded` counts) and `structuredContent` carried all of it —
 * but the TEXT renderer never mentioned the threshold, the verdict, or the
 * failing files. A caller who passed `outputFormat: 'text'` alongside `minScore`
 * got an ordinary weakest-first table back with no indication that a gate had
 * been requested, let alone that it had FAILED. `outputFormat` is a rendering
 * choice, not a feature toggle.
 *
 * The verdict is rendered on the FIRST line, above the banner and the table: a
 * sweep ranks up to 25 files, and a verdict below that table is one a human
 * scrolling — or an agent reading a truncated content block — can miss.
 */
describe('formatTriageAsText — gate verdict', () => {
  const row = (file: string, mutationScore: string): TriageRow => ({
    file,
    mutationScore,
    total: 10,
    killed: 8,
    survived: 2,
    noCoverage: 0,
  });

  it('renders nothing about a gate when no minScore was supplied', () => {
    // The no-gate output must stay byte-identical to the pre-fix rendering:
    // adding an unconditional "Gate:" line would be its own defect.
    const text = textOf([row('a.ts', '50.00%')], [], 1, 0);
    expect(text).not.toContain('Gate');
    expect(text.split('\n')[0]).toBe('Chaos-MCP Triage: 1 of 1 files audited');
  });

  it('announces a passing gate with its threshold', () => {
    const text = textOf([row('a.ts', '90.00%')], [], 1, 0, undefined, [], 80);
    expect(text.split('\n')[0]).toBe('Gate: passed (minScore 80)');
  });

  it('puts a FAILED verdict on the first line, with the threshold and the failing files', () => {
    const rows = [row('a.ts', '50.00%'), row('b.ts', '60.00%')];
    const text = textOf(rows, [], 2, 0, undefined, [], 80);
    expect(text.split('\n')[0]).toBe(
      'Gate: FAILED (minScore 80) — 2 file(s) below threshold: a.ts, b.ts',
    );
    // Above the banner AND above the table: the point of the fix is that it
    // cannot be buried under a long leaderboard.
    expect(text.indexOf('Gate: FAILED')).toBeLessThan(text.indexOf('Chaos-MCP Triage'));
    expect(text.indexOf('Gate: FAILED')).toBeLessThan(text.indexOf('Weakest first'));
  });

  it('distinguishes "not graded" from "below threshold" when every score passed', () => {
    // Wave 1's fail-closed rule: errored / never-audited files fail the gate even
    // though no score is under the threshold. Without the "0 below threshold"
    // clause that verdict reads as a bug in the gate rather than as an
    // incomplete sweep.
    const text = textOf(
      [row('a.ts', '100.00%')],
      [{ file: 'b.ts', error: 'boom' }],
      3,
      0,
      undefined,
      ['c.ts'],
      80,
    );
    expect(text.split('\n')[0]).toBe(
      'Gate: FAILED (minScore 80) — 0 below threshold, but 2 file(s) were not graded ' +
        '(1 errored, 1 unaudited)',
    );
  });

  it('reports the ungraded count alongside failing scores when both are present', () => {
    // `below_threshold` wins the headline (it is the actionable cause) but the
    // ungraded files must not vanish from the line — they are the other half of
    // why CI is red.
    const text = textOf(
      [row('a.ts', '10.00%')],
      [{ file: 'b.ts', error: 'boom' }],
      2,
      0,
      undefined,
      [],
      80,
    );
    expect(text.split('\n')[0]).toBe(
      'Gate: FAILED (minScore 80) — 1 file(s) below threshold: a.ts; ' +
        '1 file(s) were not graded (1 errored, 0 unaudited)',
    );
  });

  it('omits the ungraded clause entirely when every selected file was graded', () => {
    // Companion to the test above: the empty branch must contribute NOTHING, or
    // every failing gate carries a noisy "0 file(s) were not graded" tail.
    const text = textOf([row('a.ts', '10.00%')], [], 1, 0, undefined, [], 80);
    expect(text.split('\n')[0]).toBe(
      'Gate: FAILED (minScore 80) — 1 file(s) below threshold: a.ts',
    );
  });

  it('caps the inline failing-file list and says how many more there are', () => {
    // A default sweep is 25 files; an all-failing run would otherwise emit one
    // unreadable 25-name line. The overflow is still in gate.failingFiles and in
    // the table below.
    const rows = Array.from({ length: 12 }, (_, i) => row(`f${i}.ts`, '10.00%'));
    const text = textOf(rows, [], 12, 0, undefined, [], 80);
    const first = text.split('\n')[0];
    expect(first).toContain('12 file(s) below threshold');
    expect(first).toContain('+2 more');
    // failingFiles is sorted lexicographically, so the two dropped names are
    // f8/f9 (f10 and f11 sort before f2).
    expect(first).not.toContain('f8.ts');
    expect(first).not.toContain('f9.ts');
    expect(first).toContain('f0.ts');
  });

  it('renders the same verdict the JSON payload carries', () => {
    // The renderer must PROJECT the payload's gate, never recompute it — that is
    // how text and JSON are kept from disagreeing about whether CI should be red.
    const payload = buildTriagePayload([row('a.ts', '50.00%')], [], 1, 0, undefined, 80);
    const text = formatTriageAsText(payload);
    expect(payload.gate?.passed).toBe(false);
    expect(text).toContain('FAILED');
    expect(text).toContain(String(payload.gate?.minScore));
    for (const f of payload.gate?.failingFiles ?? []) expect(text).toContain(f);
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
    writeFileSync(join(root, 'sub', 'c.rs'), '');
    writeFileSync(join(root, 'node_modules', 'd.ts'), '');
    writeFileSync(join(root, '__tests__', 'e.ts'), '');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('recurses a directory, keeping supported non-test source files', () => {
    const { files, discovered, skipped } = discoverFiles(['.'], root, 25);
    expect(files.sort()).toEqual(['a.ts', 'b.py', 'sub/c.rs'].sort());
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

describe('discoverFiles ignores third-party dependency directories', () => {
  let root: string;
  // Every one of these sorts BEFORE "src/", so before they were ignored a
  // maxFiles cap could be spent entirely on vendored code and rank none of the
  // caller's own files.
  const VENDORED = ['vendor', 'target', '.venv', 'venv', 'env', '__pycache__', '.tox', 'out'];
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'chaos-triage-vendor-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'app.py'), '');
    for (const d of VENDORED) {
      mkdirSync(join(root, d));
      writeFileSync(join(root, d, 'dep.py'), '');
    }
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('discovers only the caller source file, never a vendored one', () => {
    const { files, discovered } = discoverFiles(['.'], root, 25);
    expect(files).toEqual(['src/app.py']);
    expect(discovered).toBe(1);
  });

  it('does not fill the maxFiles budget with vendored files', () => {
    // With a cap of 1 and lexicographic sorting, ".tox/dep.py" would win over
    // "src/app.py" if these directories were still walked.
    expect(discoverFiles(['.'], root, 1).files).toEqual(['src/app.py']);
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
  const changed = ['src/a.ts', 'src/util/b.ts', 'README.md', 'src/a.test.ts', 'pkg/c.rs'];

  it('keeps only supported non-test source files', () => {
    const r = discoverChangedFiles(changed, undefined, 25);
    expect(r.files).toEqual(['pkg/c.rs', 'src/a.ts', 'src/util/b.ts']);
    expect(r.discovered).toBe(3);
    expect(r.skipped).toBe(0);
  });

  it('intersects with paths prefixes when provided', () => {
    const r = discoverChangedFiles(changed, ['src/util'], 25);
    expect(r.files).toEqual(['src/util/b.ts']);
  });

  it('caps at maxFiles and reports skipped', () => {
    const r = discoverChangedFiles(changed, undefined, 1);
    expect(r.files).toEqual(['pkg/c.rs']);
    expect(r.discovered).toBe(3);
    expect(r.skipped).toBe(2);
  });

  it('treats an EMPTY paths array as "no filter", exactly like omitting it', () => {
    // `!paths || paths.length === 0`. Without the length half, an empty array
    // reaches `[].some(...)` — which is always false — and every changed file is
    // silently filtered out, so a diff-scoped triage reports nothing to audit.
    const r = discoverChangedFiles(changed, [], 25);
    expect(r.files).toEqual(['pkg/c.rs', 'src/a.ts', 'src/util/b.ts']);
  });

  it('matches a path given as the file itself, not only as a directory prefix', () => {
    // `rel === norm || rel.startsWith(norm + '/')`. Callers routinely pass an
    // exact file path; with only the prefix half, `src/a.ts` never matches
    // `src/a.ts` (it would need to be `src/a.ts/…`) and the file is dropped.
    expect(discoverChangedFiles(changed, ['src/a.ts'], 25).files).toEqual(['src/a.ts']);
  });

  it('ignores a trailing slash on a directory path', () => {
    expect(discoverChangedFiles(changed, ['src/util/'], 25).files).toEqual(['src/util/b.ts']);
    expect(discoverChangedFiles(changed, ['src/util///'], 25).files).toEqual(['src/util/b.ts']);
  });

  it('keeps a file matching ANY of several paths, not only files matching all', () => {
    // `paths.some(...)`. As `.every(...)` a file would have to live under every
    // path at once — impossible for two disjoint directories — so a multi-path
    // triage would return nothing at all. With a single path the two are
    // indistinguishable, which is why every existing case missed it.
    const r = discoverChangedFiles(changed, ['src/util', 'pkg'], 25);
    expect(r.files).toEqual(['pkg/c.rs', 'src/util/b.ts']);
  });

  it('does not treat a path as a prefix of a longer sibling directory', () => {
    // `src/uti` must not match `src/util/b.ts` — the `/` in the prefix check is
    // what stops a partial segment from matching.
    expect(discoverChangedFiles(changed, ['src/uti'], 25).files).toEqual([]);
  });

  it('accepts a "./"-prefixed path, exactly as the non-diff branch does', () => {
    // `discoverFiles` resolves paths against the workspace root, so "./src"
    // works there. Here the raw string was compared against git's "src/foo.ts"
    // and matched nothing — the sweep reported "no changed files found" with
    // full confidence. Both spellings must select the same files.
    const root = process.cwd();
    expect(discoverChangedFiles(changed, ['./src'], 25, root).files).toEqual([
      'src/a.ts',
      'src/util/b.ts',
    ]);
    expect(discoverChangedFiles(changed, ['src/'], 25, root).files).toEqual([
      'src/a.ts',
      'src/util/b.ts',
    ]);
    expect(discoverChangedFiles(changed, ['./src/util/'], 25, root).files).toEqual([
      'src/util/b.ts',
    ]);
  });

  it('treats an absolute path inside the workspace as its relative form', () => {
    const root = process.cwd();
    expect(discoverChangedFiles(changed, [join(root, 'src', 'util')], 25, root).files).toEqual([
      'src/util/b.ts',
    ]);
  });

  it('treats "." as the workspace root, matching everything', () => {
    // "." normalises to the empty relative path; that must read as "no filter"
    // rather than as a path nothing can start with.
    expect(discoverChangedFiles(changed, ['.'], 25, process.cwd()).files).toEqual([
      'pkg/c.rs',
      'src/a.ts',
      'src/util/b.ts',
    ]);
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

  it('omits the scopeNote key entirely when there is no scope note', () => {
    // Not `scopeNote: undefined`. The payload is returned as structuredContent,
    // where a key that is present-but-undefined is a different shape than one
    // that was never set — and `toEqual` cannot tell them apart.
    expect(Object.keys(buildTriagePayload([], [], 0, 0))).not.toContain('scopeNote');
  });

  it('omits the unaudited fields when every discovered file was audited', () => {
    const rows = [
      { file: 'a.ts', mutationScore: '90.00%', total: 10, killed: 9, survived: 1, noCoverage: 0 },
    ];
    const p = buildTriagePayload(rows, [], 1, 0);
    expect(p.note).not.toContain('time budget ran out');
    expect(Object.keys(p)).not.toContain('unaudited');
    expect(Object.keys(p)).not.toContain('stoppedReason');
    expect(Object.keys(p.summary)).not.toContain('filesUnaudited');
  });
});

describe('buildTriagePayload gate computation', () => {
  it('adds no caveat notes when nothing errored and nothing was partial', () => {
    // Both caveats are appended to the SAME note string, so an always-true guard
    // on either one produces a report that claims files were skipped or
    // truncated when they were not — and the operator goes looking for them.
    const rows = [
      { file: 'a.ts', mutationScore: '90.00%', total: 10, killed: 9, survived: 1, noCoverage: 0 },
    ];
    const p = buildTriagePayload(rows, [], 1, 0, undefined, 80);
    expect(p.note).not.toContain('errored and are not graded');
    expect(p.note).not.toContain('partially');
  });

  it('computes a gate over ranked rows when minScore is given', () => {
    const rows = [
      { file: 'a.ts', mutationScore: '90.00%', total: 10, killed: 9, survived: 1, noCoverage: 0 },
      { file: 'b.ts', mutationScore: '50.00%', total: 10, killed: 5, survived: 5, noCoverage: 0 },
    ];
    const payload = buildTriagePayload(rows, [], 2, 0, undefined, 80);
    expect(payload.gate).toEqual({
      minScore: 80,
      passed: false,
      failingFiles: ['b.ts'],
      reason: 'below_threshold',
      notGraded: { errored: 0, unaudited: 0 },
    });
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
    expect(payload.ranking[0].passed).toBeUndefined();
  });

  it('gate passes when all rows meet the threshold', () => {
    const rows = [
      { file: 'a.ts', mutationScore: '90.00%', total: 10, killed: 9, survived: 1, noCoverage: 0 },
      { file: 'b.ts', mutationScore: '85.00%', total: 10, killed: 8, survived: 2, noCoverage: 0 },
    ];
    const payload = buildTriagePayload(rows, [], 2, 0, undefined, 80);
    expect(payload.gate).toEqual({
      minScore: 80,
      passed: true,
      failingFiles: [],
      notGraded: { errored: 0, unaudited: 0 },
    });
    // `reason` is absent, not present-and-undefined: the payload is returned as
    // structuredContent, where the two are different shapes.
    expect(Object.keys(payload.gate ?? {})).not.toContain('reason');
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
    // An errored file was never measured, so the sweep is incomplete and the
    // gate fails closed — but the file is not listed as failing a threshold it
    // was never graded against.
    expect(payload.gate?.passed).toBe(false);
    expect(payload.gate?.failingFiles).not.toContain('b.ts');
  });
});

/**
 * The gate is what a CI step keys on, so it must describe the WHOLE sweep.
 * `rows` covers only the files that produced a score; grading on that subset
 * alone let a run go green while files errored or were never audited at all.
 */
describe('buildTriagePayload gate fails closed over ungraded files', () => {
  const passing = (file: string): TriageRow => ({
    file,
    mutationScore: '90.00%',
    total: 10,
    killed: 9,
    survived: 1,
    noCoverage: 0,
  });

  it('fails the gate when a file was never audited, even though every graded row passed', () => {
    const p = buildTriagePayload([passing('a.ts')], [], 2, 0, undefined, 80, ['b.ts']);
    expect(p.gate?.passed).toBe(false);
    expect(p.gate?.reason).toBe('files_not_graded');
    expect(p.gate?.notGraded).toEqual({ errored: 0, unaudited: 1 });
    // The unaudited file failed no threshold — it has no score at all.
    expect(p.gate?.failingFiles).toEqual([]);
    expect(p.note).toContain('never audited');
  });

  it('fails the gate when a file errored, even though every graded row passed', () => {
    const p = buildTriagePayload(
      [passing('a.ts')],
      [{ file: 'b.ts', error: 'boom' }],
      2,
      0,
      undefined,
      80,
    );
    expect(p.gate?.passed).toBe(false);
    expect(p.gate?.reason).toBe('files_not_graded');
    expect(p.gate?.notGraded).toEqual({ errored: 1, unaudited: 0 });
    expect(p.gate?.failingFiles).toEqual([]);
  });

  it('passes the gate only when every discovered file was audited and met the threshold', () => {
    const p = buildTriagePayload([passing('a.ts'), passing('b.ts')], [], 2, 0, undefined, 80);
    expect(p.gate?.passed).toBe(true);
    expect(p.gate?.reason).toBeUndefined();
    expect(p.gate?.notGraded).toEqual({ errored: 0, unaudited: 0 });
  });

  it('reports below_threshold rather than files_not_graded when both are true', () => {
    // A real failing score is the more actionable of the two reasons.
    const rows = [
      { file: 'a.ts', mutationScore: '10.00%', total: 10, killed: 1, survived: 9, noCoverage: 0 },
    ];
    const p = buildTriagePayload(rows, [{ file: 'b.ts', error: 'boom' }], 3, 0, undefined, 80, [
      'c.ts',
    ]);
    expect(p.gate?.reason).toBe('below_threshold');
    expect(p.gate?.notGraded).toEqual({ errored: 1, unaudited: 1 });
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

/**
 * A triage row's score is only as meaningful as the audit behind it. Two
 * things used to be invisible in the leaderboard: a file audited only
 * partially (time budget exhausted mid-batch), and a file never audited at all.
 * Both let the ranking read as covering more than it did — and the first also
 * passed the gate on a fraction of a file.
 */
describe('buildTriagePayload — partial and unaudited files', () => {
  const row = (over: Partial<TriageRow> = {}): TriageRow => ({
    file: 'src/a.ts',
    mutationScore: '100.00%',
    total: 10,
    killed: 10,
    survived: 0,
    noCoverage: 0,
    ...over,
  });

  it('fails the gate for a partially-audited file despite a perfect score', () => {
    const p = buildTriagePayload([row({ complete: false })], [], 1, 0, undefined, 80);
    expect(p.gate?.passed).toBe(false);
    expect(p.gate?.failingFiles).toEqual(['src/a.ts']);
    expect(p.ranking[0].passed).toBe(false);
  });

  it('passes the gate for the same score when the audit was complete', () => {
    const p = buildTriagePayload([row()], [], 1, 0, undefined, 80);
    expect(p.gate?.passed).toBe(true);
  });

  it('says in the note how many files were only partially audited', () => {
    const p = buildTriagePayload([row({ complete: false })], [], 1, 0, undefined, 80);
    expect(p.note).toContain('partially');
  });

  it('reports files the time budget never reached, separately from errors', () => {
    const p = buildTriagePayload([row()], [], 3, 0, undefined, undefined, ['src/b.ts', 'src/c.ts']);
    expect(p.unaudited).toEqual(['src/b.ts', 'src/c.ts']);
    expect(p.summary.filesUnaudited).toBe(2);
    expect(p.summary.filesErrored).toBe(0);
    expect(p.stoppedReason).toBe('time_budget_exhausted');
    expect(p.note).toContain('time budget');
  });

  it('omits the unaudited fields entirely when everything was audited', () => {
    const p = buildTriagePayload([row()], [], 1, 0);
    expect(p).not.toHaveProperty('unaudited');
    expect(p).not.toHaveProperty('stoppedReason');
    expect(p.summary.filesUnaudited).toBeUndefined();
  });

  it('marks a partial row inline in the text output', () => {
    const text = textOf(
      [row({ complete: false, batchesCompleted: 2, batchesPlanned: 7 })],
      [],
      1,
      0,
    );
    expect(text).toContain('partial: 2/7 batches');
  });

  it('lists unaudited files in the text output', () => {
    const text = textOf([row()], [], 2, 0, undefined, ['src/b.ts']);
    expect(text).toContain('Not audited');
    expect(text).toContain('src/b.ts');
  });
});

/**
 * `walk` builds candidate paths with `relative()`, which yields BACKslashes on
 * Windows — so the `(^|/)test_*.py` alternative never matched a nested pytest
 * module and triage audited test files as though they were source.
 */
describe('isSupportedSourceFile — separators and case', () => {
  it('recognises a nested pytest module written with either separator', () => {
    expect(isSupportedSourceFile('pkg/test_math.py')).toBe(false);
    expect(isSupportedSourceFile('pkg\\test_math.py')).toBe(false);
  });

  it('still accepts ordinary sources under either separator', () => {
    expect(isSupportedSourceFile('pkg/math.py')).toBe(true);
    expect(isSupportedSourceFile('pkg\\math.py')).toBe(true);
  });

  it('accepts uppercase extensions (case-insensitive filesystems)', () => {
    expect(isSupportedSourceFile('src/Main.RS')).toBe(true);
    expect(isSupportedSourceFile('src/Foo.PHP')).toBe(true);
  });

  it('still rejects genuinely unsupported extensions', () => {
    expect(isSupportedSourceFile('README.md')).toBe(false);
  });
});

describe('compareTriageRows', () => {
  const row = (over: Partial<TriageRow>): TriageRow => ({
    file: 'f',
    mutationScore: '80.00%',
    total: 10,
    killed: 8,
    survived: 2,
    noCoverage: 0,
    ...over,
  });

  it('orders by score ascending — the weakest file first', () => {
    expect(
      compareTriageRows(row({ mutationScore: '40.00%' }), row({ mutationScore: '90.00%' })),
    ).toBeLessThan(0);
    expect(
      compareTriageRows(row({ mutationScore: '90.00%' }), row({ mutationScore: '40.00%' })),
    ).toBeGreaterThan(0);
  });

  it('breaks a score tie by survivor count descending', () => {
    // Same score, more uncaught mutants ⇒ ranked worse. A mutant that flips this
    // subtraction to `a.survived - b.survived` would bury the file with the most
    // holes at the bottom of the leaderboard.
    expect(compareTriageRows(row({ survived: 9 }), row({ survived: 1 }))).toBeLessThan(0);
    expect(compareTriageRows(row({ survived: 1 }), row({ survived: 9 }))).toBeGreaterThan(0);
  });

  it('breaks a score-and-survivor tie by file name ascending', () => {
    expect(compareTriageRows(row({ file: 'a.ts' }), row({ file: 'b.ts' }))).toBeLessThan(0);
    expect(compareTriageRows(row({ file: 'b.ts' }), row({ file: 'a.ts' }))).toBeGreaterThan(0);
  });

  it('treats fully identical rows as equal', () => {
    expect(compareTriageRows(row({}), row({}))).toBe(0);
  });

  it('ranks an unparseable score as a perfect 100 rather than as zero', () => {
    // `scoreNum` maps a non-numeric score ("n/a", from a file with no mutable
    // logic) to 100, so it sorts to the SAFE end. Reading it as 0 would put every
    // logic-free file at the top of a weakest-first list.
    expect(
      compareTriageRows(row({ mutationScore: '99.00%' }), row({ mutationScore: 'n/a' })),
    ).toBeLessThan(0);
  });

  it('sorts a real leaderboard weakest-first through Array.sort', () => {
    const rows = [
      row({ file: 'safe.ts', mutationScore: '95.00%', survived: 1 }),
      row({ file: 'b-weak.ts', mutationScore: '50.00%', survived: 4 }),
      row({ file: 'a-weak.ts', mutationScore: '50.00%', survived: 4 }),
      row({ file: 'weakest.ts', mutationScore: '50.00%', survived: 7 }),
    ];
    expect([...rows].sort(compareTriageRows).map((r) => r.file)).toEqual([
      'weakest.ts',
      'a-weak.ts',
      'b-weak.ts',
      'safe.ts',
    ]);
  });
});
