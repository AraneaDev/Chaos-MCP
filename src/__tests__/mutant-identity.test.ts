import { describe, it, expect } from 'vitest';
import { CHANGE_SIDE_CAP, changeOf, normalizeChange } from '../utils/mutant-identity.js';

describe('normalizeChange', () => {
  it('collapses whitespace runs and trims', () => {
    expect(normalizeChange('  a   >\t0  ')).toBe('a > 0');
  });

  it('caps at CHANGE_SIDE_CAP characters with an ellipsis', () => {
    const long = 'x'.repeat(CHANGE_SIDE_CAP + 50);
    const out = normalizeChange(long);
    expect(out).toHaveLength(CHANGE_SIDE_CAP);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves a string exactly at the cap untouched', () => {
    const exact = 'y'.repeat(CHANGE_SIDE_CAP);
    expect(normalizeChange(exact)).toBe(exact);
  });

  it('measures the cap AFTER collapsing whitespace', () => {
    // A line padded out past the cap by indentation alone must survive intact —
    // otherwise re-indenting code would silently change its identity, which is
    // the exact churn this normalisation exists to absorb.
    const padded = `${' '.repeat(60)}a > 0${' '.repeat(60)}`;
    expect(normalizeChange(padded)).toBe('a > 0');
  });
});

describe('changeOf', () => {
  it('joins both halves with an arrow (StrykerJS shape)', () => {
    expect(changeOf({ original: 'a > 0', mutated: 'true' })).toBe('a > 0 → true');
  });

  it('renders a mutated-only mutant with a leading arrow', () => {
    expect(changeOf({ mutated: 'true' })).toBe('→ true');
  });

  it('renders an original-only mutant with a trailing arrow', () => {
    expect(changeOf({ original: 'a > 0' })).toBe('a > 0 →');
  });

  it('returns undefined when the engine reported neither (cargo-mutants)', () => {
    expect(changeOf({})).toBeUndefined();
  });

  it('treats a whitespace-only side as absent', () => {
    expect(changeOf({ original: '   ', mutated: 'true' })).toBe('→ true');
    expect(changeOf({ original: 'a > 0', mutated: '  ' })).toBe('a > 0 →');
    expect(changeOf({ original: ' ', mutated: '\t' })).toBeUndefined();
  });

  it('keeps the one-sided forms distinct from each other', () => {
    // Without the arrows both would normalise to "true" and the two mutants
    // would share one identity.
    expect(changeOf({ mutated: 'true' })).not.toBe(changeOf({ original: 'true' }));
  });

  it('distinguishes two mutants sharing a replacement but not an original', () => {
    // The case the whole schema exists for: several ConditionalExpression
    // mutants on one line, every one of them replacing its span with `true`.
    const a = changeOf({ original: 'Array.isArray(args.unsuppress)', mutated: 'true' });
    const b = changeOf({ original: 'args.unsuppress.length > 0', mutated: 'true' });
    expect(a).not.toBe(b);
  });

  it('normalises each side independently', () => {
    expect(changeOf({ original: '  a\n>\t0 ', mutated: ' true ' })).toBe('a > 0 → true');
  });
});
