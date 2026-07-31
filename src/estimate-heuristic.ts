import { assertNeverProjectType, type SupportedProjectType } from './utils/project-detector.js';
import { ENGINE_REGISTRY, type SyntaxFamily } from './engines/registry.js';

export interface HeuristicResult {
  mutants: number;
  constructs: number;
}

// Using String.fromCharCode to avoid esbuild backtick parsing issues.
const BACKTICK = String.fromCharCode(96);

/** Pattern source for a `q`-quoted literal that consumes backslash escapes. */
function quotedLiteral(q: string): string {
  return q + '(?:\\\\[\\s\\S]|[^' + q + '\\\\])*' + q;
}

/**
 * Pattern matching every "noise" span — comments AND string literals — in ONE
 * left-to-right alternation, so whichever span STARTS first wins.
 *
 * Order matters only between alternatives that can match at the same position:
 * the triple-quote patterns must precede the single-character quotes, or `'''`
 * would be consumed as the empty string `''`.
 *
 * A single pass is what makes the two token classes mutually exclusive. Running
 * comments first meant `const u = "http://x"` lost the tail of its literal (the
 * `//` read as a comment start, and the orphaned quote then consumed across
 * lines); running strings first would break the equally common `// don't` the
 * same way. Neither happens when one scan decides which token opened first.
 */
function noisePattern(family: SyntaxFamily): RegExp {
  // Block comments (C-family). Harmless to run for python (none present).
  const parts = ['\\/\\*[\\s\\S]*?\\*\\/'];
  switch (family) {
    case 'python':
      parts.push("'''[\\s\\S]*?'''", '"""[\\s\\S]*?"""', '#[^\\n]*');
      break;
    case 'php':
      parts.push('\\/\\/[^\\n]*');
      // PHP also supports `#` line comments (and `#[Attr]` attributes, dropped as
      // comments — acceptable for an approximate estimate).
      parts.push('#[^\\n]*');
      break;
    case 'c':
      // NOT applied to python, where `//` is floor division.
      parts.push('\\/\\/[^\\n]*');
      break;
    default:
      // Exhaustiveness guard, not a runtime check: `family` is narrowed to
      // `never` here, so a new SyntaxFamily without a case above is a COMPILE
      // error rather than a language silently getting C-family comment
      // stripping and a wrong mutant estimate (F35b). The C-family fallthrough
      // below is retained and stays unreachable for the declared union.
      assertNeverProjectType(family);
      parts.push('\\/\\/[^\\n]*');
      break;
  }
  // Template literals (JS/TS) then ordinary double/single-quoted strings.
  parts.push(quotedLiteral(BACKTICK), quotedLiteral('"'), quotedLiteral("'"));
  return new RegExp(parts.join('|'), 'g');
}

/**
 * Strip block comments, line comments, and string/template literals so that
 * operators appearing inside them are not counted. Best-effort and
 * language-approximate — Python uses `#` line comments and triple-quoted
 * strings; the C-family languages use `//` and block comments. Replacement keeps a
 * space so adjacent tokens don't merge.
 *
 * Which set of rules applies is decided by the language's
 * `EngineDescriptor.syntaxFamily`, not by an `if (projectType === …)` chain with
 * an implicit C-family `else` — that `else` silently gave any newly added
 * language C-family stripping and a wrong estimate (finding 35b).
 */
function stripNoise(source: string, projectType: SupportedProjectType): string {
  // The lexical family — NOT the language — decides how comments and string
  // literals are recognised. It comes from the engine registry, so a new
  // language must state its family instead of silently inheriting the C one.
  // `?? 'c'` is unreachable for the declared union — it only catches a caller
  // that defeated the type system (an `as never` cast at a boundary). It keeps
  // this best-effort estimator from THROWING on such a value, as it did before;
  // the compile-time force is the mandatory `syntaxFamily` field, not this.
  const family = ENGINE_REGISTRY[projectType]?.syntaxFamily ?? 'c';
  let s = source.replace(noisePattern(family), ' ');
  // The open/close tags are punctuation, not code: `<?php` otherwise reads
  // as a `<` comparison plus a `?` ternary in every single file.
  if (family === 'php') s = s.replace(/<\?php|<\?=|\?>/g, ' ');
  // Member and arrow tokens are punctuation too, and they are the single
  // largest source of over-estimation: `->` contributed a phantom `-` AND a
  // phantom `>` (weighted x2 as a comparison), `?->` added a phantom ternary,
  // and `=>` — PHP array keys, JS/TS arrow functions — a phantom `>`. On one
  // 600-line PHP file that turned 27 real mutants into an estimate of 903.
  s = s.replace(/\?->|->|=>/g, ' ');
  return s;
}

/** Count non-overlapping matches of a global regex. */
function count(re: RegExp, s: string): number {
  const m = s.match(re);
  return m === null ? 0 : m.length;
}

/**
 * Approximate the number of mutants a mutation tool would generate for source code.
 * Returns the raw construct count and a weighted mutant estimate. APPROXIMATE
 * by design — callers label this fidelity: 'approx'. Comparison operators are
 * weighted 2 (relational-boundary + equality mutations); all else weight 1.
 */
export function estimateHeuristic(
  source: string,
  projectType: SupportedProjectType,
): HeuristicResult {
  const s = stripNoise(source, projectType);

  const comparison = count(/(===|!==|==|!=|<=|>=|<|>)/g, s);
  const arithmetic = count(/[+\-*/%]/g, s) - count(/\+\+|--/g, s) * 2; // exclude ++/-- double-count
  const logical = count(/(&&|\|\|)/g, s);
  const conditional = count(/\b(if|while|for)\b/g, s) + count(/\?/g, s);
  const returns = count(/\breturn\b/g, s);
  const booleans = count(/\b(true|false|True|False)\b/g, s);
  const numbers = count(/\b\d+(?:\.\d+)?\b/g, s);
  const incdec = count(/\+\+|--/g, s);

  const safe = (n: number) => (n > 0 ? n : 0);
  const constructs =
    comparison + safe(arithmetic) + logical + conditional + returns + booleans + numbers + incdec;
  // Comparison weighted x2; everything else x1.
  const mutants =
    comparison * 2 +
    safe(arithmetic) +
    logical +
    conditional +
    returns +
    booleans +
    numbers +
    incdec;

  return { mutants, constructs };
}
