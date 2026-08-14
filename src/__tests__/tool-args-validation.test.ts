import { describe, it, expect } from 'vitest';
import { validateToolArgs } from '../handler.js';
import type { ToolArgs } from '../core/tool-args-validation.js';

/**
 * Boundary coverage for every per-argument validator in tool-args-validation.ts.
 *
 * These validators are the only thing standing between an untyped MCP payload
 * and the engine, and each one is a chain of `||`-ed guards where a later guard
 * usually happens to reject whatever an earlier one missed. That redundancy is
 * why the module scored 76% under mutation testing while looking well covered:
 * "is it rejected?" passes no matter which guard fired, so the assertions below
 * pin the EXACT message instead. A wrong message means the wrong guard caught
 * it, which is how an off-by-one or a dropped `Number.isInteger` hides.
 *
 * Everything goes through `validateToolArgs` (the real entry point) rather than
 * the private per-field functions, so the pass-through order and the
 * single-vs-multiple error formatting are exercised too.
 */

/** The rejection message, or null when the args validate. */
function message(args: ToolArgs): string | null {
  const result = validateToolArgs(args);
  if (result === null) return null;
  return (result.content[0] as { text: string }).text;
}

const MAX_LINE = 100_000;

/** The 32-bit signed maximum — the largest delay setTimeout accepts unclamped. */
const MAX_TIMEOUT = 2_147_483_647;

describe('validateToolArgs — timeoutMs', () => {
  const ERR = 'timeoutMs must be a positive number. Example: 120000.';
  const OVERFLOW_ERR = `timeoutMs must be <= ${MAX_TIMEOUT} (the largest delay a timer accepts; larger values are clamped to 1ms and abort the run immediately). Example: 120000.`;

  it('accepts a positive number and omission', () => {
    expect(message({})).toBeNull();
    expect(message({ timeoutMs: 1 })).toBeNull();
    expect(message({ timeoutMs: 120_000 })).toBeNull();
  });

  it('rejects zero, negatives, NaN, and numeric strings', () => {
    // `"60000"` is the one that matters in practice: it comes straight from a
    // hand-written JSON config and used to fall through to the 5-minute default
    // while the caller believed the run was capped.
    expect(message({ timeoutMs: 0 })).toBe(ERR);
    expect(message({ timeoutMs: -1 })).toBe(ERR);
    expect(message({ timeoutMs: Number.NaN })).toBe(ERR);
    expect(message({ timeoutMs: '60000' })).toBe(ERR);
    expect(message({ timeoutMs: null })).toBe(ERR);
  });

  it('accepts a fractional millisecond value (positive is the only rule)', () => {
    // Pins `> 0` rather than an integer check: the resolver takes any positive
    // number, and rejecting 0.5 here would be a stricter contract than the code.
    expect(message({ timeoutMs: 0.5 })).toBeNull();
  });

  it('accepts exactly the 32-bit timer maximum', () => {
    // The boundary itself is legal: setTimeout stores delays in a 32-bit int and
    // 2147483647 is the largest value it holds without clamping.
    expect(message({ timeoutMs: MAX_TIMEOUT })).toBeNull();
  });

  it('rejects a value above the 32-bit timer maximum', () => {
    // One stray zero in a config's defaultTimeoutMs used to pass validation and
    // then be clamped by Node to 1ms, killing the mutation tool right after
    // spawn while reporting "Command timed out after 3000000000ms".
    expect(message({ timeoutMs: MAX_TIMEOUT + 1 })).toBe(OVERFLOW_ERR);
    expect(message({ timeoutMs: 3_000_000_000 })).toBe(OVERFLOW_ERR);
    expect(message({ timeoutMs: Number.POSITIVE_INFINITY })).toBe(OVERFLOW_ERR);
  });
});

describe('validateToolArgs — perMutantTimeoutMs', () => {
  const ERR = 'perMutantTimeoutMs must be a positive number. Example: 10000.';

  it('accepts a positive number', () => {
    expect(message({ perMutantTimeoutMs: 10_000 })).toBeNull();
    expect(message({ perMutantTimeoutMs: 0.5 })).toBeNull();
  });

  it('rejects zero, negatives, and non-numbers', () => {
    expect(message({ perMutantTimeoutMs: 0 })).toBe(ERR);
    expect(message({ perMutantTimeoutMs: -1 })).toBe(ERR);
    expect(message({ perMutantTimeoutMs: '10000' })).toBe(ERR);
  });

  it('accepts the 32-bit timer maximum and rejects anything above it', () => {
    const OVERFLOW_ERR = `perMutantTimeoutMs must be <= ${MAX_TIMEOUT} (the largest delay a timer accepts; larger values are clamped to 1ms and abort the run immediately). Example: 10000.`;
    expect(message({ perMutantTimeoutMs: MAX_TIMEOUT })).toBeNull();
    expect(message({ perMutantTimeoutMs: MAX_TIMEOUT + 1 })).toBe(OVERFLOW_ERR);
  });
});

