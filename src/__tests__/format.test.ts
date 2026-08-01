import { describe, it, expect } from 'vitest';
import {
  formatResultAsText,
  formatResultAsJson,
  buildResultPayload,
  type ResultPayload,
} from '../core/format.js';
import { hasNoMutableLogic, displayMutationScore } from '../core/score-semantics.js';
import { evaluateGate } from '../core/gate.js';
import type { MutationResult } from '../engines/base.js';

type Vuln = MutationResult['vulnerabilities'][number];

/** A description that matches the NoCoverage marker regex in format.ts. */
const NO_COVERAGE_DESC = 'no test reached this mutant';

function vuln(line: number, mutator: string, description = 'survived mutant'): Vuln {
  return { line, mutator, description };
}

function result(overrides: Partial<MutationResult> = {}): MutationResult {
  return {
    target: 'src/foo.ts',
    totalMutants: 10,
    killed: 8,
    survived: 2,
    mutationScore: '80.00%',
    vulnerabilities: [],
    ...overrides,
  };
}

interface JsonShape {
  target: string;
  mutationScore: string;
  summary: { total: number; killed: number; survived: number };
  survivors: { line: number; mutators: Record<string, number> }[];
  noCoverage: { line: number; mutators: Record<string, number> }[];
  note: string;
}

const CLEAN_NOTE = 'No surviving mutants — the test suite caught every mutation.';
const DIRTY_NOTE =
  'survivors: mutants your tests ran but did not kill. noCoverage: mutants no test reached (per line+mutator, so a line may appear here and in survivors). mutators = type→count. Add or strengthen tests targeting these.';

describe('formatResultAsText — advisory lines', () => {
  it('surfaces a fidelity warning when the engine flagged one', () => {
    // A fidelity note means the run's own numbers may be wrong (a
    // misconfiguration in the audited project, not a finding about the code).
    // Text consumers get no other signal that the score is untrustworthy.
    const text = formatResultAsText(result({ fidelityNote: 'PHPUnit stopped on a warning.' }));
    expect(text).toContain('Warning: PHPUnit stopped on a warning.');
  });

  it('prints no warning line for an ordinary result', () => {
    expect(formatResultAsText(result())).not.toContain('Warning:');
  });

  it('reports incompetent mutants, which explain why total < generated', () => {
    const text = formatResultAsText(result({ incompetent: 3 }));
    expect(text).toContain(
      'Note: 3 mutant(s) excluded as incompetent (mutated code never produced a real pass/fail).',
    );
  });

  it('ignores a negative incompetent count rather than printing it', () => {
    // The `&&` guard is what rejects nonsense; under `||` a negative value is
    // truthy and the report gains a "-1 mutant(s) excluded" line.
    expect(formatResultAsText(result({ incompetent: -1 }))).not.toContain('incompetent');
  });

  it('says nothing about incompetent mutants when there were none', () => {
    // Both arms of `result.incompetent && result.incompetent > 0`: absent, and
    // present-but-zero. A "0 mutant(s) excluded" line is pure noise.
    expect(formatResultAsText(result())).not.toContain('incompetent');
    expect(formatResultAsText(result({ incompetent: 0 }))).not.toContain('incompetent');
  });

  it('prints the scope note when the run was scoped', () => {
    const text = formatResultAsText(result({ scopeNote: 'no changed lines' }));
    expect(text).toContain('Scope: no changed lines');
    expect(formatResultAsText(result())).not.toContain('Scope:');
  });
});

