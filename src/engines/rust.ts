/**
 * Mutation testing engine for Rust files (cargo-mutants).
 *
 * This module is the ENGINE and nothing else: it sequences one run — resolve
 * jobs and the `--file` glob → probe the target → invoke cargo-mutants →
 * diagnose a startup/baseline failure → parse the output — and owns the
 * filesystem and subprocess work that sequencing needs. Every phase's substance
 * lives under `engines/rust/`:
 *
 *   args.ts         — `-j` job policy and `--file` glob escaping (pure)
 *   report.ts       — cargo-mutants text-output parsing and scoring (pure)
 *   canonicalize.ts — mapping change descriptions to canonical mutators (pure)
 *
 * The helpers are re-exported here because that is the surface the test suite
 * and callers (`src/estimate.ts` imports `escapeCargoFileGlob` from this path)
 * already import; the split moved where they live, not what the module offers.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { cpus } from 'node:os';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BaseEngine, RunOptions, MutationResult } from './base.js';
import { invokeMutationTool } from '../utils/exec-classify.js';
import { log, isVerbose } from '../utils/logger.js';
import { DEFAULT_TIMEOUT_MS } from '../utils/constants.js';
import { resolveCargoJobs, escapeCargoFileGlob, inDiffArgs, timeoutArgs } from './rust/args.js';
import {
  countCargoMutantsList,
  enrichCargoMutantsResult,
  parseCargoSummary,
  parseCargoMutantsText,
} from './rust/report.js';
import { isBaselineCompileFailure } from './rust/failures.js';
import { readStructuredOutput, readStructuredSummary } from './rust/structured.js';

export { resolveCargoJobs, escapeCargoFileGlob, inDiffArgs, timeoutArgs } from './rust/args.js';
export {
  type CargoSummary,
  type ScoredCounts,
  parseCargoSummary,
  scoreCounts,
  stripCargoTiming,
  noMutantsError,
  parseCargoMutantsText,
  countCargoMutantsList,
  enrichCargoMutantsResult,
} from './rust/report.js';
export {
  joinToStructured,
  readStructuredOutput,
  readStructuredSummary,
} from './rust/structured.js';

/**
 * Mutation testing engine for Rust files.
 *
 * Shells out to `cargo mutants` to generate and evaluate mutants.
 * Requires `cargo-mutants` to be installed: `cargo install cargo-mutants`.
 *
 * Note: Line-level scoping is not supported by cargo-mutants' `--file` flag.
 * The `lineScope` option is reported as ignored for Rust targets.
 */
