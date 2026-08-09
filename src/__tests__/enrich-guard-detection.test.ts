import { describe, it, expect } from 'vitest';
import { looksLikeExhaustivenessGuard } from '../core/enrich.js';

/**
 * `looksLikeExhaustivenessGuard` decides whether a surviving mutant gets the
 * ordinary "add a test" advice or the EQUIVALENT_GUARD_SEMANTIC one — "do not
 * write a test for this; suppress it as equivalent". That makes it the one
 * function here whose wrong answer costs a user real work: a false positive
 * tells them to suppress a genuine coverage gap.
 *
 * It had no direct tests. Every case below is built so the mutant takes a
 * visibly different path rather than merely recomputing the same answer.
 */

/** Mirrors GUARD_SCAN_MAX_LINES in core/enrich.ts (not exported). */
const SCAN_MAX = 40;
/** A marker line: the `const x: never = y` idiom the detector looks for. */
const MARKER = '  const unhandled: never = diff;';

describe('looksLikeExhaustivenessGuard — bounds of the line argument', () => {
  it('accepts a guard on the very FIRST line', () => {
    // The `line < 1` guard rejects below the range, so line 1 itself must be
    // scanned. `<= 1` would refuse to look at the first line of any file.
    expect(looksLikeExhaustivenessGuard(1, [MARKER])).toBe(true);
  });

  it('accepts a guard on the very LAST line', () => {
    // Mirror of the above: `line > length` rejects past the end, so the last
    // line is in range. `>= length` would blind the detector to it.
    expect(looksLikeExhaustivenessGuard(2, ['const a = 1;', MARKER])).toBe(true);
  });

  it('refuses a line outside the source, and a missing source', () => {
    expect(looksLikeExhaustivenessGuard(0, [MARKER])).toBe(false);
    expect(looksLikeExhaustivenessGuard(2, [MARKER])).toBe(false);
    expect(looksLikeExhaustivenessGuard(1, undefined)).toBe(false);
  });
});

describe('looksLikeExhaustivenessGuard — the scan ceiling', () => {
  it('stops at the end of the source rather than reading past it', () => {
    // The ceiling is min(sourceLines.length, …). Taking the MAXIMUM instead
    // walks off the end of the array, and the depth counter dereferences each
    // line — so the detector throws a TypeError on any unclosed block near the
    // end of a file instead of answering.
    const lines = ['default: {', '  a();', '  b();'];

    expect(looksLikeExhaustivenessGuard(1, lines)).toBe(false);
  });

  it('scans exactly GUARD_SCAN_MAX_LINES lines of an open block, no more', () => {
    // The cap exists so an unbalanced brace cannot walk the rest of the file.
    // A marker just past it must NOT be found: reaching it means the ceiling
    // was computed one line too far, or the loop ran one iteration too many.
    const lines = [
      'switch (kind) {', // opens depth 1, never closed
      ...Array.from({ length: SCAN_MAX - 1 }, () => '  noop();'),
      MARKER, // sits at index SCAN_MAX — one beyond the last scanned line
      '  more();',
    ];

    expect(looksLikeExhaustivenessGuard(1, lines)).toBe(false);
  });

  it('finds a marker on the LAST line the cap allows', () => {
    // The other side of the same boundary, so "scans 40" is pinned from both
    // directions rather than only from above.
    const lines = [
      'switch (kind) {',
      ...Array.from({ length: SCAN_MAX - 2 }, () => '  noop();'),
      MARKER, // index SCAN_MAX - 1 — the last line inside the cap
      '  more();',
    ];

    expect(looksLikeExhaustivenessGuard(1, lines)).toBe(true);
  });
});

describe('looksLikeExhaustivenessGuard — an ordinary line is not a guard', () => {
  it('does not borrow a marker from the lines below an unrelated statement', () => {
    // A line that neither opens a block nor is a switch label is judged ALONE.
    // Scanning on from it would let any statement sitting above a guard inherit
    // "suppress this" — the false positive that costs a user a real test.
    const lines = ['const x = 1;', MARKER];

    expect(looksLikeExhaustivenessGuard(1, lines)).toBe(false);
  });

  it('still recognises a marker ON the line itself', () => {
    expect(looksLikeExhaustivenessGuard(1, ['  assertNeverProjectType(kind);'])).toBe(true);
  });
});

