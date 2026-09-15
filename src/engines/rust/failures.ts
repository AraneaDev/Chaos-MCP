/** Detect cargo-mutants output for an unmutated baseline compile failure. */
export function isBaselineCompileFailure(output: string): boolean {
  return /(?:^|\n)\s*(?:error:\s+could not compile\b|(?:error[:\s]+)?(?:unmutated\s+)?baseline\b[^\n]*(?:failed|error)\b)/i.test(
    output,
  );
}
