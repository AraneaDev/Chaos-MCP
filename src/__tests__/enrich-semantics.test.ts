import { describe, it, expect } from 'vitest';
import { MUTATOR_SEMANTICS, SEVERITY_RANK, UNKNOWN_SEMANTIC } from '../enrich.js';

describe('MUTATOR_SEMANTICS table integrity', () => {
  it('every entry has a non-empty why and hint and a valid tier', () => {
    const tiers = new Set(['high', 'medium', 'low']);
    for (const sem of Object.values(MUTATOR_SEMANTICS)) {
      expect(sem.why.length).toBeGreaterThan(0);
      expect(sem.hint.length).toBeGreaterThan(0);
      expect(tiers.has(sem.severity)).toBe(true);
    }
  });

  it('classifies the high-risk control-flow mutators as high severity', () => {
    for (const name of [
      'ConditionalExpression',
      'EqualityOperator',
      'ArithmeticOperator',
      'LogicalOperator',
      'UnaryOperator',
      'UpdateOperator',
      'BooleanLiteral',
      'BlockStatement',
    ]) {
      expect(MUTATOR_SEMANTICS[name]?.severity).toBe('high');
    }
  });

  it('classifies cosmetic mutators as low severity', () => {
    expect(MUTATOR_SEMANTICS.StringLiteral.severity).toBe('low');
    expect(MUTATOR_SEMANTICS.Regex.severity).toBe('low');
  });

  it('ranks severities high > medium > low > unknown', () => {
    expect(SEVERITY_RANK.high).toBeGreaterThan(SEVERITY_RANK.medium);
    expect(SEVERITY_RANK.medium).toBeGreaterThan(SEVERITY_RANK.low);
    expect(SEVERITY_RANK.low).toBeGreaterThan(SEVERITY_RANK.unknown);
  });

  it('provides generic copy for unknown mutants', () => {
    expect(UNKNOWN_SEMANTIC.why.length).toBeGreaterThan(0);
    expect(UNKNOWN_SEMANTIC.hint.length).toBeGreaterThan(0);
  });
});
