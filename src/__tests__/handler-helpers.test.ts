import { describe, it, expect, vi, beforeEach } from 'vitest';

// resolvePrebuildCommand probes the filesystem for go.mod / Cargo.toml.
vi.mock('fs', () => ({ existsSync: vi.fn(() => false) }));

import { existsSync } from 'fs';
import { validateToolArgs, buildRunOptions, resolvePrebuildCommand } from '../handler.js';
import type { EnvironmentInfo } from '../utils/project-detector.js';

const mockExistsSync = vi.mocked(existsSync);

/** Build an EnvironmentInfo with sensible defaults for the given overrides. */
function env(overrides: Partial<EnvironmentInfo> = {}): EnvironmentInfo {
  return {
    projectType: 'typescript',
    testRunner: 'vitest',
    detectedRunner: 'vitest',
    packageManager: '',
    workspaceRoot: '/ws',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
});

describe('validateToolArgs', () => {
  it('returns null when no optional args are provided', () => {
    expect(validateToolArgs({})).toBeNull();
  });

  // ── perMutantTimeoutMs ──
  it.each([0, -1, 'x', null])('rejects perMutantTimeoutMs=%p', (v) => {
    const res = validateToolArgs({ perMutantTimeoutMs: v });
    expect(res?.isError).toBe(true);
    expect((res?.content[0] as { text: string }).text).toContain('perMutantTimeoutMs');
  });
  it('accepts a positive perMutantTimeoutMs', () => {
    expect(validateToolArgs({ perMutantTimeoutMs: 100 })).toBeNull();
  });

  // ── prebuildCommand ──
  it.each(['', '   ', 123, true])('rejects prebuildCommand=%p', (v) => {
    const res = validateToolArgs({ prebuildCommand: v });
    expect(res?.isError).toBe(true);
    expect((res?.content[0] as { text: string }).text).toContain('prebuildCommand');
  });
  it('accepts a non-empty prebuildCommand', () => {
    expect(validateToolArgs({ prebuildCommand: 'npm run build' })).toBeNull();
  });

  // ── concurrency (integer 1..64) ──
  it.each([0, 65, 2.5, 'x', -1])('rejects concurrency=%p', (v) => {
    const res = validateToolArgs({ concurrency: v });
    expect(res?.isError).toBe(true);
    expect((res?.content[0] as { text: string }).text).toContain('concurrency');
  });
  it.each([1, 64, 8])('accepts concurrency=%p', (v) => {
    expect(validateToolArgs({ concurrency: v })).toBeNull();
  });

  // ── lineScope ──
  it.each([
    null,
    [],
    { start: 0, end: 5 },
    { start: 5, end: 1 },
    { start: 1.5, end: 5 },
    { start: 1, end: 2.5 },
    { start: '1', end: 5 },
  ])('rejects lineScope=%p', (v) => {
    const res = validateToolArgs({ lineScope: v });
    expect(res?.isError).toBe(true);
    expect((res?.content[0] as { text: string }).text).toContain('lineScope');
  });
  it.each([
    { start: 1, end: 1 },
    { start: 10, end: 45 },
  ])('accepts lineScope=%p', (v) => {
    expect(validateToolArgs({ lineScope: v })).toBeNull();
  });
});

