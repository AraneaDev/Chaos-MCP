import { describe, it, expect, afterEach } from 'vitest';
import { resolve, delimiter, join } from 'node:path';
import {
  ALLOWED_ROOTS_ENV,
  allowedWorkspaceRoots,
  isPathInside,
  isPathPermitted,
  isWorkspaceRootAllowed,
  workspaceRootBoundary,
} from '../utils/path-safety.js';

/** Restore the ambient environment so cases cannot leak into one another. */
const original = process.env[ALLOWED_ROOTS_ENV];
afterEach(() => {
  if (original === undefined) Reflect.deleteProperty(process.env, ALLOWED_ROOTS_ENV);
  else process.env[ALLOWED_ROOTS_ENV] = original;
});

const CWD = resolve(process.cwd());
const OUTSIDE = resolve(CWD, '..', 'some-other-project');
const OUTSIDE_CHILD = join(OUTSIDE, 'src', 'lib');

describe('isPathInside', () => {
  it('accepts the root itself and paths strictly inside it', () => {
    expect(isPathInside(CWD, CWD)).toBe(true);
    expect(isPathInside(join(CWD, 'src'), CWD)).toBe(true);
  });
  it('rejects parents and siblings', () => {
    expect(isPathInside(resolve(CWD, '..'), CWD)).toBe(false);
    expect(isPathInside(OUTSIDE, CWD)).toBe(false);
  });
});

describe('allowedWorkspaceRoots', () => {
  it('is empty when the variable is unset, empty, or only whitespace', () => {
    Reflect.deleteProperty(process.env, ALLOWED_ROOTS_ENV);
    expect(allowedWorkspaceRoots()).toEqual([]);
    process.env[ALLOWED_ROOTS_ENV] = '';
    expect(allowedWorkspaceRoots()).toEqual([]);
    process.env[ALLOWED_ROOTS_ENV] = '   ';
    expect(allowedWorkspaceRoots()).toEqual([]);
  });

  it('splits on the platform delimiter and resolves each entry to an absolute path', () => {
    process.env[ALLOWED_ROOTS_ENV] = [OUTSIDE, 'relative/dir'].join(delimiter);
    expect(allowedWorkspaceRoots()).toEqual([OUTSIDE, resolve('relative/dir')]);
  });

  it('drops blank segments rather than resolving them to the working directory', () => {
    // A stray delimiter (`/a::/b`) must not silently add cwd to the list.
    process.env[ALLOWED_ROOTS_ENV] = `${OUTSIDE}${delimiter}${delimiter}  ${delimiter}`;
    expect(allowedWorkspaceRoots()).toEqual([OUTSIDE]);
  });

  it('re-reads the environment on every call instead of caching at import', () => {
    Reflect.deleteProperty(process.env, ALLOWED_ROOTS_ENV);
    expect(allowedWorkspaceRoots()).toEqual([]);
    process.env[ALLOWED_ROOTS_ENV] = OUTSIDE;
    expect(allowedWorkspaceRoots()).toEqual([OUTSIDE]);
  });
});

describe('isWorkspaceRootAllowed', () => {
  it('allows the working directory and anything under it with no configuration', () => {
    Reflect.deleteProperty(process.env, ALLOWED_ROOTS_ENV);
    expect(isWorkspaceRootAllowed(CWD)).toBe(true);
    expect(isWorkspaceRootAllowed(join(CWD, 'src'))).toBe(true);
  });

  it('rejects a path outside the working directory when nothing is configured', () => {
    Reflect.deleteProperty(process.env, ALLOWED_ROOTS_ENV);
    expect(isWorkspaceRootAllowed(OUTSIDE)).toBe(false);
  });

  it('allows a configured root and its descendants', () => {
    process.env[ALLOWED_ROOTS_ENV] = OUTSIDE;
    expect(isWorkspaceRootAllowed(OUTSIDE)).toBe(true);
    expect(isWorkspaceRootAllowed(OUTSIDE_CHILD)).toBe(true);
  });

  it('still rejects a path outside every configured root', () => {
    // Widening to one root must not widen to its siblings or its parent.
    process.env[ALLOWED_ROOTS_ENV] = OUTSIDE;
    expect(isWorkspaceRootAllowed(resolve(CWD, '..', 'unlisted-project'))).toBe(false);
    expect(isWorkspaceRootAllowed(resolve(OUTSIDE, '..'))).toBe(false);
  });
});

