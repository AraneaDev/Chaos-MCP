import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

/**
 * End-to-end cargo-mutants test that spawns the mutation tool against a tiny
 * fixture Rust project, asserting that mutants are generated and some survive.
 *
 * Run with `E2E_RUST=1 npm test`. Otherwise the heavy mutation test silently
 * skips (cargo-mutants takes 30-120s even for a one-file fixture).
 *
 * Prerequisites:
 *   - Rust toolchain (cargo, rustc)
 *   - cargo-mutants: `cargo install cargo-mutants`
 *
 * Why opt-in:
 *   1. cargo-mutants runs take 30-120s even for a one-file fixture.
 *   2. The tool is not a Node.js dependency — it must be installed separately.
 */

const E2E_RUST_ENABLED = process.env.E2E_RUST === '1';

// ─── DETECTION ───────────────────────────────────────────────────────────────

function detectRust(): { available: boolean; reason: string } {
  // Check cargo
  const cargoCheck = spawnSync('cargo', ['--version'], { stdio: 'pipe', timeout: 5000 });
  if (cargoCheck.status !== 0) {
    return { available: false, reason: 'cargo not found (install Rust via https://rustup.rs)' };
  }

  // Check cargo-mutants
  const mutCheck = spawnSync('cargo', ['mutants', '--help'], { stdio: 'pipe', timeout: 5000 });
  if (mutCheck.status !== 0) {
    return {
      available: false,
      reason: 'cargo-mutants not found (run: cargo install cargo-mutants)',
    };
  }

  return { available: true, reason: '' };
}

const rustDetect = detectRust();

// Always-on canary: cheap, runs even when E2E_RUST is unset. THROWS
// when E2E_RUST=1 is set but the toolchain is missing, so misconfigured
// CI fails loudly instead of silently skipping.
const it_canary = it;

// Heavy test: only runs when env + toolchain are both good.
const it_heavy = E2E_RUST_ENABLED && rustDetect.available ? it : it.skip;

if (E2E_RUST_ENABLED && !rustDetect.available) {
  console.error(
    `[e2e-rust] E2E_RUST=1 set but toolchain unavailable — ${rustDetect.reason}. ` +
      'Install Rust and cargo-mutants, or unset E2E_RUST if you do not intend to run this E2E.',
  );
}

// ─── FIXTURE ─────────────────────────────────────────────────────────────────

interface RustFixture {
  rootDir: string;
  remove: () => void;
}

function createRustFixture(): RustFixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'cargo-mutants-e2e-'));

  // Create a minimal Cargo project
  writeFileSync(
    join(rootDir, 'Cargo.toml'),
    `[package]
name = "e2e-fixture"
version = "0.1.0"
edition = "2021"

[lib]
path = "src/lib.rs"
`,
  );

  const srcDir = join(rootDir, 'src');
  mkdirSync(srcDir, { recursive: true });

  // lib.rs: a divide() function with an intentional coverage gap
  writeFileSync(
    join(srcDir, 'lib.rs'),
    `/// Divides a by b. Returns 0 when b is 0.
pub fn divide(a: i32, b: i32) -> i32 {
    if b == 0 {
        return 0;
    }
    a / b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_divide_valid() {
        assert_eq!(divide(4, 2), 2);
    }
    // NOTE: the b == 0 branch is intentionally NOT tested, so its
    // mutants will survive and the score will be <100%.
}
`,
  );

  return {
    rootDir,
    remove: () => {
      try {
        rmSync(rootDir, { recursive: true, force: true });
      } catch {
        // Best-effort
      }
    },
  };
}

// ─── TESTS ───────────────────────────────────────────────────────────────────

describe('cargo-mutants E2E', () => {
  let fixture: RustFixture;

  beforeAll(() => {
    if (!E2E_RUST_ENABLED || !rustDetect.available) return;
    fixture = createRustFixture();
  });

  afterAll(() => {
    if (fixture) fixture.remove();
  });

  // ── Loud canary ────────────────────────────────────────────────────────────
  it_canary('fails loudly when E2E_RUST=1 is set but toolchain is missing', () => {
    if (!E2E_RUST_ENABLED) {
      return;
    }
    if (!rustDetect.available) {
      throw new Error(
        `[e2e-rust] E2E_RUST=1 set but toolchain unavailable — ${rustDetect.reason}. ` +
          'Install Rust and cargo-mutants, or unset E2E_RUST if you do not intend to run this E2E.',
      );
    }
  });

  // ── Heavy mutation test ────────────────────────────────────────────────────
  it_heavy(
    'runs real mutation testing and reflects intentional coverage gaps in the score',
    async () => {
      // cargo-mutants works on the workspace as a whole. We pass --file
      // to restrict mutations to lib.rs. First, build to ensure the
      // project compiles (cargo-mutants requires a compilable project).

      const buildResult = spawnSync('cargo', ['build'], {
        cwd: fixture.rootDir,
        stdio: 'pipe',
        timeout: 60_000,
      });

      if (buildResult.status !== 0) {
        throw new Error(
          `cargo build failed in fixture. stderr: ${buildResult.stderr.toString().slice(0, 500)}`,
        );
      }

      // Run cargo-mutants
      const result = spawnSync('cargo', ['mutants', '--file', 'src/lib.rs'], {
        cwd: fixture.rootDir,
        stdio: 'pipe',
        timeout: 120_000,
      });

      const stdout = result.stdout.toString().trim();

      // cargo-mutants text output contains MISSED / CAUGHT lines
      const missedCount = (stdout.match(/^MISSED\s+/gim) || []).length;
      const caughtCount = (stdout.match(/^CAUGHT\s+/gim) || []).length;
      const total = missedCount + caughtCount;

      expect(total).toBeGreaterThanOrEqual(1);

      // At least one mutant survived (the b == 0 branch is untested)
      expect(missedCount).toBeGreaterThanOrEqual(1);

      // Score is bounded: not 0% (some mutants killed), not 100% (b == 0 survives)
      const score = total > 0 ? (caughtCount / total) * 100 : 100;
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(100);
    },
    180_000,
  );
});
