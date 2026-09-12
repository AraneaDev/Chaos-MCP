import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, LEVEL_RANK, type CapabilityLevel } from '../engines/capabilities.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BASELINE_PATH = join(__dirname, '..', 'engines', 'capabilities.baseline.json');

/**
 * `JSON.parse` returns `unknown` shaped only by a type ASSERTION, which is
 * never checked at runtime. A typo'd level (e.g. `"fulll"`) would otherwise
 * sail through as a `CapabilityLevel`, and `LEVEL_RANK[level]` would then be
 * `undefined` for it: `undefined < n` and `n > undefined` both evaluate to
 * `false`, so both ratchet checks below silently pass on that one entry
 * instead of catching the typo or the regression it might be hiding.
 */
function parseBaseline(raw: string): Record<string, Record<string, CapabilityLevel>> {
  const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
  for (const [engine, caps] of Object.entries(parsed)) {
    for (const [capability, level] of Object.entries(caps)) {
      if (typeof level !== 'string' || !(level in LEVEL_RANK)) {
        throw new Error(
          `capabilities.baseline.json: ${engine}.${capability} has invalid level ` +
            `${JSON.stringify(level)}, expected one of ${Object.keys(LEVEL_RANK).join(', ')}`,
        );
      }
    }
  }
  return parsed as Record<string, Record<string, CapabilityLevel>>;
}

describe('parity ratchet', () => {
  const baseline = parseBaseline(readFileSync(BASELINE_PATH, 'utf-8'));

  it('never drops a capability below its baseline', () => {
    const drops: string[] = [];
    for (const [engine, caps] of Object.entries(baseline)) {
      for (const [capability, level] of Object.entries(caps)) {
        const current =
          CAPABILITIES[engine as keyof typeof CAPABILITIES]?.[
            capability as keyof (typeof CAPABILITIES)['typescript']
          ];
        if (current === undefined) {
          drops.push(`${engine}.${capability} was removed from the matrix`);
          continue;
        }
        if (LEVEL_RANK[current] < LEVEL_RANK[level]) {
          drops.push(`${engine}.${capability}: ${level} -> ${current}`);
        }
      }
    }
    expect(drops, 'parity went DOWN, which is never allowed').toEqual([]);
  });

  it('fails when parity goes up until the baseline is updated', () => {
    const raised: string[] = [];
    for (const [engine, caps] of Object.entries(CAPABILITIES)) {
      for (const [capability, level] of Object.entries(caps)) {
        const before = baseline[engine]?.[capability];
        if (before === undefined || LEVEL_RANK[level] > LEVEL_RANK[before]) {
          raised.push(`${engine}.${capability}`);
        }
      }
    }
    expect(
      raised,
      'parity went UP. Run `npm run build && node scripts/update-parity-baseline.mjs` to lock it in',
    ).toEqual([]);
  });

  it('keeps the matrix in step with the registry flags', () => {
    expect(CAPABILITIES.typescript['diff-line-scope']).toBe('full');
    expect(CAPABILITIES.python['diff-line-scope']).toBe('none');
    expect(CAPABILITIES.python.concurrency).toBe('none');
  });
});

describe('parseBaseline (MINOR 7)', () => {
  it('accepts every real level the baseline file uses', () => {
    expect(() => parseBaseline('{"typescript":{"concurrency":"full"}}')).not.toThrow();
    expect(() => parseBaseline('{"typescript":{"concurrency":"partial"}}')).not.toThrow();
    expect(() => parseBaseline('{"typescript":{"concurrency":"none"}}')).not.toThrow();
  });

  it('rejects a typo in a level instead of silently disabling the ratchet for it', () => {
    // Before this validation existed, a typo like "fulll" parsed through the
    // bare type assertion unchanged: LEVEL_RANK['fulll'] is undefined, so
    // BOTH `LEVEL_RANK[current] < LEVEL_RANK[level]` (the drop check) and
    // `LEVEL_RANK[level] > LEVEL_RANK[before]` (the raise check) evaluate to
    // `false` for that entry, no matter what CAPABILITIES actually says. The
    // ratchet went quiet on that one capability instead of failing loudly.
    expect(() => parseBaseline('{"typescript":{"concurrency":"fulll"}}')).toThrow(/invalid level/);
  });
});
