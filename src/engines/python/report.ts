/**
 * Reading cosmic-ray's `dump` output into a {@link MutationResult}.
 *
 * Pure: given the dump text it decides the score, the survivors and their
 * locations, with no filesystem or subprocess. The two dump shapes this parser
 * tolerates — and the error raised for a third — are the substance here.
 */
import { type MutationResult, type Vulnerability, formatMutationScore } from '../base.js';

/** Extract original→mutated source from a cosmic-ray unified `diff`. */
function extractDiffChange(diff: string): { original?: string; mutated?: string } {
  let original: string | undefined;
  let mutated: string | undefined;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('---') || raw.startsWith('+++')) continue; // file headers
    if (original === undefined && raw.startsWith('-')) original = raw.slice(1).trim();
    else if (mutated === undefined && raw.startsWith('+')) mutated = raw.slice(1).trim();
  }
  return { original, mutated };
}

/**
 * Thrown when a surviving mutant's work item matches neither cosmic-ray dump
 * shape Chaos-MCP knows how to read. See {@link readMutationSpec}.
 */
export class CosmicRayDumpShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CosmicRayDumpShapeError';
  }
}

/** The two per-mutation fields a survivor's location is built from. */
interface CosmicRayMutationSpec {
  operator_name?: unknown;
  start_pos?: unknown;
}

/**
 * Read `operator_name` + `start_pos` out of one candidate record, or `undefined`
 * when it carries neither.
 *
 * `undefined` — rather than a `{ line: 0, mutator: 'Mutation' }` default — is
 * the whole point. Suppression and verify key survivors on `keyOf(line, mutator)`
 * (`utils/suppression.ts`, `verify.ts`, `audit/apply-suppressions.ts`), so a
 * placeholder collapses EVERY survivor in the file onto the single key
 * `"0 Mutation"`: suppressing one silently suppresses all of them, and a verify
 * re-run reports phantom "now killed" mutants. The killed/survived counts and
 * the mutation score stay correct throughout (they come only from
 * `test_outcome`), which is what made the old failure silent as well as
 * dangerous.
 *
 * A record carrying only ONE of the two fields is still returned: the other half
 * falls back, which loses precision but does not collide across operators/lines
 * the way a fully-empty record does.
 */
function readMutationSpec(source: unknown): { line: number; operator: string } | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const spec = source as CosmicRayMutationSpec;
  const operator = typeof spec.operator_name === 'string' ? spec.operator_name : undefined;
  const line =
    Array.isArray(spec.start_pos) && typeof spec.start_pos[0] === 'number'
      ? spec.start_pos[0]
      : undefined;
  if (operator === undefined && line === undefined) return undefined;
  return { line: line ?? 0, operator: operator ?? 'Mutation' };
}

/**
 * Locate a survivor's mutation record across cosmic-ray's two work-item shapes.
 *
 * cosmic-ray >= 8.4 nests them: `WorkItem { job_id, mutations: MutationSpec[] }`
 * — the multi-mutation shape that supports higher-order mutation (verified
 * against the 8.4.6 `work_item.py` this repo pins in
 * `containers/python/requirements.txt`). Earlier 8.x carried `operator_name` /
 * `start_pos` FLAT on the WorkItem. The container path is pinned, but NATIVE
 * mode runs whatever `pipx install cosmic-ray` produced and nothing probes
 * `cosmic-ray --version`, so both shapes have to be read.
 *
 * @throws {CosmicRayDumpShapeError} when neither shape is present.
 */
function resolveSurvivorLocation(item: unknown): { line: number; operator: string } {
  const nested = Array.isArray((item as { mutations?: unknown })?.mutations)
    ? ((item as { mutations: unknown[] }).mutations[0] as unknown)
    : undefined;
  const spec = readMutationSpec(nested) ?? readMutationSpec(item);
  if (spec) return spec;

  const keys =
    typeof item === 'object' && item !== null ? Object.keys(item).join(', ') : String(item);
  throw new CosmicRayDumpShapeError(
    `cosmic-ray dump shape not recognised — Chaos-MCP supports cosmic-ray >= 8.3; got: ` +
      `${keys || '(no keys)'}. A surviving mutant's work item carried neither a \`mutations[]\` ` +
      `entry (cosmic-ray >= 8.4) nor top-level \`operator_name\`/\`start_pos\` (cosmic-ray 8.3), ` +
      `so its line and operator cannot be identified. Chaos-MCP refuses to substitute a ` +
      `placeholder here because every survivor would then share one suppression key and ` +
      `suppressing one would hide them all. Install a supported cosmic-ray ` +
      `(\`pipx install 'cosmic-ray==8.4.6'\` — the version containers/python pins).`,
  );
}