describe('looksLikeExhaustivenessGuard — brace-less switch arms', () => {
  it('scans a `default:` arm and finds its marker', () => {
    expect(looksLikeExhaustivenessGuard(1, ['default:', MARKER])).toBe(true);
  });

  it('scans a `case` label with a multi-character value', () => {
    // The label pattern consumes everything up to the colon. Matching a single
    // character instead would fail on every real `case 'name':`.
    expect(looksLikeExhaustivenessGuard(1, ["case 'ranges':", MARKER])).toBe(true);
  });

  it('is anchored: a label appearing MID-LINE does not open a scan', () => {
    // Without the leading anchor, any line that merely contains the word
    // `default:` starts a guard scan.
    expect(looksLikeExhaustivenessGuard(1, ['  x = 1; default:', MARKER])).toBe(false);
  });

  it('requires the label to be ALONE on its line', () => {
    // Without the trailing anchor, `default: doThing();` reads as a bare label
    // and the scan runs on into unrelated code.
    expect(looksLikeExhaustivenessGuard(1, ['default: doThing();', MARKER])).toBe(false);
  });

  it('gives up at the end of the arm rather than reading the next one', () => {
    // A REACHABLE arm must not borrow the guard from a `default:` below it.
    // Each terminator is asserted separately: they are separate alternatives in
    // the pattern, and one of them going missing is invisible if only `break`
    // is ever exercised.
    for (const terminator of ['  break;', '  return x;', '  continue;', '  throw new Error();']) {
      expect(looksLikeExhaustivenessGuard(1, ["case 'a':", terminator, MARKER])).toBe(false);
    }
  });

  it('gives up at the next label or a closing brace', () => {
    for (const boundary of ["  case 'b':", '  default:', '}']) {
      expect(looksLikeExhaustivenessGuard(1, ["case 'a':", boundary, MARKER])).toBe(false);
    }
  });

  it('is anchored on the terminator too: a mention mid-line does not end the arm', () => {
    // `// return early` is a comment, not a terminator. An unanchored pattern
    // stops the scan there and reports a real guard as an ordinary gap.
    const lines = ["case 'a':", '  foo(); // return early', MARKER];

    expect(looksLikeExhaustivenessGuard(1, lines)).toBe(true);
  });

  it('does not treat `returning()` as a `return` terminator', () => {
    // The word boundary after `return`. Without it any identifier starting with
    // "return" ends the arm early.
    const lines = ["case 'a':", '  returning();', MARKER];

    expect(looksLikeExhaustivenessGuard(1, lines)).toBe(true);
  });

  it('reports an arm with neither marker nor terminator as NOT a guard', () => {
    // The fall-through answer for a scan that simply ran out of lines.
    expect(looksLikeExhaustivenessGuard(1, ['default:', '  a();', '  b();'])).toBe(false);
  });

  it('applies the same scan cap to a brace-less arm as to a braced block', () => {
    // The two branches keep their own loops, so the cap has to be pinned twice.
    // A marker one line past the ceiling must not be found by either.
    const lines = [
      'default:',
      ...Array.from({ length: SCAN_MAX - 1 }, () => '  noop();'),
      MARKER, // index SCAN_MAX — one beyond the last line the cap allows
      '  more();',
    ];

    expect(looksLikeExhaustivenessGuard(1, lines)).toBe(false);
  });

  it('accepts a label spaced away from its colon', () => {
    // `default :` — the pattern allows whitespace on BOTH sides of the colon.
    // Requiring none there stops the detector recognising the arm at all.
    expect(looksLikeExhaustivenessGuard(1, ['default :', MARKER])).toBe(true);
  });

  it('accepts a label with trailing whitespace after the colon', () => {
    // The line must be nothing BUT the label, and trailing spaces are still
    // nothing. A pattern that demands non-space to the end rejects any label
    // an editor left a trailing space on.
    expect(looksLikeExhaustivenessGuard(1, ['default:   ', MARKER])).toBe(true);
  });

  it('ends the arm on a terminator spaced away from its punctuation', () => {
    // `break ;` and `continue ;` are unusual but legal, and the pattern
    // deliberately tolerates the gap. Not tolerating it walks straight past the
    // end of a reachable arm and borrows the guard below it.
    for (const terminator of ['  break ;', '  continue ;']) {
      expect(looksLikeExhaustivenessGuard(1, ["case 'a':", terminator, MARKER])).toBe(false);
    }
  });

  it('ends the arm on a following label spaced away from its colon', () => {
    expect(looksLikeExhaustivenessGuard(1, ["case 'a':", '  default :', MARKER])).toBe(false);
  });
});

describe('looksLikeExhaustivenessGuard — the marker patterns', () => {
  // Each pattern allows OPTIONAL whitespace at a specific position. The mutants
  // tighten that to "exactly one" or widen it to "any non-space", so every case
  // below sits precisely where the quantifier is.

  it('matches an assertNever call written with a space before the paren', () => {
    expect(looksLikeExhaustivenessGuard(1, ['  assertNeverProjectType (kind);'])).toBe(true);
  });

  it('matches assertUnreachable with and without a space before the paren', () => {
    expect(looksLikeExhaustivenessGuard(1, ['  assertUnreachable(kind);'])).toBe(true);
    expect(looksLikeExhaustivenessGuard(1, ['  assertUnreachable (kind);'])).toBe(true);
  });

  it('matches the never-typed assignment however it is spaced', () => {
    for (const text of [
      '  const u:never=diff;',
      '  const u: never= diff;',
      '  const u :  never  =  diff;',
    ]) {
      expect(looksLikeExhaustivenessGuard(1, [text])).toBe(true);
    }
  });

  it('does not match a generic unreachable throw', () => {
    // Deliberately NOT a marker: a throwing guard can sit on a reachable error
    // path that genuinely should be tested, and advising suppression there
    // would hide a real gap.
    expect(looksLikeExhaustivenessGuard(1, ["  throw new Error('unreachable');"])).toBe(false);
  });
});

describe('looksLikeExhaustivenessGuard — braced guard blocks', () => {
  it('scans a braced block to its matching close', () => {
    const lines = ['default: {', MARKER, '}'];

    expect(looksLikeExhaustivenessGuard(1, lines)).toBe(true);
  });

  it('stops at the closing brace rather than running into the code after it', () => {
    // Depth returning to zero ends the block. Reading on would let the
    // statement AFTER a plain block inherit a guard that follows it.
    const lines = ['if (x) {', '  a();', '}', MARKER];

    expect(looksLikeExhaustivenessGuard(1, lines)).toBe(false);
  });
});