describe('validateToolArgs — prebuildCommand', () => {
  const ERR = 'prebuildCommand must be a non-empty string. Example: "npm run build".';

  it('accepts a non-empty command', () => {
    expect(message({ prebuildCommand: 'npm run build' })).toBeNull();
  });

  it('rejects empty, whitespace-only, and non-string commands', () => {
    // Whitespace-only is the interesting one: it is a non-empty string, so only
    // the `.trim()` distinguishes it from a real command.
    expect(message({ prebuildCommand: '' })).toBe(ERR);
    expect(message({ prebuildCommand: '   ' })).toBe(ERR);
    expect(message({ prebuildCommand: '\t\n' })).toBe(ERR);
    expect(message({ prebuildCommand: 123 })).toBe(ERR);
  });
});

describe('validateToolArgs — concurrency', () => {
  const ERR = 'concurrency must be an integer between 1 and 64 (Stryker workers).';

  it('accepts both ends of the inclusive range', () => {
    expect(message({ concurrency: 1 })).toBeNull();
    expect(message({ concurrency: 64 })).toBeNull();
  });

  it('rejects just outside each end', () => {
    expect(message({ concurrency: 0 })).toBe(ERR);
    expect(message({ concurrency: 65 })).toBe(ERR);
  });

  it('rejects non-integers and non-numbers', () => {
    expect(message({ concurrency: 1.5 })).toBe(ERR);
    expect(message({ concurrency: '4' })).toBe(ERR);
    expect(message({ concurrency: Number.NaN })).toBe(ERR);
  });
});

describe('validateToolArgs — lineScope', () => {
  const SHAPE_ERR =
    'lineScope must be { start: integer >= 1, end: integer >= start }. Example: { start: 10, end: 45 }.';
  const START_ERR = `lineScope.start must be an integer between 1 and ${MAX_LINE}.`;
  const END_ERR = `lineScope.end must be an integer between lineScope.start and ${MAX_LINE}.`;

  it('accepts a well-formed range, including a single-line one', () => {
    expect(message({ lineScope: { start: 10, end: 45 } })).toBeNull();
    expect(message({ lineScope: { start: 7, end: 7 } })).toBeNull();
  });

  it('rejects anything that is not a plain {start,end} object', () => {
    expect(message({ lineScope: null })).toBe(SHAPE_ERR);
    expect(message({ lineScope: [] })).toBe(SHAPE_ERR);
    expect(message({ lineScope: 'ten' })).toBe(SHAPE_ERR);
    expect(message({ lineScope: { start: '1', end: 2 } })).toBe(SHAPE_ERR);
    expect(message({ lineScope: { start: 1, end: '2' } })).toBe(SHAPE_ERR);
    expect(message({ lineScope: { start: 1.5, end: 2 } })).toBe(SHAPE_ERR);
    expect(message({ lineScope: { start: 1, end: 2.5 } })).toBe(SHAPE_ERR);
  });

  it('reports a start outside 1..MAX distinctly from a bad shape', () => {
    expect(message({ lineScope: { start: 0, end: 5 } })).toBe(START_ERR);
    expect(message({ lineScope: { start: MAX_LINE + 1, end: MAX_LINE + 2 } })).toBe(START_ERR);
    expect(message({ lineScope: { start: 1, end: 5 } })).toBeNull();
  });

  it('accepts a range sitting exactly on the upper bound', () => {
    // Both bounds are inclusive: `start > MAX` must not be `>=`, or the very
    // last addressable line of a maximal file becomes unauditable. The
    // `{ start: 1, end: MAX }` case below cannot see this — only a start ON the
    // boundary distinguishes the two operators.
    expect(message({ lineScope: { start: MAX_LINE, end: MAX_LINE } })).toBeNull();
  });

  it('reports an end below start, or past MAX, distinctly', () => {
    expect(message({ lineScope: { start: 10, end: 9 } })).toBe(END_ERR);
    expect(message({ lineScope: { start: 1, end: MAX_LINE + 1 } })).toBe(END_ERR);
    expect(message({ lineScope: { start: 1, end: MAX_LINE } })).toBeNull();
  });
});

