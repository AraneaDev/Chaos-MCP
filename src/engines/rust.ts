import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import {
  BaseEngine,
  RunOptions,
  MutationResult,
  formatMutationScore,
  survivorVulnerability,
} from './base.js';
import { invokeMutationTool } from '../utils/exec-classify.js';
import { log, isVerbose } from '../utils/logger.js';
import { DEFAULT_TIMEOUT_MS } from '../utils/constants.js';

/**
 * Resolve the cargo-mutants `-j` job count. Explicit `concurrency` (from a tool
 * arg or `rust.concurrency` config, already validated to 1–64) is honored as-is.
 * Otherwise a deliberately LOW default: `2` when the machine has spare cores
 * (`cpuCount >= 3`), else `1` (serial). cargo-mutants' own docs warn against
 * core-scaling `-j` for Rust — its build/test tooling is already parallel, and
 * each job needs its own multi-GB `target/` copy — so the default stays small.
 * A result of `1` means "serial"; the engine omits `-j` entirely in that case.
 */
export function resolveCargoJobs(concurrency: number | undefined, cpuCount: number): number {
  if (typeof concurrency === 'number' && Number.isInteger(concurrency) && concurrency >= 1) {
    return concurrency;
  }
  return cpuCount >= 3 ? 2 : 1;
}

/**
 * Escape a source path for cargo-mutants' `--file` flag, which takes a GLOB
 * rather than a literal path.
 *
 * WHY (audit Med#4): `*`, `?`, `[`, `]`, `{` and `}` are all legal POSIX
 * filename characters AND glob metacharacters. Passed through verbatim,
 * `src/parser/token[0].rs` makes `[0]` a character class, so the glob matches
 * `src/parser/token0.rs` — a DIFFERENT file — or, far more often, nothing at
 * all. Verified against cargo-mutants 27.1.0: the unescaped pattern really did
 * list mutants for the wrong file, and `src/does{not}exist.rs` matched nothing
 * while cargo-mutants still exited 0 ("Found 0 mutants to test"), which is what
 * used to surface as a serene 100.00%.
 *
 * HOW: cargo-mutants matches with globset, whose backslash escape is not usable
 * here (a backslash is a path separator on Windows). Instead every metacharacter
 * is wrapped in a single-character class, which always matches that character
 * literally: `[` becomes `[[]`, `*` becomes `[*]`, and so on. That is the same
 * transformation `globset::escape` performs, extended with `{`/`}` because
 * cargo-mutants leaves brace alternation (`{a,b}`) enabled. Each of the six
 * escapes below was confirmed to select exactly the intended file against real
 * cargo-mutants 27.1.0.
 *
 * Deliberately NOT escaped:
 *  - `!` — only special immediately after a `[`, and every `[` we emit is itself
 *    escaped, so a literal `!` can never open a negated class. `[!]` would in
 *    fact be an unterminated class and fail to compile at all.
 *  - `\` — the Windows path separator, which must reach cargo-mutants intact.
 *
 * Escaping is best-effort by nature (glob dialects differ); the zero-mutant
 * guard in {@link parseCargoMutantsText} is what stops a miss becoming a false
 * 100%. Where the two meet: a glob that misses a file which is NOT on disk still
 * throws, and a glob that somehow misses a file that IS on disk degrades to a
 * zero-mutant "n/a" result — never to a 100% score — because `hasNoMutableLogic`
 * (src/format.ts) refuses to render 0/0 as a percentage at all.
 */
export function escapeCargoFileGlob(filePath: string): string {
  return filePath.replace(/[*?[\]{}]/g, (c) => `[${c}]`);
}

/**
 * Authoritative per-outcome counts extracted from cargo-mutants' final summary
 * line, e.g. "47 mutants tested in 30s: 4 missed, 42 caught, 1 unviable".
 */
interface CargoSummary {
  caught: number;
  missed: number;
  unviable: number;
  timeout: number;
}

/**
 * Extract cargo-mutants' summary counts from its final report line.
 *
 * WHY this is load-bearing: by default cargo-mutants (v27) prints ONLY the
 * MISSED (and, with extra flags, TIMEOUT/UNVIABLE) result lines — CAUGHT mutants
 * are silent. So counting printed lines alone under-reports both `total` and
 * `killed`, yielding a bogus 0% score on a suite that actually kills most
 * mutants. The summary line is the ground truth for the totals; the per-line
 * MISSED entries remain the source of survivor detail.
 *
 * The line looks like:
 *   "47 mutants tested in 30s: 4 missed, 42 caught, 1 unviable"
 *   "13 mutants tested in 14s: 2 missed, 11 caught"
 * (order/set of categories varies; zero-count categories are omitted).
 * Returns null when no recognisable summary line is present — callers must then
 * REFUSE to score the run (see parseCargoMutantsText); there is no sound
 * fallback, because the printed lines alone under-report the totals.
 */