describe('formatResultAsText — no-coverage section', () => {
  const noCov = (line: number, mutator = 'ConditionalExpression') =>
    vuln(line, mutator, NO_COVERAGE_DESC);

  it('reports how many no-coverage groups the cap hid', () => {
    // The survivors section has its own truncation note; the no-coverage
    // section repeats the pattern, and only a no-coverage-heavy result reaches
    // that second copy. Without it the list silently ends at the cap.
    const text = formatResultAsText(
      result({ vulnerabilities: [1, 2, 3, 4, 5].map((n) => noCov(n)) }),
      undefined,
      { maxSurvivors: 2 },
    );
    expect(text).toContain('No-coverage mutants (line: mutators):');
    expect(text).toContain('…3 more (raise maxSurvivors to see them)');
  });

  it('reports how many no-coverage groups the severity floor hid', () => {
    const text = formatResultAsText(
      result({ vulnerabilities: [noCov(1, 'ConditionalExpression'), noCov(2, 'StringLiteral')] }),
      { projectType: 'typescript' },
      { severityFloor: 'high' },
    );
    expect(text).toContain('…1 hidden below severityFloor');
  });

  it('adds neither note when nothing was capped or filtered', () => {
    const text = formatResultAsText(result({ vulnerabilities: [noCov(1)] }));
    expect(text).toContain('No-coverage mutants (line: mutators):');
    expect(text).not.toContain('raise maxSurvivors');
    expect(text).not.toContain('hidden below severityFloor');
  });

  it('prints the floor-ignored note when the caller asked for a floor without enrichment', () => {
    // Audit M6: the JSON path attaches this via enrichNote, and text users got
    // nothing — so a severityFloor that silently did nothing looked like a
    // floor that found nothing to hide.
    //
    // UPDATED: this test used to hand `formatResultAsText` a `floorIgnoredNote`
    // option and assert it was echoed. NO production caller ever set that field
    // — audit-output.ts never passed it — so the test was the only thing keeping
    // it alive while `prepareGroups` computed the real wording into
    // `prepared.enrichNote` and the text path threw it away. The field is gone;
    // the test now drives the note the way a real caller does (a severityFloor
    // with enrichment off) and asserts the SHARED wording reaches text output.
    const text = formatResultAsText(
      result({ vulnerabilities: [vuln(1, 'StringLiteral')] }),
      undefined,
      { severityFloor: 'high' },
    );
    expect(text).toContain(
      'severityFloor was ignored: it requires enrichment (severity classification), which is off for this run.',
    );
    expect(
      formatResultAsText(result({ vulnerabilities: [vuln(1, 'StringLiteral')] })),
    ).not.toContain('severityFloor was ignored');
  });

  it('uses the same floor-ignored wording in text and JSON', () => {
    // One computation, two renderings: the whole point of dropping the
    // caller-supplied note. If these ever diverge the note has been forked again.
    const r = result({ vulnerabilities: [vuln(1, 'StringLiteral')] });
    const text = formatResultAsText(r, undefined, { severityFloor: 'high' });
    const json = JSON.parse(
      JSON.stringify(buildResultPayload(r, { severityFloor: 'high' })),
    ) as ResultPayload;
    expect(json.enrichNote).toBeDefined();
    expect(text).toContain(json.enrichNote as string);
  });

  it('surfaces the unclassified-mutants advisory in text output too', () => {
    // The other thing `prepared.enrichNote` carries. Text output dropped it
    // entirely, so a report full of `[unknown]` severities never said why.
    const text = formatResultAsText(result({ vulnerabilities: [vuln(1, 'SomeFutureMutator')] }), {
      projectType: 'typescript',
    });
    expect(text).toContain('could not be classified');
  });
});

describe('unclassified-mutant advisory wording', () => {
  const unknownMutant = (projectType: 'rust' | 'php' | 'python' | 'typescript') =>
    buildResultPayload(result({ vulnerabilities: [vuln(1, 'Totally Unmapped Operator')] }), {
      enrich: { projectType },
    }).enrichNote ?? '';

  it('blames the tool only for cargo-mutants, which really does hide the operator', () => {
    expect(unknownMutant('rust')).toContain('cargo-mutants reports a free-text description');
  });

  it('does not tell a php/python/typescript caller their tool is operator-less', () => {
    // Infection, cosmic-ray and StrykerJS all report an operator name and the
    // engines store it, so "this language's mutation tool doesn't expose
    // per-mutant operator detail" was simply false — it sent a PHP user looking
    // for a better mutation tool when the gap was a missing lookup table here.
    for (const projectType of ['php', 'python', 'typescript'] as const) {
      const note = unknownMutant(projectType);
      expect(note).not.toContain("doesn't expose");
      expect(note).toContain('is not one this server maps to a severity category');
      expect(note).toContain(projectType);
    }
  });
});