describe('buildRunOptions', () => {
  it('prefers a positive args.timeoutMs over config', () => {
    const o = buildRunOptions(
      { timeoutMs: 5000 },
      { defaultTimeoutMs: 99 },
      env(),
      '/sb',
      'typescript',
    );
    expect(o.timeoutMs).toBe(5000);
  });

  it('falls back to engine-specific timeoutMs, then global default, when args omit it', () => {
    expect(
      buildRunOptions(
        {},
        { stryker: { timeoutMs: 222 }, defaultTimeoutMs: 99 },
        env(),
        '/sb',
        'typescript',
      ).timeoutMs,
    ).toBe(222);
    expect(
      buildRunOptions({}, { defaultTimeoutMs: 99 }, env(), '/sb', 'typescript').timeoutMs,
    ).toBe(99);
    // args.timeoutMs of 0 is not "positive" → falls back
    expect(
      buildRunOptions({ timeoutMs: 0 }, { defaultTimeoutMs: 99 }, env(), '/sb', 'typescript')
        .timeoutMs,
    ).toBe(99);
  });

  it('resolves TS testRunner precedence: stryker > global > env (mutmut ignored)', () => {
    // For TypeScript the Stryker section wins; Mutmut's runner must NOT leak in.
    expect(
      buildRunOptions(
        {},
        { stryker: { testRunner: 'a' }, mutmut: { testRunner: 'b' }, testRunner: 'c' },
        env(),
        '/sb',
        'typescript',
      ).testRunner,
    ).toBe('a');
    // Med#2: no stryker section → mutmut must NOT be used for a TS target; fall
    // through to the global default instead.
    expect(
      buildRunOptions(
        {},
        { mutmut: { testRunner: 'b' }, testRunner: 'c' },
        env(),
        '/sb',
        'typescript',
      ).testRunner,
    ).toBe('c');
    expect(buildRunOptions({}, { testRunner: 'c' }, env(), '/sb', 'typescript').testRunner).toBe(
      'c',
    );
    expect(buildRunOptions({}, {}, env({ testRunner: 'd' }), '/sb', 'typescript').testRunner).toBe(
      'd',
    );
  });

  it('resolves Python testRunner from the mutmut section, never from stryker', () => {
    // Both sections present → Python must take mutmut's runner, not Stryker's.
    expect(
      buildRunOptions(
        {},
        { stryker: { testRunner: 'vitest' }, mutmut: { testRunner: 'unittest' } },
        env({ testRunner: 'pytest' }),
        '/sb',
        'python',
      ).testRunner,
    ).toBe('unittest');
    // Only a stryker section → it must NOT leak into a Python run; fall through
    // to env's detected runner.
    expect(
      buildRunOptions(
        {},
        { stryker: { testRunner: 'vitest' } },
        env({ testRunner: 'pytest' }),
        '/sb',
        'python',
      ).testRunner,
    ).toBe('pytest');
  });

  it('uses the workDir passed in', () => {
    expect(buildRunOptions({}, {}, env(), '/sandbox-x', 'typescript').workDir).toBe('/sandbox-x');
  });

  it('passes through a valid lineScope, filters the denylist, and drops the allowlist', () => {
    const o = buildRunOptions(
      {
        lineScope: { start: 3, end: 9 },
        mutatorAllowlist: ['A', 1, 'B'],
        mutatorDenylist: ['C', null],
      },
      {},
      env(),
      '/sb',
      'typescript',
    );
    expect(o.lineScope).toEqual({ start: 3, end: 9 });
    expect(o.mutatorDenylist).toEqual(['C']);
    // High#3: mutatorAllowlist is unsupported in StrykerJS v9. It must never be
    // propagated into RunOptions (it would make the TS engine throw on every run).
    expect(o.mutatorAllowlist).toBeUndefined();
  });

  it('drops a config-provided mutatorAllowlist so it cannot break TS runs', () => {
    const o = buildRunOptions(
      {},
      { stryker: { mutatorAllowlist: ['ArithmeticOperator'] } },
      env(),
      '/sb',
      'typescript',
    );
    expect(o.mutatorAllowlist).toBeUndefined();
  });

  it('keeps args.concurrency only within 1..64, else falls back to config', () => {
    expect(buildRunOptions({ concurrency: 4 }, {}, env(), '/sb', 'typescript').concurrency).toBe(4);
    expect(buildRunOptions({ concurrency: 1 }, {}, env(), '/sb', 'typescript').concurrency).toBe(1);
    expect(buildRunOptions({ concurrency: 64 }, {}, env(), '/sb', 'typescript').concurrency).toBe(
      64,
    );
    // out of range → config fallback
    expect(
      buildRunOptions({ concurrency: 65 }, { concurrency: 3 }, env(), '/sb', 'typescript')
        .concurrency,
    ).toBe(3);
    // config out of range → undefined
    expect(
      buildRunOptions({}, { concurrency: 999 }, env(), '/sb', 'typescript').concurrency,
    ).toBeUndefined();
  });

  it('maps dryRun / incremental / outputFormat from args then config', () => {
    expect(buildRunOptions({ dryRun: true }, {}, env(), '/sb', 'typescript').dryRun).toBe(true);
    expect(
      buildRunOptions({}, { stryker: { dryRun: true } }, env(), '/sb', 'typescript').dryRun,
    ).toBe(true);
    expect(buildRunOptions({ incremental: true }, {}, env(), '/sb', 'typescript').incremental).toBe(
      true,
    );
    expect(
      buildRunOptions({ outputFormat: 'text' }, {}, env(), '/sb', 'typescript').outputFormat,
    ).toBe('text');
    expect(
      buildRunOptions({ outputFormat: 'bogus' }, {}, env(), '/sb', 'typescript').outputFormat,
    ).toBeUndefined();
  });

  it('keeps a positive args.perMutantTimeoutMs, else config, else undefined', () => {
    expect(
      buildRunOptions({ perMutantTimeoutMs: 10 }, {}, env(), '/sb', 'typescript')
        .perMutantTimeoutMs,
    ).toBe(10);
    expect(
      buildRunOptions({}, { perMutantTimeoutMs: 20 }, env(), '/sb', 'typescript')
        .perMutantTimeoutMs,
    ).toBe(20);
    expect(buildRunOptions({}, {}, env(), '/sb', 'typescript').perMutantTimeoutMs).toBeUndefined();
  });

  it('selects the engine-specific config section by project type', () => {
    expect(
      buildRunOptions(
        {},
        { mutmut: { timeoutMs: 7 } },
        env({ projectType: 'python' }),
        '/sb',
        'python',
      ).timeoutMs,
    ).toBe(7);
    expect(
      buildRunOptions({}, { go: { timeoutMs: 8 } }, env({ projectType: 'go' }), '/sb', 'go')
        .timeoutMs,
    ).toBe(8);
    expect(
      buildRunOptions({}, { rust: { timeoutMs: 9 } }, env({ projectType: 'rust' }), '/sb', 'rust')
        .timeoutMs,
    ).toBe(9);
  });
});

