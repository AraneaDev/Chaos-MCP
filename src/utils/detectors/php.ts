/**
 * PHP workspace detection: Composer root markers and test-runner signals.
 */
import type { LanguageDetector } from './types.js';

/** Marker files that indicate a PHP project root. */
export const PHP_ROOT_MARKERS = ['composer.json'] as const;

/**
 * Detect the PHP test runner. v1 targets PHPUnit only: presence of
 * phpunit.xml / phpunit.xml.dist (or a project-supplied infection.json which
 * carries its own framework) resolves to 'phpunit'. Returns 'phpunit' as the
 * default since Infection defaults to PHPUnit.
 *
 * @internal Exported for testing only.
 */
export function detectPhpTestRunner(_workspaceRoot: string): string {
  return 'phpunit';
}

/**
 * Detect the raw PHP test runner without mapping.
 * @internal Exported for testing only.
 */
export function detectRawPhpRunner(workspaceRoot: string): string {
  return detectPhpTestRunner(workspaceRoot);
}

export const phpDetector: LanguageDetector = {
  matches: (p) => p.endsWith('.php'),
  extensions: ['.php'],
  markers: PHP_ROOT_MARKERS,
  testRunner: detectPhpTestRunner,
  rawRunner: detectRawPhpRunner,
};
