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
 * Build the Stryker command-runner string without exposing a Windows shell
 * injection surface. Stryker accepts only a command string here, not argv.
 * Unsafe Windows paths therefore fall back to the project's configured command
 * instead of being interpolated through cmd.exe.
 */
export function buildVitestRelatedCommand(targetFile: string): string | undefined {
  if (process.platform === 'win32') {
    if (!/^[A-Za-z0-9_./\\:-]+$/.test(targetFile)) return undefined;
    return `npx vitest related ${targetFile} --run`;
  }
  return `npx vitest related ${quoteCommandArg(targetFile)} --run`;
}
