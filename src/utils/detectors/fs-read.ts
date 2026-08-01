/**
 * Failure-tolerant file reads shared by the language detectors.
 *
 * Detection is best-effort by design: an unreadable or malformed workspace file
 * means "this signal is absent", never an error — a project with a broken
 * `package.json` must still be auditable via its other signals.
 *
 * Imports from `'fs'` rather than `'node:fs'` deliberately: the detector test
 * suite mocks the bare specifier, and the two are distinct module records.
 */
import { readFileSync } from 'fs';

/**
 * Read and parse a JSON file, returning `null` on any failure.
 * @internal
 */
export function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Read a file as UTF-8 text, returning `null` on any failure.
 * @internal
 */
export function readTextSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
