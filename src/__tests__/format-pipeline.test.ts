import { describe, it, expect } from 'vitest';
import { buildResultPayload, formatResultAsText } from '../core/format.js';
import type { MutationResult, Vulnerability } from '../engines/base.js';

/**
 * The group pipeline in `core/format.ts` — compact, enrich, floor, cap, and the
 * worst-severity reduce — reached through its two exported entry points.
 *
 * These cover what a mutation audit of the module found unpinned: the ORDER
 * survivors are reported in, the optional keys the payload adds only when it has
 * something to say, and the notes that explain a partial or filtered run. Every
 * one of them is what a caller reads; none of them had a test that could fail.
 */

const vuln = (over: Partial<Vulnerability> = {}): Vulnerability => ({
  line: 1,
  mutator: 'ConditionalExpression',
  description: 'survived',
  kind: 'survived',
  ...over,
});

const result = (over: Partial<MutationResult> = {}): MutationResult => ({
  target: 'src/x.ts',
  totalMutants: 10,
  killed: 8,
  survived: 2,
  mutationScore: '80.00%',
  vulnerabilities: [],
  ...over,
});

/** Enrichment needs a project type; the source lines only feed context snippets. */
const enrich = { projectType: 'typescript' as const, sourceLines: undefined };

describe('survivor ordering', () => {
  it('lists equally-severe groups in ascending line order', () => {
    // The sort is `severity DESC, then line ASC`. The tie-break is the only
    // thing deciding order among the (very common) equal-severity groups, and
    // an always-positive comparator silently reverses them — so the report
    // walks the file backwards.
    const payload = buildResultPayload(
      result({
        vulnerabilities: [vuln({ line: 30 }), vuln({ line: 10 }), vuln({ line: 20 })],
      }),
      { enrich },
    );

    expect(payload.survivors.map((g) => g.line)).toEqual([10, 20, 30]);
  });

  it('still puts a higher severity first, ahead of a lower one on an earlier line', () => {
    // The tie-break must not outrank severity itself.
    const payload = buildResultPayload(
      result({
        vulnerabilities: [
          vuln({ line: 5, mutator: 'SomeUnmappedMutator' }), // unknown → lowest
          vuln({ line: 50, mutator: 'ConditionalExpression' }), // high
        ],
      }),
      { enrich },
    );

    expect(payload.survivors[0].line).toBe(50);
  });
});

describe('change strings degrade rather than inventing one', () => {
  it('omits `changes` entirely when neither side of the edit is known', () => {
    // buildChange returns undefined when both halves are empty, and the group
    // then carries no `changes` key at all. Returning the empty original
    // instead puts `changes: ['']` on the group — a sampled edit that says
    // nothing, in a field the schema documents as real edits.
    const payload = buildResultPayload(
      result({ vulnerabilities: [vuln({ original: '', mutated: '' })] }),
    );

    expect(Object.keys(payload.survivors[0])).not.toContain('changes');
    expect(payload.note).not.toContain('changes = sampled');
  });

  it('surfaces the original alone when only the mutated side is missing', () => {
    const payload = buildResultPayload(
      result({ vulnerabilities: [vuln({ original: 'a > b', mutated: '' })] }),
    );

    expect(payload.survivors[0].changes).toEqual(['a > b']);
  });

  it('surfaces the mutated alone when only the original is missing', () => {
    const payload = buildResultPayload(
      result({ vulnerabilities: [vuln({ original: '', mutated: 'a >= b' })] }),
    );

    expect(payload.survivors[0].changes).toEqual(['a >= b']);
  });
});

