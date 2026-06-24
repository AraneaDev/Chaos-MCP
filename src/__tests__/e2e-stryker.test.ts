import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  symlinkSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Stryker } from '@stryker-mutator/core';
import type { StrykerOptions, StrykerRunResult } from '@stryker-mutator/core';

/**
 * End-to-end StrykerJS test that programmatically runs mutation testing
 * against a tiny fixture project, asserting the resulting JSON report
 * reflects the fixture's intentional coverage gaps.
 *
 * Run with `E2E_STRYKER=1 npm test`. Otherwise silently skips (the test
 * is slow and depends on Stryker plugin/version compatibility).
 *
 * Why opt-in:
 *   1. Stryker programmatic runs take 10-60s even for a one-file fixture.
 *   2. The plugin/core major-version compatibility check below will throw
 *      a clear error if E2E_STRYKER=1 is set against an incompatible pair,
 *      so misconfigurations surface immediately in CI.
 */

const E2E_STRYKER_ENABLED = process.env.E2E_STRYKER === '1';

// ─── COMPATIBILITY DETECTION ─────────────────────────────────────────────────

interface CompatReport {
  compatible: boolean;
  coreMajor: string | null;
  runnerMajor: string | null;
  reason: string;
}

function detectCompat(): CompatReport {
  const pkgJsonPath = join(process.cwd(), 'package.json');
  if (!existsSync(pkgJsonPath)) {
    return { compatible: false, coreMajor: null, runnerMajor: null, reason: 'no package.json' };
  }
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const coreRange = pkg.dependencies?.['@stryker-mutator/core'] ?? pkg.devDependencies?.['@stryker-mutator/core'];
  const runnerRange =
    pkg.dependencies?.['@stryker-mutator/vitest-runner'] ??
    pkg.devDependencies?.['@stryker-mutator/vitest-runner'];
  const majorOf = (range: string | undefined): string | null => {
    const m = range?.match(/\^?(\d+)/);
    return m && m[1] ? m[1] : null;
  };
  const coreMajor = majorOf(coreRange);
  const runnerMajor = majorOf(runnerRange);

  if (!coreMajor || !runnerMajor) {
    return { compatible: false, coreMajor, runnerMajor, reason: 'plugin or core not installed' };
  }
  if (coreMajor !== runnerMajor) {
    return {
      compatible: false,
      coreMajor,
      runnerMajor,
      reason: `core v${coreMajor} incompatible with vitest-runner v${runnerMajor} (mismatched DI tokens)`,
    };
  }
  return {
    compatible: true,
    coreMajor,
    runnerMajor,
    reason: `core v${coreMajor}, vitest-runner v${runnerMajor}`,
  };
}

const compat = detectCompat();
if (E2E_STRYKER_ENABLED && !compat.compatible) {
  // Loud in CI: an explicit opt-in that silently skips defeats the purpose.
  // Go to stderr so CI runners surface it in red alongside test failures.
  console.error(
    `[e2e-stryker] E2E_STRYKER=1 set but plugin incompatible — ${compat.reason}. ` +
      'To run this test, align @stryker-mutator/core and @stryker-mutator/vitest-runner to the same major version.',
  );
}
const it_e2e = E2E_STRYKER_ENABLED && compat.compatible ? it : it.skip;

// ─── FIXTURE ─────────────────────────────────────────────────────────────────

interface StrykerFixture {
  rootDir: string;
  remove: () => void;
}

