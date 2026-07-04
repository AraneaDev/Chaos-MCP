import { describe, it, expect } from 'vitest';
import { evaluateGate, validateMinScore } from '../gate.js';

describe('evaluateGate', () => {
  it('passes when score >= minScore', () => {
    expect(evaluateGate('87.50%', 80)).toEqual({ minScore: 80, passed: true });
  });
  it('passes on exact equality', () => {
    expect(evaluateGate('80.00%', 80)).toEqual({ minScore: 80, passed: true });
  });
  it('fails when score < minScore', () => {
    expect(evaluateGate('72.00%', 80)).toEqual({ minScore: 80, passed: false });
  });
  it('parses a score without a percent sign', () => {
    expect(evaluateGate('90', 80).passed).toBe(true);
  });
  it('grades an integer-only score below the threshold as failing', () => {
    // A bare integer (no decimal) must still parse and grade. This distinguishes
    // the optional-decimal regex `(?:\.\d+)?` from a mutant that requires a
    // decimal — under which "72" would not match and would spuriously pass.
    expect(evaluateGate('72', 80)).toEqual({ minScore: 80, passed: false });
  });
  it('treats an unparseable score as passing', () => {
    expect(evaluateGate('n/a', 80)).toEqual({ minScore: 80, passed: true });
    expect(evaluateGate('', 80).passed).toBe(true);
  });

  it('retains full decimal precision when grading against a fractional threshold', () => {
    // Pins the fractional part of the regex `(?:\.\d+)?`. A "79.95" score sitting
    // exactly on a 79.95 threshold must pass. Mutants that truncate the fraction to
    // a single digit (`\.\d` → "79.9") or reject digits after the dot (`\.\D+` →
    // "79") both drop below the threshold and would spuriously fail — so this kills
    // the ×2 Regex survivors on line 13 that a whole-number score can't reach.
    expect(evaluateGate('79.95%', 79.95)).toEqual({ minScore: 79.95, passed: true });
  });
});

describe('validateMinScore', () => {
  it('accepts undefined (optional)', () => {
    expect(validateMinScore(undefined)).toBeNull();
  });
  it('accepts 0..100', () => {
    expect(validateMinScore(0)).toBeNull();
    expect(validateMinScore(80)).toBeNull();
    expect(validateMinScore(100)).toBeNull();
    expect(validateMinScore(72.5)).toBeNull();
  });
  it('rejects out-of-range and non-numbers', () => {
    expect(validateMinScore(-1)).toMatch(/minScore/);
    expect(validateMinScore(101)).toMatch(/minScore/);
    expect(validateMinScore('80')).toMatch(/minScore/);
    expect(validateMinScore(NaN)).toMatch(/minScore/);
  });
});