export class RustEngine extends BaseEngine {
  async run(filePath: string, options?: RunOptions): Promise<MutationResult> {
    const cwd = options?.workDir ?? process.cwd();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // cargo-mutants `--file` is a GLOB matched against the source path. Pass the
    // full workspace-relative path (Med#9) so the run is scoped to exactly this
    // file — a bare basename would also match same-named files in other dirs —
    // and escape it (Med#4) so a metacharacter that is legal in a filename does
    // not turn the path into a pattern matching some other file, or none.
    const jobs = resolveCargoJobs(options?.concurrency, cpus().length);
    const fileGlob = escapeCargoFileGlob(filePath);

    // Does the target actually exist under the run's working directory? This is
    // the signal that lets the zero-mutant guard tell "the glob matched nothing"
    // (an error) from "this file has no mutable logic" (a legitimate zero) —
    // cargo-mutants prints the identical "Found 0 mutants to test" and exits 0
    // for both. See noMutantsError for why the distinction matters.
    //
    // Checked with the ORIGINAL, UNESCAPED `filePath`: the escaping exists only
    // to stop the glob engine reinterpreting a metacharacter, whereas a `[` in a
    // real filename is just a `[` to the filesystem — probing for the escaped
    // `token[[]0[]].rs` would find nothing and turn every such file into a false
    // error, exactly the bug Med#4 fixed on the glob side.
    //
    // `workDir` is a HOST path in both execution modes (the container session
    // bind-mounts it to /workspace), so a host-side stat is correct for both.
    // `resolve` rather than `join` so an absolute `filePath` is probed where it
    // actually lives instead of being appended to the sandbox root. A stat that
    // cannot see the file only ever routes us to the pre-existing error path, so
    // the check can never manufacture a score that was not there before.
    const targetExists = existsSync(resolve(cwd, filePath));

    // `--in-diff` composes with `--file` rather than replacing it: the glob
    // still selects the file, and `--in-diff` narrows enumeration to what the
    // diff touched. Reads only `diffScope.kind === 'patch'` (see inDiffArgs);
    // an absent or non-patch diffScope adds nothing, so an unscoped run stays
    // byte-identical to before diff scoping existed.
    const outputDir = options?.dryRun
      ? undefined
      : mkdtempSync(
          join(
            existsSync(cwd) ? cwd : tmpdir(),
            existsSync(cwd) ? '.chaos-cargo-mutants-' : 'chaos-cargo-mutants-',
          ),
        );
    const args = [
      'mutants',
      ...(options?.dryRun ? ['--list'] : []),
      ...(outputDir ? ['--output', outputDir] : []),
      '--file',
      fileGlob,
      ...inDiffArgs(options?.diffScope),
      ...timeoutArgs(options?.perMutantTimeoutMs),
    ];
    if (jobs > 1) args.push('-j', String(jobs));

    if (isVerbose()) {
      // Log the escaped pattern, i.e. the argument cargo-mutants actually
      // receives — that is the string an operator needs in order to reproduce
      // the run by hand. It is identical to `filePath` for ordinary paths.
      log(`RustEngine: cargo mutants --file "${fileGlob}"${jobs > 1 ? ` -j ${jobs}` : ''}`);
    }

    try {
      let stdout: string;
      let stderr: string;

      try {
        const result = await invokeMutationTool('cargo-mutants', 'cargo', args, {
          cwd,
          timeoutMs,
          // Node's execFile REPLACES the child's whole environment when `env` is
          // set rather than merging it with process.env, so a bare innerEnv would
          // strip PATH/CARGO_HOME/RUSTUP_HOME and cargo would fail to launch at
          // all (spawn cargo ENOENT). Merge over the current environment, and
          // only when there is something to merge, so the no-cap path stays
          // byte-identical to today (see prepareInfectionWorkspace in
          // engines/php/config.ts for the same pattern).
          env: options?.innerEnv ? { ...process.env, ...options.innerEnv } : undefined,
          signal: options?.signal,
          executor: options?.executor,
        });
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (error: unknown) {
        // Startup failures rethrow; non-ExecFailure errors wrap; otherwise we get
        // a typed ExecFailureError back for the rust-specific handling below.
        const execErr = this.toExecFailure(error, 'cargo-mutants');

        // Cancellation FIRST, before the rewrap below.
        //
        // `invokeMutationTool` deliberately rethrows an abort as the raw
        // `ExecFailureError` with `code: 'ABORTED'` so `isCancel` can still
        // recognise it ("Rethrow the classified error untouched so the code (and
        // `isCancel`) survive", utils/exec-classify.ts); python.ts guards the same
        // way for the same reason. A killed child arrives here with empty stdout,
        // so without this branch a deliberate stop came back wearing the phantom
        // diagnosis `cargo-mutants failed (exit null) with no parseable output …
        // run \`cargo test\``, and the marker `isCancel` keys on was gone. Callers
        // with a request context are rescued by `ctx.signal.aborted`; `computeCount`
        // in estimate.ts has none.
        if (execErr.code === 'ABORTED') throw execErr;

        // Non-zero exit: cargo-mutants exits non-zero when mutants survive OR
        // when the baseline `cargo test` itself fails. If stdout is empty we
        // treat it as a baseline failure (no mutants parsed out); otherwise
        // fall through and parse the captured stdout.
        stdout = execErr.stdout;
        stderr = execErr.stderr;

        // Whitespace-only stdout (e.g. a lone "\n" flushed before the run died)
        // carries no mutants either, but is truthy. A bare `!stdout` check would
        // let it through to the text parser and report a useless zero-mutant
        // result instead of the accurate "baseline test suite failed" diagnosis.
        // `!stdout ||` guards the case where stdout is absent entirely.
        if (isBaselineCompileFailure(`${stdout}\n${stderr}`)) {
          throw new Error(
            `cargo-mutants baseline compile failure: ${stderr?.slice(0, 500) || stdout.slice(0, 500)}`,
          );
        }
        if (!stdout || !stdout.trim()) {
          throw new Error(
            `cargo-mutants failed (exit ${execErr.exit}) with no parseable output. ` +
              `This usually means the baseline test suite itself failed. Fix the baseline before retrying. ` +
              `stderr: ${execErr.stderr?.slice(0, 500) ?? ''}`,
          );
        }
      }

      if (isVerbose() && stderr) {
        log(`cargo-mutants stderr: ${stderr.slice(0, 500)}`);
      }

      if (options?.dryRun) {
        return countCargoMutantsList(stdout, filePath);
      }

      // Text only: `run` never asks for structured output (`--output` writes
      // `mutants.out/outcomes.json` to DISK; stdout is always human-readable), so
      // there is nothing to attempt a JSON parse on. The old JSON branch was
      // unreachable, validated a shape `outcomes.json` does not have anyway, and
      // cost a throwaway multi-MB `JSON.parse` on every run (audit L7).
      const parsed = parseCargoMutantsText(
        stdout,
        filePath,
        targetExists,
        options?.diffScope?.kind === 'patch' ? 'scoped' : 'whole-file',
      );
      const baseline = stdout.match(/Unmutated baseline in [\d.]+s build \+ ([\d.]+)s test/i);
      const baselineTestMs = baseline
        ? Math.ceil(Number.parseFloat(baseline[1]) * 1000)
        : undefined;
      if (
        options?.perMutantTimeoutMs !== undefined &&
        baselineTestMs !== undefined &&
        options.perMutantTimeoutMs < baselineTestMs
      ) {
        parsed.fidelityNote =
          `perMutantTimeoutMs (${options.perMutantTimeoutMs}ms) is below the baseline test time ` +
          `${baselineTestMs}ms; the score may be inflated because cargo-mutants counts timeouts as killed.`;
      }
      let source: string | undefined;
      try {
        source = readFileSync(resolve(cwd, filePath), 'utf8');
      } catch {
        source = undefined;
      }
      return enrichCargoMutantsResult(
        parsed,
        outputDir ? readStructuredOutput(outputDir) : undefined,
        outputDir ? readStructuredSummary(outputDir) : undefined,
        source,
        parseCargoSummary(stdout),
      );
    } finally {
      if (outputDir) rmSync(outputDir, { recursive: true, force: true });
    }
  }
}
