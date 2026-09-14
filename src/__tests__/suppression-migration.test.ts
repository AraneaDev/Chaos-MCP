import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applySuppressions } from '../audit/apply-suppressions.js';
import { loadVerifiedSuppressions } from '../audit/suppression-io.js';
import { addSuppressions } from '../utils/suppression.js';
import type { MutationResult } from '../engines/base.js';

const MUTATOR = 'delete ! in maybe_send';
const FILE = 'src/notify.rs';

describe('Rust suppression migration', () => {
  it('keeps a main-era mutator-only suppression applying to richer output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chaos-rust-suppression-'));
    try {
      const source = readFileSync(
        join(process.cwd(), 'src/__tests__/fixtures/cargo-mutants-out/source/notify.rs'),
        'utf8',
      );
      mkdirSync(dirname(join(root, FILE)), { recursive: true });
      writeFileSync(join(root, FILE), source, 'utf8');

      const oldResult: MutationResult = {
        target: FILE,
        totalMutants: 1,
        killed: 0,
        survived: 1,
        mutationScore: '0.00%',
        vulnerabilities: [{ line: 11, mutator: MUTATOR, description: 'old Rust report' }],
      };
      await addSuppressions(root, FILE, [{ line: 11, mutator: MUTATOR, reason: 'equivalent' }]);
      const oldVerdict = loadVerifiedSuppressions(root, FILE, undefined);
      expect(applySuppressions(oldResult, oldVerdict).suppressedCount).toBe(1);

      const enrichedResult: MutationResult = {
        ...oldResult,
        vulnerabilities: [
          {
            ...oldResult.vulnerabilities[0],
            column: 8,
            original: '!',
            mutated: '',
          },
        ],
      };
      const enrichedVerdict = loadVerifiedSuppressions(root, FILE, undefined);
      expect(applySuppressions(enrichedResult, enrichedVerdict).suppressedCount).toBe(1);

      await addSuppressions(root, FILE, [{ line: 11, mutator: MUTATOR, reason: 'updated' }]);
      const stored = JSON.parse(
        readFileSync(join(root, '.chaos-mcp/suppressions.json'), 'utf8'),
      ) as { entries: Record<string, unknown[]> };
      expect(stored.entries[FILE]).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