function parseCargoSummary(stdout: string): CargoSummary | null {
  const lines = stdout.split('\n');
  // Scan from the end: the summary is the last such line cargo-mutants prints.
  for (let i = lines.length - 1; i >= 0; i--) {
    // Match "<n> mutants tested ... : <tail>". "Found N mutants to test" says
    // "to test", not "tested", so it is correctly excluded.
    //
    // The remainder is captured WITHOUT forbidding a colon before the result
    // colon (audit Med#5b). The old `[^:]*:` required the duration to be
    // colon-free, so a run rendered as "in 1:04:" instead of "in 64s:" dropped
    // the summary entirely and took the (now removed) bogus fallback. We take
    // the LAST colon on the line as the separator instead: the result list
    // itself ("4 missed, 42 caught") never contains one, while a clock-style
    // duration does. A line with no colon at all is still scanned, so a format
    // that drops the separator degrades to "unrecognised", not to a wrong score.
    const head = lines[i].match(/\bmutants?\s+tested\b(.*)$/i);
    if (!head) continue;
    const colon = head[1].lastIndexOf(':');
    const tail = colon >= 0 ? head[1].slice(colon + 1) : head[1];

    const summary: CargoSummary = { caught: 0, missed: 0, unviable: 0, timeout: 0 };
    let matched = false;
    const re = /(\d+)\s+([a-zA-Z]+)/g;
    let g: RegExpExecArray | null;
    while ((g = re.exec(tail)) !== null) {
      const n = parseInt(g[1], 10);
      const label = g[2].toLowerCase();
      if (label.startsWith('caught')) {
        summary.caught += n;
        matched = true;
      } else if (label.startsWith('miss')) {
        summary.missed += n;
        matched = true;
      } else if (label.startsWith('unviable')) {
        summary.unviable += n;
        matched = true;
      } else if (label.startsWith('timeout')) {
        summary.timeout += n;
        matched = true;
      }
    }
    if (matched) return summary;
  }
  return null;
}

/**
 * The scored view of one set of cargo-mutants outcome counts.
 */
interface ScoredCounts {
  totalMutants: number;
  killed: number;
  survived: number;
  mutationScore: string;
  /** Only present when non-zero, matching the `MutationResult` spread below. */
  incompetent?: number;
}

/**
 * Turn cargo-mutants' four outcome counts into the scored fields of a
 * {@link MutationResult}.
 *
 * It is the ONLY place a cargo-mutants run is turned into a score, so the rules
 * below cannot drift between output shapes. They are:
 *  - timeouts count as KILLED — the suite detected the mutant by hanging on it;
 *  - unviable mutants (did not compile) leave the denominator entirely and are
 *    surfaced as `incompetent`, since no test ever exercised them. Reading
 *    cargo's own `summary.total` did neither: it includes unviable mutants,
 *    deflating the score against mutants that were never run.
 */
function scoreCounts(counts: {
  caught: number;
  missed: number;
  timeout: number;
  unviable: number;
}): ScoredCounts {
  const killed = counts.caught + counts.timeout;
  const survived = counts.missed;
  const totalMutants = killed + survived;
  return {
    totalMutants,
    killed,
    survived,
    mutationScore: formatMutationScore(killed, totalMutants),
    ...(counts.unviable > 0 ? { incompetent: counts.unviable } : {}),
  };
}

/**
 * Strip cargo-mutants' trailing " in <build> build + <test> test" timing suffix
 * from a mutant description. WHY: the timing varies run-to-run ("in 0s build +
 * 0s test" vs "in 8s build + 2s test"), so leaving it in the `mutator` label
 * would give the SAME logical mutant a different suppression/verify key on every
 * run, silently breaking baseline re-tests. Only the trailing timing clause is
 * removed; an earlier "... in <fn_name>" in the mutation text is preserved.
 */
function stripCargoTiming(desc: string): string {
  return desc.replace(/\s+in\s+\S+\s+build\s+\+\s+\S+\s+test$/, '').trim();
}

