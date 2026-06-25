import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

/**
 * End-to-end go-mutesting test that spawns the mutation tool against a tiny
 * fixture Go project, asserting that mutants are generated and some survive.
 *
 * Run with `E2E_GO=1 npm test`. Otherwise the heavy mutation test silently
 * skips (go-mutesting takes 5-30s even for a one-file fixture).
 *
 * Prerequisites:
 *   - Go toolchain (go 1.21+)
 *   - go-mutesting: `go install github.com/zimmski/go-mutesting/cmd/go-mutesting@latest`
 *
 * Why opt-in:
 *   1. go-mutesting runs take 5-30s even for a one-file fixture.
 *   2. The tool is not a Node.js dependency — it must be installed separately.
 */

const E2E_GO_ENABLED = process.env.E2E_GO === '1';

// ─── DETECTION ───────────────────────────────────────────────────────────────

function detectGo(): { available: boolean; reason: string } {
  // Check go binary
  const goCheck = spawnSync('go', ['version'], { stdio: 'pipe', timeout: 5000 });
  if (goCheck.status !== 0) {
    return { available: false, reason: 'go toolchain not found (install go 1.21+)' };
  }

  // Check go-mutesting binary — Go CLI tools conventionally use single-dash
  // flags. Try `-h` first; some versions respond to `--help`.
  const mutCheck = spawnSync('go-mutesting', ['-h'], { stdio: 'pipe', timeout: 5000 });
  const helpOutput = mutCheck.stdout.toString() + mutCheck.stderr.toString();
  if (mutCheck.status !== 0 && !helpOutput.toLowerCase().includes('usage')) {
    return {
      available: false,
      reason:
        'go-mutesting not found (run: go install github.com/zimmski/go-mutesting/cmd/go-mutesting@latest)',
    };
  }

  return { available: true, reason: '' };
}

const goDetect = detectGo();

// Always-on canary: cheap, runs even when E2E_GO is unset. THROWS
// when E2E_GO=1 is set but the toolchain is missing, so misconfigured
// CI fails loudly instead of silently skipping.
const it_canary = it;

// Heavy test: only runs when env + toolchain are both good.
const it_heavy = E2E_GO_ENABLED && goDetect.available ? it : it.skip;

if (E2E_GO_ENABLED && !goDetect.available) {
  console.error(
    `[e2e-go] E2E_GO=1 set but toolchain unavailable — ${goDetect.reason}. ` +
      'Install Go and go-mutesting, or unset E2E_GO if you do not intend to run this E2E.',
  );
}

// ─── FIXTURE ─────────────────────────────────────────────────────────────────

interface GoFixture {
  rootDir: string;
  remove: () => void;
}

function createGoFixture(): GoFixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'go-mutesting-e2e-'));
  // go-mutesting expects a module structure; we use a flat layout
  // with the source file at the module root.

  // go.mod
  writeFileSync(
    join(rootDir, 'go.mod'),
    `module e2e-fixture

go 1.21
`,
  );

  // math.go: a divide() function with an intentional coverage gap
  writeFileSync(
    join(rootDir, 'math.go'),
    `package main

func Divide(a, b int) int {
	if b == 0 {
		return 0
	}
	return a / b
}
`,
  );

  // math_test.go: tests the valid case but NOT the b == 0 branch
  writeFileSync(
    join(rootDir, 'math_test.go'),
    `package main

import "testing"

func TestDivide(t *testing.T) {
	result := Divide(4, 2)
	if result != 2 {
		t.Errorf("Divide(4, 2) = %d; want 2", result)
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

describe('go-mutesting E2E', () => {
  let fixture: GoFixture;

  beforeAll(() => {
    if (!E2E_GO_ENABLED || !goDetect.available) return;
    fixture = createGoFixture();
  });

  afterAll(() => {
    if (fixture) fixture.remove();
  });

  // ── Loud canary ────────────────────────────────────────────────────────────
  it_canary('fails loudly when E2E_GO=1 is set but toolchain is missing', () => {
    if (!E2E_GO_ENABLED) {
      return;
    }
    if (!goDetect.available) {
      throw new Error(
        `[e2e-go] E2E_GO=1 set but toolchain unavailable — ${goDetect.reason}. ` +
          'Install Go and go-mutesting, or unset E2E_GO if you do not intend to run this E2E.',
      );
    }
  });

  // ── Heavy mutation test ────────────────────────────────────────────────────
  it_heavy(
    'runs real mutation testing and reflects intentional coverage gaps in the score',
    async () => {
      // Run go-mutesting against math.go
      const result = spawnSync('go-mutesting', ['math.go'], {
        cwd: fixture.rootDir,
        stdio: 'pipe',
        timeout: 60_000,
      });

      const stdout = result.stdout.toString().trim();

      // go-mutesting exits non-zero when mutants survive OR when
      // baseline tests fail. We verify stdout has parseable results.
      expect(stdout.length).toBeGreaterThan(0);

      // Count PASS and FAIL lines
      const passCount = (stdout.match(/^PASS\s+/gm) || []).length;
      const failCount = (stdout.match(/^FAIL\s+/gm) || []).length;
      const total = passCount + failCount;

      expect(total).toBeGreaterThanOrEqual(1);

      // At least one mutant survived (the b == 0 branch is untested)
      expect(failCount).toBeGreaterThanOrEqual(1);

      // Score is bounded: not 0% (some mutants killed), not 100% (b == 0 survives)
      const score = total > 0 ? (passCount / total) * 100 : 100;
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(100);
    },
    120_000,
  );
});
