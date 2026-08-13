/**
 * Reading cargo-mutants' text output into a {@link MutationResult}.
 *
 * Pure: given the tool's stdout (plus whether the target file exists, passed in
 * rather than stat'ed) it decides the score, the survivors, and whether the run
 * can be scored at all — no filesystem, no subprocess. The guards here (summary
 * line as the only source of totals, zero-mutant targeting check) are the
 * difference between a real 100% and a run that tested nothing.
 */
import { type MutationResult, formatMutationScore, survivorVulnerability } from '../base.js';
import { escapeCargoFileGlob } from './args.js';

/**
 * Authoritative per-outcome counts extracted from cargo-mutants' final summary
 * line, e.g. "47 mutants tested in 30s: 4 missed, 42 caught, 1 unviable".
 */
export interface CargoSummary {
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
export function parseCargoSummary(stdout: string): CargoSummary | null {
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
export interface ScoredCounts {
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
export function scoreCounts(counts: {
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
export function stripCargoTiming(desc: string): string {
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
 * zero-mutant result instead, which `hasNoMutableLogic` (src/score-semantics.ts) renders
 * as "n/a" — explicitly NOT the same claim as proven coverage.
 */
export function noMutantsError(filePath: string): Error {
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
export function parseCargoMutantsText(
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
        // Deliberately NO `mutated`. cargo-mutants reports no replacement text:
        // its description IS the mutant's name, so storing it a second time as
        // the change made every Rust mutant carry `change: "→ <description>"` —
        // the one-sided form `changeOf` produces when only the mutated half
        // exists. Two things went wrong with that. The report rendered the same
        // string WITHOUT the arrow (a separate formatter, since unified), so the
        // `change` a caller copied out of `changes` never matched the one in
        // suppressions.json and `unsuppress` silently did nothing. And the
        // `changes` array itself was a verbatim duplicate of the `mutators`
        // keys. Both docs describing this ("`change` is absent only for engines
        // that report no replacement (cargo-mutants…)", utils/suppression.ts;
        // "`undefined` when the engine reported neither half — cargo-mutants",
        // utils/mutant-identity.ts) already described the behaviour this line
        // now has: mutator-only identity, which for cargo-mutants loses nothing
        // because the mutator IS the description.
        //
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
  //         re-exports). `hasNoMutableLogic` in src/score-semantics.ts renders that as
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
    // cargo-mutants has no line-scoping mode — `supportsLineScope: false` in
    // engines/registry.ts — so a report from it always enumerated the whole
    // file. Say so structurally instead of leaving readers to infer it from
    // the ABSENCE of a scope note: a whole-file run can still ACQUIRE one
    // (handler.ts appends "diffBase scoping is not supported for rust; mutated
    // the whole file" before the suppression phase), and the transitional
    // `scopeKind === undefined && !scopeNote` fallback reads that note as
    // evidence of scoping. Without this field the orphan counter and the
    // no-mutable-logic verdict both switch themselves off on every `diffBase`
    // run — the case they exist for.
    scopeKind: 'whole-file',
    ...(scored.incompetent !== undefined ? { incompetent: scored.incompetent } : {}),
  };
}
