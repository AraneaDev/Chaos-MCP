import { describe, it, expect } from 'vitest';
import { canonicalizeMutator, MUTATOR_SEMANTICS } from '../enrich.js';

describe('canonicalizeMutator', () => {
  it('maps StrykerJS canonical names directly for typescript', () => {
    expect(canonicalizeMutator('ConditionalExpression', 'typescript')).toBe('ConditionalExpression');
    expect(canonicalizeMutator('EqualityOperator', 'typescript')).toBe('EqualityOperator');
    expect(canonicalizeMutator('StringLiteral', 'typescript')).toBe('StringLiteral');
  });

  it('returns unknown for a Stryker name not in the table', () => {
    expect(canonicalizeMutator('SomeFutureMutator', 'typescript')).toBe('unknown');
  });

  it('infers Rust categories from the change description', () => {
    expect(canonicalizeMutator('replace > with', 'rust', 'replace > with >=')).toBe('EqualityOperator');
    expect(canonicalizeMutator('replace add ->', 'rust', 'replace a + b with a - b')).toBe('ArithmeticOperator');
    expect(canonicalizeMutator('replace && with', 'rust', 'replace x && y with x || y')).toBe('LogicalOperator');
    expect(canonicalizeMutator('replace true', 'rust', 'replace true with false')).toBe('BooleanLiteral');
  });

  it('returns unknown for Rust when the description has no recognizable operator', () => {
    expect(canonicalizeMutator('replace foo', 'rust', 'replace foo with Default::default()')).toBe('unknown');
  });

  it('does not misclassify cargo-mutants -> arrow as ArithmeticOperator', () => {
    // The `-` in `->` must not trigger the arithmetic rule.
    expect(
      canonicalizeMutator('replace get_name ->', 'rust', 'replace get_name -> String with String::new()'),
    ).toBe('unknown');
  });

  it('returns unknown for Go and Python (coarse engines)', () => {
    expect(canonicalizeMutator('Go Mutation Operator', 'go')).toBe('unknown');
    expect(canonicalizeMutator('Arithmetic/Logical Mutation', 'python')).toBe('unknown');
  });

  it('only ever returns a table key or unknown', () => {
    const keys = new Set([...Object.keys(MUTATOR_SEMANTICS), 'unknown']);
    expect(keys.has(canonicalizeMutator('ConditionalExpression', 'typescript'))).toBe(true);
    expect(keys.has(canonicalizeMutator('whatever', 'go'))).toBe(true);
  });
});