describe('optional payload keys', () => {
  it('omits worstSeverity from the summary when the run was not enriched', () => {
    // Assigning it unconditionally puts `worstSeverity: undefined` on the
    // summary — a key a consumer can enumerate and sort on.
    const payload = buildResultPayload(result({ vulnerabilities: [vuln()] }));

    expect(Object.keys(payload.summary).sort()).toEqual(['killed', 'survived', 'total']);
  });

  it('reports worstSeverity once enrichment has a severity to report', () => {
    const payload = buildResultPayload(result({ vulnerabilities: [vuln()] }), { enrich });

    expect(payload.summary.worstSeverity).toBe('high');
  });

  it('omits the hidden-groups warning when nothing was hidden', () => {
    const payload = buildResultPayload(result({ vulnerabilities: [vuln()] }));

    expect(payload.note).not.toContain('INCOMPLETE LIST');
    expect(Object.keys(payload)).not.toContain('survivorsTruncated');
  });

  it('counts every hiding mechanism toward the incomplete-list warning', () => {
    // The four counters are SUMMED. A minus sign anywhere in that sum can zero
    // the total out and drop the warning from a response that really is
    // partial — the exact response `audit/scope.ts` refuses as a baseline.
    const payload = buildResultPayload(
      result({
        vulnerabilities: [vuln({ line: 1 }), vuln({ line: 2 }), vuln({ line: 3 })],
      }),
      { maxSurvivors: 1 },
    );

    expect(payload.survivorsTruncated).toBe(2);
    expect(payload.note).toContain('INCOMPLETE LIST: 2 line group(s) are hidden');
  });
});

describe('the unclassified-mutator note', () => {
  it('falls back to the generic wording for a project type the registry lacks', () => {
    // Reading the engine descriptor without the optional link throws a
    // TypeError on an unrecognised project type — on the reporting path of
    // every audit that produced an unclassifiable mutant.
    const payload = buildResultPayload(
      result({ vulnerabilities: [vuln({ mutator: 'SomeUnmappedMutator' })] }),
      { enrich: { projectType: 'cobol' as never, sourceLines: undefined } },
    );

    expect(payload.enrichNote).toContain('could not be classified');
    expect(payload.enrichNote).toContain('cobol');
  });
});

describe('the partial-run note', () => {
  const partial = (over: Partial<MutationResult> = {}) =>
    result({
      complete: false,
      batchesCompleted: 2,
      batchesPlanned: 7,
      stoppedReason: 'time_budget_exhausted',
      vulnerabilities: [],
      survived: 0,
      killed: 10,
      ...over,
    });

  it('names the batches that ran when both counts are known', () => {
    const payload = buildResultPayload(partial());

    expect(payload.note).toContain('the 2 of 7 batches that completed');
  });

  it.each([
    ['no plan', { batchesCompleted: 2, batchesPlanned: undefined }],
    ['no completed count', { batchesCompleted: undefined, batchesPlanned: 7 }],
    ['neither', { batchesCompleted: undefined, batchesPlanned: undefined }],
  ])('degrades to vaguer wording when the batch counts are %s', (_label, counts) => {
    // Only a HALF-known pair distinguishes `&&` from `||`; with both absent the
    // two operators agree. `||` would print "the 2 of undefined batches that
    // completed", which reads as a measurement.
    const payload = buildResultPayload(partial(counts));

    expect(payload.note).toContain('the part of this file that was measured');
    expect(payload.note).not.toContain('undefined');
  });

  it('distinguishes an exhausted budget from any other early stop', () => {
    expect(buildResultPayload(partial()).note).toContain('the time budget was exhausted');
    expect(buildResultPayload(partial({ stoppedReason: undefined })).note).toContain(
      'the run stopped before the rest could run',
    );
  });
});

