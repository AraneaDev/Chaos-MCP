import { describe, it, expect } from 'vitest';
import {
  parseBaseline,
  computeVerifyDelta,
  evaluateVerifyGate,
  buildVerifyNote,
  formatVerifyResultAsJson,
  formatVerifyResultAsText,
  verifyPayloadFields,
} from '../core/verify.js';
import type { MutationResult } from '../engines/base.js';

const result = (vulns: { line: number; mutator: string }[]): MutationResult => ({
  target: 'src/x.ts',
  totalMutants: 10,
  killed: 8,
  survived: vulns.length,
  mutationScore: '80.00%',
  vulnerabilities: vulns.map((v) => ({ ...v, description: 'survived' })),
});

/**
 * A re-run that stopped early — the shape `runBatched` produces when the time
 * budget drains or a batch throws (Finding 2). Verify is whole-file on every
 * engine, so it plans the MAXIMUM number of batches and is the run most likely
 * to be truncated.
 */
const partialResult = (
  vulns: { line: number; mutator: string }[],
  extra: Partial<MutationResult> = {},
): MutationResult => ({
  ...result(vulns),
  complete: false,
  batchesCompleted: 2,
  batchesPlanned: 7,
  stoppedReason: 'time_budget_exhausted',
  ...extra,
});

describe('parseBaseline', () => {
  it('flattens survivors + noCoverage into deduped (line, mutator) keys', () => {
    expect(
      parseBaseline({
        survivors: [{ line: 42, mutators: { ConditionalExpression: 1, BooleanLiteral: 2 } }],
        noCoverage: [{ line: 88, mutators: { ArithmeticOperator: 1 } }],
      }),
    ).toEqual([
      { line: 42, mutator: 'BooleanLiteral' },
      { line: 42, mutator: 'ConditionalExpression' },
      { line: 88, mutator: 'ArithmeticOperator' },
    ]);
  });

  it('dedupes the same (line, mutator) appearing in both arrays', () => {
    expect(
      parseBaseline({
        survivors: [{ line: 5, mutators: { M: 1 } }],
        noCoverage: [{ line: 5, mutators: { M: 1 } }],
      }),
    ).toEqual([{ line: 5, mutator: 'M' }]);
  });

  it('returns empty for an empty baseline', () => {
    expect(parseBaseline({})).toEqual([]);
  });

  /**
   * A baseline is not always a value this process produced: one form arrives as
   * a raw `baseline` tool argument, another is read back from the on-disk run
   * cache. A null element used to be dereferenced, throwing a TypeError out of
   * `computeScope` that the handler reported as "Chaos Engine Halted: Cannot
   * read properties of null" — an internal crash where the caller should have
   * seen the ordinary "not found or expired" / bad-argument error (audit M10).
   */
  it('skips a null group instead of throwing', () => {
    const b = {
      survivors: [null, { line: 4, mutators: { M: 1 } }],
      noCoverage: [undefined],
    } as unknown as Parameters<typeof parseBaseline>[0];
    expect(parseBaseline(b)).toEqual([{ line: 4, mutator: 'M' }]);
  });

  it('skips a group with no usable line number', () => {
    // Otherwise the mutant is keyed "undefined M" and silently corrupts the delta.
    const b = {
      survivors: [{ mutators: { M: 1 } }, { line: '9', mutators: { M: 1 } }],
    } as unknown as Parameters<typeof parseBaseline>[0];
    expect(parseBaseline(b)).toEqual([]);
  });
});

