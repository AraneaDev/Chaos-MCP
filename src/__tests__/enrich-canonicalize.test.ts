import { describe, it, expect } from 'vitest';
import { canonicalizeMutator, MUTATOR_SEMANTICS } from '../enrich.js';

describe('canonicalizeMutator', () => {
  it('maps StrykerJS canonical names directly for typescript', () => {
    expect(canonicalizeMutator('ConditionalExpression', 'typescript')).toBe(
      'ConditionalExpression',
    );
    expect(canonicalizeMutator('EqualityOperator', 'typescript')).toBe('EqualityOperator');
    expect(canonicalizeMutator('StringLiteral', 'typescript')).toBe('StringLiteral');
  });

  it('returns unknown for a Stryker name not in the table', () => {
    expect(canonicalizeMutator('SomeFutureMutator', 'typescript')).toBe('unknown');
  });

  it('infers Rust categories from the change description', () => {
    expect(canonicalizeMutator('replace > with', 'rust', 'replace > with >=')).toBe(
      'EqualityOperator',
    );
    expect(canonicalizeMutator('replace add ->', 'rust', 'replace a + b with a - b')).toBe(
      'ArithmeticOperator',
    );
    expect(canonicalizeMutator('replace && with', 'rust', 'replace x && y with x || y')).toBe(
      'LogicalOperator',
    );
    expect(canonicalizeMutator('replace true', 'rust', 'replace true with false')).toBe(
      'BooleanLiteral',
    );
  });

  it('returns unknown for Rust when the description has no recognizable operator', () => {
    expect(canonicalizeMutator('replace foo', 'rust', 'replace foo with Default::default()')).toBe(
      'unknown',
    );
  });

  it('does not misclassify cargo-mutants -> arrow as ArithmeticOperator', () => {
    // The `-` in `->` must not trigger the arithmetic rule.
    expect(
      canonicalizeMutator(
        'replace get_name ->',
        'rust',
        'replace get_name -> String with String::new()',
      ),
    ).toBe('unknown');
  });

  it('classifies a bare < / > (no =) as EqualityOperator', () => {
    // The EqualityOperator rule is /[<>]=?|==|!=/ — the `=` is OPTIONAL, so a
    // relational flip with no `=` must still match. Guards the `=?` quantifier.
    expect(canonicalizeMutator('replace < with >', 'rust', 'replace a < b with a > b')).toBe(
      'EqualityOperator',
    );
  });

  it('does not apply the Rust rules to non-Rust engines even with change text', () => {
    // Go/Python descriptions can contain operator chars, but only Rust packs a
    // reliable per-mutant operator into changeText. The `projectType === 'rust'`
    // guard must hold even when changeText would match a rule.
    expect(canonicalizeMutator('Go Mutation Operator', 'go', 'replace > with >=')).toBe('unknown');
    expect(canonicalizeMutator('Some Python Mutation', 'python', 'replace && with ||')).toBe(
      'unknown',
    );
  });

  it('returns unknown for Rust when changeText is absent (no throw)', () => {
    // The `&& changeText` guard short-circuits before the .replace() call; a
    // Rust target with no description must degrade to unknown, not crash.
    expect(canonicalizeMutator('replace foo', 'rust', undefined)).toBe('unknown');
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

describe('canonicalizeMutator (python — cosmic-ray operator names)', () => {
  // cosmic-ray emits authoritative operator names; the Python branch maps the
  // NAME directly (no diff inference). Comparison is matched before BinaryOperator,
  // and BooleanOperator (and/or) before the generic True/False rule.
  it('maps a comparison-operator replacement to EqualityOperator', () => {
    expect(canonicalizeMutator('core/ReplaceComparisonOperator_Lt_LtE', 'python')).toBe(
      'EqualityOperator',
    );
  });
  it('maps a binary-operator replacement to ArithmeticOperator', () => {
    expect(canonicalizeMutator('core/ReplaceBinaryOperator_Add_Sub', 'python')).toBe(
      'ArithmeticOperator',
    );
    // bitwise variants live under the same operator family
    expect(canonicalizeMutator('core/ReplaceBinaryOperator_Add_BitOr', 'python')).toBe(
      'ArithmeticOperator',
    );
  });
  it('maps a boolean-operator (and/or) replacement to LogicalOperator', () => {
    expect(canonicalizeMutator('core/ReplaceBooleanOperator_And_Or', 'python')).toBe(
      'LogicalOperator',
    );
  });
  it('maps a unary-operator replacement to UnaryOperator', () => {
    expect(canonicalizeMutator('core/ReplaceUnaryOperator_Not_Nothing', 'python')).toBe(
      'UnaryOperator',
    );
  });
  it('maps True/False replacement to BooleanLiteral (not LogicalOperator)', () => {
    expect(canonicalizeMutator('core/ReplaceTrueWithFalse', 'python')).toBe('BooleanLiteral');
  });
  it('maps NumberReplacer to ArithmeticOperator (a wrong constant is a value bug)', () => {
    expect(canonicalizeMutator('core/NumberReplacer', 'python')).toBe('ArithmeticOperator');
  });
  it('maps a string replacement to StringLiteral', () => {
    expect(canonicalizeMutator('core/StringReplacer', 'python')).toBe('StringLiteral');
  });
  it('returns unknown for an unrecognized cosmic-ray operator', () => {
    expect(canonicalizeMutator('core/ZeroIterationForLoop', 'python')).toBe('unknown');
  });
});

describe('canonicalizeMutator (go)', () => {
  it('maps go-mutesting branch mutators to ConditionalExpression', () => {
    expect(canonicalizeMutator('branch/if', 'go')).toBe('ConditionalExpression');
    expect(canonicalizeMutator('branch/else', 'go')).toBe('ConditionalExpression');
    expect(canonicalizeMutator('branch/case', 'go')).toBe('ConditionalExpression');
  });
  it('maps comparison/remove mutators', () => {
    expect(canonicalizeMutator('expression/comparison', 'go')).toBe('EqualityOperator');
    expect(canonicalizeMutator('expression/remove', 'go')).toBe('MethodExpression');
    expect(canonicalizeMutator('statement/remove', 'go')).toBe('BlockStatement');
  });
  it('falls back to unknown for unmapped go mutators', () => {
    expect(canonicalizeMutator('something/weird', 'go')).toBe('unknown');
    expect(canonicalizeMutator('Go Mutation Operator', 'go')).toBe('unknown');
  });
});