describe('validateToolArgs — diffBase', () => {
  const SHAPE_ERR =
    'diffBase must be a non-empty string: "HEAD", "staged", or a git ref. Example: "HEAD".';
  const DASH_ERR = 'diffBase must not start with "-" (it would be mistaken for a git option).';

  it('accepts a plain ref', () => {
    expect(message({ diffBase: 'HEAD' })).toBeNull();
    expect(message({ diffBase: 'main' })).toBeNull();
  });

  it('rejects empty, whitespace-only, and non-string refs', () => {
    expect(message({ diffBase: '' })).toBe(SHAPE_ERR);
    expect(message({ diffBase: '   ' })).toBe(SHAPE_ERR);
    expect(message({ diffBase: 42 })).toBe(SHAPE_ERR);
  });

  it('rejects an option-like ref before anything else', () => {
    // A leading `-` would be parsed by git as a flag, not a ref.
    expect(message({ diffBase: '--upload-pack=evil' })).toBe(DASH_ERR);
    expect(message({ diffBase: '-x' })).toBe(DASH_ERR);
  });

  it('rejects diffBase combined with lineScope', () => {
    expect(message({ diffBase: 'HEAD', lineScope: { start: 1, end: 2 } })).toBe(
      'diffBase and lineScope are mutually exclusive — use one or the other, not both.',
    );
  });
});

describe('validateToolArgs — baseline', () => {
  const SHAPE_ERR =
    'baseline must be an object with optional "survivors" and "noCoverage" arrays from a prior run.';
  const ENTRY_ERR =
    'each baseline entry must be { line: integer >= 1, mutators: object of mutator→count }.';
  const COUNT_ERR = 'baseline mutator counts must be positive integers.';
  const NAME_ERR = 'baseline mutator names must be non-empty strings.';
  const EMPTY_ERR =
    'baseline must contain at least one (line, mutator) entry across survivors/noCoverage.';

  const ok = { survivors: [{ line: 42, mutators: { ConditionalExpression: 1 } }] };

  it('accepts a well-formed baseline', () => {
    expect(message({ baseline: ok })).toBeNull();
    expect(message({ baseline: { noCoverage: [{ line: 1, mutators: { M: 1 } }] } })).toBeNull();
  });

  it('rejects a baseline that is not a plain object', () => {
    expect(message({ baseline: null })).toBe(SHAPE_ERR);
    expect(message({ baseline: [] })).toBe(SHAPE_ERR);
    expect(message({ baseline: 'prior' })).toBe(SHAPE_ERR);
  });

  it('rejects a non-array survivors/noCoverage, naming the offending key', () => {
    expect(message({ baseline: { survivors: {} } })).toBe(
      'baseline.survivors must be an array of { line, mutators } objects.',
    );
    expect(message({ baseline: { noCoverage: 'none' } })).toBe(
      'baseline.noCoverage must be an array of { line, mutators } objects.',
    );
  });

  it('rejects an entry whose mutators is not a plain object', () => {
    // A string `mutators` is the sharp one: `Object.entries('ab')` yields
    // index→char pairs, so without the typeof guard it walks straight into the
    // count check and reports the wrong error.
    expect(message({ baseline: { survivors: [{ line: 1, mutators: 'ab' }] } })).toBe(ENTRY_ERR);
    expect(message({ baseline: { survivors: [{ line: 1, mutators: null }] } })).toBe(ENTRY_ERR);
    expect(message({ baseline: { survivors: [{ line: 1, mutators: [] }] } })).toBe(ENTRY_ERR);
    expect(message({ baseline: { survivors: [null] } })).toBe(ENTRY_ERR);
    expect(message({ baseline: { survivors: ['x'] } })).toBe(ENTRY_ERR);
  });

  it('requires every mutator count to be a positive integer', () => {
    const withCount = (cnt: unknown) =>
      message({ baseline: { survivors: [{ line: 1, mutators: { M: cnt } }] } });
    expect(withCount(0)).toBe(COUNT_ERR);
    expect(withCount(-1)).toBe(COUNT_ERR);
    expect(withCount(1.5)).toBe(COUNT_ERR);
    expect(withCount('2')).toBe(COUNT_ERR);
    expect(withCount(Number.NaN)).toBe(COUNT_ERR);
    // 1 is the lower bound and must be accepted.
    expect(withCount(1)).toBeNull();
  });

  it('rejects a blank mutator name', () => {
    expect(message({ baseline: { survivors: [{ line: 1, mutators: { '   ': 1 } }] } })).toBe(
      NAME_ERR,
    );
  });

  it('rejects a baseline with no (line, mutator) pairs at all', () => {
    expect(message({ baseline: {} })).toBe(EMPTY_ERR);
    expect(message({ baseline: { survivors: [] } })).toBe(EMPTY_ERR);
    expect(message({ baseline: { survivors: [{ line: 1, mutators: {} }] } })).toBe(EMPTY_ERR);
  });

  it('rejects baseline combined with diffBase or lineScope', () => {
    const ERR =
      'baseline is mutually exclusive with diffBase and lineScope — use only one at a time.';
    expect(message({ baseline: ok, diffBase: 'HEAD' })).toBe(ERR);
    expect(message({ baseline: ok, lineScope: { start: 1, end: 2 } })).toBe(ERR);
  });
});