describe('computeVerifyDelta', () => {
  const baseline = parseBaseline({
    survivors: [{ line: 42, mutators: { ConditionalExpression: 1 } }],
    noCoverage: [{ line: 88, mutators: { ArithmeticOperator: 1 } }],
  });

  it('classifies nowKilled, stillSurviving, and newSurvivors', () => {
    const delta = computeVerifyDelta(
      baseline,
      result([
        { line: 88, mutator: 'ArithmeticOperator' },
        { line: 42, mutator: 'BooleanLiteral' },
      ]),
    );
    expect(delta.baselineTotal).toBe(2);
    expect(delta.nowKilled).toEqual([{ line: 42, mutator: 'ConditionalExpression' }]);
    expect(delta.stillSurviving).toEqual([{ line: 88, mutator: 'ArithmeticOperator' }]);
    expect(delta.newSurvivors).toEqual([{ line: 42, mutator: 'BooleanLiteral' }]);
  });

  it('counts a re-run survivor on a NON-baseline line, with no engine exemption', () => {
    // This test previously asserted the opposite — that an out-of-baseline
    // survivor is dropped for StrykerJS — on the grounds that "the re-run is
    // scoped to baseline lines, so an out-of-baseline survivor cannot occur".
    // The scoping that premise rested on was one single-line range per baseline
    // line, and Stryker only generates a mutant whose ENTIRE span fits the
    // range, so multi-line mutants were never re-tested and came back reported
    // as `nowKilled`. Verify now re-runs whole-file on every engine, so an
    // out-of-baseline survivor CAN occur and is a real regression.
    const delta = computeVerifyDelta(baseline, result([{ line: 999, mutator: 'X' }]));
    expect(delta.newSurvivors).toEqual([{ line: 999, mutator: 'X' }]);
    expect(delta.nowKilled).toEqual([
      { line: 42, mutator: 'ConditionalExpression' },
      { line: 88, mutator: 'ArithmeticOperator' },
    ]);
  });

  it('includes a new survivor ON a baseline line', () => {
    // A fresh survivor whose (line, mutator) key is NEW but whose LINE is in the
    // baseline is a regression on a re-tested line and must be counted. Held
    // before and after the line-scope exemption was removed.
    const delta = computeVerifyDelta(baseline, result([{ line: 42, mutator: 'BooleanLiteral' }]));
    expect(delta.newSurvivors).toEqual([{ line: 42, mutator: 'BooleanLiteral' }]);
  });

  it('counts re-run survivors on non-baseline lines as newSurvivors for whole-file engines (H1)', () => {
    // engineSupportsLineScope=false (cosmic-ray/cargo-mutants/Infection, and the
    // default): the whole file is re-run, so a regression the fix introduces on a
    // line outside the baseline is a real new survivor and MUST be reported.
    const delta = computeVerifyDelta(baseline, result([{ line: 999, mutator: 'X' }]));
    expect(delta.newSurvivors).toEqual([{ line: 999, mutator: 'X' }]);
    expect(delta.nowKilled).toEqual([
      { line: 42, mutator: 'ConditionalExpression' },
      { line: 88, mutator: 'ArithmeticOperator' },
    ]);
  });

  it('reports all killed when the re-run has no baseline survivors', () => {
    const delta = computeVerifyDelta(baseline, result([]));
    expect(delta.nowKilled).toHaveLength(2);
    expect(delta.stillSurviving).toEqual([]);
  });

  it('deduplicates non-baseline entries on a baseline line in newSurvivors', () => {
    // If the dedup guard is removed, the duplicate Z would appear twice in newSurvivors.
    const delta = computeVerifyDelta(
      parseBaseline({ survivors: [{ line: 5, mutators: { M: 1 } }] }),
      result([
        { line: 5, mutator: 'Z' },
        { line: 5, mutator: 'Z' }, // duplicate – must be deduped
      ]),
    );
    expect(delta.newSurvivors).toHaveLength(1);
    expect(delta.newSurvivors[0]).toEqual({ line: 5, mutator: 'Z' });
  });

  // ── Finding 2: absence only proves a kill when the re-run enumerated everything ──

  it('leaves notReChecked empty and nowKilled populated for a COMPLETE re-run', () => {
    // The unchanged contract, pinned so the partial branch cannot be widened
    // into the normal case by accident.
    const delta = computeVerifyDelta(baseline, result([]));
    expect(delta.nowKilled).toHaveLength(2);
    expect(delta.notReChecked).toEqual([]);
  });

  it('reports an absent baseline mutant as notReChecked, not nowKilled, when the re-run was partial', () => {
    // The re-run merged 2 of 7 batches. A baseline mutant that did not reappear
    // may simply never have been GENERATED, so "you fixed it" is unsupported.
    const delta = computeVerifyDelta(baseline, partialResult([]));
    expect(delta.nowKilled).toEqual([]);
    expect(delta.notReChecked).toEqual([
      { line: 42, mutator: 'ConditionalExpression' },
      { line: 88, mutator: 'ArithmeticOperator' },
    ]);
  });

  it('still trusts PRESENCE on a partial re-run: stillSurviving and newSurvivors are unaffected', () => {
    // A mutant the truncated re-run actually saw survive is a fact regardless of
    // how much of the file ran — only the absence inference is unsound.
    const delta = computeVerifyDelta(
      baseline,
      partialResult([
        { line: 88, mutator: 'ArithmeticOperator' },
        { line: 999, mutator: 'X' },
      ]),
    );
    expect(delta.stillSurviving).toEqual([{ line: 88, mutator: 'ArithmeticOperator' }]);
    expect(delta.newSurvivors).toEqual([{ line: 999, mutator: 'X' }]);
    expect(delta.notReChecked).toEqual([{ line: 42, mutator: 'ConditionalExpression' }]);
    expect(delta.nowKilled).toEqual([]);
  });

  it("forwards the run's partial provenance onto the delta", () => {
    const delta = computeVerifyDelta(baseline, partialResult([]));
    expect(delta.complete).toBe(false);
    expect(delta.batchesCompleted).toBe(2);
    expect(delta.batchesPlanned).toBe(7);
    expect(delta.stoppedReason).toBe('time_budget_exhausted');
  });

  it('omits the provenance keys ENTIRELY when the engine reported none', () => {
    // Four `if (x !== undefined)` guards, and the difference between honouring
    // them and assigning unconditionally is `{}` versus `{ complete: undefined }`
    // — invisible to `toBeUndefined()`, to `toEqual`, and to JSON (which drops
    // undefined-valued keys). The key set is the only place it shows, and the
    // delta is spread into a response, so a key that exists is a key a consumer
    // can enumerate.
    const delta = computeVerifyDelta(baseline, result([]));

    expect(Object.keys(delta).sort()).toEqual([
      'baselineTotal',
      'newSurvivors',
      'notReChecked',
      'nowKilled',
      'stillSurviving',
    ]);
  });

  it('forwards each provenance key independently of the others', () => {
    // One key present, the rest absent — so a guard that fires for the wrong
    // field, or forwards all four together, is visible. `complete: false` is the
    // one that changes the delta's meaning, so it is the one asserted alone.
    const delta = computeVerifyDelta(baseline, {
      ...result([]),
      complete: false,
    });

    expect(Object.keys(delta).sort()).toEqual([
      'baselineTotal',
      'complete',
      'newSurvivors',
      'notReChecked',
      'nowKilled',
      'stillSurviving',
    ]);
    expect(delta.complete).toBe(false);
  });

  it('treats an explicitly complete run as complete (`=== false`, not `!== true`)', () => {
    // Engines with no batching concept leave `complete` undefined; one that sets
    // it to true is equally whole. Both must keep the absence⇒killed inference.
    expect(computeVerifyDelta(baseline, result([])).complete).toBeUndefined();
    const explicit = computeVerifyDelta(baseline, { ...result([]), complete: true });
    expect(explicit.complete).toBe(true);
    expect(explicit.nowKilled).toHaveLength(2);
    expect(explicit.notReChecked).toEqual([]);
  });
});