describe('the severity-floor note in text output', () => {
  it('explains an empty report caused entirely by the floor', () => {
    // Every group filtered out: both render blocks are skipped, so without this
    // the report ended on "targeting these lines" with no lines above it.
    const text = formatResultAsText(
      result({ vulnerabilities: [vuln({ mutator: 'SomeUnmappedMutator' })] }),
      enrich,
      { severityFloor: 'high' },
    );

    expect(text).toContain('hidden below severityFloor');
    expect(text).toContain('Lower severityFloor to see them');
    expect(text).not.toContain('Add or strengthen tests targeting these lines');
  });

  it('keeps the ordinary advice when the floor hid nothing', () => {
    const text = formatResultAsText(result({ vulnerabilities: [vuln()] }), enrich, {
      severityFloor: 'high',
    });

    expect(text).not.toContain('hidden below severityFloor');
    expect(text).toContain('Add or strengthen tests targeting these lines');
  });

  it('does not claim everything was filtered when no-coverage groups survived', () => {
    // The note says "every surviving line group was filtered out, so none are
    // listed above" — a claim that is false while the no-coverage block still
    // has rows to print. All three conjuncts have to hold.
    const text = formatResultAsText(
      result({
        vulnerabilities: [
          vuln({ line: 1, mutator: 'SomeUnmappedMutator' }), // survivor, filtered by the floor
          vuln({ line: 2, kind: 'noCoverage' }), // high — survives the floor
        ],
      }),
      enrich,
      { severityFloor: 'high' },
    );

    expect(text).not.toContain('every surviving line group was filtered out');
  });

  it('does not blame the floor when the cap is what emptied the report', () => {
    // Reaching this line with nothing left, but nothing FILTERED: a cap of 0
    // truncates both lists away, so `hiddenByFloor` is 0. Printing the note
    // anyway says "…0 hidden below severityFloor — every surviving line group
    // was filtered out", which is wrong twice over — the count is zero and the
    // floor is not what removed them.
    const text = formatResultAsText(
      result({ vulnerabilities: [vuln({ line: 1 }), vuln({ line: 2 })] }),
      enrich,
      { maxSurvivors: 0 },
    );

    expect(text).not.toContain('hidden below severityFloor');
  });

  it('says nothing about the floor on a clean run where it hid nothing', () => {
    // hiddenByFloor is 0 here, and "…0 hidden below severityFloor" is a
    // sentence about nothing on a report that is genuinely clean.
    const text = formatResultAsText(
      result({ vulnerabilities: [], survived: 0, killed: 10 }),
      enrich,
      { severityFloor: 'high' },
    );

    expect(text).not.toContain('hidden below severityFloor');
  });
});

describe('counter guards refuse a nonsensical negative', () => {
  // Each of these reads `if (x && x > 0)`. The `&&` alone would let a NEGATIVE
  // count through — truthy, but meaningless — and print "Note: -1 mutant(s)
  // excluded". The comparison is what makes the guard mean "a real, positive
  // count", so a negative is the input that proves it is doing work.

  it('does not report a negative incompetent count in the payload', () => {
    const payload = buildResultPayload(
      result({ vulnerabilities: [vuln()], incompetent: -1 } as Partial<MutationResult>),
    );

    expect(Object.keys(payload)).not.toContain('incompetent');
    expect(payload.note).not.toContain('excluded as incompetent');
  });

  it('does not report a negative incompetent count in text output', () => {
    const text = formatResultAsText(
      result({ vulnerabilities: [vuln()], incompetent: -1 } as Partial<MutationResult>),
    );

    expect(text).not.toContain('excluded as incompetent');
  });

  it('does not report a negative suppressed count', () => {
    const payload = buildResultPayload(result({ vulnerabilities: [vuln()] }), {
      suppressedCount: -1,
    });

    expect(Object.keys(payload)).not.toContain('suppressedCount');
    expect(payload.note).not.toContain('suppressed and excluded');
  });

  it.each([
    ['driftedSuppressions'],
    ['unverifiedSuppressions'],
    ['orphanedSuppressions'],
    ['rejectedSuppressions'],
    ['relocatedSuppressions'],
  ] as const)('does not report a negative %s', (key) => {
    const payload = buildResultPayload(result({ vulnerabilities: [vuln()] }), { [key]: -1 });

    expect(Object.keys(payload)).not.toContain(key);
  });

  it.each([
    ['driftedSuppressions'],
    ['unverifiedSuppressions'],
    ['orphanedSuppressions'],
    ['rejectedSuppressions'],
    ['relocatedSuppressions'],
  ] as const)('DOES report a positive %s', (key) => {
    const payload = buildResultPayload(result({ vulnerabilities: [vuln()] }), { [key]: 2 });

    expect(payload[key]).toBe(2);
  });
});