describe('validateToolArgs — baseline line bounds', () => {
  const line = (n: unknown) =>
    message({ baseline: { survivors: [{ line: n, mutators: { M: 1 } }] } });

  it('accepts both ends of the permitted range', () => {
    expect(line(1)).toBeNull();
    expect(line(MAX_LINE)).toBeNull();
  });

  it('rejects a line below 1, or not an integer, with the same message', () => {
    // Every one of these must be caught by `line >= 1` / `Number.isInteger`,
    // NOT by the upper-bound guard — hence the exact message.
    const ERR = 'baseline survivors: line must be an integer >= 1.';
    expect(line(0)).toBe(ERR);
    expect(line(-1)).toBe(ERR);
    expect(line(1.5)).toBe(ERR);
    expect(line('5')).toBe(ERR);
    expect(line(Number.NaN)).toBe(ERR);
    expect(line(Number.POSITIVE_INFINITY)).toBe(ERR);
    expect(line(undefined)).toBe(ERR);
  });

  it('rejects a line past the upper bound with its own message', () => {
    expect(line(MAX_LINE + 1)).toBe(`baseline survivors: line must be <= ${MAX_LINE}.`);
  });
});

describe('validateToolArgs — mutatorAllowlist', () => {
  it('rejects a non-array with the array-shape message', () => {
    // Without this guard the very next line calls `.length`/`.every` on a
    // non-array and the validator throws instead of returning a message.
    expect(message({ mutatorAllowlist: 'ConditionalExpression' })).toBe(
      'mutatorAllowlist must be an array of strings. (StrykerJS v9 has no allowlist — use mutatorDenylist.)',
    );
    expect(message({ mutatorAllowlist: {} })).toBe(
      'mutatorAllowlist must be an array of strings. (StrykerJS v9 has no allowlist — use mutatorDenylist.)',
    );
  });

  it('reports an EMPTY allowlist distinctly from a populated one', () => {
    expect(message({ mutatorAllowlist: [] })).toBe(
      'mutatorAllowlist is not supported in StrykerJS v9 — pass mutatorDenylist instead.',
    );
  });

  it('rejects entries that are not non-empty strings', () => {
    const ERR = 'mutatorAllowlist entries must be non-empty strings.';
    expect(message({ mutatorAllowlist: [''] })).toBe(ERR);
    // Whitespace-only: a non-empty string that only `.trim()` rejects.
    expect(message({ mutatorAllowlist: ['   '] })).toBe(ERR);
    expect(message({ mutatorAllowlist: [123] })).toBe(ERR);
    expect(message({ mutatorAllowlist: [null] })).toBe(ERR);
    // EVERY entry must qualify, not merely one of them.
    expect(message({ mutatorAllowlist: ['ConditionalExpression', ''] })).toBe(ERR);
    expect(message({ mutatorAllowlist: ['', 'ConditionalExpression'] })).toBe(ERR);
  });

  it('rejects even a well-formed allowlist, because v9 cannot express one', () => {
    // Names the engine the OPTION belongs to. On a .rs or .py target the old
    // wording read as a claim about the engine that file would actually run on.
    expect(message({ mutatorAllowlist: ['ConditionalExpression'] })).toBe(
      'mutatorAllowlist is a StrykerJS option and is not supported in StrykerJS v9 — use mutatorDenylist instead, or supply your own stryker.config.json with explicit mutator settings. Non-TypeScript targets do not accept it at all.',
    );
  });
});