describe('formatVerifyResultAsJson', () => {
  it('emits the verify shape with mode and killedCount', () => {
    const delta = computeVerifyDelta(
      parseBaseline({ survivors: [{ line: 42, mutators: { C: 1 } }] }),
      result([]),
    );
    const json = JSON.parse(formatVerifyResultAsJson('src/x.ts', delta));
    expect(json.mode).toBe('verify');
    expect(json.target).toBe('src/x.ts');
    expect(json.baselineTotal).toBe(1);
    expect(json.killedCount).toBe(1);
    expect(json.nowKilled).toEqual([{ line: 42, mutator: 'C' }]);
    expect(json.stillSurviving).toEqual([]);
    expect(json.newSurvivors).toEqual([]);
  });

  it('includes an explanatory note string', () => {
    const delta = computeVerifyDelta(
      parseBaseline({ survivors: [{ line: 1, mutators: { A: 1 } }] }),
      result([{ line: 1, mutator: 'A' }]),
    );
    const json = JSON.parse(formatVerifyResultAsJson('src/x.ts', delta));
    expect(typeof json.note).toBe('string');
    expect(json.note).toContain('still surviving');
    // Pin each concatenated fragment of the note (kills StringLiteral→"" mutants).
    expect(json.note).toContain('previously-uncaught mutants are now killed');
    expect(json.note).toContain('stillSurviving: add or strengthen tests for these.');
    expect(json.note).toContain('newSurvivors: your change introduced these uncaught mutants');
  });
});