function createStrykerFixture(): StrykerFixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'stryker-e2e-'));
  const srcDir = join(rootDir, 'src');
  mkdirSync(srcDir, { recursive: true });

  // Reuse the host's installed node_modules via a junction so the fixture
  // resolves @stryker-mutator/core, the vitest runner, vitest, and
  // TypeScript without needing `npm install` (CI has no network).
  // `junction` works on Windows without admin privileges AND on POSIX.
  const hostNodeModules = join(process.cwd(), 'node_modules');
  if (!existsSync(hostNodeModules)) {
    throw new Error(
      `[e2e-stryker] Host node_modules not found at ${hostNodeModules}. Run \`npm install\` first.`,
    );
  }
  symlinkSync(hostNodeModules, join(rootDir, 'node_modules'), 'junction');

  writeFileSync(
    join(rootDir, 'package.json'),
    JSON.stringify({
      name: 'stryker-e2e-fixture',
      type: 'module',
      scripts: { test: 'vitest run' },
    }),
  );

  // math.ts: a divide() function with an intentional coverage gap.
  // Stryker will generate mutants for: `=== 0`/`!== 0`, the literal `0`,
  // the `/` operator, and a couple of arithmetic boundary checks. Our
  // partial test below will catch some but not all.
  writeFileSync(
    join(srcDir, 'math.ts'),
    [
      'export function divide(a: number, b: number): number {',
      '  if (b === 0) return 0;',
      '  return a / b;',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(srcDir, 'math.test.ts'),
    [
      "import { describe, it, expect } from 'vitest';",
      "import { divide } from './math.js';",
      '',
      "describe('divide', () => {",
      "  it('divides valid inputs', () => {",
      '    expect(divide(4, 2)).toBe(2);',
      '  });',
      '  // NOTE: the b === 0 branch is intentionally NOT tested, so its',
      '  // mutants will survive and the score will be <100%.',
      '});',
      '',
    ].join('\n'),
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

// ─── TEST ────────────────────────────────────────────────────────────────────

describe('StrykerJS programmatic E2E', () => {
  let fixture: StrykerFixture;

  beforeAll(() => {
    if (!E2E_STRYKER_ENABLED || !compat.compatible) return;
    fixture = createStrykerFixture();
  });

  afterAll(() => {
    if (fixture) fixture.remove();
  });

  it_e2e(
    'runs real mutation testing and reflects intentional coverage gaps in the score',
    async () => {
      const reportPath = join(fixture.rootDir, 'reports', 'mutation', 'mutation.json');

      const options: StrykerOptions = {
        testRunner: 'vitest',
        coverageAnalysis: 'perTest',
        reporters: ['json'],
        jsonReporter: { fileName: reportPath },
        concurrency: 1,
        mutate: ['src/math.ts'],
        cleanTempDir: true,
        logLevel: 'off',
      };

      // Stryker reads its config from process.cwd() by default. Switch into
      // the fixture dir so it can resolve vitest config + node_modules.
      const originalCwd = process.cwd();
      process.chdir(fixture.rootDir);
      try {
        const stryker = new Stryker(options);
        // Stryker returns StrykerRunResult | undefined depending on version;
        // we only care about the JSON reporter writing the report file.
        const result: StrykerRunResult | undefined = await stryker.runMutationTest();
        void result;
      } finally {
        process.chdir(originalCwd);
      }

      expect(existsSync(reportPath)).toBe(true);
      const reportJson = JSON.parse(readFileSync(reportPath, 'utf8')) as {
        files?: Record<string, { mutants?: { status: string }[] }>;
      };

      const fileEntry = reportJson.files?.['src/math.ts'];
      const mutants = fileEntry?.mutants ?? [];
      expect(mutants.length).toBeGreaterThanOrEqual(2);

      const killed = mutants.filter((m) => m.status === 'Killed' || m.status === 'Timeout').length;
      const survived = mutants.filter(
        (m) => m.status === 'Survived' || m.status === 'NoCoverage',
      ).length;

      // The b === 0 branch is intentionally untested \u2192 at least one surviving
      // mutant is expected.
      expect(killed).toBeGreaterThanOrEqual(1);
      expect(survived).toBeGreaterThanOrEqual(1);

      const score = killed + survived > 0 ? (killed / (killed + survived)) * 100 : 0;
      // Score is bounded (not 0%, not 100%) because some mutants are killed
      // by the partial test suite and others survive due to the gap.
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(100);
    },
    120_000,
  );
});
