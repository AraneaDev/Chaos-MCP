import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { formatAuditOutput } from '../audit/audit-output.js';
import type { MutationResult, Vulnerability } from '../engines/base.js';
import type { EnvironmentInfo } from '../utils/project-detector.js';
import type { ChaosConfig } from '../utils/config-loader.js';
import type { ToolArgs } from '../core/tool-args-validation.js';
import type { SupportedProjectType } from '../engines/registry.js';
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
  /** Selects the engine whose ignored-option set is reported; defaults to Stryker's. */
  projectType?: SupportedProjectType;
}) {
  return formatAuditOutput(
    opts.auditResults ?? result(),
    opts.args ?? {},
    opts.projectType ?? 'typescript',
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

  it('separates the drift notes from the delta note and from each other', () => {
    // The two notes are welded onto one string and onto one content block by
    // separators that are invisible in a `toContain('Note:')` assertion: drop
    // the space and the delta note runs into the first drift note; drop the
    // newline and both drift notes render as a single unreadable line. Only a
    // two-note run can see either, so both kinds of rejection are recorded.
    writeSuppressions([
      { line: 2, mutator: 'ArithmeticOperator', reason: 'v1 entry' },
      { line: 3, mutator: 'BlockStatement', reason: 'stale entry', fingerprint: 'deadbeef' },
    ]);

    const response = run({ baselineKeys: baseline });
    const note = structured(response).note as string;

    // Delta note → first drift note, and drifted note → unverified note.
    expect(note).toContain('on the same lines. 1 suppression(s) no longer match');
    expect(note).toContain('`unsuppress`). 1 suppression(s) predate content fingerprinting');

    // The trailing block is one line per rejected-suppression note.
    const noteLines = (response.content[1] as { text: string }).text.split('\n');
    expect(noteLines.length).toBe(2);
    expect(noteLines.filter((l) => !l.startsWith('Note: '))).toEqual([]);
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

describe('formatAuditOutput — text output', () => {
  const threeSurvivingLines: Vulnerability[] = [
    { line: 1, mutator: 'BlockStatement', kind: 'survived' },
    { line: 2, mutator: 'ArithmeticOperator', kind: 'survived' },
    { line: 3, mutator: 'BooleanLiteral', kind: 'survived' },
  ];

  it('hands the resolved reporting options and the gate to the text renderer', () => {
    // The renderer's whole options argument is a single mutation target, and
    // text mode is the only place it is observable: `structuredContent` is built
    // from a separate call, so dropping these options leaves the payload intact
    // while the human-readable report silently loses its verdict and its cap.
    const response = run({
      auditResults: result({ survived: 3, vulnerabilities: threeSurvivingLines }),
      args: { outputFormat: 'text', minScore: 95, maxSurvivors: 1 },
    });
    const text = (response.content[0] as { text: string }).text;

    expect(text).toContain('Gate: FAILED (minScore 95)');
    // maxSurvivors: 1 keeps the first line group and counts the other two.
    expect(text).toContain('2 more');
    expect(text).not.toContain('  3: ');
  });

  it('reports rejected suppressions in the text report as well as the payload', () => {
    // drifted/unverified reach the renderer only through that same options
    // object; a caller reading text output must still learn that stale
    // suppressions were skipped, because the score was not helped by them.
    const text = (
      run({
        args: { outputFormat: 'text' },
        suppression: { applied: 0, drifted: 2, unverified: 1 },
      }).content[0] as { text: string }
    ).text;

    expect(text).toContain('2 suppression(s) no longer match');
    expect(text).toContain('1 suppression(s) predate');
  });

  it('returns the report as one content block typed as text', () => {
    // The block's `type` is what makes an MCP client render it at all: an empty
    // type still satisfies the SDK's shape but shows the caller nothing.
    const response = run({ args: { outputFormat: 'text' } });

    expect(response.content.length).toBe(1);
    expect(response.content[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('Chaos-MCP Audit Report:'),
    });
  });
});

describe('formatAuditOutput — options the resolved engine ignores', () => {
  // cosmic-ray (Python) honours none of the StrykerJS-only options, so a Python
  // audit given two of them must say both had no effect. Every other test here
  // runs against the TypeScript engine, where the ignored set is always empty
  // and this whole branch is unreachable.
  const strykerOnly: ToolArgs = { dryRun: true, incremental: true };

  it('names every ignored option in a trailing note', () => {
    const response = run({
      projectType: 'python',
      args: { ...strykerOnly, outputFormat: 'text' },
    });
    const note = (response.content[1] as { text: string }).text;

    expect(response.content.length).toBe(2);
    // Comma-separated: joined with an empty string the two names fuse into one
    // unrecognisable option ("dryRunincremental").
    expect(note).toContain('dryRun, incremental');
    // And the note itself must be renderable, like the report block above it.
    expect(response.content[1]).toEqual({ type: 'text', text: note });
    expect(note).toContain('python engine');
  });

  it('repeats the ignored options in the structured payload', () => {
    // The trailing note is prose; a programmatic caller reads this field, and it
    // is populated from the same list only when that list is non-empty.
    const s = structured(run({ projectType: 'python', args: strykerOnly }));
    expect(s.ignoredOptions).toEqual(['dryRun', 'incremental']);
  });

  it('adds neither the note nor the field when nothing was ignored', () => {
    // Same engine, none of the unsupported options supplied: the other arm of
    // the guard, without which forcing it true is invisible.
    const response = run({ projectType: 'python', args: {} });

    expect(response.content.length).toBe(1);
    expect(structured(response).ignoredOptions).toBeUndefined();
  });
});