/**
 * The error raised when cargo-mutants reported no mutants at all for a file that
 * IS NOT THERE — the target does not exist under the run's working directory
 * (audit Med#4).
 *
 * WHY this is an error and not a score: with zero mutants the scored
 * denominator is zero, and `formatMutationScore(0, 0)` is `"100.00%"`
 * (base.ts) — a fully-covered verdict for a file whose mutants were never even
 * generated. cargo-mutants prints "Found 0 mutants to test" and exits 0 in that
 * case, so nothing downstream would notice. The commonest cause is a `--file`
 * glob that matched nothing (see escapeCargoFileGlob), but the guard is
 * deliberately written against the SYMPTOM so it also catches a mistyped path,
 * a file outside the cargo workspace, and a module never reached from the crate
 * root.
 *
 * WHY it is gated on the target's existence: "Found 0 mutants to test" + exit 0
 * is ALSO what cargo-mutants prints for a file it found perfectly well and that
 * simply has no mutable logic — a `consts.rs`, a `mod.rs` barrel, a file of pure
 * `pub use` re-exports. Throwing for that shape too is a false alarm, and an
 * expensive one: `triage_test_coverage` fails its CI gate closed over errored
 * files (`src/triage.ts` — "N file(s) errored and are not graded, so the gate
 * fails closed"), so an ordinary constants file in a Rust repo would break the
 * build. That is the same class of harm as the false 100% this guard removed,
 * merely pointed the other way. File existence separates the two, and it is a
 * sound discriminator now that the glob is escaped: a correctly-escaped glob
 * that fails to match a file which demonstrably exists is not a case real
 * cargo-mutants produces. A file that exists and yields no mutants returns a
 * zero-mutant result instead, which `hasNoMutableLogic` (src/format.ts) renders
 * as "n/a" — explicitly NOT the same claim as proven coverage.
 */
function noMutantsError(filePath: string): Error {
  const glob = escapeCargoFileGlob(filePath);
  return new Error(
    `cargo-mutants generated no mutants for "${filePath}", so there is nothing to score. ` +
      `Chaos-MCP will not report that as 100% — a zero-mutant run is not a covered file. ` +
      `Check that the \`--file\` glob (${glob}) matches the intended source file, that the path is ` +
      `inside this cargo workspace, and that the module is reachable from the crate root. ` +
      `Verify with: cargo mutants --list --file '${glob}'`,
  );
}

/**
 * Parse cargo-mutants text output into a MutationResult.
 *
 * cargo-mutants stdout contains survivor lines like:
 *   "MISSED   src/main.rs:42:9: replace > with >= in fn foo in 0s build + 0s test"
 *   "UNCAUGHT src/main.rs:88:5: ..."
 * plus a final summary line ("N mutants tested in Xs: A missed, B caught, ...").
 *
 * Cargo-mutants uses the terms MISSED (survived) and CAUGHT (killed), but only
 * MISSED lines are printed by default (see parseCargoSummary). The printed lines
 * are therefore the source of SURVIVOR DETAIL only; every number in the score
 * comes from the summary line, and a run without one is refused outright.
 *
 * @param targetExists — whether `filePath` actually resolves to a file under the
 *   run's working directory, established by {@link RustEngine.run} before the
 *   tool was invoked. It is passed in rather than stat'ed here so this stays a
 *   pure, unit-testable function of the tool's output; it is the ONLY thing that
 *   tells a zero-mutant run that missed its target (an error) apart from one
 *   that found a file with no mutable logic (not an error). See noMutantsError.
 */