describe('validateToolArgs — enrich / maxSurvivors / severityFloor / outputFormat', () => {
  it('requires enrich to be a boolean', () => {
    const ERR = 'enrich must be a boolean. Example: true.';
    expect(message({ enrich: true })).toBeNull();
    expect(message({ enrich: false })).toBeNull();
    expect(message({ enrich: 'true' })).toBe(ERR);
    expect(message({ enrich: 1 })).toBe(ERR);
    expect(message({ enrich: null })).toBe(ERR);
  });

  it('requires maxSurvivors to be an integer >= 1', () => {
    const ERR = 'maxSurvivors must be an integer >= 1. Example: 20.';
    expect(message({ maxSurvivors: 1 })).toBeNull();
    expect(message({ maxSurvivors: 0 })).toBe(ERR);
    expect(message({ maxSurvivors: -1 })).toBe(ERR);
    expect(message({ maxSurvivors: 1.5 })).toBe(ERR);
    expect(message({ maxSurvivors: '20' })).toBe(ERR);
  });

  it('accepts exactly the three severity levels', () => {
    const ERR = 'severityFloor must be one of "high", "medium", or "low". Example: "high".';
    expect(message({ severityFloor: 'high' })).toBeNull();
    expect(message({ severityFloor: 'medium' })).toBeNull();
    expect(message({ severityFloor: 'low' })).toBeNull();
    // Case-sensitive, and "unknown" is deliberately not selectable.
    expect(message({ severityFloor: 'HIGH' })).toBe(ERR);
    expect(message({ severityFloor: 'unknown' })).toBe(ERR);
    expect(message({ severityFloor: '' })).toBe(ERR);
  });

  it('accepts exactly the two output formats', () => {
    const ERR = 'outputFormat must be one of "text" or "json". Example: "json".';
    expect(message({ outputFormat: 'text' })).toBeNull();
    expect(message({ outputFormat: 'json' })).toBeNull();
    expect(message({ outputFormat: 'JSON' })).toBe(ERR);
    expect(message({ outputFormat: 'xml' })).toBe(ERR);
  });
});

describe('validateToolArgs — dryRun / incremental', () => {
  // Both resolve via `typeof args.x === 'boolean' ? … : cfg`, so an unrejected
  // near-miss ("true", 1) reads as "not supplied" and silently escalates a
  // cheap pre-flight into a full mutation run. `false` must stay accepted —
  // it is a meaningful opt-out, not an absent value.
  it('requires dryRun to be a boolean', () => {
    const ERR = 'dryRun must be a boolean. Example: true.';
    expect(message({})).toBeNull();
    expect(message({ dryRun: true })).toBeNull();
    expect(message({ dryRun: false })).toBeNull();
    expect(message({ dryRun: 'true' })).toBe(ERR);
    expect(message({ dryRun: 1 })).toBe(ERR);
    expect(message({ dryRun: 0 })).toBe(ERR);
    expect(message({ dryRun: null })).toBe(ERR);
  });

  it('requires incremental to be a boolean', () => {
    const ERR = 'incremental must be a boolean. Example: true.';
    expect(message({})).toBeNull();
    expect(message({ incremental: true })).toBeNull();
    expect(message({ incremental: false })).toBeNull();
    expect(message({ incremental: 'false' })).toBe(ERR);
    expect(message({ incremental: 0 })).toBe(ERR);
    expect(message({ incremental: null })).toBe(ERR);
  });
});

