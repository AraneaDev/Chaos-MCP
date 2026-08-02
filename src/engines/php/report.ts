/**
 * Reading Infection's JSON log into a {@link MutationResult}.
 *
 * Pure: given the log text it decides the score, the survivors, and whether the
 * log can be trusted at all — no filesystem, no subprocess. The guards here
 * (recognised-keys, provenance, totals cross-check) are the difference between
 * a real 100% and a log this parser silently failed to read.
 */
import {
  type MutationResult,
  type Vulnerability,
  formatMutationScore,
  survivorVulnerability,
} from '../base.js';
import { warn } from '../../utils/logger.js';

/** One mutant entry in Infection's JSON log. */
interface InfectionMutant {
  mutator?: { mutatorName?: string; originalFilePath?: string; originalStartLine?: number };
  diff?: string;
}
interface InfectionJsonLog {
  stats?: {
    totalMutantsCount?: number;
    killedCount?: number;
    /**
     * Infection 0.31+ splits kills: `killedCount` became tests-only and static
     * analysis kills are counted separately here. Absent before 0.31, where
     * `killedCount` was already the total.
     */
    killedByStaticAnalysisCount?: number;
    escapedCount?: number;
    timeOutCount?: number;
    timedOutCount?: number;
    /** Counts we do not score from, read only by the totals cross-check below. */
    notCoveredCount?: number;
    errorCount?: number;
    syntaxErrorCount?: number;
    skippedCount?: number;
    ignoredCount?: number;
  };
  escaped?: InfectionMutant[];
  killed?: InfectionMutant[];
  /** Mutants a static analyser killed rather than the test suite (0.31+). */
  killedByStaticAnalysis?: InfectionMutant[];
  timeouted?: InfectionMutant[];
  timedOut?: InfectionMutant[];
  /**
   * Mutants on lines no test covers — an actionable coverage hole, not a pass.
   *
   * `uncovered` is Infection's REAL key name for this list: its JSON reporter
   * emits `'uncovered' => …` at both ends of {@link SUPPORTED_INFECTION_RANGE}
   * (0.27's `JsonLogger`, 0.34's `JsonReporter`). `notCovered` is a tolerated
   * alias only, kept so hand-written or legacy logs still parse — note that
   * `stats.notCoveredCount` above IS a real Infection key and unrelated to this
   * spelling.
   */
  uncovered?: InfectionMutant[];
  /** Tolerated alias for {@link InfectionJsonLog.uncovered}; not a key Infection emits. */
  notCovered?: InfectionMutant[];
  /** Mutants whose run crashed before producing a pass/fail — unscoreable. */
  errored?: InfectionMutant[];
}

/**
 * Infection releases whose JSON-log key names this parser was written against.
 * Named in the "unrecognised log" error so a reader knows what to check.
 *
 * The binary is NOT under our control in native mode — `run` takes the audited
 * project's `vendor/bin/infection`, or a global `infection` from PATH; the
 * `0.34.0` pin in `containers/php/composer.json` covers container runs only.
 */
const SUPPORTED_INFECTION_RANGE = '0.27–0.34';

/**
 * `stats` keys that prove the log is a shape this parser understands. Only keys
 * we actually READ count — recognising a name we would ignore is not evidence
 * that the numbers we do read are there.
 */
const RECOGNISED_STAT_KEYS = [
  'totalMutantsCount',
  'killedCount',
  'escapedCount',
  'timeOutCount',
  'timedOutCount',
] as const;

/** Result lists this parser knows how to read. */
const RECOGNISED_MUTANT_LISTS = [
  'escaped',
  'killed',
  'killedByStaticAnalysis',
  'timeouted',
  'timedOut',
  'uncovered',
  'notCovered',
  'errored',
] as const;

/** Cap on how many key names an error message quotes back. */
const MAX_QUOTED_KEYS = 12;

/** Render the keys a rejected log actually carried, for the error message. */
function describeLogKeys(parsed: unknown): string {
  if (typeof parsed !== 'object' || parsed === null) {
    return `a JSON ${parsed === null ? 'null' : typeof parsed}, not an object`;
  }
  if (Array.isArray(parsed)) return 'a JSON array, not an object';
  const quote = (keys: string[]): string =>
    keys.length > MAX_QUOTED_KEYS
      ? `${keys.slice(0, MAX_QUOTED_KEYS).join(', ')}, …`
      : keys.join(', ');
  const obj = parsed as Record<string, unknown>;
  const top = Object.keys(obj);
  const stats = obj.stats;
  const statKeys =
    typeof stats === 'object' && stats !== null && !Array.isArray(stats)
      ? Object.keys(stats as Record<string, unknown>)
      : null;
  const topPart = top.length > 0 ? `[${quote(top)}]` : '[] (empty object)';
  return statKeys === null ? topPart : `${topPart}, stats: [${quote(statKeys)}]`;
}