describe('resolvePrebuildCommand', () => {
  it('returns an explicit prebuildCommand verbatim', () => {
    expect(resolvePrebuildCommand({ prebuildCommand: 'make' }, env(), 'typescript')).toBe('make');
  });

  it('ignores a blank explicit prebuildCommand and falls through', () => {
    expect(resolvePrebuildCommand({ prebuildCommand: '   ' }, env(), 'typescript')).toBeNull();
  });

  it('does NOT auto-install for a uv Python project', () => {
    // Auto-running `uv sync` would install packages into the sandbox's `.venv`,
    // which is a symlink to the host's `.venv` — corrupting the real workspace.
    // The host's existing (symlinked) environment is already in place.
    expect(
      resolvePrebuildCommand({}, env({ projectType: 'python', packageManager: 'uv' }), 'python'),
    ).toBeNull();
  });

  it('does NOT auto-install for a poetry Python project', () => {
    expect(
      resolvePrebuildCommand(
        {},
        env({ projectType: 'python', packageManager: 'poetry' }),
        'python',
      ),
    ).toBeNull();
  });

  it('returns "go mod download" for Go when go.mod exists', () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith('go.mod'));
    expect(resolvePrebuildCommand({}, env({ projectType: 'go' }), 'go')).toBe('go mod download');
  });

  it('returns "cargo check" for Rust when Cargo.toml exists', () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith('Cargo.toml'));
    expect(resolvePrebuildCommand({}, env({ projectType: 'rust' }), 'rust')).toBe('cargo check');
  });

  it('returns null for Go when go.mod is absent', () => {
    mockExistsSync.mockReturnValue(false);
    expect(resolvePrebuildCommand({}, env({ projectType: 'go' }), 'go')).toBeNull();
  });

  it('returns null for a plain TypeScript or pip Python project', () => {
    expect(resolvePrebuildCommand({}, env(), 'typescript')).toBeNull();
    expect(
      resolvePrebuildCommand({}, env({ projectType: 'python', packageManager: 'pip' }), 'python'),
    ).toBeNull();
  });
});