describe('validateToolArgs — runId', () => {
  const SHAPE_ERR =
    'runId must be a non-empty string returned by a prior audit. Example: "a1b2c3d4".';
  const FORMAT_ERR =
    'runId must be an 8-character lowercase hex id returned by a prior audit. Example: "a1b2c3d4".';

  it('accepts an id of the minted shape', () => {
    expect(message({ runId: 'a1b2c3d4' })).toBeNull();
    expect(message({ runId: '00000000' })).toBeNull();
    expect(message({ runId: 'ffffffff' })).toBeNull();
  });

  it('rejects a missing or non-string id before checking its shape', () => {
    expect(message({ runId: '' })).toBe(SHAPE_ERR);
    expect(message({ runId: '   ' })).toBe(SHAPE_ERR);
    expect(message({ runId: 12345678 })).toBe(SHAPE_ERR);
  });

  it('rejects anything but 8 lowercase hex characters', () => {
    // The id is interpolated into a cache filename, so a path fragment here
    // would read an arbitrary JSON file off disk.
    expect(message({ runId: '../../etc' })).toBe(FORMAT_ERR);
    expect(message({ runId: 'A1B2C3D4' })).toBe(FORMAT_ERR); // uppercase
    expect(message({ runId: 'a1b2c3d' })).toBe(FORMAT_ERR); // 7 chars
    expect(message({ runId: 'a1b2c3d4e' })).toBe(FORMAT_ERR); // 9 chars
    expect(message({ runId: 'g1b2c3d4' })).toBe(FORMAT_ERR); // non-hex
    expect(message({ runId: 'a1b2c3d\n' })).toBe(FORMAT_ERR); // trailing newline
  });

  it('reports mutual exclusion BEFORE complaining about the id shape', () => {
    // A caller who passed both arguments needs to be told to drop one, not sent
    // off fixing an id that was fine.
    const ERR =
      'runId is mutually exclusive with baseline, diffBase, and lineScope — use only one at a time.';
    expect(message({ runId: 'a1b2c3d4', diffBase: 'HEAD' })).toBe(ERR);
    expect(message({ runId: 'a1b2c3d4', lineScope: { start: 1, end: 2 } })).toBe(ERR);
    // Even a malformed id reports the exclusion first.
    expect(message({ runId: 'NOT-HEX', diffBase: 'HEAD' })).toBe(ERR);
  });
});