/**
 * Require POSITIVE evidence that this log is one we can score, and return it
 * narrowed.
 *
 * WHY this exists: `JSON.parse` only proves the bytes are syntactically JSON.
 * Past that, every field read below fails SOFT — `Array.isArray(...) ? ... : []`
 * and `stats.killedCount ?? …`. A log that parses but names its results
 * something this parser has never heard of therefore produced killed 0 /
 * survived 0 / total 0, and `formatMutationScore(0, 0)` turns that into a
 * confident `"100.00%"` (see base.ts — total 0 → 100% is load-bearing
 * downstream). Infection killing 40 of 50 mutants would be reported as a clean
 * file. `assertLogDescribes` cannot catch it either: with no entries there are
 * no recorded paths, so it returns early by design.
 *
 * This is not a hypothetical drift: the scorer below already carries a
 * workaround for one such rename (`timeOutCount` ⇄ `timedOutCount`), which is
 * direct evidence that Infection has restructured these keys before.
 *
 * Evidence is deliberately strict about emptiness — an empty array is not proof
 * that the parser understood anything, since `{"stats":{},"escaped":[]}` is
 * exactly the shape a total rename degrades to. A real Infection run always
 * emits its `stats` counts (zeroes included), so a genuinely mutant-free file
 * still passes on `stats` alone.
 */
function requireRecognisedLog(parsed: unknown, filePath: string): InfectionJsonLog {
  const obj =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  const stats =
    obj !== undefined &&
    typeof obj.stats === 'object' &&
    obj.stats !== null &&
    !Array.isArray(obj.stats)
      ? (obj.stats as Record<string, unknown>)
      : undefined;
  const hasStatEvidence =
    stats !== undefined && RECOGNISED_STAT_KEYS.some((k) => Number.isFinite(stats[k]));
  const hasListEvidence =
    obj !== undefined &&
    RECOGNISED_MUTANT_LISTS.some((k) => Array.isArray(obj[k]) && (obj[k] as unknown[]).length > 0);

  if (hasStatEvidence || hasListEvidence) return obj as InfectionJsonLog;

  throw new Error(
    `Infection's JSON log has no recognised result keys — Chaos-MCP supports Infection ` +
      `${SUPPORTED_INFECTION_RANGE}; got keys: ${describeLogKeys(parsed)}. Either the log is not ` +
      `Infection's (or was truncated mid-write), or this Infection release renamed them. Scoring it ` +
      `anyway would report ${filePath} as a confident 100.00% for zero mutants actually read.`,
  );
}

/**
 * Reject a log that demonstrably describes some other file.
 *
 * `--filter` scopes the run to one file, so every mutant Infection records
 * should sit in it. When none do, the log did not come from this run — the
 * observed case being a stale `chaos-infection-log.json` copied into the
 * sandbox with the workspace and read after Infection failed to start, which
 * reported another file's hours-old mutants as a fresh 100% score.
 *
 * Paths are compared by suffix because the log records absolute sandbox paths
 * while the audit target is workspace-relative. Mutants with no recorded path
 * cannot contradict anything, so a log carrying none is left alone rather than
 * made unusable.
 *
 * EVERY list the parser consumes is fed in, not just `escaped`/`killed`: a file
 * with no coverage at all yields a log whose only entries are `uncovered`, and
 * those now become reported vulnerabilities — so they need the same provenance
 * check. Feeding more lists in can only ever help a genuine log (the match is
 * `.some`), while giving the stale-log guard something to work with in cases
 * where it previously returned early with nothing recorded.
 */
function assertLogDescribes(filePath: string, mutants: InfectionMutant[]): void {
  const recorded = mutants
    .map((m) => m.mutator?.originalFilePath)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => p.replace(/\\/g, '/'));
  if (recorded.length === 0) {
    return;
  }
  const target = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (recorded.some((p) => p === target || p.endsWith(`/${target}`))) {
    return;
  }
  throw new Error(
    `Infection's JSON log describes a different file than the one audited (${filePath}); ` +
      `its mutants belong to ${recorded[0]}. The log is stale or left over from another run, ` +
      `so no result can be reported for ${filePath}.`,
  );
}

