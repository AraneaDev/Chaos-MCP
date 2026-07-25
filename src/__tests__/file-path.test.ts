import { describe, it, expect, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { validateFilePath } from '../utils/file-path.js';
import { ALLOWED_ROOTS_ENV } from '../utils/path-safety.js';

/** Restore the ambient environment so cases cannot leak into one another. */
const original = process.env[ALLOWED_ROOTS_ENV];
afterEach(() => {
  if (original === undefined) Reflect.deleteProperty(process.env, ALLOWED_ROOTS_ENV);
  else process.env[ALLOWED_ROOTS_ENV] = original;
});

const CWD = resolve(process.cwd());
const OUTSIDE = resolve(CWD, '..', 'some-other-project');

const errorText = (result: ReturnType<typeof validateFilePath>): string => {
  if (result.ok) throw new Error('expected a rejection');
  return (result.error.content[0] as { text: string }).text;
};

const accepted = (result: ReturnType<typeof validateFilePath>): { resolvedFile: string } => {
  if (!result.ok) throw new Error(`expected acceptance, got: ${errorText(result)}`);
  return result.value;
};

describe('validateFilePath', () => {
  it('rejects a missing, non-string, or empty filePath', () => {
    expect(errorText(validateFilePath(undefined))).toContain('non-empty string');
    expect(errorText(validateFilePath(123))).toContain('non-empty string');
    expect(errorText(validateFilePath(''))).toContain('non-empty string');
  });

  it('accepts a path inside the working directory', () => {
    expect(accepted(validateFilePath('src/utils/math.ts')).resolvedFile).toBe(
      join(CWD, 'src/utils/math.ts'),
    );
  });

  it('rejects a path outside cwd when no roots are configured', () => {
    Reflect.deleteProperty(process.env, ALLOWED_ROOTS_ENV);
    expect(errorText(validateFilePath('../../etc/passwd'))).toContain(
      'must resolve within the workspace',
    );
  });

  // ─── CHAOS_ALLOWED_ROOTS opt-in ──────────────────────────────────────────

  /**
   * The opt-in exists so a server started in project A can audit project B.
   * Clamping this check to cwd made it unreachable: every tool call was
   * rejected here, before the sandbox — the layer the opt-in was built into —
   * ever saw the path.
   */
  it('accepts a path inside a CHAOS_ALLOWED_ROOTS entry', () => {
    process.env[ALLOWED_ROOTS_ENV] = OUTSIDE;
    const target = join(OUTSIDE, 'src', 'enrich.ts');

    expect(accepted(validateFilePath(target)).resolvedFile).toBe(target);
  });

  it('still rejects a path that no allowed root covers', () => {
    process.env[ALLOWED_ROOTS_ENV] = OUTSIDE;
    const unlisted = resolve(CWD, '..', 'unlisted-project', 'src/enrich.ts');

    expect(errorText(validateFilePath(unlisted))).toContain('must resolve within the workspace');
  });

  it('names the configured roots when it rejects, so the grant is debuggable', () => {
    process.env[ALLOWED_ROOTS_ENV] = OUTSIDE;
    const unlisted = resolve(CWD, '..', 'unlisted-project', 'src/enrich.ts');

    expect(errorText(validateFilePath(unlisted))).toContain(OUTSIDE);
  });

  it('echoes the argument name it was given', () => {
    expect(errorText(validateFilePath(undefined, 'paths[0]'))).toContain('paths[0]');
  });
});
