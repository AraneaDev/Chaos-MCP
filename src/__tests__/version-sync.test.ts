import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { APP_VERSION } from '../index.js';
import { CONTAINER_IMAGE_VERSION } from '../utils/execution.js';

/**
 * Verifies that the APP_VERSION exported from src/index.ts matches the
 * `version` field in package.json. This prevents version drift between
 * the source code and the published package metadata.
 *
 * The release process (CONTRIBUTING.md) requires updating both:
 *   1. `version` in package.json
 *   2. `APP_VERSION` in src/index.ts
 *
 * This test enforces that they stay in sync.
 */
describe('version sync', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const packageJsonPath = join(__dirname, '..', '..', 'package.json');

  it('APP_VERSION matches package.json version', () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      version: string;
    };
    expect(packageJson.version).toBeDefined();
    expect(APP_VERSION).toBe(packageJson.version);
    expect(CONTAINER_IMAGE_VERSION).toBe(packageJson.version);
  });

  it('APP_VERSION follows semver format (MAJOR.MINOR.PATCH)', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
