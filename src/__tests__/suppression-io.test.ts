import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadVerifiedSuppressions, applyAndCountSuppressions } from '../audit/suppression-io.js';
import type { MutationResult } from '../engines/base.js';

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
  vulnerabilities: [{ line: 1, mutator: 'ConditionalExpression', kind: 'survived' }],
});

describe('loadVerifiedSuppressions', () => {
  it('applies an entry whose fingerprint still matches its source line', () => {
    writeSuppressions([
      { line: 1, mutator: 'ConditionalExpression', reason: 'ok', fingerprint: LINE_1_FINGERPRINT },
    ]);

    const verdict = loadVerifiedSuppressions(ws, REL, undefined);

    expect(verdict.applied.has('1 ConditionalExpression')).toBe(true);
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

    expect(verdict.applied.size).toBe(0);
    expect(verdict.drifted).toBe(1);
    expect(verdict.unverified).toBe(0);
  });

  it('counts an unfingerprinted entry as unverified, not as drifted', () => {
    // v1 data. It cannot be proven to still point at the code it was argued about, and
    // back-filling a fingerprint from today's source would bless exactly the mismatch
    // the feature exists to catch. Reported separately so the caller can re-confirm it.
    writeSuppressions([{ line: 1, mutator: 'ConditionalExpression', reason: 'v1' }]);

    const verdict = loadVerifiedSuppressions(ws, REL, undefined);

    expect(verdict.applied.size).toBe(0);
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

    expect(verdict.applied.size).toBe(0);
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
});
