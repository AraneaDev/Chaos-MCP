import { writeFileSync, existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  BaseEngine,
  RunOptions,
  MutationResult,
  Vulnerability,
  formatMutationScore,
  survivorVulnerability,
} from './base.js';
import { invokeMutationTool } from '../utils/exec-classify.js';
import type { ExecFailureError } from '../utils/exec-error.js';
import { log, isVerbose, warn } from '../utils/logger.js';
import { DEFAULT_TIMEOUT_MS } from '../utils/constants.js';

/** Name of the config we generate when the project ships none. */
const GENERATED_CONFIG_NAME = 'infection.json';
/** Config files Infection already recognises — if present, we do NOT overwrite. */
const PROJECT_CONFIG_NAMES = ['infection.json', 'infection.json5'];
/**
 * PHPUnit configuration files Infection looks for at the project root. Our
 * generated config targets PHPUnit, so when none of these exist Infection has
 * no test runner to drive — a project using a different or custom runner.
 */
const PHPUNIT_CONFIG_NAMES = [
  'phpunit.xml',
  'phpunit.xml.dist',
  'phpunit.dist.xml',
  'phpunit.yml',
  'phpunit.yml.dist',
  'phpunit.dist.yml',
  'phpunit.php',
];
/** Sandbox-relative JSON log path we always read results from. */
const JSON_LOG_NAME = 'chaos-infection-log.json';

/**
 * Top path segment of the audit target, used as the generated config's
 * `source.directories` root (hybrid fallback only — a project shipping its own
 * infection.json keeps it).
 *
 * NORMALISE BEFORE SLICING. Taking `indexOf('/')` on the raw path answered `"."`
 * for two shapes callers actually pass: `./src/Calculator.php` (first slash at
 * index 1, so the slice is the literal `"."`) and an absolute
 * `/sandbox/src/Calculator.php` (first slash at index 0, which the `slash > 0`
 * guard rejects). `"."` is not a harmless default here: it tells Infection the
 * ENTIRE project tree is mutable source, which pulls in `tests/` and the
 * `vendor/` that dependency-dirs.ts links into the sandbox — the same
 * over-broad coverage scope this file diagnoses at
 * {@link diagnoseInfectionStartupFailure} case (2).
 *
 * `assertLogDescribes` already normalised a leading `./` on the very same
 * input, so before this fix two functions in this file disagreed about what
 * `./src/X.php` meant.
 *
 * Order of preference:
 *  1. the first segment of the (normalised, cwd-relative) path — `src`;
 *  2. failing that, the file's OWN directory, which is still narrower than the
 *     project root — an absolute target outside `cwd` lands here;
 *  3. `"."` only when there is genuinely nothing better: a root-level file, or
 *     a directory that is a bare ancestor chain (`../..`), which would be
 *     BROADER than the project root rather than narrower.
 *
 * @param cwd — the directory the generated `infection.json` is written to and
 *   that Infection resolves `source.directories` against (the sandbox), so an
 *   absolute target is expressed relative to it.
 */
export function inferSourceDir(filePath: string, cwd: string = process.cwd()): string {
  const toPosix = (p: string): string => p.replace(/\\/g, '/');
  // Strip any number of leading `./` segments: `./src/X.php` and `././src/X.php`
  // both denote `src/X.php`.
  const norm = toPosix(filePath).replace(/^(?:\.\/)+/, '');
  // Windows drive letters count as absolute too, so `C:/sb/src/X.php` is not
  // mistaken for a relative path whose first segment is `C:`.
  const isAbs = /^(?:[A-Za-z]:)?\//.test(norm);
  const rel = isAbs ? toPosix(relative(toPosix(cwd), norm)) : norm;

  const slash = rel.indexOf('/');
  const first = slash > 0 ? rel.slice(0, slash) : '';
  // `..` is an ancestor, not a source root; `.` is the project-root default we
  // are trying to avoid.
  if (first !== '' && first !== '.' && first !== '..') return first;

  // Fall back to the file's own directory rather than the project root. A path
  // with no separator at all (`Calculator.php`) has no directory — `slice` on a
  // -1 index would silently chop its last character instead.
  const lastSlash = rel.lastIndexOf('/');
  const dir = lastSlash > 0 ? rel.slice(0, lastSlash) : lastSlash === 0 ? '/' : '';
  const usable =
    dir !== '' &&
    dir !== '.' &&
    !/^(?:[A-Za-z]:)?\//.test(dir) && // still absolute → not expressible as a source root
    dir.split('/').some((seg) => seg !== '..'); // pure `../..` is broader than `.`
  return usable ? dir : '.';
}

