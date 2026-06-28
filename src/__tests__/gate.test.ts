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
  it('treats an unparseable score as passing', () => {
    expect(evaluateGate('n/a', 80)).toEqual({ minScore: 80, passed: true });
    expect(evaluateGate('', 80).passed).toBe(true);
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
