import { describe, it, expect, afterEach } from 'vitest';
import { resolve, join, delimiter } from 'node:path';
import { validateFilePath, describeBoundary } from '../utils/file-path.js';
import { toolError } from '../tool-result.js';
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
  return result.message;
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

  it('produces a well-formed text content block once an MCP caller wraps it', () => {
    // MCP clients dispatch on `type`; a blank one renders as an unknown block
    // and the rejection reason never reaches the caller. The validator no longer
    // builds the envelope itself (it is not an MCP-only helper), so this pins the
    // wrapping the three tool handlers apply: `toolError(result.message)`.
    const result = validateFilePath(undefined);
    if (result.ok) throw new Error('expected a rejection');
    const wrapped = toolError(result.message);
    expect(wrapped.isError).toBe(true);
    expect(wrapped.content[0].type).toBe('text');
    expect((wrapped.content[0] as { text: string }).text).toBe(result.message);
  });

  it('echoes the argument name it was given', () => {
    expect(errorText(validateFilePath(undefined, 'paths[0]'))).toContain('paths[0]');
  });
});

describe('describeBoundary', () => {
  it('names only the working directory when nothing is configured', () => {
    Reflect.deleteProperty(process.env, ALLOWED_ROOTS_ENV);
    expect(describeBoundary(CWD)).toBe(CWD);
  });

  it('lists the working directory alongside every configured root', () => {
    // The cwd must stay in the list: a grant ADDS roots, it never replaces the
    // process's own directory, and a rejection that omitted cwd would read as
    // "your own workspace is out of bounds".
    const other = resolve(CWD, '..', 'second-project');
    process.env[ALLOWED_ROOTS_ENV] = [OUTSIDE, other].join(delimiter);
    expect(describeBoundary(CWD)).toBe(`${CWD} or ${OUTSIDE} or ${other}`);
  });

  it('joins with " or " rather than concatenating the paths together', () => {
    // Pins the separator: `join('')` would render two roots as one unreadable
    // path, and every "contains that root" assertion would still pass.
    process.env[ALLOWED_ROOTS_ENV] = OUTSIDE;
    expect(describeBoundary(CWD)).toContain(' or ');
  });

  it('falls back to the working directory when the grant is only blank segments', () => {
    // `allowedWorkspaceRoots` drops blanks, so the list is empty and the
    // `length === 0` branch must still be taken.
    process.env[ALLOWED_ROOTS_ENV] = `${delimiter}   ${delimiter}`;
    expect(describeBoundary(CWD)).toBe(CWD);
  });
});
