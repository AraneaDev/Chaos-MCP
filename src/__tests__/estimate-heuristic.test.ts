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

  // Exact-count assertions: every term in the constructs/mutants sums must hold its
  // weight. `toBeGreaterThan` checks let arithmetic-operator flips survive; these pin
  // the exact totals so a `+`->`-` or `*2`->`/2` swap changes the number and dies.
  it('weights every construct exactly (comparison x2, all else x1)', () => {
    // comparison:3 (> < >=), arithmetic:1 (after excluding ++/-- double-count),
    // logical:2 (&& ||), conditional:3 (if while ?), returns:2, booleans:2 (true false),
    // numbers:2 (0 10), incdec:2 (++ --)  => constructs 17, mutants 17 + comparison(3) = 20
    const src = `function f(a, b) {
      let i = 0;
      i++;
      if (a > b && i < 10) { return a + b; }
      while (b || a) { i--; }
      const ok = a >= b ? true : false;
      return ok;
    }`;
    expect(estimateHeuristic(src, 'typescript')).toEqual({ mutants: 20, constructs: 17 });
  });

  it('excludes the ++/-- double-count from the arithmetic term', () => {
    // `a + b` is one real arithmetic op; the four `+`/`-` chars inside `i++`/`j--`
    // are cancelled by the `- count(++|--) * 2` correction. arithmetic:1 + incdec:2.
    expect(estimateHeuristic(`a + b; i++; j--;`, 'typescript')).toEqual({
      mutants: 3,
      constructs: 3,
    });
  });

  it('adds the ternary `?` into the conditional term', () => {
    expect(estimateHeuristic(`x ? y : z;`, 'typescript')).toEqual({ mutants: 1, constructs: 1 });
  });

  it('does NOT count operators inside block comments', () => {
    const withBlock = `/* a + b > c && d */\nconst x = 1;`;
    const noBlock = `const x = 1;`;
    expect(estimateHeuristic(withBlock, 'typescript')).toEqual(
      estimateHeuristic(noBlock, 'typescript'),
    );
  });

  it('clamps a non-positive arithmetic term to zero (safe wrapper)', () => {
    // `i++; i--;` => bare +/- chars 4, minus 2*incdec(2)=4 => arithmetic 0, clamped to 0.
    // Only the two incdec mutations remain, so constructs/mutants == incdec count == 2.
    expect(estimateHeuristic(`i++; i--;`, 'typescript')).toEqual({ mutants: 2, constructs: 2 });
  });

  it('counts a decimal literal as a single number', () => {
    // Pins the `\d+(?:\.\d+)?` number regex: a mutant that drops the `+` (\.\d) or
    // negates the class (\.\D) would split `1.55` into two numbers.
    expect(estimateHeuristic(`const x = 1.55;`, 'typescript')).toEqual({
      mutants: 1,
      constructs: 1,
    });
  });

  it('replaces a stripped block comment with a separating space, not nothing', () => {
    // `1/* */2` -> "1 2" (two numbers). If the replacement were '' the tokens would
    // merge into "12" (one number) — this distinguishes the ' ' -> '' string mutant.
    expect(estimateHeuristic(`1/* */2`, 'typescript')).toEqual({ mutants: 2, constructs: 2 });
  });
});