describe('formatVerifyResultAsText', () => {
  it('leads with a success line when nothing still survives and no regressions', () => {
    const delta = computeVerifyDelta(
      parseBaseline({ survivors: [{ line: 42, mutators: { C: 1 } }] }),
      result([]),
    );
    const text = formatVerifyResultAsText('src/x.ts', delta);
    expect(text).toContain('Chaos-MCP Verify Report: src/x.ts');
    expect(text).toContain('All 1 previously-uncaught mutants are now killed.');
    // The report header and success line are joined by '\n' (kills join('\n')→join('')).
    expect(text).toBe(
      'Chaos-MCP Verify Report: src/x.ts\nAll 1 previously-uncaught mutants are now killed.',
    );
  });

  it('lists still-surviving and new mutants when present', () => {
    const delta = computeVerifyDelta(
      parseBaseline({ survivors: [{ line: 88, mutators: { A: 1 } }] }),
      result([{ line: 88, mutator: 'A' }]),
    );
    const text = formatVerifyResultAsText('src/x.ts', delta);
    expect(text).toContain('Still surviving:');
    expect(text).toContain('  88: A');
    // Pin the summary line fragments (kills StringLiteral→"" on lines 108-109).
    expect(text).toContain('0 of 1 previously-uncaught mutants now killed; ');
    expect(text).toContain('1 still surviving; 0 new.');
    // Sections are newline-joined (kills join('\n')→join('') on line 123).
    expect(text.split('\n')).toContain('Still surviving:');
  });

  it('lists Now killed and New survivors sections when both are present', () => {
    // baseline: {10:A, 10:B}; re-run: {10:B (still), 10:C (new on baseline line 10)} → A killed.
    const delta = computeVerifyDelta(
      parseBaseline({ survivors: [{ line: 10, mutators: { A: 1, B: 1 } }] }),
      result([
        { line: 10, mutator: 'B' },
        { line: 10, mutator: 'C' },
      ]),
    );
    const text = formatVerifyResultAsText('src/x.ts', delta);
    expect(text).toContain('Now killed:');
    expect(text).toContain('  10: A');
    expect(text).toContain('New survivors (regressions on baseline lines):');
    expect(text).toContain('  10: C');
  });

  it('does NOT show success when newSurvivors is non-empty even if stillSurviving is empty', () => {
    // Kills the `&&`→`||` (or `newSurvivors.length===0`→`true`) mutation on the early-return guard.
    // baseline=[A], rerun=[B on line 1] → nowKilled=[A], stillSurviving=[], newSurvivors=[B]
    const delta = computeVerifyDelta(
      parseBaseline({ survivors: [{ line: 1, mutators: { A: 1 } }] }),
      result([{ line: 1, mutator: 'B' }]),
    );
    const text = formatVerifyResultAsText('src/x.ts', delta);
    expect(text).not.toContain('All 1 previously-uncaught mutants are now killed.');
    expect(text).toContain('New survivors (regressions on baseline lines):');
  });

  it('omits "Now killed:" and "New survivors" sections when those counts are zero', () => {
    // baseline=[A], rerun=[A] → nowKilled=[], stillSurviving=[A], newSurvivors=[]
    const delta = computeVerifyDelta(
      parseBaseline({ survivors: [{ line: 5, mutators: { A: 1 } }] }),
      result([{ line: 5, mutator: 'A' }]),
    );
    const text = formatVerifyResultAsText('src/x.ts', delta);
    expect(text).not.toContain('Now killed:');
    expect(text).not.toContain('New survivors');
    expect(text).toContain('Still surviving:');
  });

  it('omits "Still surviving:" section when stillSurviving is empty', () => {
    // baseline=[A], rerun=[B on line 1] → nowKilled=[A], stillSurviving=[], newSurvivors=[B]
    const delta = computeVerifyDelta(
      parseBaseline({ survivors: [{ line: 1, mutators: { A: 1 } }] }),
      result([{ line: 1, mutator: 'B' }]),
    );
    const text = formatVerifyResultAsText('src/x.ts', delta);
    expect(text).not.toContain('Still surviving:');
    expect(text).toContain('Now killed:');
    expect(text).toContain('New survivors (regressions on baseline lines):');
  });
});

