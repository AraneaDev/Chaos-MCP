import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BaseEngine, RunOptions, MutationResult, Vulnerability } from './base.js';
import { ExecFailureError } from '../utils/exec.js';
import { invokeMutationTool, MutationToolStartupError } from '../utils/exec-classify.js';
import { log, isVerbose } from '../utils/logger.js';

/** Default timeout for mutmut runs (5 minutes). */
const DEFAULT_TIMEOUT_MS = 300_000;

/** Where mutmut v3 `export-cicd-stats` writes its JSON, relative to the run cwd. */
const CICD_STATS_PATH = ['mutants', 'mutmut-cicd-stats.json'];

/**
 * Cap on `mutmut show` enrichment calls per audit. Survivors beyond this stay
 * located only by id (the handler ranks + caps the displayed set anyway, and
 * unenriched survivors sort last as severity "unknown").
 */
const MAX_SHOW_CALLS = 50;

/**
 * Category labels emitted by `mutmut results`, paired with the emoji that
 * appears in the output header line (e.g. "Survived 🙂 (3)").
 *
 * Mutmut v2 and v3 both use these exact labels + emoji.
 */
const MUTMUT_CATEGORIES = {
  survived: { label: 'Survived', emoji: '🙂' },
  killed: { label: 'Killed', emoji: '🎉' },
  timeout: { label: 'Timeout', emoji: '⏰' },
  skipped: { label: 'Skipped', emoji: '🤔' },
  suspicious: { label: 'Suspicious', emoji: '🤨' },
} as const;

/**
 * Extract the count from a `mutmut results` category header line.
 *
 * Header lines look like:
 *   "Survived 🙂 (3)"
 *   "Killed 🎉 (12)"
 *
 * Returns 0 when no parenthetical count is present.
 */
