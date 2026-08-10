import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadVerifiedSuppressions, applyAndCountSuppressions } from '../audit/suppression-io.js';
import type { MutationResult } from '../engines/base.js';
import { appliedKeys } from './support/suppression-verdict.js';

/**
 * `audit/suppression-io.ts` had no test file. It owns the rule that decides whether a
 * recorded suppression still applies, and that rule is load-bearing: auditing this repo
 * found 125 of its 127 stored entries inert, every one of them silently, because a
 * suppression only applies when its content fingerprint still matches the line it was
 * argued about.
 *
 * The three verdicts are pinned separately — applied, drifted, unverified — because
 * they mean different things to a caller. Drifted says "this was argued about, but the
 * code moved"; unverified says "this predates fingerprinting and was never checked".
 * Collapsing either into "not applied" would lose the reason.
 */

const REL = 'src/target.ts';
const LINE_1 = 'export const a = 1;';
/**
 * The digest of LINE_1 under the current normalise-then-hash rule, written out rather
 * than computed with fingerprintOfLine. This value is PERSISTED in every user's
 * suppressions file, so a change to the hash silently invalidates all of them; pinning
 * the literal makes that break a test instead of a user's suppressions.
 */
const LINE_1_FINGERPRINT = '683314ed2211';

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'chaos-sup-io-'));
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, REL), `${LINE_1}\nconst b = 2;\n`);
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

function writeSuppressions(entries: Record<string, unknown>[]): void {
  mkdirSync(join(ws, '.chaos-mcp'), { recursive: true });
  writeFileSync(
    join(ws, '.chaos-mcp', 'suppressions.json'),
    JSON.stringify({ version: 2, entries: { [REL]: entries } }),
  );
}

const result = (): MutationResult => ({
  target: REL,
  totalMutants: 4,
  killed: 3,
  survived: 1,
  mutationScore: '75.00%',
  vulnerabilities: [
    {
      line: 1,
      mutator: 'ConditionalExpression',
      kind: 'survived',
      description: 'ConditionalExpression survived at line 1',
    },
  ],
});

describe('loadVerifiedSuppressions', () => {
  it('applies an entry whose fingerprint still matches its source line', () => {
    writeSuppressions([
      { line: 1, mutator: 'ConditionalExpression', reason: 'ok', fingerprint: LINE_1_FINGERPRINT },
    ]);

    const verdict = loadVerifiedSuppressions(ws, REL, undefined);

    expect(appliedKeys(verdict).includes('1 ConditionalExpression')).toBe(true);
    expect(verdict.drifted).toBe(0);
    expect(verdict.unverified).toBe(0);
  });

  it('counts an entry as drifted when the line it targets has changed', () => {
    // The whole point of the fingerprint: the argument was made about different code,
    // so the suppression must stop applying rather than silently cover whatever moved
    // onto that line.
    writeSuppressions([
      { line: 1, mutator: 'ConditionalExpression', reason: 'stale', fingerprint: 'deadbeef' },
    ]);

    const verdict = loadVerifiedSuppressions(ws, REL, undefined);

    expect(appliedKeys(verdict).length).toBe(0);
    expect(verdict.drifted).toBe(1);
    expect(verdict.unverified).toBe(0);
  });

  it('counts an unfingerprinted entry as unverified, not as drifted', () => {
    // v1 data. It cannot be proven to still point at the code it was argued about, and
    // back-filling a fingerprint from today's source would bless exactly the mismatch
    // the feature exists to catch. Reported separately so the caller can re-confirm it.
    writeSuppressions([{ line: 1, mutator: 'ConditionalExpression', reason: 'v1' }]);

    const verdict = loadVerifiedSuppressions(ws, REL, undefined);

    expect(appliedKeys(verdict).length).toBe(0);
    expect(verdict.unverified).toBe(1);
    expect(verdict.drifted).toBe(0);
  });

  it('counts an entry pointing past the end of the file as drifted', () => {
    writeSuppressions([
      { line: 99, mutator: 'ConditionalExpression', reason: 'gone', fingerprint: 'deadbeef' },
    ]);

    expect(loadVerifiedSuppressions(ws, REL, undefined).drifted).toBe(1);
  });

  it('reports nothing when no suppressions file exists', () => {
    const verdict = loadVerifiedSuppressions(ws, REL, undefined);

    expect(appliedKeys(verdict).length).toBe(0);
    expect(verdict.drifted).toBe(0);
    expect(verdict.unverified).toBe(0);
  });
});