describe('clean note for a partial (time-budget-truncated) run', () => {
  const cleanPartial = (overrides: Partial<MutationResult> = {}) =>
    result({
      survived: 0,
      killed: 12,
      totalMutants: 12,
      vulnerabilities: [],
      complete: false,
      batchesCompleted: 2,
      batchesPlanned: 7,
      stoppedReason: 'time_budget_exhausted',
      ...overrides,
    });

  it('does not claim the suite caught every mutation when batches were skipped', () => {
    // The consumer half of the zero-batch finding: a run that stopped early
    // scored only the batches that finished, so "the test suite caught every
    // mutation" claims full credit for a file that was merely sampled.
    const payload = buildResultPayload(cleanPartial());
    expect(payload.note).not.toContain('caught every mutation');
    expect(payload.note).toContain('the 2 of 7 batches that completed');
    expect(payload.note).toContain('unknown, not killed');
  });

  it('says the same thing in text output', () => {
    // Text and JSON must not disagree about whether a file is clean.
    const text = formatResultAsText(cleanPartial());
    expect(text).not.toContain('your tests caught all mutations');
    expect(text).toContain('the 2 of 7 batches that completed');
  });

  it('degrades gracefully when the batch counts are absent', () => {
    const payload = buildResultPayload(
      cleanPartial({ batchesCompleted: undefined, batchesPlanned: undefined }),
    );
    expect(payload.note).toContain('the part of this file that was measured');
  });

  it('names the time budget only when that is why it stopped', () => {
    const other = buildResultPayload(cleanPartial({ stoppedReason: undefined }));
    expect(other.note).toContain('the run stopped before the rest could run');
    expect(other.note).not.toContain('the time budget was exhausted');
  });

  // Found by running Chaos-MCP on itself: verifying a runId whose baseline held
  // no survivors short-circuits without running anything, and the payload said
  // "the test suite caught every mutation" over `total: 0`. That sentence is
  // only ever true when at least one mutant actually ran. The scopeNote already
  // explained the short-circuit; the note must not contradict it.
  describe('a short-circuit that ran zero mutants', () => {
    const shortCircuit = (scopeNote: string): MutationResult =>
      result({
        totalMutants: 0,
        killed: 0,
        survived: 0,
        vulnerabilities: [],
        mutationScore: '100.00%',
        scopeNote,
      });

    it('does not claim the suite caught every mutation when nothing was run', () => {
      const payload = buildResultPayload(
        shortCircuit(
          'The baseline for src/a.ts recorded no uncaught mutants, so there is nothing to verify; no mutants were run.',
        ),
      );
      expect(payload.note).not.toContain('caught every mutation');
      expect(payload.note).toContain('No mutants were run');
      expect(payload.note).toContain('see the scope note');
    });

    it('applies to the diffBase no-changes short-circuit too', () => {
      const payload = buildResultPayload(
        shortCircuit('No changed lines in src/a.ts vs main; nothing to mutate.'),
      );
      expect(payload.note).not.toContain('caught every mutation');
      expect(payload.note).toContain('No mutants were run');
    });

    it('says the same thing in text output', () => {
      const text = formatResultAsText(shortCircuit('No changed lines in src/a.ts vs main.'));
      expect(text).not.toContain('caught every mutation');
      expect(text).toContain('No mutants were run');
    });

    it('still prefers the no-mutable-logic wording when that is what a zero means', () => {
      // A whole-file run that enumerated nothing is a DIFFERENT zero, and
      // hasNoMutableLogic must keep winning — this guard must not swallow it.
      const payload = buildResultPayload(
        result({
          totalMutants: 0,
          killed: 0,
          survived: 0,
          vulnerabilities: [],
          scopeKind: 'whole-file',
        }),
      );
      expect(payload.note).toContain('no mutable logic');
      expect(payload.note).not.toContain('No mutants were run');
    });
  });

  it('still gives full credit to a run that completed', () => {
    // The unchanged happy path: `complete` absent or true keeps the original
    // wording, so a normal audit reads exactly as it did before.
    expect(buildResultPayload(result({ survived: 0, killed: 10, vulnerabilities: [] })).note).toBe(
      CLEAN_NOTE,
    );
    expect(
      buildResultPayload(result({ survived: 0, killed: 10, vulnerabilities: [], complete: true }))
        .note,
    ).toBe(CLEAN_NOTE);
  });
});

describe('enrichment reads the uncapped change set', () => {
  it('classifies a Rust group from a change beyond the display cap', () => {
    // `changes` is capped to 3 entries + a "…N more" sentinel for display. Rust
    // severity is derived from the change TEXT alone (cargo-mutants exposes no
    // operator name), so enriching from the capped list means an operator that
    // appears only in change #4 can never decide its own severity — and the
    // logical-first rule ordering exists precisely so `&&` outranks the rest.
    const r = result({
      vulnerabilities: [
        { line: 7, mutator: 'replace a', description: 'survived', mutated: 'replace a with 1' },
        { line: 7, mutator: 'replace b', description: 'survived', mutated: 'replace b with 2' },
        { line: 7, mutator: 'replace c', description: 'survived', mutated: 'replace c with 3' },
        {
          line: 7,
          mutator: 'replace d',
          description: 'survived',
          mutated: 'replace x && y with x || y',
        },
      ],
    });
    const payload = buildResultPayload(r, { enrich: { projectType: 'rust' } });
    const group = payload.survivors[0] as { severity?: string; changes?: string[] };
    expect(group.severity).toBe('high');
    expect(payload.summary.worstSeverity).toBe('high');
    // …while the DISPLAY list is still capped exactly as before.
    expect(group.changes).toEqual([
      'replace a with 1',
      'replace b with 2',
      'replace c with 3',
      '…1 more',
    ]);
  });

  it('leaves a within-cap group classified exactly as before', () => {
    const r = result({
      vulnerabilities: [
        { line: 7, mutator: 'replace >', description: 'survived', mutated: 'replace > with >=' },
      ],
    });
    const group = buildResultPayload(r, { enrich: { projectType: 'rust' } }).survivors[0] as {
      severity?: string;
      changes?: string[];
    };
    expect(group.severity).toBe('high');
    expect(group.changes).toEqual(['replace > with >=']);
  });
});

