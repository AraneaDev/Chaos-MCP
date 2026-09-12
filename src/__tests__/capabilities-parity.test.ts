import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, LEVEL_RANK, type CapabilityLevel } from '../engines/capabilities.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BASELINE_PATH = join(__dirname, '..', 'engines', 'capabilities.baseline.json');

describe('parity ratchet', () => {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as Record<
    string,
    Record<string, CapabilityLevel>
  >;

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