describe('the incomplete-list count sums every hiding mechanism', () => {
  // Four counters are added together. A minus anywhere in that sum understates
  // the total — and at exactly the wrong moment, because this warning is what
  // stops a caller echoing a partial response back as a verify `baseline`.

  it('adds truncation on BOTH sides', () => {
    const payload = buildResultPayload(
      result({
        vulnerabilities: [
          vuln({ line: 1 }),
          vuln({ line: 2 }),
          vuln({ line: 3 }),
          vuln({ line: 11, kind: 'noCoverage' }),
          vuln({ line: 12, kind: 'noCoverage' }),
          vuln({ line: 13, kind: 'noCoverage' }),
        ],
      }),
      { maxSurvivors: 1 },
    );

    expect(payload.survivorsTruncated).toBe(2);
    expect(payload.noCoverageTruncated).toBe(2);
    expect(payload.note).toContain('INCOMPLETE LIST: 4 line group(s)');
  });

  it('adds floor filtering on BOTH sides', () => {
    const payload = buildResultPayload(
      result({
        vulnerabilities: [
          vuln({ line: 1, mutator: 'SomeUnmappedMutator' }), // filtered
          vuln({ line: 11, mutator: 'SomeUnmappedMutator', kind: 'noCoverage' }), // filtered
          vuln({ line: 2 }), // kept, so the run is not "everything filtered"
          vuln({ line: 12, kind: 'noCoverage' }), // kept
        ],
      }),
      { enrich, severityFloor: 'high' },
    );

    expect(payload.survivorsFiltered).toBe(1);
    expect(payload.noCoverageFiltered).toBe(1);
    expect(payload.note).toContain('INCOMPLETE LIST: 2 line group(s)');
  });
});

describe('refused suppressions are said out loud', () => {
  // A refused entry is never stored, so no later run mentions it again. The
  // caller asked for a suppression and did not get one; silence there is how 40
  // stored suppressions in this repository came to point at comment lines.
  it('names the count and what to check when entries were refused', () => {
    const payload = buildResultPayload(result({ vulnerabilities: [vuln()] }), {
      rejectedSuppressions: 2,
    });

    expect(payload.rejectedSuppressions).toBe(2);
    expect(payload.note).toContain('2 suppression(s) were NOT stored');
    // All THREE causes must be named, because the count alone cannot say which
    // applied and each one sends the reader to a different fix: correct the
    // line, name a `change`, or re-run with a larger budget.
    expect(payload.note).toContain('blank or comment-only');
    expect(payload.note).toContain('several mutants of that mutator');
    expect(payload.note).toContain('`change` naming the one you mean');
    expect(payload.note).toContain('stopped early and never generated the mutant');
    expect(payload.note).toContain('larger');
    expect(payload.note).toContain('timeoutMs');
    expect(payload.note).toContain(
      'Check the line number against the survivor you meant to suppress',
    );
  });

  it('renders the same refusal in TEXT output', () => {
    // Text and JSON are two projections of one payload in this codebase, and a
    // text-only caller is exactly the one who would otherwise never learn their
    // suppression did not land. Both now read the wording from
    // `suppressionDriftNotes`, so they cannot drift apart.
    const text = formatResultAsText(result({ vulnerabilities: [vuln()] }), undefined, {
      rejectedSuppressions: 2,
    });

    expect(text).toContain('Note: 2 suppression(s) were NOT stored');
    expect(text).toContain('blank or comment-only');
    expect(text).toContain('several mutants of that mutator');
    expect(text).toContain('stopped early and never generated the mutant');
  });

  it('says nothing when every requested suppression was stored', () => {
    const payload = buildResultPayload(result({ vulnerabilities: [vuln()] }), {
      rejectedSuppressions: 0,
    });

    expect(Object.keys(payload)).not.toContain('rejectedSuppressions');
    expect(payload.note).not.toContain('NOT stored');
  });
});

