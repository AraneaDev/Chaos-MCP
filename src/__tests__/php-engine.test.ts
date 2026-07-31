import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/exec-classify.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/exec-classify.js')>(
    '../utils/exec-classify.js',
  );
  return { ...actual, invokeMutationTool: vi.fn() };
});
// The engine's diagnostics go through the logger; mock it so the verbose paths
// are observable instead of writing to the test runner's stderr.
vi.mock('../utils/logger.js', () => ({
  log: vi.fn(),
  isVerbose: vi.fn(() => false),
  // `warn` is always-on (it does not check verbose), so the totals cross-check
  // in parseInfectionJsonLog would write to the runner's stderr unmocked.
  warn: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

import { existsSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { invokeMutationTool, MutationToolStartupError } from '../utils/exec-classify.js';
import { ExecFailureError } from '../utils/exec-error.js';
import {
  PhpEngine,
  parseInfectionJsonLog,
  buildInfectionConfig,
  inferSourceDir,
  infectionDiagnostics,
  diagnoseInfectionStartupFailure,
  explainMissingJsonLog,
  phpunitFailsOnWarning,
} from '../engines/php.js';

const mockInvoke = vi.mocked(invokeMutationTool);
const mockExists = vi.mocked(existsSync);
const mockWrite = vi.mocked(writeFileSync);
const mockRead = vi.mocked(readFileSync);
const mockMkdir = vi.mocked(mkdirSync);
const mockRm = vi.mocked(rmSync);

// A minimal Infection JSON log: 3 killed, 1 timed-out, 1 escaped → killed 4, survived 1.
const SAMPLE_LOG = JSON.stringify({
  stats: { totalMutantsCount: 5, killedCount: 3, escapedCount: 1, timeOutCount: 1 },
  escaped: [
    {
      mutator: {
        mutatorName: 'GreaterThan',
        originalFilePath: 'src/Calculator.php',
        originalStartLine: 12,
      },
      diff: '--- Original\n+++ New\n@@ @@\n- return $a > $b;\n+ return $a >= $b;',
    },
  ],
  killed: [{}, {}, {}],
  timeouted: [{}],
});

beforeEach(() => {
  vi.clearAllMocks();
  mockExists.mockReturnValue(false);
  mockWrite.mockReturnValue(undefined);
});

describe('phpunitFailsOnWarning', () => {
  it('is true when the root element sets failOnWarning="true"', () => {
    expect(phpunitFailsOnWarning('<phpunit failOnWarning="true"></phpunit>')).toBe(true);
  });

  /** Real configs spread attributes over many lines. */
  it('finds the attribute across a multi-line root element', () => {
    const xml = `<?xml version="1.0"?>
<phpunit xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         bootstrap="tests/bootstrap.php"
         failOnRisky="true"
         failOnWarning="true"
         cacheDirectory=".phpunit.cache">
  <testsuites/>
</phpunit>`;
    expect(phpunitFailsOnWarning(xml)).toBe(true);
  });

  it('accepts single-quoted attribute values', () => {
    expect(phpunitFailsOnWarning("<phpunit failOnWarning='true'/>")).toBe(true);
  });

  it('is false when the attribute is absent', () => {
    expect(phpunitFailsOnWarning('<phpunit bootstrap="x.php"><testsuites/></phpunit>')).toBe(false);
  });

  it('is false when the attribute is explicitly false', () => {
    expect(phpunitFailsOnWarning('<phpunit failOnWarning="false"/>')).toBe(false);
  });

  /**
   * The setting is only meaningful on the root element. A comment quoting it —
   * the shape a config carries right after someone reads about this trap — must
   * not be mistaken for the setting itself.
   */
  it('ignores the attribute when it appears only in a comment', () => {
    const xml = `<!-- consider failOnWarning="true" here -->\n<phpunit bootstrap="x.php"/>`;
    expect(phpunitFailsOnWarning(xml)).toBe(false);
  });

  it('is false for a file with no phpunit element at all', () => {
    expect(phpunitFailsOnWarning('<not-phpunit failOnWarning="true"/>')).toBe(false);
  });

  it('strips a MULTI-LINE comment before looking for the root element', () => {
    // The comment strip is lazy and spans newlines. Narrowed to a single
    // character (or to whitespace/non-whitespace only) it stops matching real
    // comments, and a commented-out root element is read as the live one.
    const xml = `<!--
      <phpunit failOnWarning="true">
        an old config someone left behind
      </phpunit>
    -->
<phpunit bootstrap="x.php"/>`;
    expect(phpunitFailsOnWarning(xml)).toBe(false);
  });

  it('strips each comment separately rather than everything between the first and last', () => {
    // Lazy `*?`: a greedy match would swallow the real root element sitting
    // between two comments and report false for a config that does set it.
    const xml = `<!-- first --><phpunit failOnWarning="true"/><!-- second -->`;
    expect(phpunitFailsOnWarning(xml)).toBe(true);
  });

  it("tolerates whitespace around the attribute's equals sign", () => {
    // `\s*=\s*` — XML permits padding, and tightening either side to `\S*`
    // makes a legitimately-configured project look unconfigured.
    expect(phpunitFailsOnWarning('<phpunit failOnWarning = "true"/>')).toBe(true);
    expect(phpunitFailsOnWarning('<phpunit failOnWarning\t=\n"true"/>')).toBe(true);
  });

  it('requires the quotes around the value to match', () => {
    // The `(["'])…\1` backreference: a mismatched pair is malformed XML, not a
    // setting.
    expect(phpunitFailsOnWarning(`<phpunit failOnWarning="true'/>`)).toBe(false);
  });

  it('does not match a longer attribute that merely ends in failOnWarning', () => {
    // The `\b` word boundary.
    expect(phpunitFailsOnWarning('<phpunit xfailOnWarning="true"/>')).toBe(false);
  });
});

describe('inferSourceDir', () => {
  it('returns the top path segment', () => {
    expect(inferSourceDir('src/Calculator.php')).toBe('src');
    expect(inferSourceDir('app/Service/Math.php')).toBe('app');
  });
  it('returns "." for a bare filename', () => {
    expect(inferSourceDir('Calculator.php')).toBe('.');
  });
  it('returns "." for a leading-slash path rather than an empty source directory', () => {
    // A path starting with a separator has no usable first segment, and an empty
    // one would be written into the generated config as
    // `source.directories: [""]`, making Infection mutate nothing. Its own
    // directory is the filesystem root, which is not a source root either, so
    // "." is the honest answer here. Normalized backslashes take the same path.
    expect(inferSourceDir('/Calculator.php')).toBe('.');
    expect(inferSourceDir('\\Calculator.php')).toBe('.');
  });
  it('normalizes backslash separators to forward slashes', () => {
    expect(inferSourceDir('src\\Domain\\Calculator.php')).toBe('src');
  });

  it('strips a leading "./" instead of reporting the whole project tree', () => {
    // `./src/Calculator.php` has its first slash at index 1, so the raw
    // first-segment slice was the literal "." — which tells Infection to treat
    // the ENTIRE project (vendor/, tests/ and all) as mutable source. The
    // provenance check in this same file already normalised a leading "./", so
    // the two functions used to disagree about the same input.
    expect(inferSourceDir('./src/Calculator.php')).toBe('src');
    expect(inferSourceDir('.\\src\\Calculator.php')).toBe('src');
    expect(inferSourceDir('././app/Service/Math.php')).toBe('app');
  });

  it('makes an absolute target relative to the directory Infection runs in', () => {
    // The sandbox path shape: the config is written to `cwd`, so the source root
    // must be expressed relative to it — not collapsed to "." because the first
    // slash sits at index 0.
    expect(inferSourceDir('/sb/src/Calculator.php', '/sb')).toBe('src');
    expect(inferSourceDir('/sb/app/Service/Math.php', '/sb')).toBe('app');
  });

  it("falls back to the file's own directory when it lies outside cwd", () => {
    // Nothing can be named as a top-level source directory here, but the file's
    // own directory is still far narrower than the project root — and "." is
    // exactly the over-broad scope that drags vendor/ and tests/ into the run.
    expect(inferSourceDir('/opt/other/src/Calculator.php', '/sb')).toBe('../opt/other/src');
    expect(inferSourceDir('/sb/../lib/Calculator.php', '/sb')).toBe('../lib');
  });

  it('never returns a bare ancestor chain, which would be broader than "."', () => {
    // `/Calculator.php` relative to `/sb/deep` is `../../Calculator.php`; its
    // directory is `../..`, an ancestor of the project root. Falling back to
    // that would widen the mutation scope rather than narrow it.
    expect(inferSourceDir('/Calculator.php', '/sb/deep')).toBe('.');
  });
});

describe('buildInfectionConfig', () => {
  it('generates minimal phpunit config with the json log path', () => {
    const cfg = JSON.parse(buildInfectionConfig('src', 'chaos-infection-log.json'));
    expect(cfg.source.directories).toEqual(['src']);
    expect(cfg.testFramework).toBe('phpunit');
    expect(cfg.logs.json).toBe('chaos-infection-log.json');
  });
});

describe('parseInfectionJsonLog', () => {
  it('maps escaped→survivors, timed-out→killed, and computes killed/(killed+survived)', () => {
    const r = parseInfectionJsonLog(SAMPLE_LOG, 'src/Calculator.php');
    expect(r.killed).toBe(4); // 3 killed + 1 timed-out
    expect(r.survived).toBe(1);
    expect(r.totalMutants).toBe(5);
    expect(r.mutationScore).toBe('80.00%');
    expect(r.vulnerabilities).toHaveLength(1);
    expect(r.vulnerabilities[0]).toMatchObject({ line: 12, mutator: 'GreaterThan' });
    expect(r.vulnerabilities[0].mutated).toContain('>=');
  });

  it('reads the legacy timedOutCount when the modern key is absent', () => {
    // Infection renamed `timedOutCount` to `timeOutCount`. The `??` chain falls
    // through key-by-key; as `&&` the legacy key is skipped and the count comes
    // from the array instead — which a stats/array skew makes wrong.
    const log = JSON.stringify({
      stats: { killedCount: 2, timedOutCount: 3 },
      escaped: [],
      killed: [],
      timeouted: [],
    });
    const r = parseInfectionJsonLog(log, 'src/X.php');
    expect(r.killed).toBe(5); // 2 killed + 3 timed out
  });

  it('prefers the modern timeOutCount over the legacy key', () => {
    const log = JSON.stringify({
      stats: { killedCount: 0, timeOutCount: 7, timedOutCount: 99 },
      escaped: [],
      killed: [],
    });
    expect(parseInfectionJsonLog(log, 'src/X.php').killed).toBe(7);
  });

  it('falls back to the timed-out ARRAY when neither count is present', () => {
    const log = JSON.stringify({
      stats: { killedCount: 1 },
      escaped: [],
      killed: [],
      timeouted: [{}, {}],
    });
    expect(parseInfectionJsonLog(log, 'src/X.php').killed).toBe(3);
  });

  it('accepts a log whose mutants record no file path at all', () => {
    // "Mutants with no recorded path cannot contradict anything." A blank path
    // must be filtered out, not treated as a path that disagrees with the
    // target — which would reject a perfectly good log as stale.
    const log = JSON.stringify({
      stats: { killedCount: 1, escapedCount: 0 },
      escaped: [],
      killed: [{ mutator: { mutatorName: 'Plus', originalFilePath: '' } }],
    });
    expect(() => parseInfectionJsonLog(log, 'src/Calculator.php')).not.toThrow();
  });

  it('normalises Windows backslash paths on both sides of the comparison', () => {
    // Infection on Windows records `C:\\sb\\src\\Calculator.php`; the audit target
    // is POSIX. Without the backslash→slash rewrite the two never match and a
    // valid log is rejected as stale.
    const log = JSON.stringify({
      stats: { killedCount: 1, escapedCount: 0 },
      escaped: [],
      killed: [
        { mutator: { mutatorName: 'Plus', originalFilePath: 'C:\\sb\\src\\Calculator.php' } },
      ],
    });
    expect(() => parseInfectionJsonLog(log, 'src\\Calculator.php')).not.toThrow();
  });

  it('strips a leading "./" from the target before comparing', () => {
    const log = JSON.stringify({
      stats: { killedCount: 1, escapedCount: 0 },
      escaped: [],
      killed: [{ mutator: { mutatorName: 'Plus', originalFilePath: '/sb/src/Calculator.php' } }],
    });
    expect(() => parseInfectionJsonLog(log, './src/Calculator.php')).not.toThrow();
  });

  it('still rejects a log that describes a genuinely different file', () => {
    const log = JSON.stringify({
      stats: { killedCount: 1, escapedCount: 0 },
      escaped: [],
      killed: [{ mutator: { mutatorName: 'Plus', originalFilePath: '/sb/src/Other.php' } }],
    });
    expect(() => parseInfectionJsonLog(log, 'src/Calculator.php')).toThrow(
      /describes a different file/,
    );
  });

  it('accepts a log where ANY mutant matches the target, not only when all do', () => {
    // `.some(...)`. As `.every(...)` a log covering the target plus one other
    // file is rejected as stale — and Infection's `--filter` is a prefix match,
    // so mixed logs are normal.
    const log = JSON.stringify({
      stats: { killedCount: 2, escapedCount: 0 },
      escaped: [],
      killed: [
        { mutator: { mutatorName: 'Plus', originalFilePath: '/sb/src/Calculator.php' } },
        { mutator: { mutatorName: 'Minus', originalFilePath: '/sb/src/Helper.php' } },
      ],
    });
    expect(() => parseInfectionJsonLog(log, 'src/Calculator.php')).not.toThrow();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // notCovered / errored. Both used to vanish from the result entirely — no
  // count, no note, nothing explaining why `totalMutants` was smaller than the
  // run Infection actually performed. They are NOT the same outcome and are not
  // reported the same way: see the parser's doc comment.
  // ───────────────────────────────────────────────────────────────────────────
  it('reports notCovered mutants as no-coverage vulnerabilities inside the denominator', () => {
    // UPDATED (audit FIX 2): this case previously asserted totalMutants 2 —
    // notCovered silently dropped. `notCovered` means "no test covers this
    // line": nothing failed, the suite never looked. That is the same outcome
    // the TypeScript engine reports as Stryker `NoCoverage` — an actionable hole
    // that is unkilled and therefore inside the denominator — not an
    // "unscoreable" mutant.
    const log = JSON.stringify({
      stats: { killedCount: 1, escapedCount: 1 },
      escaped: [{ mutator: { mutatorName: 'Plus', originalStartLine: 3 } }],
      killed: [{}],
      notCovered: [
        { mutator: { mutatorName: 'Minus', originalStartLine: 7 }, diff: '  - $a - $b\n' },
        { mutator: { mutatorName: 'Identical', originalStartLine: 9 } },
      ],
      errored: [{}],
    });
    const r = parseInfectionJsonLog(log, 'src/X.php');
    expect(r.killed).toBe(1);
    expect(r.survived).toBe(1); // survivors only — notCovered is not a survivor
    expect(r.totalMutants).toBe(4); // 1 killed + 1 escaped + 2 notCovered; errored excluded
    expect(r.mutationScore).toBe('25.00%');
    // `triage.ts` derives its noCoverage figure as vulnerabilities.length - survived.
    expect(r.vulnerabilities).toHaveLength(3);
    expect(r.vulnerabilities.filter((v) => v.kind === 'noCoverage')).toHaveLength(2);
    const nc = r.vulnerabilities.find((v) => v.line === 7);
    expect(nc).toMatchObject({ kind: 'noCoverage', mutator: 'Minus', mutated: '- $a - $b' });
    expect(nc?.description).toMatch(/no test reached/i);
  });

  it('counts errored mutants as incompetent and keeps them out of the score', () => {
    // base.ts defines `incompetent` as mutants the tool could not score because
    // the mutated code failed before a real pass/fail — exactly Infection's
    // `errored`. format.ts already renders it; it simply never fired for PHP.
    const log = JSON.stringify({
      stats: { killedCount: 2 },
      escaped: [],
      killed: [{}, {}],
      errored: [{}, {}, {}],
    });
    const r = parseInfectionJsonLog(log, 'src/X.php');
    expect(r.incompetent).toBe(3);
    expect(r.totalMutants).toBe(2);
    expect(r.mutationScore).toBe('100.00%');
  });

  it('omits incompetent entirely when nothing errored', () => {
    // Present-but-zero reads as "the tool reported this" to consumers that only
    // check for the key (format.ts guards on `> 0`, but the payload shape is
    // user-visible). Matches the Rust engine's conditional spread.
    const r = parseInfectionJsonLog(SAMPLE_LOG, 'src/Calculator.php');
    expect(Object.keys(r)).not.toContain('incompetent');
  });

  it('checks notCovered mutants against the audited file too (stale-log provenance)', () => {
    // notCovered entries are now REPORTED, so they need the same provenance
    // guard as escaped/killed. A stale log whose only entries are another file's
    // uncovered mutants would otherwise be published as this file's coverage holes.
    const log = JSON.stringify({
      stats: { killedCount: 0 },
      escaped: [],
      killed: [],
      notCovered: [{ mutator: { mutatorName: 'Plus', originalFilePath: '/sb/src/Other.php' } }],
    });
    expect(() => parseInfectionJsonLog(log, 'src/Calculator.php')).toThrow(/different file/i);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Schema drift. `JSON.parse` proves only that the bytes are JSON; every field
  // read past it fails SOFT, so a log whose result keys this parser has never
  // heard of scored killed 0 / survived 0 / total 0 — which formatMutationScore
  // renders as a confident "100.00%".
  // ───────────────────────────────────────────────────────────────────────────
  it('refuses a log with no recognised result keys instead of scoring it 100%', () => {
    // UPDATED (audit FIX 1): this case previously asserted the defect —
    // `{"stats":{},"escaped":[]}` → totalMutants 0, "100.00%". Empty stats plus
    // empty arrays is exactly what a wholesale key rename degrades to, and a
    // real Infection run always emits its stats counts, so it cannot be
    // mistaken for a genuinely mutant-free file.
    expect(() =>
      parseInfectionJsonLog(JSON.stringify({ stats: {}, escaped: [] }), 'src/X.php'),
    ).toThrow(/no recognised result keys/);
  });

  it('names the supported Infection range and the keys it actually got', () => {
    // A plausible future rename: the same data under names this parser cannot
    // read. Without the guard it scores 100.00% for a file with 50 survivors.
    const renamed = JSON.stringify({
      summary: { totalCount: 50, detectedCount: 10 },
      survivors: [{ mutator: { mutatorName: 'Plus', originalStartLine: 3 } }],
    });
    expect(() => parseInfectionJsonLog(renamed, 'src/X.php')).toThrow(/0\.27–0\.34/);
    expect(() => parseInfectionJsonLog(renamed, 'src/X.php')).toThrow(/summary, survivors/);
  });

  it.each([
    ['a JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a bare number', '42'],
    ['an empty object', '{}'],
  ])('refuses %s rather than reading fields off it', (_label, text) => {
    // `JSON.parse('null')` used to reach `parsed.escaped` and throw a raw
    // TypeError; the others scored a silent 100%.
    expect(() => parseInfectionJsonLog(text, 'src/X.php')).toThrow(/no recognised result keys/);
  });

  it('accepts a genuinely mutant-free run reported through stats alone', () => {
    // The honest zero: Infection ran, found nothing to mutate, and said so with
    // its own counts. That must still score (total 0 → "100.00%"), or a file of
    // pure constants becomes an audit failure.
    const log = JSON.stringify({
      stats: { totalMutantsCount: 0, killedCount: 0, escapedCount: 0, timeOutCount: 0 },
      escaped: [],
      killed: [],
    });
    const r = parseInfectionJsonLog(log, 'src/X.php');
    expect(r.totalMutants).toBe(0);
    expect(r.mutationScore).toBe('100.00%');
    expect(r.vulnerabilities).toEqual([]);
  });

  it('accepts a log carrying only mutant lists, with no stats block at all', () => {
    const log = JSON.stringify({ escaped: [{ mutator: { originalStartLine: 2 } }], killed: [{}] });
    expect(parseInfectionJsonLog(log, 'src/X.php').totalMutants).toBe(2);
  });

  it('warns when Infection’s own total disagrees with what the parser read', async () => {
    // The partial rename the recognised-keys guard cannot see: `stats` is
    // intact, so the log looks understood, but the survivor list moved to a name
    // we do not read and its 6 mutants vanish from the score.
    const { warn } = await import('../utils/logger.js');
    vi.mocked(warn).mockClear();
    const log = JSON.stringify({
      stats: { totalMutantsCount: 10, killedCount: 4 },
      killed: [{}, {}, {}, {}],
      survivedMutants: [{}, {}, {}, {}, {}, {}],
    });
    const r = parseInfectionJsonLog(log, 'src/X.php');
    expect(r.mutationScore).toBe('100.00%'); // still the best reading of what was there…
    expect(vi.mocked(warn)).toHaveBeenCalledWith(
      expect.stringContaining('reports 10 mutant(s) in total but this parser accounted for 4'),
    );
  });

  it('does not warn when the totals reconcile, including declared-but-unscored mutants', async () => {
    // `ignored`/`skipped`/`syntaxError` mutants are legitimately part of
    // Infection's total; counting them keeps the check from crying wolf on a
    // perfectly well-read log.
    const { warn } = await import('../utils/logger.js');
    vi.mocked(warn).mockClear();
    const log = JSON.stringify({
      stats: {
        totalMutantsCount: 8,
        killedCount: 3,
        escapedCount: 1,
        timeOutCount: 1,
        ignoredCount: 2,
        skippedCount: 1,
      },
      escaped: [{ mutator: { originalStartLine: 5 } }],
      killed: [{}, {}, {}],
      timeouted: [{}],
    });
    parseInfectionJsonLog(log, 'src/X.php');
    expect(vi.mocked(warn)).not.toHaveBeenCalled();
  });

  it('does not warn when the log carries no total to check against', async () => {
    const { warn } = await import('../utils/logger.js');
    vi.mocked(warn).mockClear();
    parseInfectionJsonLog(
      JSON.stringify({ stats: { killedCount: 1 }, escaped: [], killed: [{}] }),
      'src/X.php',
    );
    expect(vi.mocked(warn)).not.toHaveBeenCalled();
  });

  it('throws on an unparseable (corrupt) JSON log rather than reporting a false 100%', () => {
    expect(() => parseInfectionJsonLog('not json {{{', 'src/X.php')).toThrow(
      /unparseable JSON log/,
    );
  });

  it('L5: derives survived/totalMutants from escaped.length, not a mismatched stats.escapedCount', () => {
    // stats.escapedCount (5) disagrees with the actual escaped array (1 entry).
    // Before the fix, `survived` would be 5 while `vulnerabilities` only had 1
    // entry — a self-contradictory result (score/survived count not matching
    // the emitted survivor list).
    const log = JSON.stringify({
      stats: { killedCount: 3, escapedCount: 5 },
      escaped: [{ mutator: { mutatorName: 'GreaterThan', originalStartLine: 12 } }],
      killed: [{}, {}, {}],
    });
    const r = parseInfectionJsonLog(log, 'src/Calculator.php');
    expect(r.vulnerabilities).toHaveLength(1);
    expect(r.survived).toBe(r.vulnerabilities.length);
    expect(r.survived).toBe(1);
    expect(r.totalMutants).toBe(4); // 3 killed + 1 survived (consistent with vulnerabilities)
    expect(r.mutationScore).toBe('75.00%');
  });

  it('tolerates an escaped entry with no mutator metadata instead of throwing', () => {
    // The `e.mutator?.` optional chaining and its `?? 0` / default-name
    // fallbacks: an Infection version skew that omits `mutator` must degrade to
    // a placeholder survivor, not crash the whole audit.
    const log = JSON.stringify({
      stats: { killedCount: 1 },
      escaped: [{}],
      killed: [{}],
    });
    const r = parseInfectionJsonLog(log, 'src/X.php');
    expect(r.vulnerabilities).toHaveLength(1);
    expect(r.vulnerabilities[0].line).toBe(0);
    expect(r.vulnerabilities[0].mutator).toBe('PHP Mutation Operator');
    expect(r.vulnerabilities[0].description).toContain('line 0');
  });

  it('trims surrounding whitespace off a survivor diff', () => {
    const log = JSON.stringify({
      stats: { killedCount: 0 },
      escaped: [
        { mutator: { mutatorName: 'Plus', originalStartLine: 4 }, diff: '\n  - $a + $b\n\n' },
      ],
      killed: [],
    });
    const r = parseInfectionJsonLog(log, 'src/X.php');
    expect(r.vulnerabilities[0].mutated).toBe('- $a + $b');
  });

  it('falls back to array lengths when the log carries no stats block', () => {
    // `parsed.stats ?? {}` plus the `?? …length` fallbacks: a log without
    // `stats` must still score, not read every count as undefined.
    const log = JSON.stringify({
      escaped: [{ mutator: { mutatorName: 'Plus', originalStartLine: 1 } }],
      killed: [{}, {}, {}],
      timeouted: [{}],
    });
    const r = parseInfectionJsonLog(log, 'src/X.php');
    expect(r.killed).toBe(4); // 3 killed + 1 timed-out, both from array lengths
    expect(r.survived).toBe(1);
    expect(r.mutationScore).toBe('80.00%');
  });

  it('treats a non-array escaped field as no survivors rather than trusting it', () => {
    const log = JSON.stringify({ stats: { killedCount: 2 }, escaped: null, killed: [{}, {}] });
    const r = parseInfectionJsonLog(log, 'src/X.php');
    expect(r.survived).toBe(0);
    expect(r.vulnerabilities).toEqual([]);
    expect(r.mutationScore).toBe('100.00%');
  });

  it('refuses a log whose mutants all belong to a different file', () => {
    // The sandbox is a copy of the workspace, so a `chaos-infection-log.json`
    // left over from an earlier audit is copied in with it. When Infection then
    // fails to start, that stale log is still on disk and used to be parsed and
    // reported as THIS file's result: auditing GraphReconciler.php returned
    // "100%, 27/27 killed" for 27 mutants that all belonged to
    // CliErrorRenderer.php and were hours old.
    const log = JSON.stringify({
      stats: { killedCount: 1 },
      escaped: [],
      killed: [{ mutator: { mutatorName: 'Plus', originalFilePath: '/sb/src/Other.php' } }],
    });

    expect(() => parseInfectionJsonLog(log, 'src/Calculator.php')).toThrow(/different file/i);
  });

  it('accepts a log whose mutants carry no file path (nothing to contradict)', () => {
    // Provenance is only enforceable when Infection records paths; a log that
    // omits them must still parse rather than becoming an unusable audit.
    const log = JSON.stringify({ stats: { killedCount: 2 }, escaped: [], killed: [{}, {}] });

    expect(parseInfectionJsonLog(log, 'src/Calculator.php').killed).toBe(2);
  });

  it('accepts a log when at least one mutant matches the audited file', () => {
    const log = JSON.stringify({
      stats: { killedCount: 2 },
      escaped: [],
      killed: [
        { mutator: { mutatorName: 'Plus', originalFilePath: '/sb/src/Calculator.php' } },
        { mutator: { mutatorName: 'Minus' } },
      ],
    });

    expect(parseInfectionJsonLog(log, 'src/Calculator.php').killed).toBe(2);
  });

  it('L5: stays identical to the stats-driven count when stats and escaped agree (normal case)', () => {
    const r = parseInfectionJsonLog(SAMPLE_LOG, 'src/Calculator.php');
    // Unchanged behavior versus the pre-fix path: escapedCount (1) already
    // equals escaped.length (1), so survived/totalMutants/score are identical.
    expect(r.survived).toBe(1);
    expect(r.totalMutants).toBe(5);
    expect(r.mutationScore).toBe('80.00%');
  });
});

describe('PhpEngine.run', () => {
  it('generates a config when none exists, filters to the file, and parses the log', async () => {
    // existsSync: no infection.json/.json5, no vendor/bin/infection, but the log IS produced.
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const engine = new PhpEngine();
    const result = await engine.run('src/Calculator.php', { workDir: '/sb' });

    // Generated config written (no project config present).
    expect(mockWrite).toHaveBeenCalledWith(
      expect.stringContaining('infection.json'),
      expect.stringContaining('"testFramework"'),
      'utf8',
    );
    // Invoked with --filter scoped to the file. The detailed JSON log is
    // configured via the generated config's `logs.json`, NOT a CLI flag —
    // Infection 0.34+ removed `--logger-json`, so it must never be passed.
    const [, bin, args] = mockInvoke.mock.calls[0];
    expect(bin).toBe('infection'); // no vendor/bin/infection → global fallback
    expect(args).toContain('--filter=src/Calculator.php');
    expect(args.some((a: string) => a.startsWith('--logger-json'))).toBe(false);
    expect(args).toContain('--no-progress');
    expect(args).toContain('--no-interaction');
    expect(result.survived).toBe(1);
  });

  /**
   * The survivors this engine reports are only trustworthy if a killed mutant
   * reliably produces a failing exit code. Under `failOnWarning="false"` it does
   * not, so the result says so rather than letting a caller act on phantoms.
   */
  it('flags survivors when the project does not fail on warnings', async () => {
    mockExists.mockImplementation(
      (p) => String(p).endsWith('chaos-infection-log.json') || String(p).endsWith('phpunit.xml'),
    );
    mockRead.mockImplementation((p) =>
      String(p).endsWith('phpunit.xml')
        ? '<phpunit failOnWarning="false"><testsuites/></phpunit>'
        : SAMPLE_LOG,
    );
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const result = await new PhpEngine().run('src/Calculator.php', { workDir: '/sb' });

    expect(result.survived).toBe(1);
    expect(result.fidelityNote).toContain('failOnWarning');
  });

  it('does not flag survivors when the project already fails on warnings', async () => {
    mockExists.mockImplementation(
      (p) => String(p).endsWith('chaos-infection-log.json') || String(p).endsWith('phpunit.xml'),
    );
    mockRead.mockImplementation((p) =>
      String(p).endsWith('phpunit.xml')
        ? '<phpunit failOnWarning="true"><testsuites/></phpunit>'
        : SAMPLE_LOG,
    );
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const result = await new PhpEngine().run('src/Calculator.php', { workDir: '/sb' });

    expect(result.fidelityNote).toBeUndefined();
  });

  /** No survivor, nothing to doubt — the advisory would be noise. */
  it('does not flag a run with no survivors', async () => {
    const cleanLog = JSON.stringify({
      stats: { totalMutantsCount: 2, killedCount: 2, escapedCount: 0, timeOutCount: 0 },
      escaped: [],
      killed: [{ mutator: { originalFilePath: 'src/Calculator.php' } }, {}],
    });
    mockExists.mockImplementation(
      (p) => String(p).endsWith('chaos-infection-log.json') || String(p).endsWith('phpunit.xml'),
    );
    mockRead.mockImplementation((p) =>
      String(p).endsWith('phpunit.xml')
        ? '<phpunit failOnWarning="false"><testsuites/></phpunit>'
        : cleanLog,
    );
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const result = await new PhpEngine().run('src/Calculator.php', { workDir: '/sb' });

    expect(result.survived).toBe(0);
    expect(result.fidelityNote).toBeUndefined();
  });

  /** A project with no PHPUnit config at all is not evidence of the trap. */
  it('does not flag when no PHPUnit config can be read', async () => {
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const result = await new PhpEngine().run('src/Calculator.php', { workDir: '/sb' });

    expect(result.survived).toBe(1);
    expect(result.fidelityNote).toBeUndefined();
  });

  it('deletes any pre-existing JSON log before running so a stale one cannot be read', async () => {
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    await new PhpEngine().run('src/Calculator.php', { workDir: '/sb' });

    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining('chaos-infection-log.json'),
      expect.objectContaining({ force: true }),
    );
    // Removal must precede the run, or it would delete this run's own output.
    expect(mockRm.mock.invocationCallOrder[0]).toBeLessThan(mockInvoke.mock.invocationCallOrder[0]);
  });

  it('reports the Infection failure instead of a stale log left in the sandbox', async () => {
    // Regression: a sandbox copy carries the workspace's old
    // chaos-infection-log.json. Infection's initial test run failed (exit 1),
    // but because a log file "existed" the engine skipped its no-log error path
    // and reported the stale contents as a fresh 100% score.
    let logOnDisk = true; // the stale copy
    mockExists.mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('chaos-infection-log.json')) return logOnDisk;
      return s.endsWith('phpunit.xml'); // a normal PHPUnit project
    });
    mockRm.mockImplementation(() => {
      logOnDisk = false;
    });
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockRejectedValue(
      new ExecFailureError(
        { stdout: '', stderr: 'initial test run failed', exit: 1, signal: null, code: undefined },
        'Infection failed',
      ),
    );

    await expect(new PhpEngine().run('src/Calculator.php', { workDir: '/sb' })).rejects.toThrow(
      /without producing a JSON log/,
    );
  });

  it('forwards the container session to Infection execution', async () => {
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });
    const executor = {
      kind: 'container' as const,
      workDir: '/sb',
      run: vi.fn(),
      runCommand: vi.fn(),
      dispose: vi.fn(),
    };

    await new PhpEngine().run('src/Calculator.php', { workDir: '/sb', executor });

    expect(mockInvoke).toHaveBeenCalledWith(
      'Infection',
      'infection',
      expect.any(Array),
      expect.objectContaining({ executor }),
    );
  });

  it('does NOT overwrite an existing project infection.json and prefers vendor/bin/infection', async () => {
    mockExists.mockImplementation((p) => {
      const s = String(p);
      return (
        s.endsWith('infection.json') ||
        s.endsWith('vendor/bin/infection') ||
        s.endsWith('chaos-infection-log.json')
      );
    });
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const engine = new PhpEngine();
    await engine.run('src/Calculator.php', { workDir: '/sb' });

    expect(mockWrite).not.toHaveBeenCalled(); // project config respected
    const [, bin] = mockInvoke.mock.calls[0];
    expect(String(bin)).toContain('vendor/bin/infection');
  });

  it('isolates Infection temp files per run via TMPDIR inside the workDir (parallel-collision regression)', async () => {
    // Infection writes to sys_get_temp_dir()/infection — a FIXED shared path.
    // Concurrent runs (parallel triage) collided there and failed with
    // "Cannot declare class ComposerAutoloaderInit… already in use". Each run
    // must get a per-workDir TMPDIR so sys_get_temp_dir() is unique.
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const engine = new PhpEngine();
    await engine.run('src/Calculator.php', { workDir: '/sb' });

    // A per-run temp dir under the sandbox workDir is created…
    expect(mockMkdir).toHaveBeenCalledWith('/sb/.chaos-infection-tmp', { recursive: true });
    // …and pointed at via TMPDIR/TMP/TEMP in the Infection invocation's env.
    const invokeEnv = mockInvoke.mock.calls[0][3]?.env as NodeJS.ProcessEnv;
    expect(invokeEnv.TMPDIR).toBe('/sb/.chaos-infection-tmp');
    expect(invokeEnv.TMP).toBe('/sb/.chaos-infection-tmp');
    expect(invokeEnv.TEMP).toBe('/sb/.chaos-infection-tmp');
    // PATH (and the rest of the environment) is preserved so `infection` still resolves.
    expect(invokeEnv.PATH).toBe(process.env.PATH);
  });

  it('parses the log even when Infection exits non-zero (mutants escaped)', async () => {
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockRejectedValue(
      new ExecFailureError(
        { stdout: '', stderr: 'MSI below threshold', exit: 1, signal: null, code: undefined },
        'nonzero',
      ),
    );

    const engine = new PhpEngine();
    const result = await engine.run('src/Calculator.php', { workDir: '/sb' });
    expect(result.survived).toBe(1);
  });

  it('throws a coverage-driver hint when no JSON log is produced', async () => {
    // A PHPUnit config IS present (so it is not the "unsupported runner" case),
    // but no log file ever appears → the coverage-driver hint.
    mockExists.mockImplementation((p) => String(p).endsWith('phpunit.xml.dist'));
    mockInvoke.mockRejectedValue(
      new ExecFailureError(
        {
          stdout: '',
          stderr: 'No code coverage driver found',
          exit: 1,
          signal: null,
          code: undefined,
        },
        'nonzero',
      ),
    );

    const engine = new PhpEngine();
    await expect(engine.run('src/Calculator.php', { workDir: '/sb' })).rejects.toThrow(
      /Xdebug or PCOV/,
    );
  });

  it('reports a missing PHPUnit config (unsupported/custom test runner) rather than the coverage hint', async () => {
    // No project Infection config, no PHPUnit config, and no JSON log: the
    // project uses a different or custom test runner, so Infection can never run.
    // The error must name the real cause, not the generic coverage-driver hint.
    mockExists.mockReturnValue(false);
    mockInvoke.mockRejectedValue(
      new ExecFailureError(
        {
          stdout: '',
          stderr: 'The path does not contain any of the requested files: "phpunit.xml", ...',
          exit: 1,
          signal: null,
          code: undefined,
        },
        'nonzero',
      ),
    );

    const engine = new PhpEngine();
    const run = engine.run('src/Calculator.php', { workDir: '/sb' });
    await expect(run).rejects.toThrow(/no PHPUnit configuration found/);
    await expect(run).rejects.not.toThrow(/Xdebug or PCOV/);
  });

  it('names the STDERR-abort cause instead of blaming the suite when PHPUnit exits 143', async () => {
    // Real failure observed auditing a project whose suite passes cleanly:
    // Infection's InitialTestsRunner stops the test process on the first byte
    // written to STDERR, PHPUnit exits 143, and the generic message sends the
    // caller off checking the coverage driver and the suite's health instead.
    mockExists.mockImplementation((p) => String(p).endsWith('phpunit.xml'));
    mockInvoke.mockRejectedValue(
      new ExecFailureError(
        {
          stdout:
            '[ERROR] Project tests must be in a passing state before running Infection.\n' +
            'PHPUnit reported an exit code of 143.\n' +
            'STDERR:\nAPP_RUNTIME_ERROR: msg\n',
          stderr: '',
          exit: 1,
          signal: null,
          code: undefined,
        },
        'nonzero',
      ),
    );

    const run = new PhpEngine().run('src/Calculator.php', { workDir: '/sb' });
    await expect(run).rejects.toThrow(/first byte written to STDERR/);
    await expect(run).rejects.not.toThrow(/Xdebug or PCOV/);
  });

  it('diagnoses the startup failure from STDERR too, not only from STDOUT', async () => {
    // The diagnosis input joins both streams (`stdout ?? '' + '\n' + stderr ?? ''`).
    // Mutation testing showed that join was only ever exercised through stdout,
    // so a variant that dropped the stderr half went undetected — yet a wrapper
    // or a differently-configured Infection can put the banner on stderr.
    mockExists.mockImplementation((p) => String(p).endsWith('phpunit.xml'));
    mockInvoke.mockRejectedValue(
      new ExecFailureError(
        {
          stdout: '',
          stderr: 'PHPUnit reported an exit code of 143.',
          exit: 1,
          signal: null,
          code: undefined,
        },
        'nonzero',
      ),
    );

    await expect(new PhpEngine().run('src/Calculator.php', { workDir: '/sb' })).rejects.toThrow(
      /first byte written to STDERR/,
    );
  });

  it('keeps the generic guidance when neither known startup failure matches', async () => {
    // The specific-diagnosis branch must not swallow the fallback: an ordinary
    // failing suite still gets the coverage-driver hint.
    mockExists.mockImplementation((p) => String(p).endsWith('phpunit.xml'));
    mockInvoke.mockRejectedValue(
      new ExecFailureError(
        {
          stdout: 'FAILURES!\nTests: 10, Assertions: 12, Failures: 1.',
          stderr: '',
          exit: 1,
          signal: null,
          code: undefined,
        },
        'nonzero',
      ),
    );

    const run = new PhpEngine().run('src/Calculator.php', { workDir: '/sb' });
    await expect(run).rejects.toThrow(/Xdebug or PCOV/);
    await expect(run).rejects.not.toThrow(/first byte written to STDERR/);
  });

  it('names the coverage-scope cause when a coverage-target attribute trips stopOnDefect', async () => {
    // `--filter` narrows the generated initial config's <source> to one file,
    // invalidating every #[CoversClass] elsewhere; Infection's own injected
    // stopOnDefect turns that warning into an aborted run.
    mockExists.mockImplementation((p) => String(p).endsWith('phpunit.xml'));
    mockInvoke.mockRejectedValue(
      new ExecFailureError(
        {
          stdout:
            '[ERROR] Project tests must be in a passing state before running Infection.\n' +
            'Class App\\Thing is not a valid target for code coverage\n',
          stderr: '',
          exit: 1,
          signal: null,
          code: undefined,
        },
        'nonzero',
      ),
    );

    const run = new PhpEngine().run('src/Calculator.php', { workDir: '/sb' });
    await expect(run).rejects.toThrow(/coverage-target attributes/);
    await expect(run).rejects.not.toThrow(/Xdebug or PCOV/);
  });

  it('rethrows the install hint when the binary is missing', async () => {
    mockExists.mockReturnValue(false);
    mockInvoke.mockRejectedValue(
      new MutationToolStartupError(
        'Infection',
        'Infection is not installed. Install it with: composer require --dev infection/infection',
      ),
    );

    const engine = new PhpEngine();
    await expect(engine.run('src/Calculator.php', { workDir: '/sb' })).rejects.toThrow(
      /composer require --dev infection\/infection/,
    );
  });

  it('forwards phpTestFrameworkOptions as --test-framework-options', async () => {
    // The framework-options arg is only appended when the caller supplies it;
    // without a test, the whole `if (options?.phpTestFrameworkOptions)` block and
    // its pushed arg go unexercised (line 165-167).
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const engine = new PhpEngine();
    await engine.run('src/Calculator.php', {
      workDir: '/sb',
      phpTestFrameworkOptions: '--testsuite=unit',
    });
    const args = mockInvoke.mock.calls[0][2] as string[];
    expect(args).toContain('--test-framework-options=--testsuite=unit');
  });

  it('omits --test-framework-options when phpTestFrameworkOptions is absent', async () => {
    // The negative of the above: no caller option → no arg. Kills the mutant that
    // removes the `if` guard and always pushes the (undefined) option.
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const engine = new PhpEngine();
    await engine.run('src/Calculator.php', { workDir: '/sb' });
    const args = mockInvoke.mock.calls[0][2] as string[];
    expect(args.some((a) => a.startsWith('--test-framework-options='))).toBe(false);
  });

  it('throws a coverage-driver hint when the JSON log exists but is unreadable', async () => {
    // Infection succeeds and the log path passes existsSync, but readFileSync
    // throws (permissions / truncation). Covers the readFileSync catch (line
    // 201-205) — distinct from the "no log produced" path above.
    mockExists.mockReturnValue(true);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });
    mockRead.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const engine = new PhpEngine();
    await expect(engine.run('src/Calculator.php', { workDir: '/sb' })).rejects.toThrow(
      /no readable JSON log/,
    );
  });

  it('runs with no options object at all', async () => {
    // `run(filePath)` is a valid call: workDir, timeoutMs, threads and
    // test-framework options are each guarded by their own optional chain, and
    // dropping ANY of them turns this into a TypeError before Infection starts.
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const engine = new PhpEngine();
    await expect(engine.run('src/Calculator.php')).resolves.toMatchObject({
      target: 'src/Calculator.php',
    });
  });

  it('reports a config-write failure instead of running against a stale config', async () => {
    // Without the generated config, Infection would run with whatever was on
    // disk — a different scope than the caller asked for.
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockWrite.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });

    const engine = new PhpEngine();
    await expect(engine.run('src/Calculator.php', { workDir: '/sb' })).rejects.toThrow(
      'Failed to write generated infection.json: EACCES: permission denied',
    );
  });

  it('logs the invocation only in verbose mode', async () => {
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockedLog = vi.mocked(log);
    const engine = new PhpEngine();

    vi.mocked(isVerbose).mockReturnValue(false);
    mockedLog.mockClear();
    await engine.run('src/Calculator.php', { workDir: '/sb' });
    expect(mockedLog).not.toHaveBeenCalled();

    vi.mocked(isVerbose).mockReturnValue(true);
    mockedLog.mockClear();
    await engine.run('src/Calculator.php', { workDir: '/sb' });
    expect(mockedLog).toHaveBeenCalledWith(expect.stringContaining('PhpEngine: infection'));

    vi.mocked(isVerbose).mockReturnValue(false);
  });

  it('logs Infection stderr in verbose mode, and nothing when stderr is empty', async () => {
    // `isVerbose() && stderr` — both halves matter: a quiet run must not emit
    // an empty "Infection stderr:" line, and a noisy one must surface it.
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockedLog = vi.mocked(log);
    const engine = new PhpEngine();
    vi.mocked(isVerbose).mockReturnValue(true);

    mockInvoke.mockResolvedValue({
      stdout: '',
      stderr: 'deprecation notice',
      exit: 0,
      signal: null,
    });
    mockedLog.mockClear();
    await engine.run('src/Calculator.php', { workDir: '/sb' });
    expect(mockedLog).toHaveBeenCalledWith(expect.stringContaining('Infection stderr:'));

    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });
    mockedLog.mockClear();
    await engine.run('src/Calculator.php', { workDir: '/sb' });
    expect(mockedLog).not.toHaveBeenCalledWith(expect.stringContaining('Infection stderr:'));

    vi.mocked(isVerbose).mockReturnValue(false);
  });

  it('withholds the fidelity advisory when the project config cannot be read', async () => {
    // An unreadable phpunit.xml answers "fails on warning = true", which
    // SUPPRESSES the advisory: the note explains one specific misconfiguration,
    // and speculating about a config we could not read would be noise.
    mockExists.mockImplementation(
      (p) => String(p).endsWith('chaos-infection-log.json') || String(p).endsWith('phpunit.xml'),
    );
    mockRead.mockImplementation((p: unknown) => {
      if (String(p).endsWith('phpunit.xml')) throw new Error('EACCES');
      return SAMPLE_LOG;
    });
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const engine = new PhpEngine();
    const result = await engine.run('src/Calculator.php', { workDir: '/sb' });

    expect(result.survived).toBe(1);
    expect(Object.keys(result)).not.toContain('fidelityNote');
  });

  it('emits the fidelity advisory when the project config does NOT fail on warnings', async () => {
    // The other arm: a readable config that tolerates warnings is exactly the
    // case the advisory exists for.
    mockExists.mockImplementation(
      (p) => String(p).endsWith('chaos-infection-log.json') || String(p).endsWith('phpunit.xml'),
    );
    mockRead.mockImplementation((p: unknown) =>
      String(p).endsWith('phpunit.xml') ? '<phpunit failOnWarning="false"></phpunit>' : SAMPLE_LOG,
    );
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const engine = new PhpEngine();
    const result = await engine.run('src/Calculator.php', { workDir: '/sb' });

    expect(result.fidelityNote).toBeTypeOf('string');
  });

  it.each(['infection.json', 'infection.json5'])(
    'leaves an existing %s in place instead of overwriting it',
    async (configName) => {
      // Infection recognises both spellings. Dropping either name from the list
      // makes the engine overwrite a config the project deliberately shipped.
      mockExists.mockImplementation(
        (p) =>
          String(p).endsWith('chaos-infection-log.json') || String(p).endsWith(`/${configName}`),
      );
      mockRead.mockReturnValue(SAMPLE_LOG);
      mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

      await new PhpEngine().run('src/Calculator.php', { workDir: '/sb' });

      expect(mockWrite).not.toHaveBeenCalledWith(
        expect.stringContaining('infection.json'),
        expect.anything(),
        expect.anything(),
      );
    },
  );

  it.each([
    'phpunit.xml',
    'phpunit.xml.dist',
    'phpunit.dist.xml',
    'phpunit.yml',
    'phpunit.yml.dist',
    'phpunit.dist.yml',
    'phpunit.php',
  ])('reads %s when deciding whether to attach the fidelity advisory', async (configName) => {
    // Each name Infection itself looks for must be probed here too: miss one and
    // a project that DOES set failOnWarning still gets told its survivors may be
    // overstated — advice that does not apply to it.
    mockExists.mockImplementation(
      (p) => String(p).endsWith('chaos-infection-log.json') || String(p).endsWith(`/${configName}`),
    );
    mockRead.mockImplementation((p: unknown) =>
      String(p).endsWith(`/${configName}`) ? '<phpunit failOnWarning="true"/>' : SAMPLE_LOG,
    );
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const result = await new PhpEngine().run('src/Calculator.php', { workDir: '/sb' });

    expect(result.survived).toBe(1);
    expect(Object.keys(result)).not.toContain('fidelityNote');
  });

  it("passes the caller's timeoutMs through to the Infection invocation", async () => {
    // `options?.timeoutMs ?? DEFAULT_TIMEOUT_MS` — as `&&` an explicit timeout
    // is discarded and every run silently takes the 5-minute default.
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const engine = new PhpEngine();
    await engine.run('src/Calculator.php', { workDir: '/sb', timeoutMs: 12_345 });

    expect(mockInvoke.mock.calls[0][3]).toMatchObject({ timeoutMs: 12_345 });
  });

  it('truncates a very long Infection stderr in the verbose log', async () => {
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({
      stdout: '',
      stderr: 'E'.repeat(5000),
      exit: 0,
      signal: null,
    });
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockedLog = vi.mocked(log);
    vi.mocked(isVerbose).mockReturnValue(true);
    mockedLog.mockClear();

    await new PhpEngine().run('src/Calculator.php', { workDir: '/sb' });

    expect(mockedLog).toHaveBeenCalledWith(`Infection stderr: ${'E'.repeat(500)}`);
    vi.mocked(isVerbose).mockReturnValue(false);
  });

  it('builds --threads: phpThreads wins, then concurrency, else max', async () => {
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const engine = new PhpEngine();
    const argsOf = () => mockInvoke.mock.calls[0][2] as string[];

    // phpThreads wins even when concurrency is also set.
    await engine.run('src/Calculator.php', { workDir: '/sb', phpThreads: '3', concurrency: 4 });
    expect(argsOf()).toContain('--threads=3');

    mockInvoke.mockClear();
    await engine.run('src/Calculator.php', { workDir: '/sb', concurrency: 4 });
    expect(argsOf()).toContain('--threads=4');

    mockInvoke.mockClear();
    await engine.run('src/Calculator.php', { workDir: '/sb' });
    expect(argsOf()).toContain('--threads=max');
  });
});

