/**
 * Rust workspace detection: Cargo root markers and test-runner signals.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { readTextSafe } from './fs-read.js';
import type { LanguageDetector } from './types.js';

/** Marker files that indicate a Rust project root. */
export const RUST_ROOT_MARKERS = ['Cargo.toml'] as const;

/**
 * Detect the Rust test runner from workspace signals.
 *
 * Priority order:
 * 1. nextest.toml or .config/nextest.toml exists → 'cargo nextest run'
 * 2. Cargo.toml [dev-dependencies] contains criterion → 'cargo test' (with criterion benchmarks)
 * 3. Fallback: 'cargo test'
 *
 * Note: cargo-nextest is a separately installed CLI tool, not a Cargo.toml
 * dependency. We detect it via its config file.
 *
 * @internal Exported for testing only.
 */
export function detectRustTestRunner(workspaceRoot: string): string {
  // Priority 1: cargo-nextest config file
  if (
    existsSync(join(workspaceRoot, 'nextest.toml')) ||
    existsSync(join(workspaceRoot, '.config', 'nextest.toml'))
  ) {
    return 'cargo nextest run';
  }

  // Priority 2: criterion benchmarks in Cargo.toml dev-dependencies
  const cargoContent = readTextSafe(join(workspaceRoot, 'Cargo.toml'));
  if (cargoContent && cargoContent.includes('criterion')) {
    // criterion is a benchmarking library, not a test runner — still use cargo test
    // but note the presence for diagnostics
    return 'cargo test';
  }

  // Priority 3: default
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