function parseCargoMutantsText(
  stdout: string,
  filePath: string,
  targetExists: boolean,
): MutationResult {
  const lines = stdout.split('\n').filter((l) => l.trim());
  // Counts every printed result line, whatever its outcome. It is NOT used for
  // scoring (see the guards below) — only to tell "cargo-mutants reported on
  // mutants but we could not read its totals" apart from "cargo-mutants
  // reported nothing at all", which are different failures with different fixes.
  let lineTotal = 0;
  const vulnerabilities: MutationResult['vulnerabilities'] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const upper = trimmed.toUpperCase();
    const isMissed = upper.startsWith('MISSED');
    const isCaught = upper.startsWith('CAUGHT');
    const isUncaught = upper.startsWith('UNCAUGHT');
    // `cargo mutants` text output uses mixed case (`timeout`, `Timeout`).
    // Normalise to uppercase before matching. (Live-audit L4 fix.)
    const isTimeout = upper.startsWith('TIMEOUT');

    if (!isMissed && !isCaught && !isUncaught && !isTimeout) continue;

    lineTotal++;
    // Audit finding H3: TIMEOUT mutants are tests that hung past the per-mutant
    // timeout. They DID detect the mutant (the test suite hung trying to assert
    // against it), so they are killed, not survivors — the summary's `timeout`
    // bucket is added to `killed` in scoreCounts. Here they only need to be kept
    // out of the vulnerability list, exactly like CAUGHT.
    if (isCaught || isTimeout) continue;

    // Extract line number and trailing description from
    // "MISSED   src/file.rs:42:9: replace add -> sub with ..." (the description
    // separator may be a colon or spaces). cargo-mutants sometimes drops the
    // column (e.g. "MISSED src/file.rs:42: replace ..."), so accept either:
    // ":<line>:<col>:" or a bare ":<line>:" / ":<line>" at end-of-line (audit L7).
    const locMatch = trimmed.match(/:(\d+)(?::\d+)?:?\s*(.*)$/);
    const mutantLine = locMatch ? parseInt(locMatch[1], 10) : 0;
    const desc = locMatch && locMatch[2] ? stripCargoTiming(locMatch[2].trim()) : '';

    vulnerabilities.push(
      // Derive a per-mutant label from the description (H2/I4): two different
      // mutations on the same line must get distinct `mutator` values, or
      // suppression/verify keys (which are `keyOf(line, mutator)`) collapse
      // them into one entry.
      // cargo-mutants reports caught/missed/unviable/timeout — "missed" is a
      // survivor; it has no separate uncovered-line outcome, hence 'survived'.
      survivorVulnerability(mutantLine, desc || 'Rust Mutation Operator', 'Rust', {
        mutated: desc || undefined,
        // No parseable location: `mutantLine` is the 0 sentinel, and "line 0"
        // reads as a real location. Render "line unknown" in the sentence.
        // The structured `line` stays 0 — the suppression/verify keys are
        // `keyOf(line, mutator)` and must not move.
        lineLabel: locMatch ? mutantLine : 'unknown',
      }),
    );
  }

  // The summary line is the ONLY source of the score (audit Med#5). The ordered
  // decision point below is where a run that cannot be scored is separated from
  // one that can:
  //
  //  1. Result lines were printed but no summary could be read → ERROR,
  //     unconditionally. The old code scored those lines directly — but
  //     cargo-mutants prints only MISSED mutants by default (see
  //     parseCargoSummary), so a file with 38 caught and 2 missed mutants was
  //     reported as 2 total / 0 killed / "0.00%", failing the gate on a
  //     well-tested file. A parsing problem must surface as a parsing problem;
  //     there is no honest score to be had from these lines. `targetExists` is
  //     deliberately NOT consulted here: the run demonstrably found the file
  //     (it reported on its mutants) and we simply cannot read the totals.
  //  2. Nothing scoreable was reported — no summary AND no result lines, or a
  //     summary whose every bucket is zero. Both spellings mean the same thing
  //     ("cargo-mutants tested nothing"), so they share one disposition, which
  //     turns on whether the target file is actually there:
  //       • target ABSENT → ERROR (noMutantsError). The `--file` glob matched
  //         nothing, or matched the wrong thing; 0/0 would format as "100.00%".
  //       • target PRESENT → a normal zero-mutant result. The file exists and
  //         genuinely has no mutable logic (constants, a `mod.rs` barrel, pure
  //         re-exports). `hasNoMutableLogic` in src/format.ts renders that as
  //         "n/a", NOT as a score — which is only true as long as the result
  //         carries no `scopeNote`, so this path must never set one.
  const summary = parseCargoSummary(stdout);
  if (!summary && lineTotal > 0) {
    throw new Error(
      `cargo-mutants printed ${lineTotal} result line(s) for "${filePath}" but no recognisable ` +
        `summary ('N mutants tested: ...'); Chaos-MCP cannot score this run. Counting the printed ` +
        `lines instead would be wrong: cargo-mutants prints only MISSED mutants by default, so a ` +
        `well-tested file would score 0.00% and fail the gate. This usually means the run was cut ` +
        `short (killed, or output truncated) or cargo-mutants changed its output format.`,
    );
  }

  // No summary and no result lines is arithmetically the same run as an
  // all-zero summary, so it is scored through the same path rather than handled
  // as a separate shape — one place decides what "nothing was tested" means.
  const counts: CargoSummary = summary ?? { caught: 0, missed: 0, unviable: 0, timeout: 0 };
  // `scoreCounts` is what keeps unviable mutants out of the denominator (they
  // were never exercised by a test) and surfaces them via the `incompetent`
  // field instead (base.ts MutationResult contract).
  const scored: ScoredCounts = scoreCounts(counts);
  // Zero SCORED mutants with zero unviable means cargo-mutants tested nothing;
  // with the file absent, that is a targeting failure and must not be scored.
  // The unviable-only run (`5 mutants tested: 5 unviable`) is deliberately NOT
  // an error either way: mutants were generated for the file — so `--file` DID
  // match — none of them compiled, and `incompetent` says so explicitly on the
  // result. That exception is why `scored.incompetent === undefined` is part of
  // the condition and not just `totalMutants === 0`.
  if (scored.totalMutants === 0 && scored.incompetent === undefined && !targetExists) {
    throw noMutantsError(filePath);
  }

  return {
    target: filePath,
    totalMutants: scored.totalMutants,
    killed: scored.killed,
    survived: scored.survived,
    mutationScore: scored.mutationScore,
    vulnerabilities,
    ...(scored.incompetent !== undefined ? { incompetent: scored.incompetent } : {}),
  };
}

