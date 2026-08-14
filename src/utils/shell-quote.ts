/**
 * Shell-command string construction helpers.
 *
 * Extracted from `handler.ts` (Finding 2): quoting a value for a POSIX shell is
 * not audit-orchestration logic, and the one caller that needs it
 * (`buildRunOptions`) had dragged it — plus the platform-specific Windows
 * fallback below — into the tool handler.
 */

/**
 * Quote one argument for a POSIX shell command string.
 *
 * The safe class deliberately excludes `\`. A value matching it is returned
 * VERBATIM AND UNQUOTED, and unquoted `\` is the POSIX escape character: the
 * shell eats it and takes the next character literally, so `src/report\name.ts`
 * reaches vitest as `src/reportname.ts` — a file that does not exist, meaning
 * zero tests run and every mutant "survives" against a 0% score. A trailing `\`
 * is worse still: it escapes the separating space and swallows the `--run` that
 * follows, leaving vitest in watch mode until the audit deadline. Backslash was
 * originally admitted for Windows separators, but the Windows path never
 * reaches here — `buildVitestRelatedCommand` returns before calling this on
 * win32 — so POSIX quoting can be strict at no cost. Anything containing a
 * backslash now takes the single-quoted branch, which passes it through intact.
 */
export function quoteCommandArg(value: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Flags that pin each mutant's test run to ONE vitest worker.
 *
 * Parallelism belongs to the layers ABOVE this command, and they already own it:
 * `triage_test_coverage` runs `fileConcurrency` files at once, and within each
 * file StrykerJS runs `--concurrency` mutants at once (capped by
 * `resolvePerFileConcurrency` so those two multiply out to about the core
 * count). Vitest then forked its own pool INSIDE each of those slots, and
 * nothing bounded it — so the real process count was
 * `fileConcurrency × perFileConcurrency × vitestWorkers`, with only the first
 * two capped.
 *
 * Measured on an 8-core / 8 GB box, auditing the SMALLEST file in this repo
 * (8 mutants):
 *
 *   `--run`                                   20 node processes, 1561 MB RSS
 *   `--run --no-file-parallelism --maxWorkers=1`   6 node processes,  440 MB RSS
 *
 * At `fileConcurrency: 4` the first row is ~6.2 GB against ~6 GB free: the box
 * OOMs partway through the first four files. That is not hypothetical — a sweep
 * of this repo's 62 source files took the machine down hard enough to need a
 * reboot. Throughput does not suffer, because Stryker is still running mutants
 * in parallel; only the redundant inner fan-out goes away.
 */
const VITEST_SINGLE_WORKER = '--no-file-parallelism --maxWorkers=1';

/**
 * Build the Stryker command-runner string without exposing a Windows shell
 * injection surface. Stryker accepts only a command string here, not argv.
 * Unsafe Windows paths therefore fall back to the project's configured command
 * instead of being interpolated through cmd.exe.
 *
 * The worker caps are unconditional — see {@link VITEST_SINGLE_WORKER}. A
 * single-file audit pays them too, and should: Stryker auto-detects its own
 * concurrency there, so the inner fan-out multiplies just the same.
 */
export function buildVitestRelatedCommand(targetFile: string): string | undefined {
  if (process.platform === 'win32') {
    if (!/^[A-Za-z0-9_./\\:-]+$/.test(targetFile)) return undefined;
    return `npx vitest related ${targetFile} --run ${VITEST_SINGLE_WORKER}`;
  }
  return `npx vitest related ${quoteCommandArg(targetFile)} --run ${VITEST_SINGLE_WORKER}`;
}
