import { describe, it, expect, vi, beforeEach } from 'vitest';

// The sentinel-line anomaly is reported through the logger, so `warn` has to be
// observable — nothing else in the payload records that it happened.
vi.mock('../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/logger.js')>();
  return { ...actual, warn: vi.fn() };
});

import { buildResultPayload } from '../core/format.js';
import { warn } from '../utils/logger.js';

const mockWarn = vi.mocked(warn);
import { evaluateGate } from '../core/gate.js';
import type { MutationResult } from '../engines/base.js';

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

describe('buildResultPayload — unknown-line sentinel', () => {
  beforeEach(() => mockWarn.mockClear());

  const vuln = (line: number) => ({ line, mutator: 'M', description: 'survived' });

  it('warns once when any mutant carries the "location unknown" sentinel', () => {
    // The Python and Rust parsers fall back to line 0 when they cannot parse a
    // location. The compact/verify/suppression paths all key on the raw line, so
    // a "0: …" group would otherwise read as a real line 0 finding.
    buildResultPayload(result({ vulnerabilities: [vuln(0), vuln(0), vuln(5)] }));

    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      'src/foo.ts: one or more mutants have an unknown source line (sentinel < 1); ' +
        'the mutation tool did not report a parseable location for them.',
    );
  });

  it('treats line 1 as a real line, not a sentinel', () => {
    // Boundary: the sentinel is `< 1`, so the first line of a file must not trip it.
    buildResultPayload(result({ vulnerabilities: [vuln(1)] }));
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('stays silent for an ordinary result', () => {
    buildResultPayload(result({ vulnerabilities: [vuln(5), vuln(12)] }));
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('catches a negative line as a sentinel too', () => {
    buildResultPayload(result({ vulnerabilities: [vuln(-3)] }));
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});

describe('buildResultPayload — change strings', () => {
  beforeEach(() => mockWarn.mockClear());

  it('omits the changes key entirely when no mutant reported a diff', () => {
    // Not `changes: undefined`: the payload becomes structuredContent, and an
    // explicit undefined key is a different object shape than an absent one.
    const payload = buildResultPayload(
      result({ vulnerabilities: [{ line: 5, mutator: 'M', description: 'survived' }] }),
    );
    expect(Object.keys(payload.survivors[0])).not.toContain('changes');
  });

  it('renders "original → mutated" when the engine reported both', () => {
    const payload = buildResultPayload(
      result({
        vulnerabilities: [
          { line: 5, mutator: 'M', description: 'survived', original: 'a > b', mutated: 'a >= b' },
        ],
      }),
    );
    expect(payload.survivors[0].changes).toEqual(['a > b → a >= b']);
  });

  it('collapses runs of whitespace inside a change string', () => {
    const payload = buildResultPayload(
      result({
        vulnerabilities: [
          {
            line: 5,
            mutator: 'M',
            description: 'survived',
            original: '  a\n\t>   b  ',
            mutated: 'a >= b',
          },
        ],
      }),
    );
    expect(payload.survivors[0].changes).toEqual(['a > b → a >= b']);
  });

  it('falls back to the mutated text alone when there is no original', () => {
    // cargo-mutants reports a description with no "before" side.
    const payload = buildResultPayload(
      result({
        vulnerabilities: [
          { line: 5, mutator: 'M', description: 'survived', mutated: 'replace foo with bar' },
        ],
      }),
    );
    expect(payload.survivors[0].changes).toEqual(['replace foo with bar']);
  });
});

describe('buildResultPayload', () => {
  it('returns the same shape formatResultAsJson serializes (clean run)', () => {
    const payload = buildResultPayload(
      result({ survived: 0, killed: 10, mutationScore: '100.00%' }),
    );
    expect(payload).toMatchObject({
      target: 'src/foo.ts',
      mutationScore: '100.00%',
      summary: { total: 10, killed: 10, survived: 0 },
      survivors: [],
      noCoverage: [],
      note: 'No surviving mutants — the test suite caught every mutation.',
    });
  });

  it('reports n/a and an honest note when zero mutants were enumerated', () => {
    const payload = buildResultPayload(
      result({ survived: 0, killed: 0, totalMutants: 0, mutationScore: '100.00%' }),
    );
    expect(payload).toMatchObject({
      mutationScore: 'n/a',
      summary: { total: 0, killed: 0, survived: 0 },
      note: 'No mutants generated — this file has no mutable logic, so mutation testing is not meaningful here (not the same as proven coverage).',
    });
  });

  it('surfaces incompetent mutants in the payload and note (audit I3)', () => {
    const payload = buildResultPayload(result({ incompetent: 3 }));
    expect(payload.incompetent).toBe(3);
    expect(payload.note).toContain('3 mutant(s) were excluded as incompetent');
  });

  it('omits incompetent when zero or absent', () => {
    expect(buildResultPayload(result({ incompetent: 0 })).incompetent).toBeUndefined();
    expect(buildResultPayload(result()).incompetent).toBeUndefined();
  });

  it('groups survivors by line with mutator counts', () => {
    const payload = buildResultPayload(
      result({
        vulnerabilities: [
          { line: 3, mutator: 'ConditionalExpression', description: 'survived' },
          { line: 3, mutator: 'ConditionalExpression', description: 'survived' },
        ],
      }),
    );
    expect(payload.survivors).toEqual([{ line: 3, mutators: { ConditionalExpression: 2 } }]);
  });
});

function manySurvivors(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    line: i + 1,
    mutator: 'ConditionalExpression',
    description: 'survived',
  }));
}

describe('buildResultPayload — optional field assembly', () => {
  /** Every field the payload adds only when it has something to say. */
  const OPTIONAL_KEYS = [
    'survivorsTruncated',
    'noCoverageTruncated',
    'survivorsFiltered',
    'noCoverageFiltered',
    'enrichNote',
    'scopeNote',
    'fidelityNote',
    'complete',
    'batchesCompleted',
    'batchesPlanned',
    'stoppedReason',
    'suggestedTestFile',
    'ignoredOptions',
    'runId',
    'suppressedCount',
    'driftedSuppressions',
    'unverifiedSuppressions',
    'orphanedSuppressions',
    'gate',
    'incompetent',
  ];

  it('adds none of the optional keys to a plain result', () => {
    // Each is guarded by `if (value) payload.key = value`. Forcing any guard
    // true attaches the key with an `undefined` value: invisible to `toEqual`
    // and to JSON, but a different object shape for structuredContent — and for
    // any consumer that checks `'gate' in payload` or iterates the keys.
    const payload = buildResultPayload(result());
    const present = OPTIONAL_KEYS.filter((k) => Object.keys(payload).includes(k));
    expect(present).toEqual([]);
    expect(Object.keys(payload.summary)).not.toContain('worstSeverity');
  });

  it('carries every optional field through when each one has a value', () => {
    // The other arm: forcing a guard false silently drops information the
    // caller asked for. Asserting them together keeps one missing field from
    // hiding behind another.
    const payload = buildResultPayload(
      result({
        vulnerabilities: [{ line: 1, mutator: 'ConditionalExpression', description: 'survived' }],
        scopeNote: 'diff scoped',
        fidelityNote: 'suite may misreport',
        incompetent: 4,
        complete: false,
        batchesCompleted: 2,
        batchesPlanned: 5,
        stoppedReason: 'time_budget_exhausted',
      }),
      {
        suggestedTestFile: { path: 'src/foo.test.ts', exists: false },
        ignoredOptions: ['concurrency'],
        runId: 'a1b2c3d4',
        suppressedCount: 2,
        gate: { minScore: 80, passed: false },
      },
    );

    expect(payload.scopeNote).toBe('diff scoped');
    expect(payload.fidelityNote).toBe('suite may misreport');
    expect(payload.incompetent).toBe(4);
    expect(payload.complete).toBe(false);
    expect(payload.batchesCompleted).toBe(2);
    expect(payload.batchesPlanned).toBe(5);
    expect(payload.stoppedReason).toBe('time_budget_exhausted');
    expect(payload.suggestedTestFile).toEqual({ path: 'src/foo.test.ts', exists: false });
    expect(payload.ignoredOptions).toEqual(['concurrency']);
    expect(payload.runId).toBe('a1b2c3d4');
    expect(payload.suppressedCount).toBe(2);
    expect(payload.gate).toEqual({ minScore: 80, passed: false });
    expect(payload.note).toContain('2 equivalent mutant(s) suppressed');
    expect(payload.note).toContain('4 mutant(s) were excluded as incompetent');
  });

  it('treats an EMPTY ignoredOptions list as nothing to report', () => {
    // `opts.ignoredOptions && opts.ignoredOptions.length > 0` — an empty array
    // is truthy, so only the length half stops an empty "ignored" list from
    // being advertised to the caller.
    const payload = buildResultPayload(result(), { ignoredOptions: [] });
    expect(Object.keys(payload)).not.toContain('ignoredOptions');
  });

  it('treats a ZERO suppressedCount as nothing to report', () => {
    const payload = buildResultPayload(result(), { suppressedCount: 0 });
    expect(Object.keys(payload)).not.toContain('suppressedCount');
    expect(payload.note).not.toContain('suppressed');
  });

  it('records truncation and filtering for the NO-COVERAGE list, not just survivors', () => {
    // Both lists are capped and floored independently, and each writes its own
    // payload field. The survivors half is covered above; forcing the
    // no-coverage guards false drops the only signal that a caller's cap or
    // floor hid something on that side.
    const noCovVulns = [1, 2, 3, 4, 5].map((line) => ({
      line,
      mutator: line === 5 ? 'StringLiteral' : 'ConditionalExpression',
      description: 'no test reached this mutant',
    }));

    const capped = buildResultPayload(result({ vulnerabilities: noCovVulns }), {
      maxSurvivors: 2,
    });
    expect(capped.noCoverage).toHaveLength(2);
    expect(capped.noCoverageTruncated).toBe(3);

    const floored = buildResultPayload(result({ vulnerabilities: noCovVulns }), {
      enrich: { projectType: 'typescript' },
      severityFloor: 'high',
    });
    expect(floored.noCoverageFiltered).toBe(1);
  });

  it('ignores a negative incompetent or suppressedCount instead of reporting it', () => {
    // `value && value > 0` — the `&&` is what rejects a nonsensical count. With
    // `||` a negative sails through and the report gains a "-1 mutant(s)
    // excluded" line, which reads as a real exclusion.
    const payload = buildResultPayload(result({ incompetent: -1 }), { suppressedCount: -1 });
    expect(Object.keys(payload)).not.toContain('incompetent');
    expect(Object.keys(payload)).not.toContain('suppressedCount');
    expect(payload.note).not.toContain('-1');
  });

  it('takes the worst severity across BOTH survivors and no-coverage groups', () => {
    // `candidates.reduce((a, b) => rank(a) >= rank(b) ? a : b)` — forcing that
    // comparison true always keeps the FIRST candidate, so a high-severity
    // no-coverage mutant is reported behind a low-severity survivor.
    const payload = buildResultPayload(
      result({
        vulnerabilities: [
          { line: 1, mutator: 'StringLiteral', description: 'survived' }, // low
          {
            line: 2,
            mutator: 'ConditionalExpression',
            description: 'no test reached this mutant',
          }, // high
        ],
      }),
      { enrich: { projectType: 'typescript' } },
    );
    expect(payload.summary.worstSeverity).toBe('high');
  });
});

describe('buildResultPayload maxSurvivors', () => {
  it('caps survivors and records how many were truncated', () => {
    const payload = buildResultPayload(result({ vulnerabilities: manySurvivors(15) }), {
      maxSurvivors: 10,
    });
    expect(payload.survivors).toHaveLength(10);
    expect(payload.survivorsTruncated).toBe(5);
  });

  it('omits the truncation count when nothing is dropped', () => {
    const payload = buildResultPayload(result({ vulnerabilities: manySurvivors(3) }), {
      maxSurvivors: 10,
    });
    expect(payload.survivors).toHaveLength(3);
    expect(payload.survivorsTruncated).toBeUndefined();
  });

  it('keeps every survivor when no cap was requested', () => {
    // `typeof max !== 'number'` is the only thing handling an absent cap. Once
    // it is bypassed the count becomes `groups.length - undefined` → NaN, which
    // serialises into the payload as null and reads as a truncation that never
    // happened.
    const payload = buildResultPayload(result({ vulnerabilities: manySurvivors(15) }));
    expect(payload.survivors).toHaveLength(15);
    expect(payload.survivorsTruncated).toBeUndefined();
  });

  it('does not truncate at exactly the cap', () => {
    // Boundary: `groups.length <= max`. At equality nothing may be dropped.
    const payload = buildResultPayload(result({ vulnerabilities: manySurvivors(10) }), {
      maxSurvivors: 10,
    });
    expect(payload.survivors).toHaveLength(10);
    expect(payload.survivorsTruncated).toBeUndefined();
  });

  it('drops exactly one past the cap', () => {
    const payload = buildResultPayload(result({ vulnerabilities: manySurvivors(11) }), {
      maxSurvivors: 10,
    });
    expect(payload.survivors).toHaveLength(10);
    expect(payload.survivorsTruncated).toBe(1);
  });
});

// ── Finding 4: a truncated/filtered response must say it is not a baseline ──
describe('buildResultPayload — incomplete-list warning', () => {
  it('warns against echoing a truncated list back as a `baseline`', () => {
    // The schema tells callers to pass the `survivors`/`noCoverage` arrays back
    // as `baseline`, but they are capped before emission and verify infers
    // "killed" from ABSENCE — so every hidden group would be reported as fixed.
    const payload = buildResultPayload(result({ vulnerabilities: manySurvivors(15) }), {
      maxSurvivors: 10,
    });
    expect(payload.note).toContain('INCOMPLETE LIST: 5 line group(s) are hidden');
    expect(payload.note).toContain('Do not pass them back as `baseline`');
    // …and it names the uncapped alternative rather than just saying "careful".
    expect(payload.note).toContain('`runId`');
  });

  it('counts groups hidden by severityFloor too, not only by the cap', () => {
    const payload = buildResultPayload(
      result({
        vulnerabilities: [
          { line: 1, mutator: 'ConditionalExpression', description: 'survived' }, // high
          { line: 2, mutator: 'StringLiteral', description: 'survived' }, // low
        ],
      }),
      { enrich: { projectType: 'typescript' }, severityFloor: 'high' },
    );
    expect(payload.survivorsFiltered).toBe(1);
    expect(payload.note).toContain('INCOMPLETE LIST: 1 line group(s) are hidden');
  });

  it('says nothing when the list is complete', () => {
    // The documented baseline workflow must read exactly as it always did when
    // nothing was hidden.
    const payload = buildResultPayload(result({ vulnerabilities: manySurvivors(3) }), {
      maxSurvivors: 10,
    });
    expect(payload.note).not.toContain('INCOMPLETE LIST');
  });
});

describe('buildResultPayload severityFloor', () => {
  it('drops groups below the floor and counts them, when enriched', () => {
    const payload = buildResultPayload(
      result({
        vulnerabilities: [
          { line: 1, mutator: 'ConditionalExpression', description: 'survived' }, // high
          { line: 2, mutator: 'StringLiteral', description: 'survived' }, // low
        ],
      }),
      { enrich: { projectType: 'typescript' }, severityFloor: 'high' },
    );
    expect(payload.survivors).toHaveLength(1);
    expect(payload.survivors[0].line).toBe(1);
    expect(payload.survivorsFiltered).toBe(1);
  });

  it('ignores severityFloor when not enriched and notes why', () => {
    const payload = buildResultPayload(
      result({
        vulnerabilities: [{ line: 1, mutator: 'ConditionalExpression', description: 'survived' }],
      }),
      { severityFloor: 'high' },
    );
    expect(payload.survivors).toHaveLength(1);
    expect(payload.survivorsFiltered).toBeUndefined();
    expect(payload.enrichNote).toContain('severityFloor');
  });
});

describe('buildResultPayload worstSeverity', () => {
  it('derives worstSeverity from noCoverage when survivors is empty', () => {
    // ConditionalExpression is 'high' severity; description routes to noCoverage bucket
    const payload = buildResultPayload(
      result({
        survived: 0,
        killed: 10,
        mutationScore: '100.00%',
        vulnerabilities: [
          {
            line: 5,
            mutator: 'ConditionalExpression',
            description: 'no test reached this mutant',
          },
        ],
      }),
      { enrich: { projectType: 'typescript' } },
    );
    expect(payload.survivors).toHaveLength(0);
    expect(payload.noCoverage).toHaveLength(1);
    expect(payload.summary.worstSeverity).toBe('high');
  });
});

describe('buildResultPayload runId / suppressedCount', () => {
  it('threads runId and suppressedCount into the payload', () => {
    const r = {
      target: 'a.ts',
      totalMutants: 8,
      killed: 6,
      survived: 2,
      mutationScore: '75.00%',
      vulnerabilities: [],
    };
    const payload = buildResultPayload(r, { runId: 'abc123de', suppressedCount: 2 });
    expect(payload.runId).toBe('abc123de');
    expect(payload.suppressedCount).toBe(2);
    expect(payload.note).toContain('suppressed');
  });

  it('omits runId/suppressedCount when not provided', () => {
    const r = {
      target: 'a.ts',
      totalMutants: 4,
      killed: 4,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    };
    const payload = buildResultPayload(r, {});
    expect(payload.runId).toBeUndefined();
    expect(payload.suppressedCount).toBeUndefined();
  });
});

describe('buildResultPayload drifted / unverified suppressions', () => {
  function result(): MutationResult {
    return {
      target: 'a.ts',
      totalMutants: 4,
      killed: 4,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    };
  }

  it('leaves the payload byte-identical when both counts are zero', () => {
    // A healthy run must read EXACTLY as it did before the feature existed.
    const before = buildResultPayload(result(), {});
    const after = buildResultPayload(result(), {
      driftedSuppressions: 0,
      unverifiedSuppressions: 0,
    });
    expect(after).toEqual(before);
    expect(Object.keys(after)).not.toContain('driftedSuppressions');
    expect(Object.keys(after)).not.toContain('unverifiedSuppressions');
  });

  it('reports drifted suppressions and tells the caller to re-confirm them', () => {
    const payload = buildResultPayload(result(), { driftedSuppressions: 3 });
    expect(payload.driftedSuppressions).toBe(3);
    expect(payload.note).toContain(
      '3 suppression(s) no longer match the code they were recorded against and were NOT applied',
    );
    expect(payload.note).toContain('re-confirm them with `suppress`');
    expect(Object.keys(payload)).not.toContain('unverifiedSuppressions');
  });

  it('reports unverified (v1) suppressions separately', () => {
    const payload = buildResultPayload(result(), { unverifiedSuppressions: 125 });
    expect(payload.unverifiedSuppressions).toBe(125);
    expect(payload.note).toContain(
      '125 suppression(s) predate content fingerprinting and were NOT applied',
    );
    expect(Object.keys(payload)).not.toContain('driftedSuppressions');
  });

  it('reports both kinds independently, alongside the applied count', () => {
    const payload = buildResultPayload(result(), {
      suppressedCount: 1,
      driftedSuppressions: 2,
      unverifiedSuppressions: 4,
    });
    expect(payload.suppressedCount).toBe(1);
    expect(payload.driftedSuppressions).toBe(2);
    expect(payload.unverifiedSuppressions).toBe(4);
    // Applied first (what changed the score), then why the rest did not.
    expect(payload.note).toContain('1 equivalent mutant(s) suppressed');
    expect(payload.note).toContain('2 suppression(s) no longer match');
    expect(payload.note).toContain('4 suppression(s) predate content fingerprinting');
  });
});

describe('buildResultPayload orphaned suppressions', () => {
  it('carries orphanedSuppressions onto the payload and the note', () => {
    const payload = buildResultPayload(result(), { orphanedSuppressions: 3 });
    expect(payload.orphanedSuppressions).toBe(3);
    expect(payload.note).toContain('matched no mutant');
  });

  it('omits orphanedSuppressions entirely when there are none', () => {
    const payload = buildResultPayload(result(), { orphanedSuppressions: 0 });
    expect(payload).not.toHaveProperty('orphanedSuppressions');
  });
});

describe('buildResultPayload gate', () => {
  it('threads a gate result into the payload', () => {
    const r = {
      target: 'a.ts',
      totalMutants: 8,
      killed: 6,
      survived: 2,
      mutationScore: '75.00%',
      vulnerabilities: [],
    };
    const payload = buildResultPayload(r, { gate: evaluateGate('75.00%', 80) });
    expect(payload.gate).toEqual({ minScore: 80, passed: false });
  });

  it('omits gate when not provided', () => {
    const r = {
      target: 'a.ts',
      totalMutants: 4,
      killed: 4,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    };
    expect(buildResultPayload(r, {}).gate).toBeUndefined();
  });
});

describe('buildResultPayload batch completion metadata', () => {
  it('threads every partial-audit field into the payload', () => {
    const payload = buildResultPayload(
      result({
        complete: false,
        batchesCompleted: 1,
        batchesPlanned: 3,
        stoppedReason: 'time_budget_exhausted',
      }),
      {},
    );
    expect(payload).toMatchObject({
      complete: false,
      batchesCompleted: 1,
      batchesPlanned: 3,
      stoppedReason: 'time_budget_exhausted',
    });
  });

  it('omits every batch field when the engine did not provide it', () => {
    const payload = buildResultPayload(result({}), {});
    expect(payload).not.toHaveProperty('complete');
    expect(payload).not.toHaveProperty('batchesCompleted');
    expect(payload).not.toHaveProperty('batchesPlanned');
    expect(payload).not.toHaveProperty('stoppedReason');
  });
});