/**
 * Mutation testing engine for Rust files.
 *
 * Shells out to `cargo mutants` to generate and evaluate mutants.
 * Requires `cargo-mutants` to be installed: `cargo install cargo-mutants`.
 *
 * Note: Line-level scoping is not supported by cargo-mutants' `--file` flag.
 * The `lineScope` option is silently ignored for Rust targets.
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

    const args = ['mutants', '--file', fileGlob];
    if (jobs > 1) args.push('-j', String(jobs));

    if (isVerbose()) {
      // Log the escaped pattern, i.e. the argument cargo-mutants actually
      // receives — that is the string an operator needs in order to reproduce
      // the run by hand. It is identical to `filePath` for ordinary paths.
      log(`RustEngine: cargo mutants --file "${fileGlob}"${jobs > 1 ? ` -j ${jobs}` : ''}`);
    }

    let stdout: string;
    let stderr: string;

    try {
      const result = await invokeMutationTool('cargo-mutants', 'cargo', args, {
        cwd,
        timeoutMs,
        signal: options?.signal,
        executor: options?.executor,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error: unknown) {
      // Startup failures rethrow; non-ExecFailure errors wrap; otherwise we get
      // a typed ExecFailureError back for the rust-specific handling below.
      const execErr = this.toExecFailure(error, 'cargo-mutants');

      // Non-zero exit: cargo-mutants exits non-zero when mutants survive OR
      // when the baseline `cargo test` itself fails. If stdout is empty we
      // treat it as a baseline failure (no mutants parsed out); otherwise
      // fall through and parse the captured stdout.
      stdout = execErr.stdout;
      stderr = execErr.stderr;

      // Whitespace-only stdout (e.g. a lone "\n" flushed before the run died)
      // carries no mutants either, but is truthy — a bare `!stdout` check would
      // let it through to the text parser and report a useless zero-mutant
      // result instead of the accurate "baseline test suite failed" diagnosis.
      // `!stdout ||` guards the case where stdout is absent entirely.
      if (!stdout || !stdout.trim()) {
        throw new Error(
          `cargo-mutants failed (exit ${execErr.exit}) with no parseable output. ` +
            `This usually means the baseline test suite itself failed \u2014 run \`cargo test\` and fix those first. ` +
            `stderr: ${execErr.stderr?.slice(0, 500) ?? ''}`,
        );
      }
    }

    if (isVerbose() && stderr) {
      log(`cargo-mutants stderr: ${stderr.slice(0, 500)}`);
    }

    // Text only: `run` never asks for structured output (`--output` writes
    // `mutants.out/outcomes.json` to DISK; stdout is always human-readable), so
    // there is nothing to attempt a JSON parse on. The old JSON branch was
    // unreachable, validated a shape `outcomes.json` does not have anyway, and
    // cost a throwaway multi-MB `JSON.parse` on every run (audit L7).
    return parseCargoMutantsText(stdout, filePath, targetExists);
  }
}