describe('infectionDiagnostics', () => {
  // Regression: Infection reports startup failures on its OWN stdout, not
  // stderr. The engine used to interpolate only `stderr`, so a real failure —
  // e.g. PHPUnit halting on a coverage-scope warning under Infection's
  // stopOnDefect — surfaced as a bare "stderr:" with nothing after it.
  it('surfaces stdout, where Infection writes its error block', () => {
    const out = infectionDiagnostics({
      stdout: '[ERROR] Project tests must be in a passing state before running Infection.',
      stderr: '',
    });
    expect(out).toContain('Infection output (tail)');
    expect(out).toContain('must be in a passing state');
  });

  it('includes both streams when each has content, stdout first', () => {
    const out = infectionDiagnostics({ stdout: 'STDOUT_MARKER', stderr: 'STDERR_MARKER' });
    expect(out).toContain('STDOUT_MARKER');
    expect(out).toContain('STDERR_MARKER');
    expect(out.indexOf('STDOUT_MARKER')).toBeLessThan(out.indexOf('STDERR_MARKER'));
  });

  it('keeps the TAIL of a long stream, where the cause lives', () => {
    // Infection prints a banner and progress dots first; the error block is last.
    const long = `BANNER${'.'.repeat(5000)}THE_ACTUAL_ERROR`;
    const out = infectionDiagnostics({ stdout: long });
    expect(out).toContain('THE_ACTUAL_ERROR');
    expect(out).not.toContain('BANNER');
    expect(out).toContain('…');
  });

  it('reports explicitly when both streams are empty', () => {
    expect(infectionDiagnostics({ stdout: '', stderr: '' })).toBe(
      '(Infection produced no output on stdout or stderr.)',
    );
    expect(infectionDiagnostics({})).toBe('(Infection produced no output on stdout or stderr.)');
  });

  // The next four cases pin behaviour that mutation testing found unprotected:
  // trimEnd-vs-trimStart, the truncation boundary, tail-vs-head slicing, and the
  // blank line between the two sections.
  it('strips only TRAILING whitespace, keeping leading indentation', () => {
    // Infection indents its error block; that indentation is meaningful context.
    const out = infectionDiagnostics({ stdout: '  indented line\ntrailing  \n' });
    expect(out).toContain('\n  indented line');
    expect(out.endsWith('trailing')).toBe(true);
  });

  it('does NOT truncate a stream exactly at the tail limit', () => {
    // DIAGNOSTIC_TAIL_CHARS is 2000; the comparison must be `>`, not `>=`.
    const exact = 'A'.repeat(2000);
    const out = infectionDiagnostics({ stdout: exact });
    expect(out).not.toContain('…');
    expect(out).toContain(exact);
  });

  it('slices from the END, keeping content that a head-slice would drop', () => {
    // Length 2411. A tail slice keeps the last 2000 chars (MID + TAIL); a head
    // slice from index 2000 would keep only ~400 chars and lose MID.
    const stream = `HEAD${'x'.repeat(1500)}MID${'y'.repeat(900)}TAIL`;
    const out = infectionDiagnostics({ stdout: stream });
    expect(out).toContain('MID');
    expect(out).toContain('TAIL');
    expect(out).not.toContain('HEAD');
  });

  it('separates the two sections with a blank line', () => {
    const out = infectionDiagnostics({ stdout: 'OUT', stderr: 'ERR' });
    expect(out).toContain('OUT\n\nstderr (tail):');
  });

  it('ignores a stream that is only whitespace', () => {
    const out = infectionDiagnostics({ stdout: '   \n\n  ', stderr: 'real failure' });
    expect(out).not.toContain('Infection output (tail)');
    expect(out).toContain('stderr (tail)');
  });
});

