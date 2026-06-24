import { BaseEngine, RunOptions, MutationResult, Vulnerability } from './base.js';
import { runShell, ExecFailureError } from '../utils/exec.js';
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
    const line = rawLine.trim();

    if (!line) {
      currentCategory = null;
      continue;
    }

    // Detect category header lines (e.g. "Survived 🙂 (3)")
    if (line.includes(MUTMUT_CATEGORIES.survived.emoji) || /^survived\b/i.test(line)) {
      currentCategory = 'survived';
      survived = parseCategoryCount(line);
      continue;
    }
    if (line.includes(MUTMUT_CATEGORIES.killed.emoji) || /^killed\b/i.test(line)) {
      currentCategory = 'killed';
      killed = parseCategoryCount(line);
      continue;
    }
    if (line.includes(MUTMUT_CATEGORIES.timeout.emoji) || /^timeout\b/i.test(line)) {
      currentCategory = 'timeout';
      timeout = parseCategoryCount(line);
      continue;
    }
    if (line.includes(MUTMUT_CATEGORIES.skipped.emoji) || /^skipped\b/i.test(line)) {
      currentCategory = 'skipped';
      skipped = parseCategoryCount(line);
      continue;
    }
    if (line.includes(MUTMUT_CATEGORIES.suspicious.emoji) || /^suspicious\b/i.test(line)) {
      currentCategory = 'suspicious';
      suspicious = parseCategoryCount(line);
      continue;
    }

    // Indented lines under a category header are mutant IDs
    if (currentCategory === 'survived' && rawLine.startsWith(' ')) {
      survivingIds.push(line);
    }
  }

  // If the header count says N survived but we only captured M IDs, trust the
  // header count for the summary but still report whatever IDs we parsed.
  const survivedCount = Math.max(survived, survivingIds.length);

  // Total = survived + killed + timeout + skipped + suspicious
  // Timeouts are counted as KILLED — the mutant caused the test suite to hang,
  // which means the test suite detected it (consistent with Stryker's behavior).
  // Suspicious mutants are treated as surviving (ambiguous outcome = potential hole).
  const totalMutants = survivedCount + killed + timeout + skipped + suspicious;
  const effectiveKilled = killed + timeout;

  const score = totalMutants > 0 ? ((effectiveKilled / totalMutants) * 100).toFixed(2) : '100.00';

  // Build vulnerability entries for surviving mutants.
  // If we captured IDs, use them; otherwise create a single summary entry.
  const vulnerabilities: Vulnerability[] = [];
  for (const id of survivingIds) {
    const lineNum = extractLineFromId(id);
    vulnerabilities.push({
      line: lineNum,
      replacement: 'Arithmetic/Logical Mutation',
      description:
        lineNum > 0
          ? `Mutated code at line ${lineNum} (mutant "${id}") bypassed the test suite. Your tests did not catch this change.`
          : `Surviving mutant "${id}" bypassed the test suite. Run \`mutmut show ${id}\` for the exact location. Your tests did not catch this change.`,
    });
  }

  // If no individual IDs were captured but we know some survived, add a summary entry
  if (survivingIds.length === 0 && survivedCount > 0) {
    vulnerabilities.push({
      line: 0,
      replacement: 'Arithmetic/Logical Mutation',
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
    try {
      await runShell('mutmut', runArgs, { cwd, timeoutMs });
    } catch (error: unknown) {
      if (error instanceof ExecFailureError) {
        // ENOENT → mutmut not installed
        if (error.code === 'ENOENT') {
          throw new Error('mutmut is not installed. Install it with: pip install mutmut');
        }

        // Timeout
        if (error.code === 'TIMEOUT') {
          throw new Error(
            `mutmut timed out after ${timeoutMs}ms. Increase timeoutMs or narrow the target file.`,
          );
        }

        // Signal-based crash
        if (error.signal && error.exit === null) {
          throw new Error(
            `mutmut crashed (signal ${error.signal}): ${error.stderr || error.message}`,
          );
        }

        // Non-zero exit from `mutmut run` means the BASELINE tests are broken,
        // NOT that mutants survived. Surface this as a real error.
        if (error.exit !== null && error.exit !== 0) {
          throw new Error(
            `mutmut baseline test failure (exit ${error.exit}). The test suite fails before mutation testing begins. ` +
              `Fix the failing tests first. Details: ${error.stderr?.slice(0, 500) || error.message}`,
          );
        }
      }

      throw error instanceof Error ? error : new Error(`mutmut execution failed: ${String(error)}`);
    }

    // Step 2: Retrieve results via `mutmut results` (text output)
    let resultsText: string;
    try {
      const result = await runShell('mutmut', ['results'], { cwd, timeoutMs });
      resultsText = result.stdout;
    } catch (error: unknown) {
      if (error instanceof ExecFailureError && error.code === 'ENOENT') {
        // Already handled above, but results could fail independently
        throw new Error('mutmut is not installed. Install it with: pip install mutmut');
      }

      // `mutmut results` may exit non-zero if no cache exists (e.g. no mutants generated)
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