function parseCategoryCount(line: string): number {
  const match = line.match(/\((\d+)\)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Extract a line number from a mutmut mutant ID.
 *
 * Mutmut IDs vary by version:
 *  - v2: "src/calculator.py:7" or "calculator.py:7"
 *  - v3: numeric IDs like "3" (line info only via `mutmut show`)
 *
 * Returns the line number when the ID embeds one, otherwise 0.
 */
function extractLineFromId(mutantId: string): number {
  // Match the last :<number> in the string (handles paths with colons on Windows)
  const match = mutantId.match(/:(\d+)\D*$/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Parse the text output of `mutmut results` into a MutationResult.
 *
 * Expected output format (mutmut v2 and v3):
 *
 *   Survived 🙂 (3)
 *     mutant_id_1
 *     mutant_id_2
 *     mutant_id_3
 *
 *   Killed 🎉 (12)
 *     ...
 *
 *   Timeout ⏰ (1)
 *     ...
 *
 *   Skipped 🤔 (0)
 *
 *   Suspicious 🤨 (0)
 *
 * Each category header line contains a label, emoji, and a parenthetical count.
 * Individual mutant IDs are listed on indented lines beneath each header.
 *
 * @param resultsText - Raw stdout from `mutmut results`
 * @param filePath - The target file path (for the result `target` field)
 */
/**
 * mutmut v3 `mutmut results` line shape: `<id>: <status>` (e.g.
 * `calc.x_classify__mutmut_1: survived`). v3 `results` lists ONLY non-killed
 * mutants (killed ones are omitted) — so this is the SURVIVOR-ID source, not a
 * count source. v2 category text (`Survived 🙂 (3)`) never matches this shape.
 */
const V3_STATUS_LINE =
  /^(\S.*?):\s+(survived|suspicious|no_tests|skipped|killed|timeout|caught_by_type_check|segfault)$/;

/** v3 statuses that mean the mutant survived (a coverage hole / ambiguous). */
const V3_SURVIVING_STATUSES = new Set(['survived', 'suspicious', 'no_tests']);

/**
 * Extract the mutmut mutant id the engine embeds in a survivor's description
 * (`… mutant "calc.x_f__mutmut_1" …`) so it can `mutmut show <id>` to enrich
 * the survivor with a line number + diff. Returns undefined when absent.
 */
export function extractMutantId(description: string): string | undefined {
  return description.match(/mutant "([^"]+)"/)?.[1];
}

/**
 * Convert a workspace-relative `.py` file path into a mutmut v3 mutant-name
 * glob. v3's `mutmut run <filter>` filters by mutant NAME (`module.func__mutmut_N`),
 * NOT by path — `mutmut run pkg/calc.py` errors with "nothing matches". The
 * module is the dotted path with the `.py` extension stripped; `.*` matches all
 * mutants in that module.
 *
 *   "calc.py"      → "calc.*"
 *   "pkg/calc.py"  → "pkg.calc.*"
 */
export function mutmutModuleGlob(filePath: string): string {
  const noExt = filePath.replace(/\.py$/i, '');
  const dotted = noExt.replace(/[/\\]/g, '.');
  return `${dotted}.*`;
}

/**
 * Parse a single `mutmut show <id>` unified diff into the changed line number
 * (1-based, new-side) and the original/mutated source for that line. Returns
 * null when the output carries no diff hunk (e.g. "no diff available").
 *
 * Example input:
 *   # calc.x_classify__mutmut_1: survived
 *   --- calc.py
 *   +++ calc.py
 *   @@ -1,4 +1,4 @@
 *    def classify(n):
 *   -    if n > 10:
 *   +    if n >= 10:
 *        return "big"
 */
export function parseMutmutShow(
  showText: string,
): { line: number; original?: string; mutated?: string } | null {
  const lines = showText.split('\n');
  const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  let header: RegExpMatchArray | null = null;
  let hunkIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(hunkRe);
    if (m) {
      header = m;
      hunkIdx = i;
      break;
    }
  }
  if (!header) return null;

  // new-side line counter; pre-decremented so the first body line lands on newStart.
  let newLine = parseInt(header[1], 10) - 1;
  let changeLine = 0;
  let original: string | undefined;
  let mutated: string | undefined;

  for (let i = hunkIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.startsWith('+')) {
      newLine++;
      if (mutated === undefined) {
        mutated = raw.slice(1).trim();
        if (changeLine === 0) changeLine = newLine;
      }
    } else if (raw.startsWith('-')) {
      if (original === undefined) {
        original = raw.slice(1).trim();
        if (changeLine === 0) changeLine = newLine + 1;
      }
    } else {
      // Context line (or trailing blank) — advances the new-side counter only.
      newLine++;
    }
  }

  if (original === undefined && mutated === undefined) return null;
  return { line: changeLine, original, mutated };
}

/**
 * Build the `[tool.mutmut]` config the engine injects into the SANDBOX
 * pyproject.toml so mutmut v3 can run. mutmut v3 refuses to start without
 * `source_paths`, and most projects don't carry a `[tool.mutmut]` section — so
 * we provide one scoped to the target file. This only ever writes to the
 * throwaway sandbox copy, never the user's real project.
 *
 * @param existingPyproject - current sandbox pyproject.toml content, or null if absent.
 * @param relFile - workspace-relative target file (becomes `source_paths`).
 * @param testSelection - optional pytest selection args (e.g. a test file or
 *   `["-m","unit"]`) to scope the baseline for large suites; emitted as
 *   `pytest_add_cli_args_test_selection`.
 * @returns the full pyproject.toml content to write, or null when the project
 *   already declares `[tool.mutmut]` (we respect the user's own config).
 */
export function buildMutmutConfigInjection(
  existingPyproject: string | null,
  relFile: string,
  testSelection?: string[],
): string | null {
  if (existingPyproject !== null && /^\s*\[tool\.mutmut\]/m.test(existingPyproject)) {
    return null;
  }
  const lines = ['[tool.mutmut]', `source_paths = [${JSON.stringify(relFile)}]`];
  if (testSelection && testSelection.length > 0) {
    lines.push(
      `pytest_add_cli_args_test_selection = [${testSelection.map((s) => JSON.stringify(s)).join(', ')}]`,
    );
  }
  const block = `${lines.join('\n')}\n`;
  if (existingPyproject === null || existingPyproject.trim() === '') return block;
  return `${existingPyproject.replace(/\s*$/, '')}\n\n${block}`;
}

/** A surviving (non-killed) mutmut v3 mutant: its id and reported status. */
export interface MutmutSurvivor {
  id: string;
  status: string;
}

/**
 * Extract surviving mutant ids from mutmut v3 `mutmut results` text. v3 lists
 * one `<id>: <status>` line per non-killed mutant; we keep the surviving
 * statuses (survived / suspicious / no_tests). Returns [] for v2 text or empty
 * output (no line matches the v3 shape).
 */
export function parseMutmutSurvivors(resultsText: string): MutmutSurvivor[] {
  const out: MutmutSurvivor[] = [];
  for (const raw of resultsText.split('\n')) {
    const m = raw.trim().match(V3_STATUS_LINE);
    if (m && V3_SURVIVING_STATUSES.has(m[2])) {
      out.push({ id: m[1], status: m[2] });
    }
  }
  return out;
}

/** Raw shape of `mutants/mutmut-cicd-stats.json` (mutmut v3 `export-cicd-stats`). */
interface MutmutCicdStats {
  killed?: number;
  survived?: number;
  total?: number;
  no_tests?: number;
  skipped?: number;
  suspicious?: number;
  timeout?: number;
  segfault?: number;
}

/**
 * Parse mutmut v3's `mutants/mutmut-cicd-stats.json` into authoritative counts.
 * This is the ONLY reliable count source in v3 — `mutmut results` omits killed
 * mutants. Returns the count portion of a MutationResult (the engine attaches
 * vulnerabilities from {@link parseMutmutSurvivors}); null on malformed JSON.
 *
 * Mapping to our semantics (mirrors the v2 parser):
 *  - caught (killed) = killed + timeout + segfault, PLUS any total-vs-explicit
 *    remainder (e.g. v3's `caught_by_type_check`, which is in `total` but not a
 *    JSON field) — the suite/type-checker detected those, so they count killed.
 *  - survived (holes) = survived + suspicious + no_tests.
 *  - totalMutants = the JSON `total` (authoritative; includes skipped).
 */
export function parseMutmutCicdStats(
  jsonText: string,
  filePath: string,
): Pick<
  MutationResult,
  'target' | 'totalMutants' | 'killed' | 'survived' | 'mutationScore'
> | null {
  let raw: MutmutCicdStats;
  try {
    raw = JSON.parse(jsonText) as MutmutCicdStats;
  } catch {
    return null;
  }
  const killed = raw.killed ?? 0;
  const survived = raw.survived ?? 0;
  const noTests = raw.no_tests ?? 0;
  const skipped = raw.skipped ?? 0;
  const suspicious = raw.suspicious ?? 0;
  const timeout = raw.timeout ?? 0;
  const segfault = raw.segfault ?? 0;
  const total =
    raw.total ?? killed + survived + noTests + skipped + suspicious + timeout + segfault;

  const explicit = killed + survived + noTests + skipped + suspicious + timeout + segfault;
  // Categories present in `total` but not emitted as JSON fields (e.g.
  // caught_by_type_check) — those mutants were caught, so fold into killed.
  const reconciledKilled = Math.max(0, total - explicit);
  const effectiveKilled = killed + timeout + segfault + reconciledKilled;
  const survivedCount = survived + suspicious + noTests;
  const score = total > 0 ? ((effectiveKilled / total) * 100).toFixed(2) : '100.00';

  return {
    target: filePath,
    totalMutants: total,
    killed: effectiveKilled,
    survived: survivedCount,
    mutationScore: `${score}%`,
  };
}

export function parseMutmutResults(resultsText: string, filePath: string): MutationResult {
  const lines = resultsText.split('\n');

  let survived = 0;
  let killed = 0;
  let timeout = 0;
  let skipped = 0;
  let suspicious = 0;
  const survivingIds: string[] = [];

  let currentCategory: 'survived' | 'killed' | 'timeout' | 'skipped' | 'suspicious' | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (!trimmed) {
      currentCategory = null;
      continue;
    }

    // Audit finding H4: distinguish section headers from mutant IDs whose
    // path happens to start with a category keyword (e.g. `survived_logic.py`).
    // Two gates that file paths cannot practically satisfy:
    //   1. The line starts with the category label (e.g. "Survived" at column 0).
    //   2. The line embeds the category emoji.
    // The parenthetical count is OPTIONAL — real headers always have one but a
    // malformed mutmut output may omit it; `parseCategoryCount` returns 0 in
    // that case, which is a safe default. (No realistic case has a file path
    // whose name contains the emoji, so the regex + emoji gate is sufficient.)
    // Header recognition accepts EITHER the category emoji OR a parenthetical
    // count (e.g. "Survived (3)" without emoji). The parens-count fallback also
    // requires the line NOT to look like a file path (has `/`/`\` or `.ext:N`),
    // so mutant IDs like `survived_logic.py:7` (no emoji, no parens) continue
    // to be correctly classified as surviving-mutant ID lines, satisfying the
    // H4 regression test.
    const looksLikePath =
      /\.[a-z0-9]+:\d+\s*$/i.test(trimmed) || /[/\\]/.test(trimmed) || /\.[a-z]+\b/i.test(trimmed);
    const hasParensCount = /\(\d+\)/.test(trimmed);
    const isHeader = (label: string, emoji: string): boolean => {
      if (!new RegExp(`^${label}\\b`, 'i').test(trimmed)) return false;
      if (trimmed.includes(emoji)) return true;
      if (hasParensCount && !looksLikePath) return true;
      return false;
    };

    // Detect category header lines (e.g. "Survived 🙂 (3)").
    if (isHeader('survived', MUTMUT_CATEGORIES.survived.emoji)) {
      currentCategory = 'survived';
      survived = parseCategoryCount(trimmed);
      continue;
    }
    if (isHeader('killed', MUTMUT_CATEGORIES.killed.emoji)) {
      currentCategory = 'killed';
      killed = parseCategoryCount(trimmed);
      continue;
    }
    if (isHeader('timeout', MUTMUT_CATEGORIES.timeout.emoji)) {
      currentCategory = 'timeout';
      timeout = parseCategoryCount(trimmed);
      continue;
    }
    if (isHeader('skipped', MUTMUT_CATEGORIES.skipped.emoji)) {
      currentCategory = 'skipped';
      skipped = parseCategoryCount(trimmed);
      continue;
    }
    if (isHeader('suspicious', MUTMUT_CATEGORIES.suspicious.emoji)) {
      currentCategory = 'suspicious';
      suspicious = parseCategoryCount(trimmed);
      continue;
    }

    // Non-header lines: indented lines under a category header are mutant IDs.
    // Headers themselves never start with leading whitespace (they sit at column 0).
    if (currentCategory === 'survived' && rawLine !== trimmed) {
      survivingIds.push(trimmed);
    }
  }

  // If the header count says N survived but we only captured M IDs, trust the
  // header count for the summary but still report whatever IDs we parsed.
  // Suspicious mutants are treated as surviving (ambiguous outcome = potential
  // hole). Include them in survivedCount so the score and summary reflect them.
  // (Audit M11: previously suspicious mutants were in totalMutants but not
  // in survivedCount, making the score lower without explanation.)
  const survivedCount = Math.max(survived, survivingIds.length) + suspicious;

  // Total = survived + killed + timeout + skipped + suspicious
  // Timeouts are counted as KILLED — the mutant caused the test suite to hang,
  // which means the test suite detected it (consistent with Stryker's behavior).
  const totalMutants = survivedCount + killed + timeout + skipped;
  const effectiveKilled = killed + timeout;

  const score = totalMutants > 0 ? ((effectiveKilled / totalMutants) * 100).toFixed(2) : '100.00';

  // Build vulnerability entries for surviving mutants.
  // If we captured IDs, use them; otherwise create a single summary entry.
  const vulnerabilities: Vulnerability[] = [];
  for (const id of survivingIds) {
    const lineNum = extractLineFromId(id);
    vulnerabilities.push({
      line: lineNum,
      mutator: 'Arithmetic/Logical Mutation',
      description:
        lineNum > 0
          ? `Mutated code at line ${lineNum} (mutant "${id}") bypassed the test suite. Your tests did not catch this change.`
          : `Surviving mutant "${id}" bypassed the test suite. Run \`mutmut show ${id}\` for the exact location. Your tests did not catch this change.`,
    });
  }

  // Emit a summary entry for suspicious mutants so the user can see why the score dropped.
  if (suspicious > 0) {
    vulnerabilities.push({
      line: 0,
      mutator: 'Suspicious Mutation',
      description: `${suspicious} suspicious mutant(s) detected. The test suite produced ambiguous results \u2014 this may indicate flaky tests or an unstable mutation. Run \`mutmut results\` for details.`,
    });
  }

  // Only fire for actual Survived-category mutants with no IDs captured;
  // suspicious mutants get their own vulnerability entry above (audit M11).
  if (survivingIds.length === 0 && survived > 0) {
    vulnerabilities.push({
      line: 0,
      mutator: 'Arithmetic/Logical Mutation',
      description: `${survivedCount} mutant(s) survived the test suite. Run \`mutmut results\` and \`mutmut show <id>\` for details.`,
    });
  }

  return {
    target: filePath,
    totalMutants,
    killed: effectiveKilled,
    survived: survivedCount,
    mutationScore: `${score}%`,
    vulnerabilities,
  };
}