describe('workspaceRootBoundary', () => {
  it('clamps to the working directory for files inside it', () => {
    process.env[ALLOWED_ROOTS_ENV] = OUTSIDE;
    expect(workspaceRootBoundary(join(CWD, 'src', 'utils'))).toBe(CWD);
  });

  it('clamps to the matching allowed root for files outside the working directory', () => {
    process.env[ALLOWED_ROOTS_ENV] = OUTSIDE;
    expect(workspaceRootBoundary(OUTSIDE_CHILD)).toBe(OUTSIDE);
  });

  it('picks the innermost root when configured roots nest', () => {
    // Clamping to the outer root would let the marker walk climb out of the
    // package and resolve the monorepo as the workspace instead.
    const inner = join(OUTSIDE, 'packages', 'api');
    process.env[ALLOWED_ROOTS_ENV] = [OUTSIDE, inner].join(delimiter);
    expect(workspaceRootBoundary(join(inner, 'src'))).toBe(inner);
  });

  it('picks the innermost root regardless of the order they are configured in', () => {
    // Same nesting, outer listed last. A "keep the most recent match" rule would
    // pass the previous case by luck of iteration order and fail here.
    const inner = join(OUTSIDE, 'packages', 'api');
    process.env[ALLOWED_ROOTS_ENV] = [inner, OUTSIDE].join(delimiter);
    expect(workspaceRootBoundary(join(inner, 'src'))).toBe(inner);
  });

  it('prefers the working directory over an allowed root that contains it', () => {
    // Listing a broad root (e.g. the parent of every checkout) must not widen
    // the marker walk for files in the working directory itself — the walk
    // would escape cwd and resolve an enclosing project as the workspace.
    process.env[ALLOWED_ROOTS_ENV] = resolve(CWD, '..');
    expect(workspaceRootBoundary(join(CWD, 'src', 'utils'))).toBe(CWD);
  });

  it('falls back to the working directory when no root matches', () => {
    process.env[ALLOWED_ROOTS_ENV] = OUTSIDE;
    expect(workspaceRootBoundary(resolve(CWD, '..', 'unlisted-project'))).toBe(CWD);
  });
});

describe('isPathPermitted', () => {
  it('accepts a file inside the working directory', () => {
    Reflect.deleteProperty(process.env, ALLOWED_ROOTS_ENV);
    expect(isPathPermitted(join(CWD, 'src', 'enrich.ts'))).toBe(true);
  });

  it('rejects a file outside every permitted root', () => {
    Reflect.deleteProperty(process.env, ALLOWED_ROOTS_ENV);
    expect(isPathPermitted(join(OUTSIDE, 'src', 'enrich.ts'))).toBe(false);
  });

  it('accepts a file inside a configured root', () => {
    // The `.some(...)` fallback is the whole point of the opt-in: without it,
    // CHAOS_ALLOWED_ROOTS is unreachable because handlers reject the path
    // before the sandbox ever sees it.
    process.env[ALLOWED_ROOTS_ENV] = OUTSIDE;
    expect(isPathPermitted(join(OUTSIDE_CHILD, 'enrich.ts'))).toBe(true);
  });

  it('grants exactly the same boundary as isWorkspaceRootAllowed', () => {
    // The two names exist for readability at their call sites (a file vs a
    // root); they must never drift into two different security boundaries.
    process.env[ALLOWED_ROOTS_ENV] = OUTSIDE;
    for (const candidate of [CWD, join(CWD, 'src'), OUTSIDE, OUTSIDE_CHILD, resolve(CWD, '..')]) {
      expect(isPathPermitted(candidate)).toBe(isWorkspaceRootAllowed(candidate));
    }
  });
});