/**
 * Cross-check what this parser accounted for against Infection's own
 * `stats.totalMutantsCount`, and `warn()` when they disagree.
 *
 * The recognised-keys guard above proves we understood SOMETHING; this proves we
 * understood all of it. A partial rename — say `escaped` becomes `survived`
 * while `stats.killedCount` keeps its name — passes the guard and still scores,
 * because every list read fails soft to `[]`. The one number that notices is
 * Infection's own total, so the gap between it and the outcomes we could read is
 * reported rather than silently absorbed into the score.
 *
 * `syntaxErrorCount`/`skippedCount`/`ignoredCount` are added to the accounted
 * side even though nothing is done with them: they are legitimately part of
 * Infection's total (a project can `ignore` mutators by config), and counting
 * them keeps the check from crying wolf on a perfectly well-read log.
 *
 * A warning, not a throw: the score is still the best reading of what the log
 * contained, and refusing the whole audit over a totals gap would be a harsher
 * failure than the unrecognised-log case it descends from.
 */
function crossCheckTotals(
  filePath: string,
  stats: NonNullable<InfectionJsonLog['stats']>,
  read: { killed: number; survived: number; noCoverage: number; incompetent: number },
): void {
  const reported = stats.totalMutantsCount;
  if (!Number.isFinite(reported)) return;
  const declaredButUnscored =
    (stats.syntaxErrorCount ?? 0) + (stats.skippedCount ?? 0) + (stats.ignoredCount ?? 0);
  const accounted =
    read.killed + read.survived + read.noCoverage + read.incompetent + declaredButUnscored;
  if (accounted === reported) return;
  warn(
    `${filePath}: Infection's JSON log reports ${String(reported)} mutant(s) in total but this parser ` +
      `accounted for ${accounted} (killed ${read.killed}, survived ${read.survived}, ` +
      `no-coverage ${read.noCoverage}, errored ${read.incompetent}, declared-but-unscored ` +
      `${declaredButUnscored}). The score covers only the outcomes it could read — a gap usually ` +
      `means this Infection release renamed a result key (Chaos-MCP supports ` +
      `${SUPPORTED_INFECTION_RANGE}).`,
  );
}

/**
 * Parse Infection's `logs.json` output into a MutationResult.
 *
 * `escaped` mutants are the reported survivors (real coverage gaps). Timed-out
 * mutants are counted as killed (the suite detected them by hanging).
 *
 * The two remaining outcomes are NOT interchangeable, and this parser used to
 * drop both on the floor — no count, no note, no explanation of why
 * `totalMutants` was smaller than the run Infection actually did:
 *
 *  - `errored` — the mutated code crashed before producing a pass/fail. That is
 *    exactly `MutationResult.incompetent` as base.ts defines it ("the tool could
 *    not score … excluded from the denominator"), so it is reported there and
 *    stays out of the score, mirroring cosmic-ray's `incompetent` and
 *    cargo-mutants' `unviable`.
 *  - `uncovered` — no test covers the line. Nothing failed; the suite simply
 *    never looked. That is an ACTIONABLE COVERAGE HOLE, not an unscoreable
 *    mutant, and it is precisely what the TypeScript engine reports as Stryker's
 *    `NoCoverage`: a vulnerability with `kind: 'noCoverage'`, unkilled and
 *    therefore inside the denominator. Filing it under `incompetent` instead
 *    would recreate this file's own false-100% failure mode — a PHP file with no
 *    tests at all has ONLY `uncovered` mutants, so killed 0 / survived 0 /
 *    total 0 renders as `"100.00%"` for a completely untested file. (`uncovered`
 *    is the key Infection actually emits; `notCovered` is read as a tolerated
 *    alias for hand-written or legacy logs.)
 *
 * Consequently `vulnerabilities` is survivors + no-coverage while `survived`
 * counts survivors only, which is the same shape `triage.ts` already derives its
 * `noCoverage` figure from (`vulnerabilities.length - survived`) and the shape
 * `applySuppressions` assumes when it subtracts a suppressed mutant from
 * `totalMutants`.
 *
 * Field names read defensively (stats when present, array lengths as fallback;
 * `timeOutCount`/`timedOutCount` and `timeouted`/`timedOut` both tolerated) so a
 * minor Infection version bump does not silently zero the count — but only
 * AFTER {@link requireRecognisedLog} has established that the log is one we
 * understand at all, because those same fallbacks are what turn a wholesale
 * rename into a confident 100%.
 */