describe('buildVerifyNote', () => {
  /** Four deliberately distinct counts so a swapped field cannot read as correct. */
  const delta = {
    baselineTotal: 5,
    nowKilled: [
      { line: 1, mutator: 'A' },
      { line: 2, mutator: 'B' },
    ],
    stillSurviving: [
      { line: 3, mutator: 'C' },
      { line: 4, mutator: 'D' },
      { line: 5, mutator: 'E' },
    ],
    newSurvivors: [{ line: 6, mutator: 'F' }],
    // A COMPLETE re-run: absence proved a kill, so nothing landed here.
    notReChecked: [],
  };

  it('reports each count against the field it belongs to', () => {
    expect(buildVerifyNote(delta)).toBe(
      '2 of 5 previously-uncaught mutants are now killed; 3 still surviving; 1 new. ' +
        'stillSurviving: add or strengthen tests for these. ' +
        'newSurvivors: your change introduced these uncaught mutants on the same lines.',
    );
  });

  it('renders zeroes rather than omitting a section when the delta is empty', () => {
    expect(
      buildVerifyNote({
        baselineTotal: 0,
        nowKilled: [],
        stillSurviving: [],
        newSurvivors: [],
        notReChecked: [],
      }),
    ).toContain('0 of 0 previously-uncaught mutants are now killed; 0 still surviving; 0 new.');
  });

  it('is the same note the JSON and text renderers carry', () => {
    // The note is built once and reused; a renderer that reworded its own copy
    // would drift from this contract silently.
    const built = buildVerifyNote(delta);
    const json = JSON.parse(formatVerifyResultAsJson('src/x.ts', delta)) as { note: string };
    expect(json.note).toBe(built);
  });

  // ── Finding 2 ──

  it('leads with the partial-re-run warning before any count', () => {
    // Every number after it is conditioned on it: `0 of 2 now killed` read
    // without the banner says "your fix achieved nothing", when the truth is
    // "we did not look".
    const note = buildVerifyNote(
      computeVerifyDelta(
        parseBaseline({ survivors: [{ line: 42, mutators: { C: 1, D: 1 } }] }),
        partialResult([]),
      ),
    );
    expect(note.startsWith('PARTIAL RE-RUN —')).toBe(true);
    expect(note).toContain('only 2 of 7 batches ran');
    expect(note).toContain('the time budget was exhausted before the rest could run');
    expect(note).toContain('nothing here can be reported as fixed');
    expect(note).toContain('2 baseline mutant(s) were NOT re-checked');
  });

  it('falls back to vaguer wording when the batch counts are unknown', () => {
    // `complete: false` with no batch numbers — the shape a non-batching stop
    // would produce. The claim must degrade, not disappear.
    const note = buildVerifyNote(
      computeVerifyDelta(
        parseBaseline({ survivors: [{ line: 1, mutators: { A: 1 } }] }),
        partialResult([], {
          batchesCompleted: undefined,
          batchesPlanned: undefined,
          stoppedReason: undefined,
        }),
      ),
    );
    expect(note).toContain('only part of the file was re-run');
    expect(note).toContain('the run stopped before the rest could run');
  });

  // Both counts absent is the easy case; the operator is only observable when
  // the two operands DISAGREE. A half-known pair must degrade to the vague
  // wording as well — `||` would print "only 2 of undefined batches ran", which
  // reads as a measurement and is worse than admitting we do not know.
  it.each([
    ['completed but no plan', { batchesCompleted: 2, batchesPlanned: undefined }],
    ['a plan but no completed count', { batchesCompleted: undefined, batchesPlanned: 7 }],
  ])(
    'falls back to vaguer wording when the batch counts are half known (%s)',
    (_label, batches) => {
      const note = buildVerifyNote(
        computeVerifyDelta(
          parseBaseline({ survivors: [{ line: 1, mutators: { A: 1 } }] }),
          partialResult([], batches),
        ),
      );

      expect(note).toContain('only part of the file was re-run');
      expect(note).not.toContain('batches ran');
      expect(note).not.toContain('undefined');
    },
  );

  it('says nothing about a partial run when the re-run was complete', () => {
    const note = buildVerifyNote(
      computeVerifyDelta(
        parseBaseline({ survivors: [{ line: 1, mutators: { A: 1 } }] }),
        result([]),
      ),
    );
    expect(note).not.toContain('PARTIAL RE-RUN');
    expect(note.startsWith('1 of 1 previously-uncaught mutants are now killed')).toBe(true);
  });
});