describe('relocated suppressions', () => {
  const move = {
    storedLine: 134,
    line: 96,
    mutator: 'ConditionalExpression',
    reason: 'guard unreachable',
  };

  it('names each tier-3 move individually, with its recorded reason', () => {
    // A bare count would hide the one thing a reader has to judge: whether the
    // entry landed on the mutant its reason was actually written about.
    const payload = buildResultPayload(result({ vulnerabilities: [vuln()] }), {
      relocatedSuppressions: 1,
      relocations: [move],
    });

    expect(payload.relocatedSuppressions).toBe(1);
    expect(payload.note).toContain('from line 134 to line 96');
    expect(payload.note).toContain('guard unreachable');
    expect(payload.note).toContain('unsuppress');
  });

  it('renders the same wording in the text projection', () => {
    const text = formatResultAsText(result({ vulnerabilities: [vuln()] }), undefined, {
      relocatedSuppressions: 1,
      relocations: [move],
    });

    expect(text).toContain(
      'Note: Suppression "ConditionalExpression" moved from line 134 to line 96',
    );
  });

  it('counts a tier-2 move without narrating it', () => {
    // Tier 2 cannot be wrong — the line's content is unchanged, it only moved —
    // so `relocations` is empty and only the count is reported.
    const payload = buildResultPayload(result({ vulnerabilities: [vuln()] }), {
      relocatedSuppressions: 3,
      relocations: [],
    });

    expect(payload.relocatedSuppressions).toBe(3);
    expect(payload.note).not.toContain('moved from line');
  });

  it('says nothing when nothing relocated', () => {
    const payload = buildResultPayload(result({ vulnerabilities: [vuln()] }), {
      relocatedSuppressions: 0,
      relocations: [],
    });

    expect(Object.keys(payload)).not.toContain('relocatedSuppressions');
    expect(payload.note).not.toContain('moved from line');
  });

  it('omits the reason clause for an entry that never carried one', () => {
    const payload = buildResultPayload(result({ vulnerabilities: [vuln()] }), {
      relocatedSuppressions: 1,
      relocations: [{ storedLine: 12, line: 20, mutator: 'EqualityOperator' }],
    });

    expect(payload.note).toContain('from line 12 to line 20');
    expect(payload.note).not.toContain('Recorded reason');
  });
});

describe('ambiguous suppression candidates', () => {
  it('lists every candidate change so the caller can name one', () => {
    // `changes` on a survivor group is capped at CHANGES_CAP and aggregated
    // across mutators, so on exactly the lines where `change` is needed — many
    // mutants of one mutator — the report cannot show them all. Without this
    // note the refusal is unactionable.
    const payload = buildResultPayload(result({ vulnerabilities: [vuln()] }), {
      rejectedSuppressions: 1,
      rejections: [
        {
          line: 331,
          mutator: 'ConditionalExpression',
          cause: 'ambiguous',
          candidates: ['a || b → false', 'a → false', 'b → false', 'a || b → true'],
        },
      ],
    });

    expect(payload.note).toContain('Line 331 carries 4 "ConditionalExpression" mutants');
    for (const c of ['a || b → false', 'a → false', 'b → false', 'a || b → true']) {
      expect(payload.note).toContain(`"${c}"`);
    }
  });

  it('says nothing extra for a rejection that is not ambiguous', () => {
    const payload = buildResultPayload(result({ vulnerabilities: [vuln()] }), {
      rejectedSuppressions: 1,
      rejections: [{ line: 12, mutator: 'ConditionalExpression', cause: 'non-mutable' }],
    });

    expect(payload.note).toContain('NOT stored');
    expect(payload.note).not.toContain('Re-issue with one of these');
  });

  it('says nothing when an ambiguous rejection carries no candidates', () => {
    const payload = buildResultPayload(result({ vulnerabilities: [vuln()] }), {
      rejectedSuppressions: 1,
      rejections: [{ line: 12, mutator: 'X', cause: 'ambiguous', candidates: [] }],
    });

    expect(payload.note).not.toContain('Re-issue with one of these');
  });
});