export function parseInfectionJsonLog(logText: string, filePath: string): MutationResult {
  let raw: unknown;
  try {
    raw = JSON.parse(logText);
  } catch {
    throw new Error(
      `Infection produced an unparseable JSON log for ${filePath}. The mutation run likely did not complete ` +
        `(check that the PHPUnit suite runs and a coverage driver — Xdebug or PCOV — is enabled).`,
    );
  }
  const parsed = requireRecognisedLog(raw, filePath);

  const escaped = Array.isArray(parsed.escaped) ? parsed.escaped : [];
  const killedArr = Array.isArray(parsed.killed) ? parsed.killed : [];
  const killedByStaticAnalysisArr = Array.isArray(parsed.killedByStaticAnalysis)
    ? parsed.killedByStaticAnalysis
    : [];
  // `uncovered` is Infection's own key; `notCovered` is a tolerated alias.
  const notCovered = Array.isArray(parsed.uncovered)
    ? parsed.uncovered
    : Array.isArray(parsed.notCovered)
      ? parsed.notCovered
      : [];
  const erroredArr = Array.isArray(parsed.errored) ? parsed.errored : [];

  const timedOutArr = Array.isArray(parsed.timeouted)
    ? parsed.timeouted
    : Array.isArray(parsed.timedOut)
      ? parsed.timedOut
      : [];

  assertLogDescribes(filePath, [
    ...escaped,
    ...killedArr,
    ...killedByStaticAnalysisArr,
    ...notCovered,
    ...erroredArr,
    ...timedOutArr,
  ]);

  // L5: `survived`/`totalMutants` must stay consistent with `vulnerabilities`,
  // which is built only from `escaped`. `escaped.length` is therefore the
  // source of truth — reading `stats.escapedCount` independently could
  // (on a stats/array mismatch from an Infection version skew) report a
  // survivor count and score that contradict the emitted `vulnerabilities`.
  // The same rule now extends to the no-coverage list: its entries are emitted
  // as no-coverage vulnerabilities, so the array — never `stats.notCoveredCount`
  // — is what the denominator is built from.
  const stats = parsed.stats ?? {};
  const survived = escaped.length;
  const noCoverage = notCovered.length;
  const timeouts = stats.timeOutCount ?? stats.timedOutCount ?? timedOutArr.length;
  // Infection 0.31+ counts static-analysis kills separately from `killedCount`
  // (which became tests-only). They drive no reported output, so the stat wins
  // with the array as fallback — the same shape as `timeouts` above. Pre-0.31
  // logs have neither, so this contributes 0 and `killedCount` stays the total.
  const killedByStaticAnalysis =
    stats.killedByStaticAnalysisCount ?? killedByStaticAnalysisArr.length;
  const killed = (stats.killedCount ?? killedArr.length) + killedByStaticAnalysis + timeouts;
  // No-coverage mutants are unkilled and in the denominator (as in the
  // TypeScript engine); `errored` mutants leave it entirely.
  const totalMutants = killed + survived + noCoverage;
  const incompetent = erroredArr.length;

  const vulnerabilities: Vulnerability[] = [
    ...escaped.map((e) =>
      survivorVulnerability(
        e.mutator?.originalStartLine ?? 0,
        e.mutator?.mutatorName ?? 'PHP Mutation Operator',
        'PHP',
        { mutated: e.diff ? e.diff.trim() : undefined },
      ),
    ),
    // Wording deliberately identical to the TypeScript engine's NoCoverage
    // sentence: `utils/no-coverage.ts` still falls back to matching the prose
    // for a `Vulnerability` built without a `kind`.
    ...notCovered.map((m): Vulnerability => {
      const vuln: Vulnerability = {
        line: m.mutator?.originalStartLine ?? 0,
        mutator: m.mutator?.mutatorName ?? 'PHP Mutation Operator',
        kind: 'noCoverage',
        description: `No test reached this line (NoCoverage). Consider adding tests covering this branch.`,
      };
      if (m.diff) vuln.mutated = m.diff.trim();
      return vuln;
    }),
  ];

  crossCheckTotals(filePath, stats, { killed, survived, noCoverage, incompetent });

  return {
    target: filePath,
    totalMutants,
    killed,
    survived,
    mutationScore: formatMutationScore(killed, totalMutants),
    vulnerabilities,
    // Absent rather than 0 when nothing errored, matching the Rust engine — a
    // present-but-zero field reads as "the tool reported this" to consumers
    // that only check for the key.
    ...(incompetent > 0 ? { incompetent } : {}),
  };
}
