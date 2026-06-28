import { BaseEngine, RunOptions, MutationResult, Vulnerability } from './base.js';
import { ExecFailureError } from '../utils/exec.js';
import { invokeMutationTool, MutationToolStartupError } from '../utils/exec-classify.js';
import { log, isVerbose } from '../utils/logger.js';

/** Default timeout for mutmut runs (5 minutes). */
const DEFAULT_TIMEOUT_MS = 300_000;

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
    // Mutmut v2 used `--paths-to-mutate <file>` and `--runner <cmd>` CLI flags.
    // Mutmut v3 (3.x) uses positional wildcard patterns (`mutmut run "src/calculator*"`)
    // and configures the runner via `[tool.mutmut]` in pyproject.toml.
    //
    // We pass the filePath as a positional argument so it works as a wildcard
    // match in v3 and as a path hint in v2. The --runner flag is only added
    // for v2 compatibility; v3 ignores unknown flags or reads from config.
    const resolvedRunner = options?.testRunner ?? 'pytest';
    const runArgs = ['run', filePath];
    if (resolvedRunner !== 'pytest') {
      runArgs.push('--runner', resolvedRunner);
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
        return inlineResult;
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

    // Step 3: Parse the text results
    return parseMutmutResults(resultsText, filePath);
  }
}