describe('applyAndCountSuppressions', () => {
  it('filters a verified suppression out of the score and reports the count', () => {
    writeSuppressions([
      { line: 1, mutator: 'ConditionalExpression', reason: 'ok', fingerprint: LINE_1_FINGERPRINT },
    ]);

    return applyAndCountSuppressions({}, result(), undefined, ws, REL, undefined).then(
      (outcome) => {
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.counts.applied).toBe(1);
        expect(outcome.result.totalMutants).toBe(3);
      },
    );
  });

  it('reports drift without filtering anything', () => {
    writeSuppressions([
      { line: 1, mutator: 'ConditionalExpression', reason: 'stale', fingerprint: 'deadbeef' },
    ]);

    return applyAndCountSuppressions({}, result(), undefined, ws, REL, undefined).then(
      (outcome) => {
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.counts.applied).toBe(0);
        expect(outcome.counts.drifted).toBe(1);
        expect(outcome.result.totalMutants).toBe(4);
      },
    );
  });

  it('does not filter in verify mode', async () => {
    // In verify mode the delta owns the filtering. Removing a now-suppressed mutant
    // from the re-run but not from the baseline would make computeVerifyDelta report it
    // as "now killed" — a fix the caller never made.
    writeSuppressions([
      { line: 1, mutator: 'ConditionalExpression', reason: 'ok', fingerprint: LINE_1_FINGERPRINT },
    ]);

    const outcome = await applyAndCountSuppressions(
      {},
      result(),
      [{ line: 1, mutator: 'ConditionalExpression' }],
      ws,
      REL,
      undefined,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.counts.applied).toBe(0);
    expect(outcome.result.totalMutants).toBe(4);
  });

  it('writes nothing when the request was already cancelled', async () => {
    // A cancelled call must stay side-effect free. The suppressions file is committed
    // to the user's repo, so a write from a run they aborted is a change they never
    // asked for and would have to notice in a diff.
    const controller = new AbortController();
    controller.abort();

    const outcome = await applyAndCountSuppressions(
      { suppress: [{ line: 1, mutator: 'ConditionalExpression', reason: 'nope' }] },
      result(),
      undefined,
      ws,
      REL,
      undefined,
      { signal: controller.signal },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect((outcome.result.content[0] as { text: string }).text).toContain('Operation cancelled.');
    expect(existsSync(join(ws, '.chaos-mcp', 'suppressions.json'))).toBe(false);
  });

  it('records a suppression the caller asked for', async () => {
    const outcome = await applyAndCountSuppressions(
      { suppress: [{ line: 1, mutator: 'ConditionalExpression', reason: 'equivalent' }] },
      result(),
      undefined,
      ws,
      REL,
      undefined,
    );

    expect(outcome.ok).toBe(true);
    const written = JSON.parse(
      readFileSync(join(ws, '.chaos-mcp', 'suppressions.json'), 'utf8'),
    ) as { entries: Record<string, { fingerprint?: string }[]> };
    // Stamped with the fingerprint of the line as it reads right now, so a later edit to
    // that line retires the suppression instead of re-pointing it at whatever replaces it.
    expect(written.entries[REL][0].fingerprint).toBe(LINE_1_FINGERPRINT);
  });

  describe('orphaned count', () => {
    // Every case below stores one entry that verifies fine (fingerprint matches
    // line 1, so it lands in `verdict.applied`) but names a mutator
    // ('EqualityOperator') the result's only vulnerability does not carry (it is
    // 'ConditionalExpression'). That makes the applied key match nothing —
    // exactly the orphan case — regardless of scope, so these four tests isolate
    // the gate in `applyAndCountSuppressions` that decides whether to report it.
    function writeOrphanEntry(): void {
      writeSuppressions([
        { line: 1, mutator: 'EqualityOperator', reason: 'gone', fingerprint: LINE_1_FINGERPRINT },
      ]);
    }

    it('reports the orphan count for a whole-file (TypeScript-shaped) run', async () => {
      writeOrphanEntry();

      const outcome = await applyAndCountSuppressions(
        {},
        { ...result(), scopeKind: 'whole-file' },
        undefined,
        ws,
        REL,
        undefined,
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.counts.orphaned).toBe(1);
    });

    it('suppresses the orphan count for a whole-file run that stopped early', async () => {
      // `scopeKind` records the REQUESTED scope, so `mergeBatchResults`
      // (engines/typescript/batches.ts) stamps 'whole-file' even when the time
      // budget stopped the run after 3 of 7 batches. Every suppression whose
      // (line, mutator) lives in a batch that never ran matched nothing for a
      // reason that says nothing about the suppression — reporting those as
      // orphaned is the cry-wolf failure this gate exists to prevent, on the
      // one engine that batches by default.
      writeOrphanEntry();

      const outcome = await applyAndCountSuppressions(
        {},
        {
          ...result(),
          scopeKind: 'whole-file',
          complete: false,
          batchesCompleted: 3,
          batchesPlanned: 7,
        },
        undefined,
        ws,
        REL,
        undefined,
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.counts.orphaned).toBe(0);
    });

    it('still reports the orphan count when a batched run completed', async () => {
      // The other side of the `complete` conjunct: `complete: true` is the
      // normal batched outcome and must not be read as "partial".
      writeOrphanEntry();

      const outcome = await applyAndCountSuppressions(
        {},
        { ...result(), scopeKind: 'whole-file', complete: true },
        undefined,
        ws,
        REL,
        undefined,
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.counts.orphaned).toBe(1);
    });

    it('suppresses the orphan count for a scoped run', async () => {
      writeOrphanEntry();

      const outcome = await applyAndCountSuppressions(
        {},
        { ...result(), scopeKind: 'scoped' },
        undefined,
        ws,
        REL,
        undefined,
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.counts.orphaned).toBe(0);
    });

    it('falls back to whole-file for a result that never sets scopeKind', async () => {
      // Rust, Python and PHP never set `scopeKind` at all — only TypeScript
      // does — and since none of them supports line-scoping
      // (`supportsLineScope: false` in engines/registry.ts) every run of
      // theirs IS whole-file. Without the TRANSITIONAL fallback this case
      // silently hard-wires `orphaned` to 0 for three of the four engines,
      // including the Rust one the whole feature exists for.
      writeOrphanEntry();

      const outcome = await applyAndCountSuppressions({}, result(), undefined, ws, REL, undefined);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.counts.orphaned).toBe(1);
    });

    it('still reports the orphan when a whole-file run carries a diffBase scope note', async () => {
      // The reason the three non-TypeScript engines now SET `scopeKind`
      // themselves rather than relying on the fallback below. A Rust, Python or
      // PHP audit run with `diffBase` is still a whole-file run — none of them
      // supports line scoping — but `handler.ts` appends "diffBase scoping is
      // not supported for <lang>; mutated the whole file" to the result BEFORE
      // the suppression phase. Under the fallback alone that note made
      // `isWholeFileRun` false, so `orphaned` was hard-wired to 0 on every
      // diffBase run of exactly the engines this counter was built for — and
      // the triage side, which gates on the result before the note is attached,
      // reported the same run's orphan. The explicit `scopeKind` settles both.
      writeOrphanEntry();

      const outcome = await applyAndCountSuppressions(
        {},
        {
          ...result(),
          scopeKind: 'whole-file',
          scopeNote: 'diffBase scoping is not supported for rust; mutated the whole file.',
        },
        undefined,
        ws,
        REL,
        undefined,
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.counts.orphaned).toBe(1);
    });

    it('does not report orphans for a scopeNote-carrying result with no scopeKind', async () => {
      // The other side of the fallback: a scopeKind-less zero that DOES carry a
      // scopeNote is the one non-enumerating shape the fallback must still
      // exclude (the twin of hasNoMutableLogic's same exclusion for StrykerJS
      // dryRun).
      writeOrphanEntry();

      const outcome = await applyAndCountSuppressions(
        {},
        { ...result(), scopeNote: 'Partial audit: 1 of 3.' },
        undefined,
        ws,
        REL,
        undefined,
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.counts.orphaned).toBe(0);
    });

    it('still reports the orphan when suppression itself synthesises a scopeNote', async () => {
      // The gate must read the PRE-suppression result. `applySuppressions`
      // synthesises a scopeNote ("All N mutant(s) ... suppressed as
      // equivalent") whenever suppression drives totalMutants to exactly 0 —
      // and that synthesised note is a statement about SUPPRESSION, not about
      // scope. If the gate reads the POST-suppression result instead, that
      // note flips the scopeKind-less fallback from true to false and masks a
      // real orphan in exactly the case this counter exists for: every mutant
      // in the file declared equivalent, and one of those declarations gone
      // stale.
      //
      // Two entries in the same batch: the ConditionalExpression suppression
      // matches the file's only vulnerability and alone exhausts
      // totalMutants (1 -> 0), triggering the synthesised scopeNote. The
      // EqualityOperator suppression is fingerprint-verified (so it lands in
      // `verdict.applied`) but names a mutator nothing in the result carries
      // — the orphan.
      writeSuppressions([
        {
          line: 1,
          mutator: 'ConditionalExpression',
          reason: 'ok',
          fingerprint: LINE_1_FINGERPRINT,
        },
        { line: 1, mutator: 'EqualityOperator', reason: 'gone', fingerprint: LINE_1_FINGERPRINT },
      ]);

      const oneMutantResult: MutationResult = {
        target: REL,
        totalMutants: 1,
        killed: 0,
        survived: 1,
        mutationScore: '0.00%',
        vulnerabilities: [
          {
            line: 1,
            mutator: 'ConditionalExpression',
            kind: 'survived',
            description: 'ConditionalExpression survived at line 1',
          },
        ],
        // scopeKind-less, Rust/PHP/Python-shaped: the fallback branch of
        // isWholeFileRun is the one under test.
      };

      const outcome = await applyAndCountSuppressions(
        {},
        oneMutantResult,
        undefined,
        ws,
        REL,
        undefined,
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      // Confirms the synthesised-scopeNote branch was actually reached, so a
      // future change that stops synthesising it can't make this test pass
      // for the wrong reason.
      expect(outcome.result.totalMutants).toBe(0);
      expect(outcome.result.scopeNote).toContain('suppressed as equivalent');
      expect(outcome.counts.orphaned).toBe(1);
    });
  });
});