describe('verify output — partial re-run (Finding 2)', () => {
  const baseline = parseBaseline({ survivors: [{ line: 42, mutators: { C: 1 } }] });

  it('JSON reports notReChecked and the partial provenance, and killedCount 0', () => {
    const json = JSON.parse(
      formatVerifyResultAsJson('src/x.ts', computeVerifyDelta(baseline, partialResult([]))),
    ) as Record<string, unknown>;
    expect(json.killedCount).toBe(0);
    expect(json.nowKilled).toEqual([]);
    expect(json.notReChecked).toEqual([{ line: 42, mutator: 'C' }]);
    expect(json.complete).toBe(false);
    expect(json.batchesCompleted).toBe(2);
    expect(json.batchesPlanned).toBe(7);
    expect(json.stoppedReason).toBe('time_budget_exhausted');
  });

  it('JSON omits the new keys entirely for a complete re-run', () => {
    // A caller that never hits a partial run must not have to learn a field
    // that is always empty for them.
    const json = JSON.parse(
      formatVerifyResultAsJson('src/x.ts', computeVerifyDelta(baseline, result([]))),
    ) as Record<string, unknown>;
    expect(json).not.toHaveProperty('notReChecked');
    expect(json).not.toHaveProperty('complete');
    expect(json.killedCount).toBe(1);
  });

  it('builds the payload WITHOUT the keys, rather than with undefined values', () => {
    // The assertion above cannot tell the two apart: `JSON.stringify` drops an
    // undefined-valued key, so `{ complete: undefined }` serialises exactly like
    // `{}`. `structuredContent` spreads this object rather than re-parsing the
    // string (`audit/audit-output.ts`), so the object's own key set is the
    // contract — and it is what the five guards in `verifyPayloadFields` exist
    // to control.
    const fields = verifyPayloadFields(computeVerifyDelta(baseline, result([])));

    expect(Object.keys(fields).sort()).toEqual([
      'baselineTotal',
      'killedCount',
      'newSurvivors',
      'nowKilled',
      'stillSurviving',
    ]);
  });

  it('adds each partial-run key only when the delta actually carries it', () => {
    // The mirror image: a partial re-run earns all five extra keys. Asserted as
    // a set, so a guard that fires on the wrong field shows up as a key in the
    // wrong place rather than as an equal-looking value.
    const fields = verifyPayloadFields(computeVerifyDelta(baseline, partialResult([])));

    expect(Object.keys(fields).sort()).toEqual([
      'baselineTotal',
      'batchesCompleted',
      'batchesPlanned',
      'complete',
      'killedCount',
      'newSurvivors',
      'notReChecked',
      'nowKilled',
      'stillSurviving',
      'stoppedReason',
    ]);
  });

  it('text replaces the all-killed success line with the partial banner', () => {
    // A truncated re-run can legitimately come back with nothing surviving and
    // no regressions; "All 1 previously-uncaught mutants are now killed." is
    // then flatly false — that mutant was never generated.
    const text = formatVerifyResultAsText(
      'src/x.ts',
      computeVerifyDelta(baseline, partialResult([])),
    );
    expect(text).not.toContain('All 1 previously-uncaught mutants are now killed.');
    expect(text.split('\n')[1].startsWith('PARTIAL RE-RUN —')).toBe(true);
    expect(text).toContain('0 of 1 previously-uncaught mutants now killed');
  });

  it('text lists the not-re-checked mutants rather than only counting them', () => {
    const text = formatVerifyResultAsText(
      'src/x.ts',
      computeVerifyDelta(
        parseBaseline({ survivors: [{ line: 42, mutators: { C: 1 } }] }),
        partialResult([{ line: 9, mutator: 'Z' }]),
      ),
    );
    expect(text).toContain(
      'Not re-checked (never generated by this partial run — status unknown):',
    );
    expect(text).toContain('  42: C');
    // Presence is still trusted, so the fresh survivor is still a regression.
    expect(text).toContain('New survivors (regressions on baseline lines):');
    expect(text).toContain('  9: Z');
    expect(text).not.toContain('Now killed:');
  });

  it('text omits the not-re-checked SECTION when the list is empty', () => {
    // Reached only past the success shortcut, so this delta has something still
    // surviving. A guard forced open prints the header — "Not re-checked (never
    // generated by this partial run — status unknown):" — with nothing under it,
    // telling a caller whose re-run was complete that some unnamed part of their
    // baseline is unaccounted for.
    const text = formatVerifyResultAsText(
      'src/x.ts',
      computeVerifyDelta(baseline, result([{ line: 42, mutator: 'C' }])),
    );

    expect(text).toContain('Still surviving:');
    expect(text).not.toContain('Not re-checked');
  });

  it('text keeps the success line for a COMPLETE re-run', () => {
    const text = formatVerifyResultAsText('src/x.ts', computeVerifyDelta(baseline, result([])));
    expect(text).toBe(
      'Chaos-MCP Verify Report: src/x.ts\nAll 1 previously-uncaught mutants are now killed.',
    );
  });
});

