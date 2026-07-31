/**
 * Shell-command string construction helpers.
 *
 * Extracted from `handler.ts` (Finding 2): quoting a value for a POSIX shell is
 * not audit-orchestration logic, and the one caller that needs it
 * (`buildRunOptions`) had dragged it — plus the platform-specific Windows
 * fallback below — into the tool handler.
 */

/** Quote one argument for a POSIX shell command string. */
export function quoteCommandArg(value: string): string {
  if (/^[A-Za-z0-9_./\\-]+$/.test(value)) return value;
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