describe('gate verdict in text output', () => {
  // buildResultPayload computed `payload.gate` and it reached structuredContent,
  // but formatResultAsText never mentioned the threshold, the verdict, or the
  // failing state — a human or agent reading only the text block saw a clean
  // report for a FAILING gate. Driven by the same GateResult the payload uses.
  it('renders a failing gate with the threshold and the score', () => {
    const text = formatResultAsText(result({ mutationScore: '61.54%' }), undefined, {
      gate: evaluateGate('61.54%', 80),
    });
    expect(text).toContain('Gate: FAILED (minScore 80) — score 61.54% is below the threshold.');
  });

  it('renders a passing gate', () => {
    const text = formatResultAsText(result({ mutationScore: '92.00%' }), undefined, {
      gate: evaluateGate('92.00%', 80),
    });
    expect(text).toContain('Gate: passed (minScore 80)');
    expect(text).not.toContain('FAILED');
  });

  it('explains a gate that failed because the audit was incomplete', () => {
    // evaluateGate fails closed on a partial run: the score is not below the
    // threshold, it is not gradable at all, and the line must say so rather than
    // accuse the code of a low score it never had.
    const text = formatResultAsText(
      result({ mutationScore: '100.00%', complete: false }),
      undefined,
      { gate: evaluateGate('100.00%', 80, false) },
    );
    expect(text).toContain('Gate: FAILED (minScore 80) — the audit did not complete');
  });

  it('says nothing about a gate when no minScore was requested', () => {
    expect(formatResultAsText(result())).not.toContain('Gate:');
  });
});

describe('hasNoMutableLogic', () => {
  it('is true only for a zero-mutant result carrying no scope note', () => {
    expect(hasNoMutableLogic(result({ totalMutants: 0 }))).toBe(true);
  });

  it('is true for a whole-file zero even when the run carried a scope note', () => {
    // The bug this replaced: `!result.scopeNote` inferred the answer from
    // free-text prose, and every BATCHED TypeScript run stamps a scopeNote — so
    // a whole-file audit of a large file stopped qualifying and a logic-free
    // file went back to reporting "100.00%". scopeKind is the engine's
    // structural answer and outranks the prose.
    expect(
      hasNoMutableLogic(
        result({ totalMutants: 0, scopeKind: 'whole-file', scopeNote: 'mutated in 4 batches' }),
      ),
    ).toBe(true);
  });

  it('is false for a scoped zero, which only proves the RANGE was empty', () => {
    // lineScope/lineRanges restricted what was enumerated; zero there says
    // nothing about the rest of the file.
    expect(hasNoMutableLogic(result({ totalMutants: 0, scopeKind: 'scoped' }))).toBe(false);
    // …and stays false even with no scopeNote to fall back on, i.e. scopeKind
    // decides on its own rather than deferring to the legacy prose check.
    expect(
      hasNoMutableLogic(result({ totalMutants: 0, scopeKind: 'scoped', scopeNote: undefined })),
    ).toBe(false);
  });

  it('is false for a partial run, whose zero covers only the batches that ran', () => {
    // `complete === false` means a time-budgeted batch loop returned early. The
    // batches that never ran were never enumerated, so "this file has no mutable
    // logic" is a claim about code nobody looked at. scopeKind describes what
    // was REQUESTED; complete describes what was DELIVERED, and the verdict
    // needs both.
    expect(
      hasNoMutableLogic(result({ totalMutants: 0, scopeKind: 'whole-file', complete: false })),
    ).toBe(false);
    // …and the score it falls back to must still not be the bare "100.00%"
    // formatMutationScore(0, 0) produces: an empty denominator is not a perfect
    // kill rate, whichever reason left it empty.
    expect(
      displayMutationScore(
        result({
          totalMutants: 0,
          killed: 0,
          mutationScore: '100.00%',
          scopeKind: 'whole-file',
          complete: false,
        }),
      ),
    ).toBe('n/a');
  });

  it('is unaffected by an explicitly complete run', () => {
    // `complete !== false`, not `=== true`: engines with no batching concept
    // leave the field undefined and must behave exactly as before.
    expect(
      hasNoMutableLogic(result({ totalMutants: 0, scopeKind: 'whole-file', complete: true })),
    ).toBe(true);
    expect(hasNoMutableLogic(result({ totalMutants: 0, complete: true }))).toBe(true);
  });

  it('is false as soon as a single mutant was enumerated', () => {
    // Pins `totalMutants === 0` against a `<= 0` / `!== 0` mutant: a one-mutant
    // file has real logic and must keep its own score.
    expect(hasNoMutableLogic(result({ totalMutants: 1 }))).toBe(false);
  });

  it('is false for a zero-mutant result that carries a scope note', () => {
    // A scoped run that mutated nothing (e.g. a diff with no changed lines) is a
    // real run, not a file without logic — this kills the `&& !result.scopeNote`
    // conjunct, which a note-less fixture alone cannot reach.
    expect(hasNoMutableLogic(result({ totalMutants: 0, scopeNote: 'no changed lines' }))).toBe(
      false,
    );
  });

  it('treats an empty scope note as absent', () => {
    // `!result.scopeNote` is a truthiness test, not a presence test: an engine
    // that emits '' has said nothing, so the row must still read as "no logic".
    expect(hasNoMutableLogic(result({ totalMutants: 0, scopeNote: '' }))).toBe(true);
  });
});

