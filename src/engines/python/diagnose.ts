/**
 * Post-run diagnosis of a cosmic-ray session.
 *
 * Separate from `report.ts` on purpose: that module is a pure parser (dump text
 * in, {@link MutationResult} out), whereas the diagnosis here probes the
 * interpreter (`describeInterpreter` shells out) to explain WHY a run produced
 * nothing scorable. It reads only already-parsed data, so it has no reason to
 * sit in the engine's orchestration path either.
 */
import type { MutationResult } from '../base.js';
import { describeInterpreter } from './interpreter.js';

/** Everything the degenerate-run diagnosis needs from a finished run. */
export interface ScorableRunCheck {
  /** The parsed result — `totalMutants` and `incompetent` are what is read. */
  result: MutationResult;
  /** Mutants that came back with ANY result (see {@link parseCosmicRayDump}). */
  completed: number;
  /** Mutants whose `test_outcome` was null/unrecognised. */
  unscored: number;
  /** The audited file, echoed in the diagnosis. */
  filePath: string;
  /** The interpreter the engine resolved, echoed via {@link describeInterpreter}. */
  interpreter: string;
  /** The `test-command` written into the generated config. */
  testCommand: string;
  /** `pythonExcludeOperators` as supplied by the caller, if any. */
  excludeOperators?: string[] | undefined;
}

/**
 * Degenerate-run guard. cosmic-ray's `baseline` returns exit 0 even when the
 * test binary is missing or collects nothing, so a broken run reaches here
 * looking like a clean one: mutants were enumerated and executed, but none
 * of them produced a killed/survived verdict. parseCosmicRayDump drops those
 * from the denominator, which would otherwise surface as a dangerously
 * misleading `total:0` / `100%` ("caught every mutation") when in truth NO
 * test ever ran. A genuinely tiny file with zero enumerated mutants has
 * `completed === 0` and is untouched.
 *
 * The two unscorable outcomes have OPPOSITE causes and must not share a
 * diagnosis. `incompetent` means the mutated code was executed and the test
 * command produced no real pass/fail → interpreter/test-command. A null
 * `test_outcome` means the worker never ran a test at all → almost always
 * `cr-filter-operators` skipping everything (step 2.5). The guard used to
 * count both as "completed" and blame the interpreter either way, so a
 * too-broad `excludeOperators` produced a confidently wrong message that
 * sent the operator to look at a Python install that was fine.
 */
export function assertScorableRun({
  result,
  completed,
  unscored,
  filePath,
  interpreter,
  testCommand,
  excludeOperators,
}: ScorableRunCheck): void {
  if (result.totalMutants === 0 && completed > 0) {
    // `incompetent` is optional on the public MutationResult shape.
    const incompetent = result.incompetent ?? 0;
    if (incompetent > 0) {
      throw new Error(
        `cosmic-ray ran ${completed} mutant(s) on ${filePath} but scored none of them — ` +
          `${incompetent} came back 'incompetent', meaning the test command never ` +
          `produced a real pass/fail. This usually means the Python interpreter or pytest is ` +
          `missing, or the test-command is wrong. Resolved interpreter: ` +
          `${describeInterpreter(interpreter)}. Resolved test-command: "${testCommand}". ` +
          `Verify it runs the suite from the project root before re-auditing.`,
      );
    }
    throw new Error(
      `cosmic-ray ran ${completed} mutant(s) on ${filePath} but scored none of them — ` +
        `${unscored} came back with no test outcome at all, which means no test was ever run ` +
        `for them (cosmic-ray records those with worker_outcome 'skipped' or 'no-test'). The ` +
        `usual cause is an operator filter that excluded every mutation: ` +
        `"cosmicray": { "excludeOperators": [...] }` +
        ((excludeOperators?.length ?? 0) > 0
          ? ` — this run used ${JSON.stringify(excludeOperators)}`
          : '') +
        `. Narrow the exclude patterns so some operators survive the filter, then re-audit.`,
    );
  }
}