/**
 * Mutation testing engine for Python files.
 *
 * Shells out to the `mutmut` CLI to generate and evaluate mutants.
 *
 * **Important:** Mutmut does not have a `json` subcommand. Results are
 * extracted by parsing the text output of `mutmut results`.
 *
 * **Exit code semantics:** `mutmut run` exits 0 even when mutants survive.
 * A non-zero exit indicates the baseline test suite is broken (tests fail
 * before any mutation), which is surfaced as an error rather than swallowed.
 *
 * Note: Mutmut does not support line-level scoping or mutator allow/denylists.
 * The `lineScope`, `mutatorAllowlist`, and `mutatorDenylist` options are silently
 * ignored for Python targets.
 */
export class PythonEngine extends BaseEngine {
  async run(filePath: string, options?: RunOptions): Promise<MutationResult> {
    const cwd = options?.workDir ?? process.cwd();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Build the mutmut run command.
    //
    // Mutmut v3's `run` positional is a mutant-NAME filter (module.func__mutmut_N),
    // NOT a file path: `mutmut run pkg/calc.py` errors with "nothing matches".
    // We pass a module glob (`pkg.calc.*`) derived from the path so the run is
    // scoped to that file's mutants. The --runner flag overrides the test runner
    // (v3 also honors `[tool.mutmut]` in pyproject.toml; pytest is the default).
    const resolvedRunner = options?.testRunner ?? 'pytest';
    const runArgs = ['run', mutmutModuleGlob(filePath)];
    if (resolvedRunner !== 'pytest') {
      runArgs.push('--runner', resolvedRunner);
    }

    // Ensure mutmut has a [tool.mutmut] config: v3 refuses to start without
    // `source_paths`, and most projects carry no such section. Inject one scoped
    // to the target file into the SANDBOX pyproject only (never the real
    // project). Best-effort — if the write fails, mutmut surfaces its own error.
    try {
      const pyprojectPath = join(cwd, 'pyproject.toml');
      const existing = existsSync(pyprojectPath) ? readFileSync(pyprojectPath, 'utf8') : null;
      const injected = buildMutmutConfigInjection(existing, filePath, options?.pythonTestSelection);
      if (injected !== null) {
        writeFileSync(pyprojectPath, injected, 'utf8');
        if (isVerbose()) {
          log('PythonEngine: injected [tool.mutmut] source_paths into the sandbox pyproject');
        }
      }
    } catch {
      // best-effort: a missing/un-writable config surfaces as a mutmut error below
    }

    if (isVerbose()) {
      log(`PythonEngine: mutmut ${runArgs.join(' ')}`);
    }

    // Step 1: Run mutmut against the target file.
    // Capture stdout — newer mutmut versions may emit results inline,
    // letting us skip the separate `mutmut results` call.
    let runStdout = '';
    try {
      const runResult = await invokeMutationTool('mutmut', 'mutmut', runArgs, {
        cwd,
        timeoutMs,
        signal: options?.signal,
      });
      runStdout = runResult.stdout;
    } catch (error: unknown) {
      if (error instanceof MutationToolStartupError) {
        // Standard startup failures (not installed, timeout, signal crash)
        throw new Error(error.message);
      }

      // Mutmut-specific exit-code semantics: a non-zero exit from `mutmut run`
      // indicates the BASELINE tests are broken, not that mutants survived.
      // (Mutmut v3 returns 0 when all mutants are tested regardless of outcome.)
      if (error instanceof ExecFailureError && error.exit !== null && error.exit !== 0) {
        throw new Error(
          `mutmut baseline test failure (exit ${error.exit}). The test suite fails before mutation testing begins. ` +
            `Fix the failing tests first. Details: ${error.stderr?.slice(0, 500) || error.message}`,
        );
      }

      throw error instanceof Error ? error : new Error(`mutmut execution failed: ${String(error)}`);
    }

    // Step 1.5: Check if mutmut run stdout already contains parseable results.
    // mutmut v3+ may emit category headers inline, saving a subprocess call.
    if (runStdout) {
      const inlineResult = parseMutmutResults(runStdout, filePath);
      if (inlineResult.totalMutants > 0) {
        if (isVerbose()) {
          log('PythonEngine: parsed results from mutmut run stdout, skipping mutmut results call');
        }
        return await this.enrichSurvivors(inlineResult, cwd, timeoutMs, options?.signal);
      }
    }

    // Step 2: Retrieve results via `mutmut results` (text output).
    // `mutmut results` may exit non-zero if no cache exists (e.g. no mutants
    // generated) — in that case we accept partial stdout if available.
    let resultsText: string;
    try {
      const result = await invokeMutationTool('mutmut', 'mutmut', ['results'], {
        cwd,
        timeoutMs,
        signal: options?.signal,
      });
      resultsText = result.stdout;
    } catch (error: unknown) {
      if (error instanceof MutationToolStartupError) {
        throw new Error(error.message);
      }
      if (error instanceof ExecFailureError && error.stdout) {
        resultsText = error.stdout;
      } else {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to retrieve mutmut results. Ensure mutmut completed successfully. Details: ${message}`,
        );
      }
    }

    // Step 3a: mutmut v3 detection. v3 `mutmut results` lists one
    // `<id>: <status>` line per NON-killed mutant (killed are omitted), so the
    // presence of such lines means v3 — and counts MUST come from the cicd JSON,
    // not this text. v2 output (category headers / empty) yields no survivors
    // here and falls through to the legacy parser below, so v2 callers/tests are
    // unaffected.
    const v3Survivors = parseMutmutSurvivors(resultsText);
    if (v3Survivors.length > 0) {
      const v3 = await this.buildV3Result(filePath, v3Survivors, cwd, timeoutMs, options?.signal);
      if (v3) return await this.enrichSurvivors(v3, cwd, timeoutMs, options?.signal);
      // export-cicd-stats unavailable/unparseable (should not happen on a working
      // v3 install): fall through to the legacy parser as a best-effort.
    }

    // Step 3b: Parse the text results (mutmut v2 category format).
    return await this.enrichSurvivors(
      parseMutmutResults(resultsText, filePath),
      cwd,
      timeoutMs,
      options?.signal,
    );
  }

  /**
   * Build a v3 MutationResult: authoritative counts from `mutmut export-cicd-stats`
   * (`mutants/mutmut-cicd-stats.json`) + a vulnerability per surviving mutant id
   * (from `mutmut results`). Returns null when the JSON can't be produced/parsed,
   * so the caller can fall back to the legacy text parser.
   */
  private async buildV3Result(
    filePath: string,
    survivors: MutmutSurvivor[],
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<MutationResult | null> {
    // Generate the stats JSON (best-effort; ignore failures and try to read).
    try {
      await invokeMutationTool('mutmut', 'mutmut', ['export-cicd-stats'], {
        cwd,
        timeoutMs,
        signal,
      });
    } catch {
      // export-cicd-stats may not exist or may warn-exit; the read below decides.
    }

    let counts: ReturnType<typeof parseMutmutCicdStats> = null;
    try {
      counts = parseMutmutCicdStats(readFileSync(join(cwd, ...CICD_STATS_PATH), 'utf8'), filePath);
    } catch {
      counts = null;
    }
    if (!counts) return null;

    // One vulnerability per surviving mutant id (line 0 until `mutmut show`
    // enrichment locates it). no_tests → a no-coverage description the formatter
    // groups separately.
    const vulnerabilities: Vulnerability[] = survivors.map(({ id, status }) => ({
      line: 0,
      mutator: 'Mutation',
      description:
        status === 'no_tests'
          ? `No test reached mutant "${id}" (no coverage). Run \`mutmut show ${id}\` for the exact location.`
          : `Surviving mutant "${id}" bypassed the test suite. Run \`mutmut show ${id}\` for the exact location.`,
    }));