describe('diagnoseInfectionStartupFailure', () => {
  it('explains the exit-code-143 case as Infection killing its own test run', () => {
    // Infection's InitialTestsRunner stops the process on the FIRST byte written
    // to STDERR, so PHPUnit exits 143 (SIGTERM) even when every test passed.
    // Reporting it as a failing suite sends the caller hunting a bug that is not
    // there.
    const out = diagnoseInfectionStartupFailure(
      '[ERROR] Project tests must be in a passing state before running Infection.\n' +
        'PHPUnit reported an exit code of 143.',
    );
    expect(out).toContain('first byte');
    expect(out).toContain('STDERR');
    expect(out).toContain('vendor/bin/phpunit 2>/tmp/suite.err');
  });

  it('explains the coverage-scope warning as a --filter artefact, not a test failure', () => {
    const out = diagnoseInfectionStartupFailure(
      'Warning: Class Foo is not a valid target for code coverage',
    );
    expect(out).toContain('coverage-scope warning');
    expect(out).toContain('stopOnDefect');
    expect(out).toContain('--filter');
  });

  it('returns null for output matching neither known signature', () => {
    // Null is the signal to fall back to the raw diagnostics; inventing an
    // explanation for an unrecognised failure would mislead.
    expect(diagnoseInfectionStartupFailure('some unrelated failure')).toBeNull();
    expect(diagnoseInfectionStartupFailure('')).toBeNull();
  });

  it('does not fire on an exit code that merely contains 143', () => {
    // The probe matches the phrase "exit code of 143", not a bare number, so a
    // line quoting e.g. 1143 or a duration of 143ms must not be diagnosed.
    expect(diagnoseInfectionStartupFailure('finished in 143ms with exit code 1')).toBeNull();
  });

  it('prefers the 143 diagnosis when both signatures appear', () => {
    // Order matters: the SIGTERM explanation is the root cause, and the coverage
    // warning is frequently present in the same tail.
    const out = diagnoseInfectionStartupFailure(
      'is not a valid target for code coverage\nexit code of 143',
    );
    expect(out).toContain('first byte');
    expect(out).not.toContain('coverage-scope warning');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// explainMissingJsonLog — the three-way failure diagnosis extracted out of
// `run`. It RETURNS the error instead of throwing it, so each branch (and the
// most-specific-first order between them) is a direct assertion.
// ─────────────────────────────────────────────────────────────────────────────
describe('explainMissingJsonLog', () => {
  const failure = (opts: { stdout?: string; stderr?: string; exit?: number | null }) =>
    new ExecFailureError(
      {
        stdout: opts.stdout ?? '',
        stderr: opts.stderr ?? '',
        exit: opts.exit ?? 1,
        signal: null,
        code: undefined,
      },
      'Infection failed',
    );

  it('returns the error rather than throwing it', () => {
    const returned = explainMissingJsonLog(failure({}), '/sb', true);
    expect(returned).toBeInstanceOf(Error);
  });

  it('blames the missing PHPUnit config when we generated the Infection config', () => {
    // No project Infection config (hasProjectConfig=false) and no phpunit.* at
    // all: our generated config targets PHPUnit, so Infection can never run.
    mockExists.mockReturnValue(false);
    const message = explainMissingJsonLog(failure({ stdout: 'banner' }), '/sb', false).message;
    expect(message).toContain(
      'Infection could not run: no PHPUnit configuration found (looked for',
    );
    expect(message).toContain('phpunit.xml, phpunit.xml.dist');
    expect(message).toContain('ship an Infection config (infection.json/infection.json5)');
    expect(message).toContain('Infection output (tail):\nbanner');
  });

  it('does not blame the missing PHPUnit config when the project ships its own Infection config', () => {
    // A project with its own Infection config may deliberately target another
    // framework, so the PHPUnit branch must not fire for it.
    mockExists.mockReturnValue(false);
    const message = explainMissingJsonLog(failure({ exit: 7 }), '/sb', true).message;
    expect(message).toContain('Infection failed (exit 7) without producing a JSON log.');
    expect(message).not.toContain('no PHPUnit configuration found');
  });

  it('surfaces a named startup failure when Infection output identifies one', () => {
    mockExists.mockImplementation((p) => String(p).endsWith('phpunit.xml'));
    const message = explainMissingJsonLog(
      failure({ stdout: 'Project tests must be in a passing state\nexit code of 143', exit: 1 }),
      '/sb',
      false,
    ).message;
    expect(message).toContain('Infection failed (exit 1) without producing a JSON log.');
    expect(message).toContain('stops the test process on the first byte');
    expect(message).toContain('Infection output (tail):');
  });

  it('reads the named startup failure from stderr as well as stdout', () => {
    mockExists.mockImplementation((p) => String(p).endsWith('phpunit.xml'));
    const message = explainMissingJsonLog(
      failure({ stderr: 'is not a valid target for code coverage' }),
      '/sb',
      false,
    ).message;
    expect(message).toContain('PHPUnit stopped on a coverage-scope warning');
  });

  it('falls back to the generic suite/coverage-driver guidance', () => {
    mockExists.mockImplementation((p) => String(p).endsWith('phpunit.xml'));
    const message = explainMissingJsonLog(
      failure({ stderr: 'something unrecognised', exit: 255 }),
      '/sb',
      false,
    ).message;
    expect(message).toBe(
      'Infection failed (exit 255) without producing a JSON log. This usually means ' +
        'the initial test run failed — ensure the PHPUnit suite passes (vendor/bin/phpunit) and a ' +
        'coverage driver (Xdebug or PCOV) is enabled.\nstderr (tail):\nsomething unrecognised',
    );
  });

  it('prefers the missing-PHPUnit-config branch over a named startup failure', () => {
    // Branch order is load-bearing: with no PHPUnit config at all, "add a
    // phpunit.xml" is the actionable cause even when the output also carries a
    // recognisable startup signature.
    mockExists.mockReturnValue(false);
    const message = explainMissingJsonLog(
      failure({ stdout: 'exit code of 143' }),
      '/sb',
      false,
    ).message;
    expect(message).toContain('no PHPUnit configuration found');
    expect(message).not.toContain('first byte');
  });

  it('accepts any of the recognised PHPUnit config names as proof of a runner', () => {
    for (const name of [
      'phpunit.xml',
      'phpunit.xml.dist',
      'phpunit.dist.xml',
      'phpunit.yml',
      'phpunit.yml.dist',
      'phpunit.dist.yml',
      'phpunit.php',
    ]) {
      mockExists.mockImplementation((p) => String(p).endsWith(name));
      expect(explainMissingJsonLog(failure({}), '/sb', false).message).not.toContain(
        'no PHPUnit configuration found',
      );
    }
  });
});
