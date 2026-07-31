import { describe, it, expect } from 'vitest';
import { estimateHeuristic } from '../estimate-heuristic.js';
import { ENGINE_REGISTRY } from '../engines/registry.js';
import type { SupportedProjectType } from '../utils/project-detector.js';

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

  it('does NOT count the arrow in a PHP member access as an operator', () => {
    // `->` used to contribute a phantom `-` (arithmetic) AND a phantom `>`
    // (comparison, weighted x2) — three mutants per member access. On one
    // 600-line file that inflated the estimate from ~27 real mutants to 903.
    const withArrows = `<?php $a->b(); $a->c(); $a->d();`;
    const none = `<?php ;`;
    expect(estimateHeuristic(withArrows, 'php')).toEqual(estimateHeuristic(none, 'php'));
  });

  it('does NOT count a PHP nullsafe arrow as a ternary', () => {
    const withNullsafe = `<?php $a?->b();`;
    const none = `<?php ;`;
    expect(estimateHeuristic(withNullsafe, 'php')).toEqual(estimateHeuristic(none, 'php'));
  });

  it('does NOT count a fat arrow as a comparison', () => {
    // Shared by PHP array keys and JS/TS arrow functions — neither is `>`.
    const phpArray = `<?php $x = [1 => 2];`;
    expect(estimateHeuristic(phpArray, 'php').mutants).toBe(
      estimateHeuristic(`<?php $x = [1, 2];`, 'php').mutants,
    );
    const arrowFn = `const f = (a) => a;`;
    expect(estimateHeuristic(arrowFn, 'typescript')).toEqual(
      estimateHeuristic(`const f = a;`, 'typescript'),
    );
  });

  it('replaces a stripped arrow or PHP tag with a separating space, not nothing', () => {
    // Dropping the token outright would fuse its neighbours: `[1=>2]` would read
    // as the single number 12, and `<?=1?>2` as 12 rather than two literals.
    expect(estimateHeuristic('<?php [1=>2];', 'php').mutants).toBe(2);
    expect(estimateHeuristic('<?=1?>2', 'php').mutants).toBe(2);
  });

  it('strips `#` as a comment only for PHP, not for a TypeScript private field', () => {
    // `#n` is a class field, not a comment; treating it as one would swallow the
    // rest of the line and everything countable on it.
    expect(estimateHeuristic('class A { #n = 1; }', 'typescript').mutants).toBe(1);
  });

  it('still counts a real comparison that neighbours an arrow', () => {
    // The strip must not swallow `>=` or a standalone `>`.
    const src = `<?php $r = $a->b >= $c;`;
    expect(estimateHeuristic(src, 'php').mutants).toBe(2);
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

  // ── stripNoise: the noise-removal regexes ────────────────────────────────
  //
  // The estimator's whole job is to count operators that are CODE. Every regex
  // below is the difference between an estimate and a number inflated by the
  // contents of comments, docstrings, and string literals. The "with vs
  // without" comparisons above cannot see most of the ways these patterns can
  // break, so these cases assert exact totals against a hand-derived count.

  describe('python triple-quoted strings', () => {
    it('strips a multi-word docstring whole, not one character of it', () => {
      // Only `1` and `2` are code. A quantifier that matches a single character
      // (`[\s\S]*?` -> `[\s\S]`), a class that matches nothing (`[^\s\S]`), or one
      // narrowed to whitespace-only / non-whitespace-only (`[\s\s]` / `[\S\S]`)
      // all fail to span "a + b > c" — leaving its operators in the count.
      expect(estimateHeuristic("x = 1\n'''a + b > c'''\ny = 2", 'python')).toEqual({
        mutants: 2,
        constructs: 2,
      });
      expect(estimateHeuristic('x = 1\n"""a + b > c"""\ny = 2', 'python')).toEqual({
        mutants: 2,
        constructs: 2,
      });
    });

    it('strips a docstring the ordinary quote-stripper would mangle', () => {
      // The plain single/double-quote strippers run later and normally clean up
      // whatever the triple-quote pass missed — which hides every way the
      // triple-quote pattern can fail to match. A body carrying an ODD number
      // of quotes defeats that fallback: it pairs the quotes off differently
      // and leaves `b + c` (and its `+`) outside any literal. Only a working
      // triple-quote pass reports the two numbers alone.
      expect(estimateHeuristic("z = 1\n'''a ' b + c'''\ny = 2", 'python')).toEqual({
        mutants: 2,
        constructs: 2,
      });
      expect(estimateHeuristic('z = 1\n"""a " b + c"""\ny = 2', 'python')).toEqual({
        mutants: 2,
        constructs: 2,
      });
    });

    it('matches each docstring lazily instead of spanning from the first to the last', () => {
      // Two docstrings with real code between them. A greedy `[\s\S]*` swallows
      // `z = 1 + 2` along with them and reports nothing at all.
      expect(estimateHeuristic("'''a'''\nz = 1 + 2\n'''b'''", 'python')).toEqual({
        mutants: 3,
        constructs: 3,
      });
      expect(estimateHeuristic('"""a"""\nz = 1 + 2\n"""b"""', 'python')).toEqual({
        mutants: 3,
        constructs: 3,
      });
    });

    it('leaves a separating space behind, so neighbouring tokens stay distinct', () => {
      // `1'''x'''2` -> "1 2" (two numbers). Replacing with '' fuses them into the
      // single number 12.
      expect(estimateHeuristic("1'''x'''2", 'python').mutants).toBe(2);
      expect(estimateHeuristic('1"""x"""2', 'python').mutants).toBe(2);
    });
  });

  describe('PHP # comments', () => {
    it('strips the whole comment body, not just the hash', () => {
      // Only the two literals are code. `#[\n]*` (hash plus newlines) and
      // `#[^\n]` (hash plus exactly one character) both leave `a + b > c`
      // behind, which adds an arithmetic op and a double-weighted comparison.
      expect(estimateHeuristic('<?php $x = 1; # a + b > c\n$y = 2;', 'php')).toEqual({
        mutants: 2,
        constructs: 2,
      });
    });
  });

  describe('template literals', () => {
    it('strips EVERY template literal, not only the first', () => {
      // Pins the 'g' flag on the constructed RegExp: without it the second
      // literal survives and its `+` is counted as code.
      const src = 'const a = `x + y`; const b = `p + q`; const n = 1;';
      expect(estimateHeuristic(src, 'typescript')).toEqual({ mutants: 1, constructs: 1 });
    });

    it('leaves a separating space behind', () => {
      expect(estimateHeuristic('1`x`2', 'typescript').mutants).toBe(2);
    });
  });

  describe('double-quoted strings', () => {
    it('strips EVERY double-quoted string, not only the first', () => {
      const src = 'const a = "x + y"; const b = "p + q"; const n = 1;';
      expect(estimateHeuristic(src, 'typescript')).toEqual({ mutants: 1, constructs: 1 });
    });

    it('leaves a separating space behind', () => {
      expect(estimateHeuristic('1"x"2', 'typescript').mutants).toBe(2);
    });

    it('consumes an escaped quote instead of ending the literal there', () => {
      // Source: const s = "x + y \" z"; const n = 1;
      // If the `\\[\s\S]` escape branch cannot match, the scan ends at the
      // backslash, re-anchors on the escaped quote, and leaves `"x + y \`
      // outside any literal — so the `+` is counted as code.
      const src = 'const s = "x + y \\" z"; const n = 1;';
      expect(estimateHeuristic(src, 'typescript')).toEqual({ mutants: 1, constructs: 1 });
    });

    it('consumes a backslash-escaped whitespace character', () => {
      // Source: const s = "x + y \ z"; const n = 1;
      // Narrowing the escape branch to non-whitespace (`\\[\S]`) breaks here
      // while the escaped-quote case above still passes.
      const src = 'const s = "x + y \\ z"; const n = 1;';
      expect(estimateHeuristic(src, 'typescript')).toEqual({ mutants: 1, constructs: 1 });
    });
  });

  describe('comments and string literals are decided in one pass', () => {
    it('does not treat `//` inside a string literal as a line comment', () => {
      // Stripping comments BEFORE strings cut `"http://x"` at the `//`, leaving an
      // unbalanced quote that then consumed everything up to the next quote —
      // several lines away — and silently deleted real code from the count.
      const src = 'const u = "http://x";\nconst n = 1 + 2;\nconst m = "y";';
      // Only `1 + 2` is code: two numbers and one arithmetic op.
      expect(estimateHeuristic(src, 'typescript')).toEqual({ mutants: 3, constructs: 3 });
    });

    it('handles `//` inside single-quoted and template literals too', () => {
      expect(estimateHeuristic("const u = 'a//b'; const n = 1;", 'typescript')).toEqual({
        mutants: 1,
        constructs: 1,
      });
      expect(estimateHeuristic('const u = `a//b`; const n = 1;', 'typescript')).toEqual({
        mutants: 1,
        constructs: 1,
      });
    });

    it('does not treat `#` inside a PHP string as a comment', () => {
      expect(estimateHeuristic('<?php $u = "a#b"; $n = 1;', 'php')).toEqual({
        mutants: 1,
        constructs: 1,
      });
    });

    it('still lets a quote inside a comment stay inside the comment', () => {
      // The mirror image of the bug above — fixing the ordering must not simply
      // move the breakage onto apostrophes in prose comments, which is what
      // stripping strings first would do.
      expect(estimateHeuristic("// don't count a + b\nconst n = 1;", 'typescript')).toEqual({
        mutants: 1,
        constructs: 1,
      });
      expect(estimateHeuristic("# don't count a + b\nn = 1", 'python')).toEqual({
        mutants: 1,
        constructs: 1,
      });
      expect(estimateHeuristic("/* don't count a + b */\nconst n = 1;", 'typescript')).toEqual({
        mutants: 1,
        constructs: 1,
      });
    });

    it('does not treat a comment opener inside a string as a comment', () => {
      // `/*` inside a literal used to open a block comment that ran to the next
      // `*/` — or to end of file, deleting the rest of the source.
      const src = 'const a = "/*"; const n = 1; const b = "*/"; const m = 2;';
      expect(estimateHeuristic(src, 'typescript')).toEqual({ mutants: 2, constructs: 2 });
    });

    it('keeps python floor division as arithmetic, not a comment', () => {
      // `//` must never be a comment opener in python.
      expect(estimateHeuristic('z = 7 // 2', 'python')).toEqual({ mutants: 4, constructs: 4 });
    });
  });

  describe('single-quoted strings', () => {
    it('strips EVERY single-quoted string, not only the first', () => {
      const src = "const a = 'x + y'; const b = 'p + q'; const n = 1;";
      expect(estimateHeuristic(src, 'typescript')).toEqual({ mutants: 1, constructs: 1 });
    });

    it('leaves a separating space behind', () => {
      expect(estimateHeuristic("1'x'2", 'typescript').mutants).toBe(2);
    });

    it('consumes an escaped quote instead of ending the literal there', () => {
      // Source: const s = 'x + y \' z'; const n = 1;
      const src = "const s = 'x + y \\' z'; const n = 1;";
      expect(estimateHeuristic(src, 'typescript')).toEqual({ mutants: 1, constructs: 1 });
    });

    it('consumes a backslash-escaped whitespace character', () => {
      // Source: const s = 'x + y \ z'; const n = 1;
      const src = "const s = 'x + y \\ z'; const n = 1;";
      expect(estimateHeuristic(src, 'typescript')).toEqual({ mutants: 1, constructs: 1 });
    });
  });
  describe('lexical family comes from the engine registry (finding 35b)', () => {
    // noisePattern switches on EngineDescriptor.syntaxFamily, not on the
    // project type, so a language that shares a family shares the behaviour and
    // a new language must state its family rather than inherit the C one.
    const RUST = 'let n = 1; // + + + +\n';
    const TS = 'const n = 1; // + + + +\n';

    it('treats rust as the C family: // is a comment, exactly like typescript', () => {
      expect(estimateHeuristic(RUST, 'rust')).toEqual(estimateHeuristic(TS, 'typescript'));
      expect(estimateHeuristic(RUST, 'rust').mutants).toBe(1);
    });

    it('keeps python OUT of the C family: // is floor division, not a comment', () => {
      // The same text under the python family keeps `//` as an operator, so the
      // trailing arithmetic is still counted.
      expect(estimateHeuristic('n = 1  // + + + +', 'python').mutants).toBeGreaterThan(
        estimateHeuristic('n = 1;  // + + + +', 'typescript').mutants,
      );
    });

    it('gives php BOTH C-family // and python-style # comments', () => {
      expect(estimateHeuristic('<?php $n = 1; // + + +', 'php')).toEqual({
        mutants: 1,
        constructs: 1,
      });
      expect(estimateHeuristic('<?php $n = 1; # + + +', 'php')).toEqual({
        mutants: 1,
        constructs: 1,
      });
    });

    it('every registry entry declares a family the stripper handles', () => {
      // Guards the never-branch: a family with no case would fall through to the
      // C-family patterns, silently mis-estimating that language.
      for (const [type, entry] of Object.entries(ENGINE_REGISTRY)) {
        expect(['c', 'python', 'php']).toContain(entry.syntaxFamily);
        expect(() => estimateHeuristic('x = 1;', type as SupportedProjectType)).not.toThrow();
      }
    });
  });
});