describe('displayMutationScore', () => {
  it('substitutes "n/a" for a file with no mutable logic', () => {
    // Audit M3: a bare "100.00%" here would rank a logic-free file as the safest
    // in the leaderboard, indistinguishable from a genuine perfect kill rate.
    expect(displayMutationScore(result({ totalMutants: 0, mutationScore: '100.00%' }))).toBe('n/a');
  });

  it('passes the raw score through untouched for a real run', () => {
    expect(displayMutationScore(result({ mutationScore: '80.00%' }))).toBe('80.00%');
  });

  it('keeps a genuine 100% distinguishable from "n/a"', () => {
    // Kills a mutant that inverts the branch: with mutants enumerated, a perfect
    // score is proven coverage and must survive as "100.00%".
    expect(
      displayMutationScore(result({ totalMutants: 10, killed: 10, mutationScore: '100.00%' })),
    ).toBe('100.00%');
  });
});

describe('formatResultAsText', () => {
  it('renders the header and the clean success line when nothing survived', () => {
    const text = formatResultAsText(
      result({
        mutationScore: '100.00%',
        killed: 10,
        totalMutants: 10,
        survived: 0,
        vulnerabilities: [],
      }),
    );
    expect(text).toBe(
      [
        'Chaos-MCP Audit Report: src/foo.ts',
        'Mutation score: 100.00% (10/10 killed, 0 survived)',
        'No surviving mutants — your tests caught all mutations.',
      ].join('\n'),
    );
  });

  it('renders n/a and an honest note for a file with zero enumerated mutants', () => {
    const text = formatResultAsText(
      result({
        mutationScore: '100.00%',
        killed: 0,
        totalMutants: 0,
        survived: 0,
        vulnerabilities: [],
      }),
    );
    expect(text).toBe(
      [
        'Chaos-MCP Audit Report: src/foo.ts',
        'Mutation score: n/a (0/0 killed, 0 survived)',
        'No mutants generated — this file has no mutable logic, so mutation testing is not meaningful here (this is not the same as proven coverage).',
      ].join('\n'),
    );
  });

  it('groups survivors by line, sorts ascending, and collapses duplicate mutators to counts', () => {
    // Deliberately out of line order, with a duplicated mutator on line 3.
    const text = formatResultAsText(
      result({
        vulnerabilities: [
          vuln(10, 'ConditionalExpression'),
          vuln(3, 'StringLiteral'),
          vuln(3, 'StringLiteral'),
          vuln(10, 'LogicalOperator'),
          vuln(5, 'EqualityOperator'),
        ],
      }),
    );
    expect(text).toBe(
      [
        'Chaos-MCP Audit Report: src/foo.ts',
        'Mutation score: 80.00% (8/10 killed, 2 survived)',
        'Survivors (line: mutators):',
        '  3: StringLiteral×2',
        '  5: EqualityOperator',
        '  10: ConditionalExpression, LogicalOperator',
        'Add or strengthen tests targeting these lines to kill the survivors.',
      ].join('\n'),
    );
  });

  it('renders a single occurrence without an ×count suffix but two occurrences with ×2', () => {
    const text = formatResultAsText(
      result({ vulnerabilities: [vuln(7, 'BooleanLiteral'), vuln(8, 'Regex'), vuln(8, 'Regex')] }),
    );
    expect(text).toContain('  7: BooleanLiteral\n');
    expect(text).toContain('  8: Regex×2');
    // A `count > 1` → `count >= 1` mutant would render "BooleanLiteral×1".
    expect(text).not.toContain('BooleanLiteral×1');
  });

  it('shows only the no-coverage table (and no survivors header) when every survivor is uncovered', () => {
    const text = formatResultAsText(
      result({
        survived: 0,
        killed: 18,
        totalMutants: 20,
        mutationScore: '90.00%',
        vulnerabilities: [
          vuln(7, 'StringLiteral', NO_COVERAGE_DESC),
          vuln(7, 'BlockStatement', NO_COVERAGE_DESC),
        ],
      }),
    );
    expect(text).toBe(
      [
        'Chaos-MCP Audit Report: src/foo.ts',
        'Mutation score: 90.00% (18/20 killed, 0 survived)',
        'No-coverage mutants (line: mutators):',
        '  7: StringLiteral, BlockStatement',
        'Add or strengthen tests targeting these lines to kill the survivors.',
      ].join('\n'),
    );
    expect(text).not.toContain('Survivors (line: mutators):');
    // No-coverage mutants exist, so the all-clear success line must NOT appear.
    expect(text).not.toContain('No surviving mutants');
  });

  it('shows both the survivors and no-coverage tables, survivors first', () => {
    const text = formatResultAsText(
      result({
        vulnerabilities: [
          vuln(4, 'ConditionalExpression'),
          vuln(9, 'StringLiteral', NO_COVERAGE_DESC),
        ],
      }),
    );
    expect(text).toBe(
      [
        'Chaos-MCP Audit Report: src/foo.ts',
        'Mutation score: 80.00% (8/10 killed, 2 survived)',
        'Survivors (line: mutators):',
        '  4: ConditionalExpression',
        'No-coverage mutants (line: mutators):',
        '  9: StringLiteral',
        'Add or strengthen tests targeting these lines to kill the survivors.',
      ].join('\n'),
    );
  });
});

