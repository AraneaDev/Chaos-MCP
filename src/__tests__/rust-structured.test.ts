import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  joinToStructured,
  readStructuredOutput,
  readStructuredSummary,
} from '../engines/rust/structured.js';
import {
  enrichCargoMutantsResult,
  parseCargoSummary,
  sliceCargoSource,
} from '../engines/rust/report.js';
import { canonicalizeRustMutator } from '../engines/rust/canonicalize.js';

const FIXTURES = join(process.cwd(), 'src/__tests__/fixtures/cargo-mutants-out');

describe('cargo-mutants structured output', () => {
  it('reads real mutants and outcome fixtures', () => {
    const mutants = readStructuredOutput(join(FIXTURES, 'mutants.out'));

    expect(mutants).toBeDefined();
    expect(mutants?.length).toBe(5);
    expect(mutants?.[0]).toMatchObject({
      file: 'src/notify.rs',
      line: 10,
      column: 5,
      replacement: '()',
      genre: 'FnValue',
      description: 'replace maybe_send with ()',
      span: { startLine: 10, startColumn: 5, endLine: 14, endColumn: 50 },
    });
    expect(readStructuredSummary(join(FIXTURES, 'mutants.out'))).toEqual({
      caught: 4,
      missed: 0,
      timeout: 4,
      unviable: 0,
    });
  });

  it('reads a real missed result with a second genre', () => {
    const mutants = readStructuredOutput(join(FIXTURES, 'missed', 'mutants.out'));
    expect(mutants).toHaveLength(1);
    expect(mutants?.[0]).toMatchObject({
      line: 11,
      column: 8,
      replacement: '',
      genre: 'UnaryOperator',
      description: 'delete ! in maybe_send',
    });
  });

  it('returns undefined when output is missing or malformed', () => {
    expect(readStructuredOutput(join(FIXTURES, 'does-not-exist'))).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), 'chaos-rust-structured-'));
    try {
      writeFileSync(join(dir, 'mutants.json'), '{not json');
      writeFileSync(join(dir, 'outcomes.json'), '{not json');
      expect(readStructuredOutput(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('joins each stdout result exactly once', () => {
    const structured = readStructuredOutput(join(FIXTURES, 'missed', 'mutants.out'));
    if (!structured) throw new Error('missed fixture did not parse');
    const result = {
      file: 'src/notify.rs',
      line: 11,
      description: 'delete ! in maybe_send',
    };
    const joined = joinToStructured([result], structured);
    expect(joined?.get(result)).toMatchObject({ genre: 'UnaryOperator', replacement: '' });
    expect(
      joinToStructured([{ ...result, description: 'not present' }], structured),
    ).toBeUndefined();
    expect(joinToStructured([result], [...structured, structured[0]])).toBeUndefined();
  });

  it('keeps fixture bytes available for source slicing tests', () => {
    expect(readFileSync(join(FIXTURES, 'source', 'notify.rs'), 'utf8')).toContain(
      'pub fn maybe_send',
    );
  });

  it('slices Unicode scalar columns rather than UTF-8 byte offsets', () => {
    expect(
      sliceCargoSource('let café = true;\n', {
        file: 'src/lib.rs',
        line: 1,
        column: 12,
        description: 'replace true with false',
        replacement: 'false',
        genre: 'FnValue',
        span: { startLine: 1, startColumn: 12, endLine: 1, endColumn: 16 },
      }),
    ).toBe('true');
  });

  it('enriches a real missed result with the source span and replacement', () => {
    const structured = readStructuredOutput(join(FIXTURES, 'missed', 'mutants.out'));
    if (!structured) throw new Error('missed fixture did not parse');
    const source = readFileSync(join(FIXTURES, 'source', 'notify.rs'), 'utf8');
    const result = {
      target: 'src/notify.rs',
      totalMutants: 1,
      killed: 0,
      survived: 1,
      mutationScore: '0.00%',
      vulnerabilities: [
        {
          line: 11,
          mutator: 'delete ! in maybe_send',
          description:
            'Mutation survived at line 11. The Rust test suite did not catch this change.',
        },
      ],
    };
    const enriched = enrichCargoMutantsResult(
      result,
      structured,
      { caught: 0, missed: 1, timeout: 0, unviable: 0 },
      source,
      parseCargoSummary('1 mutant tested: 1 missed'),
    );
    expect(enriched.vulnerabilities[0]).toMatchObject({
      column: 8,
      original: '!',
      mutated: '',
      mutator: 'delete ! in maybe_send',
    });
  });

  it('falls back unchanged when structured and stdout totals disagree', () => {
    const result = {
      target: 'src/notify.rs',
      totalMutants: 1,
      killed: 0,
      survived: 1,
      mutationScore: '0.00%',
      vulnerabilities: [{ line: 11, mutator: 'delete ! in maybe_send', description: 'x' }],
    };
    expect(
      enrichCargoMutantsResult(
        result,
        readStructuredOutput(join(FIXTURES, 'missed', 'mutants.out')),
        { caught: 1, missed: 0, timeout: 0, unviable: 0 },
        'source',
        parseCargoSummary('1 mutant tested: 1 missed'),
      ),
    ).toBe(result);
  });

  it('uses a structured genre only when the description is not enough', () => {
    expect(canonicalizeRustMutator('unclassified change', '==', 'BinaryOperator')).toBe(
      'EqualityOperator',
    );
    expect(canonicalizeRustMutator('replace == with !=', undefined, 'BinaryOperator')).toBe(
      'EqualityOperator',
    );
  });
});