/**
 * Parse cosmic-ray `dump` output (one `[WorkItem, WorkResult]` JSON pair per
 * line) into a MutationResult.
 *
 * - `test_outcome: "killed"` → caught by the suite.
 * - `test_outcome: "survived"` → a coverage hole (becomes a vulnerability with
 *   the exact line from `start_pos`, the authoritative `operator_name`, and the
 *   original/mutated source from the `diff`).
 * - `test_outcome: "incompetent"` → the mutation produced uncompilable code; it
 *   is excluded from the denominator (not a real test gap), mirroring how
 *   StrykerJS handles compile errors.
 * - `test_outcome: null` (or anything unrecognised) → UNSCORED. cosmic-ray's
 *   `WorkResult` carries BOTH `worker_outcome` and `test_outcome`, and the
 *   latter is `None` whenever the worker never reached a test — most importantly
 *   for `worker_outcome == "skipped"`, which is exactly what `cr-filter-operators`
 *   writes for every mutant an `excludeOperators` pattern matched. Counting
 *   those as merely "completed" made the degenerate-run guard misdiagnose a
 *   too-broad operator filter as a missing Python interpreter.
 * - `result === null` → a pending job (exec interrupted); ignored entirely.
 *
 * Returns the result alongside `completed` (mutants that came back with ANY
 * result) and `unscored`. Neither is a field on `MutationResult` (the public
 * payload shape): the engine reads them to tell "no mutants enumerated" (a
 * genuine 100%) from "mutants ran but none were scorable", and to tell WHICH
 * kind of unscorable. See the degenerate-run guard, `assertScorableRun` in
 * `./diagnose.ts`.
 */
export function parseCosmicRayDump(
  dumpText: string,
  filePath: string,
): { result: MutationResult; completed: number; unscored: number } {
  let killed = 0;
  let survived = 0;
  let incompetent = 0;
  let unscored = 0;
  let completed = 0;
  const vulnerabilities: Vulnerability[] = [];

  for (const raw of dumpText.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // malformed line — skip defensively
    }
    if (!Array.isArray(parsed) || parsed.length < 2) continue;
    const item: unknown = parsed[0];
    const result = parsed[1] as { test_outcome?: string | null; diff?: string } | null;
    if (!result) continue; // pending job
    completed++;

    const outcome = result.test_outcome;
    if (outcome === 'killed') {
      killed++;
    } else if (outcome === 'survived') {
      survived++;
      const { line, operator } = resolveSurvivorLocation(item);
      const { original, mutated } = extractDiffChange(result.diff ?? '');
      const vuln: Vulnerability = {
        line,
        mutator: operator,
        // cosmic-ray reports killed/survived/incompetent only — it has no
        // "no test reached this line" outcome to distinguish.
        kind: 'survived',
        description: `Surviving mutant (${operator}) at line ${line} bypassed the test suite. Your tests did not catch this change.`,
      };
      if (original !== undefined) vuln.original = original;
      if (mutated !== undefined) vuln.mutated = mutated;
      vulnerabilities.push(vuln);
    } else if (outcome === 'incompetent') {
      // Uncompilable mutation — excluded from the denominator, not a test gap.
      incompetent++;
    } else {
      // null / undefined / an outcome from a future cosmic-ray. The worker never
      // produced a pass/fail, so this mutant is not evidence about the suite in
      // either direction; it is tracked separately so the engine can say WHY.
      unscored++;
    }
  }

  const totalMutants = killed + survived;

  return {
    result: {
      target: filePath,
      totalMutants,
      killed,
      survived,
      mutationScore: formatMutationScore(killed, totalMutants),
      vulnerabilities,
      // cosmic-ray mutates whole modules — `supportsLineScope: false` in
      // engines/registry.ts — so this report always enumerated the whole file.
      // See the same field in engines/rust/report.ts for why the absence of a
      // scope note is NOT a usable proxy for it.
      scopeKind: 'whole-file' as const,
      incompetent,
    },
    completed,
    unscored,
  };
}