/**
 * A `suppress` argument the write REFUSED.
 *
 * `addSuppressions` turns away an entry whose target line is blank or
 * comment-only, because no engine reports a mutant at a position inside a
 * comment. The refusal has to reach the caller: the entry is not stored, so no
 * later run will ever mention it, and the caller would otherwise believe their
 * suppression landed. Auditing this repo found 40 stored entries in exactly
 * that state — pointing at comments, applying to nothing, and reported by
 * nothing.
 */
describe('applyAndCountSuppressions — refused entries', () => {
  it('counts a suppression aimed at a comment line', async () => {
    writeFileSync(join(ws, REL), `${LINE_1}\n// a comment, not a mutant site\n`);

    const outcome = await applyAndCountSuppressions(
      { suppress: [{ line: 2, mutator: 'ConditionalExpression', reason: 'looked equivalent' }] },
      result(),
      undefined,
      ws,
      REL,
      undefined,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.counts.rejected).toBe(1);
    // And nothing was written for it, which is the point of the count.
    expect(appliedKeys(loadVerifiedSuppressions(ws, REL, undefined)).length).toBe(0);
  });

  it('reports zero refusals when the target is real code', async () => {
    const outcome = await applyAndCountSuppressions(
      { suppress: [{ line: 1, mutator: 'ConditionalExpression', reason: 'equivalent' }] },
      result(),
      undefined,
      ws,
      REL,
      undefined,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.counts.rejected).toBe(0);
    expect(appliedKeys(loadVerifiedSuppressions(ws, REL, undefined)).length).toBe(1);
  });
});

