/**
 * Rust workspace detection: Cargo root markers and test-runner signals.
 */
import type { LanguageDetector } from './types.js';

/** Marker files that indicate a Rust project root. */
export const RUST_ROOT_MARKERS = ['Cargo.toml'] as const;

/**
 * Detect the Rust test runner from workspace signals.
 *
 * cargo-mutants invokes the Rust test tool itself. Nextest and criterion
 * detection here therefore had no effect on the audit command.
 *
 * @internal Exported for testing only.
 */
export function detectRustTestRunner(workspaceRoot: string): string {
  void workspaceRoot;
  return 'cargo test';
}

/**
 * Detect the raw Rust test runner without mapping.
 *
 * @internal Exported for testing only.
 */
export function detectRawRustRunner(workspaceRoot: string): string {
  return detectRustTestRunner(workspaceRoot);
}

export const rustDetector: LanguageDetector = {
  matches: (p) => p.endsWith('.rs'),
  extensions: ['.rs'],
  markers: RUST_ROOT_MARKERS,
  testRunner: detectRustTestRunner,
  rawRunner: detectRawRustRunner,
};
