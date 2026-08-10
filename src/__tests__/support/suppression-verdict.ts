/**
 * Test helpers for the v3 suppression verdict.
 *
 * Before v3 a verdict was a `Set<"<line> <mutator>">` and tests built one
 * inline. Identity is now the mutator plus the change, and the verdict carries
 * placed entries rather than keys — so these two helpers translate between the
 * old shorthand and the new shape.
 *
 * They deliberately produce CHANGELESS entries, which match on mutator alone.
 * That is exactly the behaviour the pre-v3 tests were written against, so a case
 * using them still asserts what it always asserted; cases that care about
 * content identity build their entries explicitly instead.
 */
import type { SuppressionVerdict } from '../../utils/suppression.js';

/** A verdict placing each `"<line> <mutator>"` key at its stored line. */
export function verdictOf(keys: string[]): SuppressionVerdict {
  return {
    resolved: keys.map((k) => {
      const sep = k.indexOf(' ');
      const line = Number(k.slice(0, sep));
      return {
        line,
        storedLine: line,
        mutator: k.slice(sep + 1),
        fingerprint: 'test-fingerprint',
        tier: 1 as const,
      };
    }),
    pending: [],
    drifted: 0,
    unverified: 0,
  };
}

/** The placed entries as sorted `"<line> <mutator>"` keys, for assertions. */
export function appliedKeys(verdict: SuppressionVerdict): string[] {
  return verdict.resolved.map((r) => `${r.line} ${r.mutator}`).sort();
}