    // The JSON survived count is authoritative; if it exceeds the ids `mutmut
    // results` listed, note the remainder so the score and detail stay coherent.
    const missing = counts.survived - vulnerabilities.length;
    if (missing > 0) {
      vulnerabilities.push({
        line: 0,
        mutator: 'Mutation',
        description: `${missing} additional surviving mutant(s) not individually listed. Run \`mutmut results\` for the full set.`,
      });
    }

    return { ...counts, vulnerabilities };
  }

  /**
   * Enrich line-less survivors (mutmut v3 ids carry no line) with a real line
   * number + original/mutated source by parsing `mutmut show <id>`. Best-effort:
   * a failed or unparseable `show` leaves the survivor as-is (located only by
   * id). The captured original/mutated feed canonicalizeMutator so Python
   * survivors get a real severity instead of "unknown".
   */
  private async enrichSurvivors(
    result: MutationResult,
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<MutationResult> {
    let shown = 0;
    for (const v of result.vulnerabilities) {
      if (v.line !== 0) continue; // already located (v2 file:line ids)
      if (shown >= MAX_SHOW_CALLS) break;
      const id = extractMutantId(v.description);
      if (!id) continue;
      shown++;
      try {
        const showResult = await invokeMutationTool('mutmut', 'mutmut', ['show', id], {
          cwd,
          timeoutMs,
          signal,
        });
        const diff = parseMutmutShow(showResult.stdout);
        if (diff) {
          v.line = diff.line;
          if (diff.original !== undefined) v.original = diff.original;
          if (diff.mutated !== undefined) v.mutated = diff.mutated;
        }
      } catch {
        // best-effort: keep the id + "mutmut show" hint already in the description
      }
    }
    return result;
  }
}
