/**
 * Diagnostic logger that writes to stderr so MCP JSON-RPC traffic on stdout
 * is never polluted.
 *
 * Enabled via the `--verbose` CLI flag.
 */

let verboseEnabled = false;

/** Enable verbose diagnostic logging. */
export function enableVerbose(): void {
  verboseEnabled = true;
}

/** Check whether verbose mode is active. */
export function isVerbose(): boolean {
  return verboseEnabled;
}

/** Write a diagnostic message to stderr if verbose mode is enabled. */
export function log(...args: unknown[]): void {
  if (!verboseEnabled) return;
  process.stderr.write(`[chaos-mcp] ${args.map(String).join(' ')}\n`);
}

/** Write a warning to stderr (always shown, regardless of verbose mode). */
export function warn(...args: unknown[]): void {
  process.stderr.write(`[chaos-mcp:warn] ${args.map(String).join(' ')}\n`);
}
