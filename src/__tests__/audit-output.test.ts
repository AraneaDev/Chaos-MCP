import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { formatAuditOutput } from '../audit/audit-output.js';
import type { MutationResult, Vulnerability } from '../engines/base.js';
import type { EnvironmentInfo } from '../utils/project-detector.js';
import type { ChaosConfig } from '../utils/config-loader.js';
import type { ToolArgs } from '../core/tool-args-validation.js';
import type { SuppressionCounts } from '../audit/suppression-io.js';
import type { MutantKey } from '../core/verify.js';

/**
 * `audit/audit-output.ts` assembles the response EVERY tool call returns, and had no
 * test file of its own — a mutation audit scored it 54.84% with 42 survivors spread
 * over independent branches, which is absence of tests rather than equivalence. The
 * handler suite executes these lines, so line coverage looked healthy; nothing
 * asserted what they decide.
 *
 * These cover the three branches that survived: the drift/unverified reporting in
 * verify mode, the suggestTestFile trigger, and the minScore gate wiring. Each is
 * asserted in BOTH directions, because a condition forced to a constant is only
 * caught by the arm it stops taking.
 *
 * A real temp workspace is used rather than mocks: the verify path reads suppressions
 * off disk through `loadVerifiedSuppressions`, and the drifted/unverified split is a
 * property of that file's contents, so faking it would test the fake.
 */

const RELATIVE_TARGET = 'src/target.ts';
const SOURCE = ['export function add(a: number, b: number) {', '  return a + b;', '}', ''].join(
  '\n',
);

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'chaos-audit-output-'));
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, RELATIVE_TARGET), SOURCE);
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

/** Write `.chaos-mcp/suppressions.json` — the default path the loader resolves. */
function writeSuppressions(entries: Record<string, unknown>[]): void {
  mkdirSync(join(ws, '.chaos-mcp'), { recursive: true });
  writeFileSync(
    join(ws, '.chaos-mcp', 'suppressions.json'),
    JSON.stringify({ version: 2, entries: { [RELATIVE_TARGET]: entries } }),
  );
}

const env = (): EnvironmentInfo => ({
  projectType: 'typescript',
  testRunner: 'vitest',
  detectedRunner: 'vitest',
  packageManager: '',
  workspaceRoot: ws,
});

const result = (over: Partial<MutationResult> = {}): MutationResult => ({
  target: RELATIVE_TARGET,
  totalMutants: 10,
  killed: 9,
  survived: 1,
  mutationScore: '90.00%',
  vulnerabilities: [],
  ...over,
});

const NO_SUPPRESSION: SuppressionCounts = { applied: 0, drifted: 0, unverified: 0 };

function run(opts: {
  auditResults?: MutationResult;
  args?: ToolArgs;
  baselineKeys?: MutantKey[];
  suppression?: SuppressionCounts;
  cfg?: ChaosConfig;
}) {
  return formatAuditOutput(
    opts.auditResults ?? result(),
    opts.args ?? {},
    'typescript',
    opts.baselineKeys,
    RELATIVE_TARGET,
    undefined,
    opts.cfg ?? {},
    env(),
    opts.suppression ?? NO_SUPPRESSION,
    undefined,
    RELATIVE_TARGET,
  );
}

const structured = (r: ReturnType<typeof run>): Record<string, unknown> =>
  r.structuredContent as Record<string, unknown>;

