import { describe, it, expect } from 'vitest';
import { estimateHeuristic } from '../estimate-heuristic.js';

describe('estimateHeuristic', () => {
  it('returns 0 for an empty file', () => {
    expect(estimateHeuristic('', 'typescript')).toEqual({ mutants: 0, constructs: 0 });
  });

  it('counts operators and keywords in real code', () => {
    const src = `function f(a: number, b: number) {
      if (a > b && a !== 0) { return a + b; }
      return false;
    }`;
    const r = estimateHeuristic(src, 'typescript');
    // > , && , !== , + , return x2 , false  → constructs >= 7, mutants > constructs (comparisons weighted)
    expect(r.constructs).toBeGreaterThanOrEqual(7);
    expect(r.mutants).toBeGreaterThan(r.constructs);
  });

  it('does NOT count operators inside comments', () => {
    const withComment = `// a + b > c && d\nconst x = 1;`;
    const noComment = `const x = 1;`;
    expect(estimateHeuristic(withComment, 'typescript').constructs).toBe(
      estimateHeuristic(noComment, 'typescript').constructs,
    );
  });

  it('does NOT count operators inside string literals', () => {
    const withStr = `const s = "a + b > c && d";`;
    const noStr = `const s = "";`;
    expect(estimateHeuristic(withStr, 'typescript').constructs).toBe(
      estimateHeuristic(noStr, 'typescript').constructs,
    );
  });

  it('does NOT count operators inside template literals', () => {
    const withTpl = 'const s = `a + b > c && d`;';
    const noTpl = 'const s = ``;';
    expect(estimateHeuristic(withTpl, 'typescript').constructs).toBe(
      estimateHeuristic(noTpl, 'typescript').constructs,
    );
  });

  it('strips python # comments', () => {
    const withComment = `# a + b > c\nx = 1`;
    const noComment = `x = 1`;
    expect(estimateHeuristic(withComment, 'python').constructs).toBe(
      estimateHeuristic(noComment, 'python').constructs,
    );
  });

  it('strips python triple-quoted strings', () => {
    const withStr = `x = 1\ny = """hello world"""`;
    const noStr = `x = 1\ny = """"""`;
    expect(estimateHeuristic(withStr, 'python').constructs).toBe(
      estimateHeuristic(noStr, 'python').constructs,
    );
  });

  it('is monotonic — more constructs yield more mutants', () => {
    const small = `return a + b;`;
    const big = `return a + b + c + d + e;`;
    expect(estimateHeuristic(big, 'typescript').mutants).toBeGreaterThan(
      estimateHeuristic(small, 'typescript').mutants,
    );
  });
});
