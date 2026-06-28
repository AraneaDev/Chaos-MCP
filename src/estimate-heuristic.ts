import type { SupportedProjectType } from './engines/registry.js';

export interface HeuristicResult {
  mutants: number;
  constructs: number;
}

/**
 * Strip block comments, line comments, and string/template literals so that
 * operators appearing inside them are not counted. Best-effort and
 * language-approximate — Python uses `#` line comments and triple-quoted
 * strings; the C-family languages use `//` and block comments. Replacement keeps a
 * space so adjacent tokens don't merge.
 */
function stripNoise(source: string, projectType: SupportedProjectType): string {
  let s = source;
  // Block comments (C-family). Harmless to run for python (none present).
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Triple-quoted python strings before single/double.
  if (projectType === 'python') {
    s = s.replace(/'''[\s\S]*?'''/g, ' ').replace(/"""[\s\S]*?"""/g, ' ');
    s = s.replace(/#[^\n]*/g, ' ');
  } else {
    s = s.replace(/\/\/[^\n]*/g, ' ');
  }
  // Template literals (JS/TS) then ordinary single/double-quoted strings.
  // Using String.fromCharCode to avoid esbuild backtick parsing issues
  const backtick = String.fromCharCode(96);
  s = s.replace(
    new RegExp(backtick + '(?:\\\\[\\s\\S]|[^' + backtick + '\\\\])*' + backtick, 'g'),
    ' ',
  );
  s = s.replace(new RegExp('"(?:\\\\[\\s\\S]|[^"\\\\])*"', 'g'), ' ');
  s = s.replace(new RegExp("'(?:\\\\[\\s\\S]|[^'\\\\])*'", 'g'), ' ');
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