/** Build a minimal Infection config for a bare PHPUnit project (hybrid fallback). */
export function buildInfectionConfig(sourceDir: string, jsonLogName: string): string {
  return (
    JSON.stringify(
      {
        source: { directories: [sourceDir] },
        testFramework: 'phpunit',
        logs: { json: jsonLogName },
      },
      null,
      2,
    ) + '\n'
  );
}

/** How much of each stream to echo back when Infection dies before logging. */
const DIAGNOSTIC_TAIL_CHARS = 2000;

/**
 * Build the operator-facing diagnostic tail for an Infection run that failed
 * before writing its JSON log.
 *
 * Infection reports startup failures — "Project tests must be in a passing
 * state", the PHPUnit exit code, and the wrapped PHPUnit STDOUT/STDERR — on its
 * OWN STDOUT, not stderr. Reporting only `stderr` (as this engine used to) left
 * every such failure ending in a bare "stderr:" with nothing after it, so the
 * real cause (a failing test, a coverage-scope warning tripping PHPUnit's
 * stopOnDefect, a killed process) was invisible and the caller was left with
 * only the generic "ensure the suite passes" guess.
 *
 * The tail — not the head — carries the cause: Infection's banner and the test
 * progress dots come first, and the error block is emitted last.
 */
export function infectionDiagnostics(err: { stdout?: string; stderr?: string }): string {
  const tail = (s: string | undefined): string => {
    const text = (s ?? '').trimEnd();
    return text.length > DIAGNOSTIC_TAIL_CHARS ? `…${text.slice(-DIAGNOSTIC_TAIL_CHARS)}` : text;
  };
  const parts: string[] = [];
  const out = tail(err.stdout);
  const errOut = tail(err.stderr);
  // Infection's own error block lives on stdout, so surface it first.
  if (out) parts.push(`Infection output (tail):\n${out}`);
  if (errOut) parts.push(`stderr (tail):\n${errOut}`);
  return parts.length > 0
    ? parts.join('\n\n')
    : '(Infection produced no output on stdout or stderr.)';
}

/**
 * Recognise the two Infection startup failures whose symptom is indistinguishable
 * from "your test suite is broken" but whose cause is neither the suite nor the
 * coverage driver. Both are specific to running Infection with `--filter`, which
 * is how this engine always runs it, so both are reachable on a project whose
 * suite passes perfectly under a plain `vendor/bin/phpunit`.
 *
 * Returns the actionable explanation, or null when the failure is not one of
 * these and the generic guidance should stand.
 */
export function diagnoseInfectionStartupFailure(output: string): string | null {
  // (1) Infection's InitialTestsRunner passes a callback to Symfony's
  //     Process::run that calls `$process->stop()` as soon as the type is
  //     Process::ERR — i.e. on the FIRST byte the test process writes to
  //     STDERR, regardless of whether any test failed. PHPUnit is SIGTERMed
  //     mid-suite and Infection reports the resulting exit code 143 under its
  //     "Project tests must be in a passing state" banner.
  if (/exit code of 143/.test(output)) {
    return (
      `Infection terminated the initial test run itself: it stops the test process on the first byte ` +
      `written to STDERR (Symfony Process::ERR), and PHPUnit then exits 143 (SIGTERM). The suite is ` +
      `probably fine — something it runs writes to STDERR. Find it with ` +
      `\`vendor/bin/phpunit 2>/tmp/suite.err\` and make those writes go to an injectable stream that ` +
      `tests can capture, so the suite emits nothing on STDERR.`
    );
  }

  // (2) `--filter=<file>` makes Infection generate an initial-run PHPUnit config
  //     whose <source> is narrowed to that one file. Every coverage-target
  //     attribute (#[CoversClass] and friends) pointing outside it becomes
  //     invalid, PHPUnit emits a warning, and Infection's own injected
  //     stopOnDefect="true" halts the suite.
  if (/is not a valid target for code coverage/.test(output)) {
    return (
      `PHPUnit stopped on a coverage-scope warning, not on a real test failure. Running Infection with ` +
      `\`--filter\` narrows the generated initial-run config's <source> to the single target file, which ` +
      `invalidates every #[CoversClass]/#[UsesClass] attribute pointing elsewhere; Infection injects ` +
      `stopOnDefect="true" into that same config, so the first such warning aborts the suite. Remove the ` +
      `coverage-target attributes from the test suite (or stop using --filter).`
    );
  }

  return null;
}

