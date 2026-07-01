import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { PhpEngine } from '../engines/php.js';

/**
 * End-to-end Infection test against a tiny PHP + PHPUnit fixture.
 * Run with `E2E_PHP=1 npm test`. Otherwise it silently skips.
 *
 * Prerequisites: php, composer, a coverage driver (Xdebug or PCOV),
 * and `composer require --dev infection/infection phpunit/phpunit` in the fixture.
 */
const E2E_PHP_ENABLED = process.env.E2E_PHP === '1';

function detectPhp(): { available: boolean; reason: string } {
  const php = spawnSync('php', ['--version'], { stdio: 'pipe', timeout: 5000 });
  if (php.status !== 0) return { available: false, reason: 'php not found' };
  const composer = spawnSync('composer', ['--version'], { stdio: 'pipe', timeout: 5000 });
  if (composer.status !== 0) return { available: false, reason: 'composer not found' };
  return { available: true, reason: '' };
}

const phpDetect = detectPhp();
const it_canary = it;
const it_heavy = E2E_PHP_ENABLED && phpDetect.available ? it : it.skip;

interface PhpFixture {
  rootDir: string;
  remove: () => void;
}

function createPhpFixture(): PhpFixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'infection-e2e-'));
  const srcDir = join(rootDir, 'src');
  const testsDir = join(rootDir, 'tests');
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(testsDir, { recursive: true });

  writeFileSync(
    join(srcDir, 'Calculator.php'),
    `<?php
namespace App;
class Calculator {
    public function max(int $a, int $b): int {
        if ($a > $b) { return $a; }
        return $b;
    }
}
`,
  );

  // Test covers max() but NOT the equal-values boundary, so the > → >= mutant survives.
  writeFileSync(
    join(testsDir, 'CalculatorTest.php'),
    `<?php
use App\\Calculator;
use PHPUnit\\Framework\\TestCase;
class CalculatorTest extends TestCase {
    public function testMax(): void {
        $this->assertSame(5, (new Calculator())->max(5, 3));
    }
}
`,
  );

  writeFileSync(
    join(rootDir, 'composer.json'),
    JSON.stringify(
      {
        name: 'chaos/e2e-fixture',
        require: {},
        'require-dev': { 'phpunit/phpunit': '^10 || ^11', 'infection/infection': '^0.27 || ^0.29' },
        autoload: { 'psr-4': { 'App\\\\': 'src/' } },
        config: { 'allow-plugins': { 'infection/extension-installer': true } },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(rootDir, 'phpunit.xml'),
    `<?xml version="1.0"?>
<phpunit bootstrap="vendor/autoload.php" colors="true">
  <testsuites>
    <testsuite name="unit"><directory>tests</directory></testsuite>
  </testsuites>
  <source><include><directory>src</directory></include></source>
</phpunit>
`,
  );

  return {
    rootDir,
    remove: () => {
      try {
        rmSync(rootDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

describe('Infection E2E', () => {
  let fixture: PhpFixture;

  beforeAll(() => {
    if (!E2E_PHP_ENABLED || !phpDetect.available) return;
    fixture = createPhpFixture();
    // Install deps once (Infection + PHPUnit) inside the fixture.
    spawnSync('composer', ['install', '--no-interaction', '--quiet'], {
      cwd: fixture.rootDir,
      stdio: 'pipe',
      timeout: 180_000,
    });
  }, 200_000);

  afterAll(() => {
    if (fixture) fixture.remove();
  });

  it_canary('fails loudly when E2E_PHP=1 is set but toolchain is missing', () => {
    if (!E2E_PHP_ENABLED) return;
    if (!phpDetect.available) {
      throw new Error(`[e2e-php] E2E_PHP=1 set but toolchain unavailable — ${phpDetect.reason}.`);
    }
  });

  it_heavy(
    'runs real Infection and reflects the intentional coverage gap in the score',
    async () => {
      const engine = new PhpEngine();
      const result = await engine.run('src/Calculator.php', { workDir: fixture.rootDir });

      expect(result.totalMutants).toBeGreaterThanOrEqual(1);
      // The > → >= boundary mutant survives (equal-values path untested).
      expect(result.survived).toBeGreaterThanOrEqual(1);
      const score = parseFloat(result.mutationScore);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThan(100);
    },
    240_000,
  );
});
