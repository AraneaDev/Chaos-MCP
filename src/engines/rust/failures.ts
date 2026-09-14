/** Detect cargo-mutants output for an unmutated baseline compile failure. */
export function isBaselineCompileFailure(output: string): boolean {
  return /(?:error:\s+could not compile|baseline[^\n]*(?:failed|error)|unmutated baseline[^\n]*(?:failed|error))/i.test(
    output,
  );
}