describe('formatAuditOutput — verify mode suppression drift reporting', () => {
  const baseline: MutantKey[] = [{ line: 2, mutator: 'ArithmeticOperator' }];

  it('reports drifted and unverified counts when the suppression file has both', () => {
    writeSuppressions([
      // No fingerprint at all: v1 data, never applied, counted as unverified.
      { line: 2, mutator: 'ArithmeticOperator', reason: 'v1 entry' },
      // Fingerprint that cannot match the real source line: counted as drifted.
      { line: 3, mutator: 'BlockStatement', reason: 'stale entry', fingerprint: 'deadbeef' },
    ]);

    const response = run({ baselineKeys: baseline });
    const s = structured(response);

    expect(s.unverifiedSuppressions).toBe(1);
    expect(s.driftedSuppressions).toBe(1);
    // The note is extended in place, and the drift notes are appended as their own
    // trailing content block so they cannot corrupt the JSON payload above them.
    expect(response.content.length).toBe(2);
    expect((response.content[1] as { text: string }).text).toContain('Note:');
  });

  it('omits both counts and the extra block when no suppressions are recorded', () => {
    // The other arm of `verifyDrift.length > 0`. Without this, forcing that
    // condition true is invisible.
    const response = run({ baselineKeys: baseline });
    const s = structured(response);

    expect(s.unverifiedSuppressions).toBeUndefined();
    expect(s.driftedSuppressions).toBeUndefined();
    expect(response.content.length).toBe(1);
  });

  it('reports only the unverified count when nothing has drifted', () => {
    // Pins `if (verdict.drifted > 0)` independently of the outer guard: with drift
    // at zero and unverified non-zero, forcing it true adds a bogus field.
    writeSuppressions([{ line: 2, mutator: 'ArithmeticOperator', reason: 'v1 entry' }]);

    const s = structured(run({ baselineKeys: baseline }));

    expect(s.unverifiedSuppressions).toBe(1);
    expect(s.driftedSuppressions).toBeUndefined();
  });

  it('reports only the drifted count when nothing is unverified', () => {
    // The mirror, pinning `if (verdict.unverified > 0)`.
    writeSuppressions([
      { line: 3, mutator: 'BlockStatement', reason: 'stale', fingerprint: 'deadbeef' },
    ]);

    const s = structured(run({ baselineKeys: baseline }));

    expect(s.driftedSuppressions).toBe(1);
    expect(s.unverifiedSuppressions).toBeUndefined();
  });
});

describe('formatAuditOutput — suggestTestFile trigger', () => {
  const vulnerability: Vulnerability = { line: 2, mutator: 'ArithmeticOperator', kind: 'survived' };

  it('suggests a test file when mutants survived', () => {
    const s = structured(run({ auditResults: result({ survived: 1, vulnerabilities: [] }) }));
    expect(s.suggestedTestFile).toBeDefined();
  });

  it('suggests a test file when survivors are reported only as vulnerabilities', () => {
    // The right-hand arm of the `||`. With survived at 0 this is the only thing that
    // can trigger a suggestion, so it is what distinguishes `||` from `&&`.
    const s = structured(
      run({ auditResults: result({ survived: 0, vulnerabilities: [vulnerability] }) }),
    );
    expect(s.suggestedTestFile).toBeDefined();
  });

  it('suggests nothing on a clean result', () => {
    const s = structured(run({ auditResults: result({ survived: 0, vulnerabilities: [] }) }));
    expect(s.suggestedTestFile).toBeUndefined();
  });
});

describe('formatAuditOutput — minScore gate wiring', () => {
  it('emits a passing gate when the score clears minScore', () => {
    const s = structured(run({ args: { minScore: 80 } }));
    expect(s.gate).toEqual(expect.objectContaining({ minScore: 80, passed: true }));
  });

  it('emits a failing gate when the score is below minScore', () => {
    const s = structured(run({ args: { minScore: 95 } }));
    expect(s.gate).toEqual(expect.objectContaining({ minScore: 95, passed: false }));
  });

  it('fails the gate on a partial audit even when the score clears the bar', () => {
    // `complete: false` must fail closed — the score covers only the batches that
    // ran, so passing a file on a fraction of it is the defect the third argument
    // to evaluateGate exists to prevent.
    const s = structured(
      run({ auditResults: result({ complete: false }), args: { minScore: 10 } }),
    );
    expect(s.gate).toEqual(expect.objectContaining({ passed: false, reason: 'partial_audit' }));
  });

  it('emits no gate when minScore is absent', () => {
    const s = structured(run({ args: {} }));
    expect(s.gate).toBeUndefined();
  });
});