/**
 * The write half of `applyAndCountSuppressions`, which had no direct coverage:
 * the unsuppress branch, the write-failure return, and the counts a call that
 * asked for nothing reports.
 */
describe('applyAndCountSuppressions — the write path', () => {
  it('honours an unsuppress request', async () => {
    // Nothing exercised the removal branch, so it could be skipped entirely and
    // the caller's explicit "drop this entry" would silently do nothing — while
    // the entry kept excluding its mutant from every later score.
    writeSuppressions([
      { line: 1, mutator: 'ConditionalExpression', reason: 'ok', fingerprint: LINE_1_FINGERPRINT },
    ]);

    const outcome = await applyAndCountSuppressions(
      { unsuppress: [{ line: 1, mutator: 'ConditionalExpression' }] },
      result(),
      undefined,
      ws,
      REL,
      undefined,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(appliedKeys(loadVerifiedSuppressions(ws, REL, undefined)).length).toBe(0);
    // The mutant it used to hide is scored again.
    expect(outcome.counts.applied).toBe(0);
    expect(outcome.result.totalMutants).toBe(4);
  });

  it('surfaces a write failure as its own error rather than continuing', async () => {
    // A directory where the suppressions file belongs makes the read throw
    // EISDIR, which the write layer wraps and rethrows. The caller must get
    // "Failed to update suppression list" — swallowing it would report a
    // successful audit whose suppression edit never landed.
    mkdirSync(join(ws, '.chaos-mcp', 'suppressions.json'), { recursive: true });

    const outcome = await applyAndCountSuppressions(
      { suppress: [{ line: 1, mutator: 'ConditionalExpression', reason: 'equivalent' }] },
      result(),
      undefined,
      ws,
      REL,
      undefined,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect((outcome.result.content[0] as { text: string }).text).toContain(
      'Failed to update suppression list',
    );
  });

  it('reports no refusals when the call asked for no suppressions at all', async () => {
    // `rejected` is read off the initialiser on this path, so a seeded value
    // there would tell every ordinary audit that it had entries refused.
    const outcome = await applyAndCountSuppressions({}, result(), undefined, ws, REL, undefined);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.counts.rejected).toBe(0);
  });
});