// ── Finding 8: minScore is accepted in verify mode, so a gate must be emitted ──
describe('evaluateVerifyGate', () => {
  const baseline = parseBaseline({ survivors: [{ line: 42, mutators: { C: 1 } }] });

  it('passes when nothing still survives and nothing is new', () => {
    expect(evaluateVerifyGate(80, computeVerifyDelta(baseline, result([])))).toEqual({
      minScore: 80,
      passed: true,
    });
  });

  it('fails when a baseline mutant is still surviving', () => {
    expect(
      evaluateVerifyGate(80, computeVerifyDelta(baseline, result([{ line: 42, mutator: 'C' }]))),
    ).toEqual({ minScore: 80, passed: false });
  });

  it('fails on a NEW survivor even though the baseline itself is clear', () => {
    // Kills an `&&`→`||` on the verdict: the whole point of `newSurvivors` is
    // that a fix which breaks a different line has not passed.
    const delta = computeVerifyDelta(baseline, result([{ line: 999, mutator: 'X' }]));
    expect(delta.stillSurviving).toEqual([]);
    expect(evaluateVerifyGate(80, delta)).toEqual({ minScore: 80, passed: false });
  });

  it('fails CLOSED on a partial re-run, with the shared partial_audit reason', () => {
    // The delta looks spotless — nothing surviving, nothing new — because the
    // re-run never generated the mutants. A CI gate must not go green on that.
    const delta = computeVerifyDelta(baseline, partialResult([]));
    expect(delta.stillSurviving).toEqual([]);
    expect(delta.newSurvivors).toEqual([]);
    expect(evaluateVerifyGate(80, delta)).toEqual({
      minScore: 80,
      passed: false,
      reason: 'partial_audit',
    });
  });

  it('does not grade on nowKilled, so a suppressed mutant cannot fail the gate', () => {
    // Suppression removes a mutant from BOTH sides: baselineTotal 0, nothing
    // killed, nothing surviving. That is a pass, not a zero-kill failure.
    const delta = computeVerifyDelta([], result([]));
    expect(delta.nowKilled).toEqual([]);
    expect(evaluateVerifyGate(100, delta).passed).toBe(true);
  });
});