function baseResult(vulns: MutationResult['vulnerabilities']): MutationResult {
  return {
    target: 'src/x.ts',
    totalMutants: 10,
    killed: 7,
    survived: 3,
    mutationScore: '70.00%',
    vulnerabilities: vulns,
  };
}

describe('A1 mutation detail (changes)', () => {
  it('emits original → mutated when both present', () => {
    const json = JSON.parse(
      formatResultAsJson(
        baseResult([
          {
            line: 42,
            mutator: 'ConditionalExpression',
            description: 'survived',
            original: 'a > b',
            mutated: 'a >= b',
          },
        ]),
      ),
    );
    expect(json.survivors[0].changes).toEqual(['a > b → a >= b']);
  });

  it('emits mutated alone when original absent (Rust case)', () => {
    const json = JSON.parse(
      formatResultAsJson(
        baseResult([
          { line: 5, mutator: 'Rust', description: 'survived', mutated: 'replace foo -> bar' },
        ]),
      ),
    );
    expect(json.survivors[0].changes).toEqual(['replace foo -> bar']);
  });

  it('omits changes entirely when no detail present', () => {
    const json = JSON.parse(
      formatResultAsJson(
        baseResult([{ line: 9, mutator: 'BooleanLiteral', description: 'survived' }]),
      ),
    );
    expect(json.survivors[0].changes).toBeUndefined();
  });

  it('dedupes identical changes on a line', () => {
    const json = JSON.parse(
      formatResultAsJson(
        baseResult([
          { line: 1, mutator: 'M', description: 'survived', original: 'x', mutated: 'y' },
          { line: 1, mutator: 'M', description: 'survived', original: 'x', mutated: 'y' },
        ]),
      ),
    );
    expect(json.survivors[0].changes).toEqual(['x → y']);
  });

  it('caps at 3 distinct changes with a …N more sentinel', () => {
    const vulns = ['a', 'b', 'c', 'd', 'e'].map((c) => ({
      line: 1,
      mutator: 'M',
      description: 'survived',
      original: c,
      mutated: c + '!',
    }));
    const json = JSON.parse(formatResultAsJson(baseResult(vulns)));
    expect(json.survivors[0].changes).toHaveLength(4);
    expect(json.survivors[0].changes[3]).toBe('…2 more');
  });

  it('normalizes whitespace/newlines to a single line', () => {
    const json = JSON.parse(
      formatResultAsJson(
        baseResult([
          {
            line: 1,
            mutator: 'M',
            description: 'survived',
            original: 'a  >\n  b',
            mutated: 'a >= b',
          },
        ]),
      ),
    );
    expect(json.survivors[0].changes).toEqual(['a > b → a >= b']);
  });

  it('renders changes inline in text format', () => {
    const text = formatResultAsText(
      baseResult([
        {
          line: 42,
          mutator: 'ConditionalExpression',
          description: 'survived',
          original: 'a > b',
          mutated: 'a >= b',
        },
      ]),
    );
    expect(text).toContain('42: ConditionalExpression  (a > b → a >= b)');
  });

  it('emits original alone when mutated absent', () => {
    const json = JSON.parse(
      formatResultAsJson(
        baseResult([
          { line: 3, mutator: 'BlockStatement', description: 'survived', original: 'doStuff()' },
        ]),
      ),
    );
    expect(json.survivors[0].changes).toEqual(['doStuff()']);
  });

  it('adds the changes clause to the JSON note only when detail is present', () => {
    const withDetail = JSON.parse(
      formatResultAsJson(
        baseResult([
          { line: 1, mutator: 'M', description: 'survived', original: 'a', mutated: 'b' },
        ]),
      ),
    );
    expect(withDetail.note).toContain('changes = sampled');

    const noDetail = JSON.parse(
      formatResultAsJson(baseResult([{ line: 1, mutator: 'M', description: 'survived' }])),
    );
    expect(noDetail.note).not.toContain('changes = sampled');
  });

  it('trims leading/trailing whitespace in change strings (kills .trim mutant, line 44)', () => {
    const json = JSON.parse(
      formatResultAsJson(
        baseResult([
          { line: 1, mutator: 'M', description: 'survived', original: '  a > b  ', mutated: 'c' },
        ]),
      ),
    );
    expect(json.survivors[0].changes).toEqual(['a > b → c']);
  });

  it('shows all 3 distinct changes with no sentinel at the cap boundary (kills <= mutant, line 57)', () => {
    const vulns = ['a', 'b', 'c'].map((c) => ({
      line: 1,
      mutator: 'M',
      description: 'survived',
      original: c,
      mutated: c + '!',
    }));
    const json = JSON.parse(formatResultAsJson(baseResult(vulns)));
    expect(json.survivors[0].changes).toEqual(['a → a!', 'b → b!', 'c → c!']);
  });

  it('joins multiple change strings with "; " in text output (kills join-separator mutant, line 125)', () => {
    const text = formatResultAsText(
      baseResult([
        { line: 7, mutator: 'M', description: 'survived', original: 'a', mutated: 'b' },
        { line: 7, mutator: 'M', description: 'survived', original: 'c', mutated: 'd' },
      ]),
    );
    expect(text).toContain('7: M×2  (a → b; c → d)');
  });

  it('renders changes on no-coverage lines in text output (kills no-coverage suffix mutant, line 132)', () => {
    const text = formatResultAsText(
      baseResult([
        {
          line: 9,
          mutator: 'M',
          description: 'No test reached this line (NoCoverage).',
          original: 'x',
          mutated: 'y',
        },
      ]),
    );
    expect(text).toContain('No-coverage mutants (line: mutators):');
    expect(text).toContain('9: M  (x → y)');
  });

  it('adds the note clause when only one of several groups has detail (kills .some→.every mutant, line 148)', () => {
    const json = JSON.parse(
      formatResultAsJson(
        baseResult([
          { line: 1, mutator: 'M', description: 'survived', original: 'a', mutated: 'b' },
          { line: 2, mutator: 'M', description: 'No test reached this line (NoCoverage).' },
        ]),
      ),
    );
    expect(json.survivors[0].changes).toEqual(['a → b']);
    expect(json.noCoverage[0].changes).toBeUndefined();
    expect(json.note).toContain('changes = sampled');
  });
});