/**
 * True when a PHPUnit configuration makes a warning fail the run.
 *
 * Only the root element counts, and comments are stripped first: a config that
 * merely *mentions* the attribute — the shape one acquires right after reading
 * about this trap — does not have it set.
 */
export function phpunitFailsOnWarning(configXml: string): boolean {
  const root = /<phpunit\b[^>]*>/i.exec(configXml.replace(/<!--[\s\S]*?-->/g, ''));
  return root !== null && /\bfailOnWarning\s*=\s*(["'])true\1/i.test(root[0]);
}

/**
 * The advisory attached to a PHP result that reports survivors while the
 * project's PHPUnit config lets warnings pass.
 *
 * Infection sets `stopOnDefect="true"` in the config it writes for each mutant,
 * so the suite halts as soon as a mutant proves itself killed. That is sound
 * only while a defect also means a non-zero exit code. A PHP warning is a
 * defect for `stopOnDefect` but is not a failure under `failOnWarning="false"`,
 * so a mutant whose effect makes an *earlier* test warn stops the run with exit
 * 0 — and Infection records it as escaped without ever reaching the test that
 * asserts the mutated behaviour.
 *
 * Measured on Knossos-MCP: one such mutant halted the suite after 86 of 1,858
 * tests, and the file reported ten survivors at 96%. With `failOnWarning="true"`
 * the same file reports zero survivors at 100% — every one had been a phantom.
 *
 * The error is one-directional: scores are depressed, never inflated. That
 * makes it expensive rather than dangerous, because it sends a reader off
 * writing tests for mutants their suite already kills.
 */
export const WARNING_FIDELITY_NOTE =
  'Survivors may be overstated: this project\'s PHPUnit config does not set failOnWarning="true". ' +
  'Infection sets stopOnDefect="true" for each mutant, so a mutant whose effect makes an earlier ' +
  'test emit a PHP warning halts the suite with exit 0 and is recorded as escaped before the test ' +
  'that would assert the change ever runs. Confirm a survivor by applying its mutation by hand and ' +
  'running the covering test file; if that fails, set failOnWarning="true" and re-audit.';

/** One mutant entry in Infection's JSON log. */
interface InfectionMutant {
  mutator?: { mutatorName?: string; originalFilePath?: string; originalStartLine?: number };
  diff?: string;
}
interface InfectionJsonLog {
  stats?: {
    totalMutantsCount?: number;
    killedCount?: number;
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
  timeouted?: InfectionMutant[];
  timedOut?: InfectionMutant[];
  /** Mutants on lines no test covers — an actionable coverage hole, not a pass. */
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
  'timeouted',
  'timedOut',
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
 * with no coverage at all yields a log whose only entries are `notCovered`, and
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
 *  - `notCovered` — no test covers the line. Nothing failed; the suite simply
 *    never looked. That is an ACTIONABLE COVERAGE HOLE, not an unscoreable
 *    mutant, and it is precisely what the TypeScript engine reports as Stryker's
 *    `NoCoverage`: a vulnerability with `kind: 'noCoverage'`, unkilled and
 *    therefore inside the denominator. Filing it under `incompetent` instead
 *    would recreate this file's own false-100% failure mode — a PHP file with no
 *    tests at all has ONLY `notCovered` mutants, so killed 0 / survived 0 /
 *    total 0 renders as `"100.00%"` for a completely untested file.
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
  const notCovered = Array.isArray(parsed.notCovered) ? parsed.notCovered : [];
  const erroredArr = Array.isArray(parsed.errored) ? parsed.errored : [];

  const timedOutArr = Array.isArray(parsed.timeouted)
    ? parsed.timeouted
    : Array.isArray(parsed.timedOut)
      ? parsed.timedOut
      : [];

  assertLogDescribes(filePath, [
    ...escaped,
    ...killedArr,
    ...notCovered,
    ...erroredArr,
    ...timedOutArr,
  ]);

  // L5: `survived`/`totalMutants` must stay consistent with `vulnerabilities`,
  // which is built only from `escaped`. `escaped.length` is therefore the
  // source of truth — reading `stats.escapedCount` independently could
  // (on a stats/array mismatch from an Infection version skew) report a
  // survivor count and score that contradict the emitted `vulnerabilities`.
  // The same rule now extends to `notCovered`: its entries are emitted as
  // no-coverage vulnerabilities, so the array — never `stats.notCoveredCount` —
  // is what the denominator is built from.
  const stats = parsed.stats ?? {};
  const survived = escaped.length;
  const noCoverage = notCovered.length;
  const timeouts = stats.timeOutCount ?? stats.timedOutCount ?? timedOutArr.length;
  const killed = (stats.killedCount ?? killedArr.length) + timeouts;
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

/**
 * Prepare the sandbox so an Infection run's output is unambiguously its own.
 *
 * Three pieces of side-effect setup, all of which must happen before the CLI is
 * invoked:
 *  1. Delete any `chaos-infection-log.json` copied in with the workspace.
 *  2. Hybrid config: write a minimal `infection.json` only when the project
 *     ships none.
 *  3. Create a per-run temp directory to point TMPDIR/TMP/TEMP at.
 *
 * @returns `hasProjectConfig` (drives the failure diagnosis and the log-read
 *   hint), the absolute `jsonLogPath` to read results from, and the `env` to
 *   run Infection with.
 * @throws only when the generated config cannot be written — without it
 *   Infection has nothing to run.
 */
function prepareInfectionWorkspace(
  cwd: string,
  filePath: string,
): { hasProjectConfig: boolean; jsonLogPath: string; env: NodeJS.ProcessEnv } {
  const jsonLogPath = join(cwd, JSON_LOG_NAME);

  // The sandbox is a copy of the workspace, so an earlier audit's
  // `chaos-infection-log.json` is copied in along with it. The failure path
  // below treats "a log exists" as proof that Infection ran, so a stale copy
  // silently stood in for a run that never happened — auditing one file
  // returned a hours-old 100% score computed for a different file entirely.
  // Removing it first makes any log read below necessarily this run's output.
  try {
    rmSync(jsonLogPath, { force: true });
  } catch {
    // Best-effort. If the stale log cannot be removed, the provenance check in
    // parseInfectionJsonLog is the remaining guard against reporting it.
  }

  // Hybrid config: only generate when the project ships none.
  const hasProjectConfig = PROJECT_CONFIG_NAMES.some((n) => existsSync(join(cwd, n)));
  if (!hasProjectConfig) {
    try {
      writeFileSync(
        join(cwd, GENERATED_CONFIG_NAME),
        // `cwd` is the sandbox: the directory this config is written to, and the
        // one Infection resolves `source.directories` against.
        buildInfectionConfig(inferSourceDir(filePath, cwd), JSON_LOG_NAME),
        'utf8',
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to write generated infection.json: ${message}`);
    }
  }

  // Isolate Infection's working files per run. Infection (and the phpunit it
  // spawns) write to `sys_get_temp_dir()/infection` — a FIXED shared path. Two
  // concurrent runs (e.g. a parallel `triage_test_coverage` sweep, each in its
  // own sandbox) clobber each other there: one run's phpunit ends up loading a
  // DIFFERENT sandbox's Composer autoloader and dies with
  // `Cannot declare class ComposerAutoloaderInit… already in use`, failing the
  // initial test run. Pointing TMPDIR/TMP/TEMP at a per-run dir inside the
  // sandbox gives each run its own `sys_get_temp_dir()`, so they never collide.
  const infectionTmp = join(cwd, '.chaos-infection-tmp');
  try {
    mkdirSync(infectionTmp, { recursive: true });
  } catch {
    // Best-effort: if we can't create it, fall through and let Infection use
    // its default temp dir (the pre-existing single-run behaviour).
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: infectionTmp,
    TMP: infectionTmp,
    TEMP: infectionTmp,
  };

  return { hasProjectConfig, jsonLogPath, env };
}

/**
 * Explain an Infection run that exited non-zero WITHOUT producing a JSON log.
 *
 * A non-zero exit alone is normal (mutants escaped); a non-zero exit with no
 * log means the initial coverage run never completed. Returns — rather than
 * throws — the error to raise, so each branch is assertable directly.
 *
 * The three branches are ordered most-specific-first, and that order decides
 * which explanation a user sees:
 *  1. we generated the config (so it targets PHPUnit) and the project has no
 *     PHPUnit config at all → Infection could never have run;
 *  2. a named startup failure recognised in Infection's own output
 *     (see {@link diagnoseInfectionStartupFailure});
 *  3. the generic "make the suite pass, enable a coverage driver" guidance.
 */
export function explainMissingJsonLog(
  execErr: ExecFailureError,
  cwd: string,
  hasProjectConfig: boolean,
): Error {
  // When we generated the config (no project Infection config), it targets
  // PHPUnit. If the project ships no PHPUnit configuration at all, Infection
  // can never run — report that specific, actionable cause instead of the
  // generic coverage-driver hint. (A project with its own Infection config
  // may deliberately target a different framework, so this only applies to
  // the generated-config path.)
  const hasPhpUnitConfig = PHPUNIT_CONFIG_NAMES.some((n) => existsSync(join(cwd, n)));
  if (!hasProjectConfig && !hasPhpUnitConfig) {
    return new Error(
      `Infection could not run: no PHPUnit configuration found (looked for ` +
        `${PHPUNIT_CONFIG_NAMES.join(', ')}). Chaos-MCP's PHP engine drives Infection, which ` +
        `requires PHPUnit; this project appears to use a different or custom test runner. Add a ` +
        `phpunit.xml, or ship an Infection config (${PROJECT_CONFIG_NAMES.join('/')}) that ` +
        `targets your framework.\n${infectionDiagnostics(execErr)}`,
    );
  }
  // Infection reports startup failures on its own STDOUT, so the specific
  // cause — when there is one we can name — is found there.
  const specific = diagnoseInfectionStartupFailure(
    `${execErr.stdout ?? ''}\n${execErr.stderr ?? ''}`,
  );
  if (specific !== null) {
    return new Error(
      `Infection failed (exit ${execErr.exit}) without producing a JSON log. ` +
        `${specific}\n${infectionDiagnostics(execErr)}`,
    );
  }
  return new Error(
    `Infection failed (exit ${execErr.exit}) without producing a JSON log. This usually means ` +
      `the initial test run failed — ensure the PHPUnit suite passes (vendor/bin/phpunit) and a ` +
      `coverage driver (Xdebug or PCOV) is enabled.\n${infectionDiagnostics(execErr)}`,
  );
}

/**
 * Mutation testing engine for PHP files, backed by the Infection CLI.
 *
 * Flow (inside the sandbox `workDir`): hybrid config (use the project's
 * infection.json/.json5 if present, else write a minimal one whose `logs.json`
 * points at our JSON log) → run
 * `infection --filter=<file> --no-progress --no-interaction --threads=<n|max>`
 * → read + parse the JSON log emitted via config `logs.json`. (Infection 0.34+
 * removed the `--logger-json` CLI flag, so the log path lives in the config.)
 *
 * Coarse: no line scoping (`supportsLineScope: false`). Requires a coverage
 * driver (Xdebug or PCOV); a missing driver surfaces as the baseline error below.
 */
export class PhpEngine extends BaseEngine {
  async run(filePath: string, options?: RunOptions): Promise<MutationResult> {
    const cwd = options?.workDir ?? process.cwd();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const { hasProjectConfig, jsonLogPath, env } = prepareInfectionWorkspace(cwd, filePath);

    // Prefer the vendored binary; fall back to a global `infection` on PATH.
    const vendored = join(cwd, 'vendor', 'bin', 'infection');
    const bin = existsSync(vendored) ? './vendor/bin/infection' : 'infection';

    const threads =
      options?.phpThreads ?? (options?.concurrency ? String(options.concurrency) : 'max');
    // NOTE: the detailed JSON log is configured via the config file's `logs.json`
    // (see buildInfectionConfig), NOT a CLI flag. Infection 0.34 removed the
    // `--logger-json` option — passing it aborts the run with
    // `The "--logger-json" option does not exist.` The full mutation-detail log
    // this engine parses is only obtainable through config `logs.json`; the CLI
    // only exposes summary/gitlab/html/text loggers.
    const args = [
      `--filter=${filePath}`,
      '--no-progress',
      '--no-interaction',
      `--threads=${threads}`,
    ];
    if (options?.phpTestFrameworkOptions) {
      args.push(`--test-framework-options=${options.phpTestFrameworkOptions}`);
    }

    if (isVerbose()) log(`PhpEngine: ${bin} ${args.join(' ')}`);

    let stderr = '';
    try {
      const res = await invokeMutationTool('Infection', bin, args, {
        cwd,
        timeoutMs,
        env,
        signal: options?.signal,
        executor: options?.executor,
      });
      stderr = res.stderr;
    } catch (error: unknown) {
      // Startup failures (missing binary/timeout/crash) rethrow via toExecFailure.
      const execErr = this.toExecFailure(error, 'Infection');
      stderr = execErr.stderr;
      // Infection exits non-zero when mutants escape (MSI below threshold). That
      // is the normal survivors case AS LONG AS the JSON log was produced. If no
      // log exists, the initial (coverage) run failed — surface the likely cause.
      if (!existsSync(jsonLogPath)) {
        throw explainMissingJsonLog(execErr, cwd, hasProjectConfig);
      }
    }

    if (isVerbose() && stderr) log(`Infection stderr: ${stderr.slice(0, 500)}`);

    let logText: string;
    try {
      logText = readFileSync(jsonLogPath, 'utf8');
    } catch {
      const configHint = hasProjectConfig
        ? `Your project ships its own Infection config (${PROJECT_CONFIG_NAMES.join('/')}); ` +
          `Infection 0.34+ has no --logger-json flag, so that config must define ` +
          `logs.json = "${JSON_LOG_NAME}" for Chaos-MCP to read the detailed results. `
        : '';
      throw new Error(
        `Infection produced no readable JSON log at ${JSON_LOG_NAME}. ${configHint}Ensure a coverage driver ` +
          `(Xdebug or PCOV) is enabled and the PHPUnit suite runs from the project root.`,
      );
    }

    const result = parseInfectionJsonLog(logText, filePath);
    // Only worth saying when there is something it could be wrong about: a
    // clean run has no survivor to doubt.
    if (result.survived > 0 && !this.projectFailsOnWarning(cwd)) {
      result.fidelityNote = WARNING_FIDELITY_NOTE;
    }
    return result;
  }

  /**
   * Whether the audited project's PHPUnit config fails on warnings. An
   * unreadable or absent config answers `true` — the advisory exists to explain
   * a specific misconfiguration, not to speculate about one we cannot see.
   */
  private projectFailsOnWarning(cwd: string): boolean {
    for (const name of PHPUNIT_CONFIG_NAMES) {
      const path = join(cwd, name);
      if (!existsSync(path)) continue;
      try {
        return phpunitFailsOnWarning(readFileSync(path, 'utf8'));
      } catch {
        return true;
      }
    }
    return true;
  }
}