describe('verify gate rendering (Finding 8)', () => {
  const baseline = parseBaseline({ survivors: [{ line: 42, mutators: { C: 1 } }] });

  it('JSON carries the gate the caller was promised', () => {
    const delta = computeVerifyDelta(baseline, result([{ line: 42, mutator: 'C' }]));
    const json = JSON.parse(
      formatVerifyResultAsJson('src/x.ts', delta, evaluateVerifyGate(80, delta)),
    ) as Record<string, unknown>;
    expect(json.gate).toEqual({ minScore: 80, passed: false });
  });

  it('JSON omits the gate entirely when no minScore was supplied', () => {
    const json = JSON.parse(
      formatVerifyResultAsJson('src/x.ts', computeVerifyDelta(baseline, result([]))),
    ) as Record<string, unknown>;
    expect(json).not.toHaveProperty('gate');
  });

  it('text renders the verdict even on the all-killed success shortcut', () => {
    // The shortcut returns early; a gate line emitted after it would never be
    // seen, which is precisely the divergence `formatGateLine` exists to stop.
    const delta = computeVerifyDelta(baseline, result([]));
    const text = formatVerifyResultAsText('src/x.ts', delta, evaluateVerifyGate(80, delta));
    expect(text).toContain('Gate: passed (minScore 80)');
    expect(text).toContain('All 1 previously-uncaught mutants are now killed.');
  });

  it('text explains a FAILED verdict in terms of the baseline, not a score', () => {
    const delta = computeVerifyDelta(baseline, result([{ line: 42, mutator: 'C' }]));
    const text = formatVerifyResultAsText('src/x.ts', delta, evaluateVerifyGate(80, delta));
    expect(text).toContain(
      'Gate: FAILED (minScore 80) — the baseline is not clear: mutants are still surviving and/or new ones appeared.',
    );
  });

  it('text explains a partial-re-run failure differently from a dirty baseline', () => {
    const delta = computeVerifyDelta(baseline, partialResult([]));
    const text = formatVerifyResultAsText('src/x.ts', delta, evaluateVerifyGate(80, delta));
    expect(text).toContain('Gate: FAILED (minScore 80) — the re-run did not complete');
  });

  it('text says nothing about a gate when none was requested', () => {
    expect(
      formatVerifyResultAsText('src/x.ts', computeVerifyDelta(baseline, result([]))),
    ).not.toContain('Gate:');
  });
});