describe('formatResultAsText severityFloor signal', () => {
  it('shows floor-hidden count and cap truncation lines in text output', () => {
    // 2 high-severity survivors (one shown, one truncated by cap) + 1 low-severity (filtered by floor)
    const text = formatResultAsText(
      result({
        vulnerabilities: [
          { line: 1, mutator: 'ConditionalExpression', description: 'survived' }, // high
          { line: 2, mutator: 'ConditionalExpression', description: 'survived' }, // high
          { line: 3, mutator: 'StringLiteral', description: 'survived' }, // low
        ],
      }),
      { projectType: 'typescript' },
      { maxSurvivors: 1, severityFloor: 'high' },
    );
    expect(text).toContain('[high]');
    expect(text).toContain('…1 more (raise maxSurvivors to see them)');
    expect(text).toContain('…1 hidden below severityFloor');
  });

  it('reports the hidden count when the floor filters out every group', () => {
    // The per-section "…N hidden below severityFloor" notes live INSIDE the
    // `survivors.length > 0` / `noCoverage.length > 0` render blocks, and
    // `prepared.clean` is pre-filter, so a floor that removes 100% of groups
    // used to skip both blocks and leave the report as a header claiming
    // survivors plus a bare "targeting these lines" with no lines above it.
    const text = formatResultAsText(
      result({
        vulnerabilities: [
          vuln(1, 'StringLiteral'), // low — filtered
          vuln(2, 'StringLiteral', NO_COVERAGE_DESC), // low — filtered
        ],
      }),
      { projectType: 'typescript' },
      { severityFloor: 'high' },
    );
    expect(text).toContain(
      '…2 hidden below severityFloor — every surviving line group was filtered out, so none are listed above.',
    );
    expect(text).toContain(
      'Lower severityFloor to see them, or treat this file as clean at that severity.',
    );
    // Neither list rendered, so the advice that points at printed lines must not
    // appear — and the run is NOT clean: 2 mutants survived, they are just below
    // the floor the caller asked for.
    expect(text).not.toContain('Add or strengthen tests targeting these lines');
    expect(text).not.toContain('No surviving mutants');
    expect(text).not.toContain('Survivors (line: mutators):');
    expect(text).not.toContain('No-coverage mutants (line: mutators):');
  });

  it('keeps the ordinary trailing advice when at least one group survives the floor', () => {
    // The all-filtered branch must not fire while anything is still rendered:
    // the existing strings are pinned by the tests above.
    const text = formatResultAsText(
      result({
        vulnerabilities: [
          vuln(1, 'ConditionalExpression'), // high — kept
          vuln(2, 'StringLiteral'), // low — filtered
        ],
      }),
      { projectType: 'typescript' },
      { severityFloor: 'high' },
    );
    expect(text).toContain('  …1 hidden below severityFloor');
    expect(text).not.toContain('every surviving line group was filtered out');
    expect(text).toContain('Add or strengthen tests targeting these lines to kill the survivors.');
  });

  it('leaves the trailing advice alone when nothing was filtered at all', () => {
    // Guards the `hiddenByFloor > 0` half of the new condition: with no floor
    // the report must end exactly as it always did.
    const text = formatResultAsText(result({ vulnerabilities: [vuln(1, 'StringLiteral')] }));
    expect(text).toContain('Add or strengthen tests targeting these lines to kill the survivors.');
    expect(text).not.toContain('hidden below severityFloor');
  });
});

