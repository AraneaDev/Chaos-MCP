import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { supportedTypeOf, resolveAuditTarget, resolveAuditTargetIn } from '../audit/target.js';

/**
 * `audit/target.ts` had no test file. It turns a caller-supplied path into an
 * engine-ready target, and the part worth pinning is the re-anchoring: `rawPath` is
 * relative to process.cwd(), but the sandbox copies `env.workspaceRoot`, which in a
 * monorepo is a SUBDIRECTORY of cwd. The engine's mutate target and the sandbox's
 * file-exists check both have to use the workspace-relative path, not the cwd-relative
 * one, or the engine is handed a path that does not exist inside the sandbox.
 */

let ws: string;
let cwdSpy: { mockRestore: () => void } | undefined;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'chaos-target-'));
});

afterEach(() => {
  cwdSpy?.mockRestore();
  cwdSpy = undefined;
  rmSync(ws, { recursive: true, force: true });
});

describe('supportedTypeOf', () => {
  it.each([
    ['src/a.ts', 'typescript'],
    ['src/a.tsx', 'typescript'],
    ['src/a.js', 'typescript'],
    ['src/a.py', 'python'],
    ['src/a.rs', 'rust'],
    ['src/a.php', 'php'],
  ])('maps %s to the %s engine', (path, expected) => {
    expect(supportedTypeOf(path)).toBe(expected);
  });

  it.each(['README.md', 'a.txt', 'Makefile', 'a.tsx.bak'])(
    'returns null for %s, which maps to no engine',
    (path) => {
      // null, not 'unsupported': callers branch on falsiness to reject the request, and
      // a truthy 'unsupported' string would be dispatched to an engine that cannot run.
      expect(supportedTypeOf(path)).toBeNull();
    },
  );
});

describe('resolveAuditTarget', () => {
  it('refuses a path whose extension maps to no engine', () => {
    expect(resolveAuditTarget('README.md', resolve(ws, 'README.md'))).toBeNull();
  });

  it('re-anchors the target onto the detected workspace root', () => {
    // A monorepo shape: the package (with its own package.json) sits BELOW cwd, so the
    // workspace root detection lands on the package and the cwd-relative path
    // 'packages/app/src/a.ts' must be re-anchored to 'src/a.ts'.
    mkdirSync(join(ws, 'packages', 'app', 'src'), { recursive: true });
    writeFileSync(join(ws, 'packages', 'app', 'package.json'), '{"name":"app"}');
    writeFileSync(join(ws, 'packages', 'app', 'src', 'a.ts'), 'export const a = 1;\n');

    const rel = 'packages/app/src/a.ts';
    const target = resolveAuditTarget(join(ws, rel), join(ws, rel));

    expect(target).not.toBeNull();
    if (!target) return;
    expect(target.projectType).toBe('typescript');
    expect(target.env.workspaceRoot).toBe(join(ws, 'packages', 'app'));
    // The engine and the sandbox both consume this, and it must be relative to the
    // workspace root rather than to cwd.
    expect(target.relFromRoot).toBe('src/a.ts');
  });
});

describe('resolveAuditTargetIn', () => {
  it('resolves a discovered file against the sweep root', () => {
    // The triage sweep holds a root and workspace-relative file names rather than
    // absolute paths; this overload is what keeps those two callers in step.
    //
    // cwd is pinned to the sweep root because that is the only condition this function
    // is correct under: it forwards `file` as the RAW path, and detectEnvironment walks
    // up from process.cwd() to find the workspace. Its sole caller
    // (triage/audit-one.ts:373) is fed `rootCwd = resolve(process.cwd())` from
    // triage-handler.ts:181, so the precondition holds in production — but pass a
    // rootCwd that is not cwd and relFromRoot escapes the workspace with '../..'.
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'package.json'), '{"name":"app"}');
    writeFileSync(join(ws, 'src', 'a.ts'), 'export const a = 1;\n');
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(ws);

    const target = resolveAuditTargetIn(ws, 'src/a.ts');

    expect(target).not.toBeNull();
    if (!target) return;
    expect(target.projectType).toBe('typescript');
    expect(target.relFromRoot).toBe('src/a.ts');
  });

  it('refuses an unsupported file discovered under the sweep root', () => {
    expect(resolveAuditTargetIn(ws, 'docs/readme.md')).toBeNull();
  });
});