describe('validateToolArgs — suppress / unsuppress', () => {
  const suppressShape =
    'suppress must be a non-empty array of { line: integer >= 1, mutator: string, reason?: string }.';
  const unsuppressShape =
    'unsuppress must be a non-empty array of { line: integer >= 1, mutator: string }.';
  const suppressEntry =
    'each suppress entry must be { line: integer >= 1, mutator: non-empty string, reason?: string }.';
  const unsuppressEntry =
    'each unsuppress entry must be { line: integer >= 1, mutator: non-empty string }.';

  it('accepts a well-formed array for each argument', () => {
    expect(
      message({ suppress: [{ line: 42, mutator: 'ConditionalExpression', reason: 'guard' }] }),
    ).toBeNull();
    expect(message({ suppress: [{ line: 42, mutator: 'ConditionalExpression' }] })).toBeNull();
    expect(message({ unsuppress: [{ line: 42, mutator: 'ConditionalExpression' }] })).toBeNull();
  });

  describe('the optional `change` field', () => {
    // `change` names WHICH mutant when one line carries several of the same
    // mutator. It is optional — omitted, the audit path resolves it from that
    // run's survivors — so the validator has to tell "absent" from "malformed"
    // and must not silently accept a value that could never match a mutant.
    const entry = (change: unknown) => ({
      suppress: [{ line: 42, mutator: 'ConditionalExpression', change }],
    });

    it('accepts a non-empty string on suppress and unsuppress', () => {
      expect(message(entry('a > 0 → true'))).toBeNull();
      expect(
        message({ unsuppress: [{ line: 42, mutator: 'Cond', change: 'a > 0 → true' }] }),
      ).toBeNull();
    });

    it('accepts an entry that omits it entirely', () => {
      expect(message({ suppress: [{ line: 42, mutator: 'Cond' }] })).toBeNull();
      expect(message(entry(undefined))).toBeNull();
    });

    it('rejects a non-string', () => {
      expect(message(entry(7))).toBe(suppressEntry);
      expect(message(entry(null))).toBe(suppressEntry);
      expect(message(entry(['a → b']))).toBe(suppressEntry);
      expect(message(entry({}))).toBe(suppressEntry);
    });

    it('rejects an empty or whitespace-only string', () => {
      // Not treated as absent: absent means "resolve it from the survivors",
      // and silently converting one to the other would file a broad
      // mutator-only entry the caller never asked for.
      expect(message(entry(''))).toBe(suppressEntry);
      expect(message(entry('   '))).toBe(suppressEntry);
      expect(message(entry('\t\n'))).toBe(suppressEntry);
    });

    it('rejects it on unsuppress too, not just suppress', () => {
      expect(message({ unsuppress: [{ line: 1, mutator: 'Cond', change: '' }] })).toBe(
        unsuppressEntry,
      );
    });
  });

  it('rejects a non-array or empty array, naming the argument', () => {
    expect(message({ suppress: [] })).toBe(suppressShape);
    expect(message({ suppress: {} })).toBe(suppressShape);
    expect(message({ unsuppress: [] })).toBe(unsuppressShape);
    expect(message({ unsuppress: 'all' })).toBe(unsuppressShape);
  });

  it('rejects an entry that is not a plain object with a non-empty mutator', () => {
    expect(message({ suppress: [null] })).toBe(suppressEntry);
    expect(message({ suppress: [[]] })).toBe(suppressEntry);
    expect(message({ suppress: ['1 A'] })).toBe(suppressEntry);
    expect(message({ suppress: [{ line: 1 }] })).toBe(suppressEntry);
    expect(message({ suppress: [{ line: 1, mutator: '' }] })).toBe(suppressEntry);
    expect(message({ suppress: [{ line: 1, mutator: '   ' }] })).toBe(suppressEntry);
    expect(message({ suppress: [{ line: 1, mutator: 123 }] })).toBe(suppressEntry);
    expect(message({ unsuppress: [{ line: 1, mutator: '' }] })).toBe(unsuppressEntry);
  });

  it('validates `reason` only where a reason is meaningful', () => {
    // `suppress` records a reason in the suppressions file, so a non-string is
    // an error. `unsuppress` has no reason field at all, so the same key is
    // simply ignored rather than rejected — this pins the allowReason flag,
    // which otherwise looks like dead configuration.
    expect(message({ suppress: [{ line: 1, mutator: 'M', reason: 123 }] })).toBe(suppressEntry);
    expect(message({ suppress: [{ line: 1, mutator: 'M', reason: undefined }] })).toBeNull();
    expect(message({ unsuppress: [{ line: 1, mutator: 'M', reason: 123 }] })).toBeNull();
  });

  it('applies the shared line bounds, prefixed with the argument name', () => {
    expect(message({ suppress: [{ line: 0, mutator: 'M' }] })).toBe(
      'suppress: line must be an integer >= 1.',
    );
    expect(message({ suppress: [{ line: 1.5, mutator: 'M' }] })).toBe(
      'suppress: line must be an integer >= 1.',
    );
    expect(message({ suppress: [{ line: MAX_LINE + 1, mutator: 'M' }] })).toBe(
      `suppress: line must be <= ${MAX_LINE}.`,
    );
    expect(message({ unsuppress: [{ line: -1, mutator: 'M' }] })).toBe(
      'unsuppress: line must be an integer >= 1.',
    );
    // Both bounds are inclusive.
    expect(message({ suppress: [{ line: 1, mutator: 'M' }] })).toBeNull();
    expect(message({ suppress: [{ line: MAX_LINE, mutator: 'M' }] })).toBeNull();
  });

  it('checks EVERY entry, not just the first', () => {
    expect(
      message({
        suppress: [
          { line: 1, mutator: 'M' },
          { line: 0, mutator: 'M' },
        ],
      }),
    ).toBe('suppress: line must be an integer >= 1.');
  });
});

describe('validateToolArgs — combined reporting', () => {
  it('accumulates every failure into one message instead of stopping at the first', () => {
    // A caller fixing arguments one round-trip at a time is the failure mode
    // this replaced; the count in the header is what tells them how many are left.
    const text = message({ timeoutMs: -1, enrich: 'yes', outputFormat: 'xml' });
    expect(text).toContain('Multiple argument errors (3):');
    expect(text).toContain('timeoutMs must be a positive number');
    expect(text).toContain('enrich must be a boolean');
    expect(text).toContain('outputFormat must be one of');
  });

  it('reports a single failure without the multi-error header', () => {
    expect(message({ enrich: 'yes' })).toBe('enrich must be a boolean. Example: true.');
  });

  it('returns null for an entirely valid argument set', () => {
    expect(
      message({
        timeoutMs: 120_000,
        perMutantTimeoutMs: 10_000,
        concurrency: 4,
        enrich: true,
        maxSurvivors: 20,
        severityFloor: 'high',
        outputFormat: 'json',
        minScore: 80,
        lineScope: { start: 1, end: 50 },
        suppress: [{ line: 3, mutator: 'M', reason: 'equivalent' }],
      }),
    ).toBeNull();
  });
});