describe('A2 scopeNote', () => {
  it('includes scopeNote in JSON when present', () => {
    const r = baseResult([]);
    r.scopeNote = 'No changed lines in src/x.ts vs HEAD; nothing to mutate.';
    const json = JSON.parse(formatResultAsJson(r));
    expect(json.scopeNote).toBe('No changed lines in src/x.ts vs HEAD; nothing to mutate.');
  });

  it('omits scopeNote from JSON when absent', () => {
    const json = JSON.parse(formatResultAsJson(baseResult([])));
    expect('scopeNote' in json).toBe(false);
  });

  it('prints a Scope line in text output when present', () => {
    const r = baseResult([]);
    r.scopeNote = 'diffBase scoping is not supported for go; mutated the whole file.';
    const text = formatResultAsText(r);
    expect(text).toContain(
      'Scope: diffBase scoping is not supported for go; mutated the whole file.',
    );
  });
});

describe('formatResultAsJson', () => {
  it('emits the clean note and empty tables when nothing survived', () => {
    const json = JSON.parse(
      formatResultAsJson(result({ survived: 0, killed: 10, vulnerabilities: [] })),
    ) as JsonShape;
    expect(json).toEqual({
      target: 'src/foo.ts',
      mutationScore: '80.00%',
      summary: { total: 10, killed: 10, survived: 0 },
      survivors: [],
      noCoverage: [],
      note: CLEAN_NOTE,
    });
  });

  it('emits the dirty note and a survivors table when mutants survived', () => {
    const json = JSON.parse(
      formatResultAsJson(
        result({
          vulnerabilities: [vuln(5, 'ConditionalExpression'), vuln(5, 'ConditionalExpression')],
        }),
      ),
    ) as JsonShape;
    expect(json.note).toBe(DIRTY_NOTE);
    expect(json.survivors).toEqual([{ line: 5, mutators: { ConditionalExpression: 2 } }]);
    expect(json.noCoverage).toEqual([]);
    expect(json.summary).toEqual({ total: 10, killed: 8, survived: 2 });
  });

  it('emits the dirty note when only no-coverage mutants exist', () => {
    const json = JSON.parse(
      formatResultAsJson(
        result({ survived: 0, vulnerabilities: [vuln(12, 'StringLiteral', NO_COVERAGE_DESC)] }),
      ),
    ) as JsonShape;
    expect(json.note).toBe(DIRTY_NOTE);
    expect(json.survivors).toEqual([]);
    expect(json.noCoverage).toEqual([{ line: 12, mutators: { StringLiteral: 1 } }]);
  });
});

describe('formatResultAsText — un-applied suppressions', () => {
  it('says nothing when both counts are zero', () => {
    // The existing report must be untouched on a healthy run.
    const plain = formatResultAsText(result());
    expect(
      formatResultAsText(result(), undefined, {
        driftedSuppressions: 0,
        unverifiedSuppressions: 0,
      }),
    ).toBe(plain);
    expect(plain).not.toContain('suppression(s)');
  });

  it('reports drifted suppressions with the action to take', () => {
    const text = formatResultAsText(result(), undefined, { driftedSuppressions: 2 });
    expect(text).toContain(
      'Note: 2 suppression(s) no longer match the code they were recorded against and were NOT applied',
    );
    expect(text).toContain('re-confirm them with `suppress`');
  });

  it('reports unverified (v1) suppressions with the action to take', () => {
    const text = formatResultAsText(result(), undefined, { unverifiedSuppressions: 125 });
    expect(text).toContain(
      'Note: 125 suppression(s) predate content fingerprinting and were NOT applied',
    );
  });

  it('still reports them on a CLEAN result', () => {
    // The clean branch returns early; a file can come back 100% while carrying
    // stale suppressions, and that is exactly when it needs saying.
    const text = formatResultAsText(result({ survived: 0, vulnerabilities: [] }), undefined, {
      unverifiedSuppressions: 1,
    });
    expect(text).toContain('No surviving mutants');
    expect(text).toContain('predate content fingerprinting');
  });

  it('emits one line per kind, both when both are non-zero', () => {
    const text = formatResultAsText(result(), undefined, {
      driftedSuppressions: 1,
      unverifiedSuppressions: 1,
    });
    expect(text.split('\n').filter((l) => l.includes('suppression(s)'))).toHaveLength(2);
  });
});
