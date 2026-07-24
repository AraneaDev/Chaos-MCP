import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// resolvePrebuildCommand probes the filesystem for go.mod / Cargo.toml.
vi.mock('fs', () => ({ existsSync: vi.fn(() => false) }));

import { existsSync } from 'fs';
import {
  validateToolArgs,
  buildRunOptions,
  buildVitestRelatedCommand,
  quoteCommandArg,
  resolveAuditTimeoutMs,
  resolvePrebuildCommand,
  auditFile,
  isPrebuildAllowed,
} from '../handler.js';
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

  // ── diffBase ──
  it('rejects non-string diffBase', () => {
    expect(validateToolArgs({ diffBase: 5 })?.isError).toBe(true);
  });

  it('rejects empty/whitespace diffBase', () => {
    expect(validateToolArgs({ diffBase: '   ' })?.isError).toBe(true);
  });

  it('rejects diffBase starting with "-" (ref safety)', () => {
    expect(validateToolArgs({ diffBase: '--output=/etc/passwd' })?.isError).toBe(true);
  });

  it('rejects diffBase together with lineScope', () => {
    expect(validateToolArgs({ diffBase: 'HEAD', lineScope: { start: 1, end: 2 } })?.isError).toBe(
      true,
    );
  });

  it('accepts a valid diffBase alone', () => {
    expect(validateToolArgs({ diffBase: 'HEAD' })).toBeNull();
  });

  describe('baseline', () => {
    const sv = { survivors: [{ line: 42, mutators: { C: 1 } }] };

    it('accepts a well-formed baseline alone', () => {
      expect(validateToolArgs({ baseline: sv })).toBeNull();
    });

    it('rejects a non-object baseline', () => {
      expect(validateToolArgs({ baseline: 'nope' })?.isError).toBe(true);
    });

    it('rejects baseline with a non-array survivors', () => {
      expect(validateToolArgs({ baseline: { survivors: {} } })?.isError).toBe(true);
    });

    it('rejects baseline entries with a bad line', () => {
      expect(
        validateToolArgs({ baseline: { survivors: [{ line: 0, mutators: { C: 1 } }] } })?.isError,
      ).toBe(true);
    });

    it('rejects an empty baseline (no mutator pairs)', () => {
      expect(validateToolArgs({ baseline: { survivors: [] } })?.isError).toBe(true);
    });

    it('rejects baseline together with diffBase', () => {
      expect(validateToolArgs({ baseline: sv, diffBase: 'HEAD' })?.isError).toBe(true);
    });

    it('rejects baseline together with lineScope', () => {
      expect(validateToolArgs({ baseline: sv, lineScope: { start: 1, end: 2 } })?.isError).toBe(
        true,
      );
    });

    it('rejects a baseline entry whose mutators is not an object', () => {
      expect(
        validateToolArgs({ baseline: { survivors: [{ line: 1, mutators: [1, 2] }] } })?.isError,
      ).toBe(true);
    });

    it('rejects a baseline entry with an empty mutator name', () => {
      // Otherwise parseBaseline builds a bogus empty-mutator key from it.
      expect(
        validateToolArgs({ baseline: { survivors: [{ line: 1, mutators: { '': 1 } }] } })?.isError,
      ).toBe(true);
    });

    it('validates the noCoverage array the same way as survivors', () => {
      expect(
        validateToolArgs({ baseline: { noCoverage: [{ line: 0, mutators: { A: 1 } }] } })?.isError,
      ).toBe(true);
    });
  });

  // ── maxSurvivors ──
  describe('validateToolArgs phase-1 args', () => {
    it('rejects non-integer maxSurvivors', () => {
      const err = validateToolArgs({ maxSurvivors: 2.5 });
      expect(err?.isError).toBe(true);
      expect((err?.content[0] as { text: string }).text).toContain('maxSurvivors');
    });
    it('rejects maxSurvivors < 1', () => {
      expect(validateToolArgs({ maxSurvivors: 0 })?.isError).toBe(true);
    });
    it('accepts a valid maxSurvivors', () => {
      expect(validateToolArgs({ maxSurvivors: 25 })).toBeNull();
    });
    it('rejects an unknown severityFloor', () => {
      const err = validateToolArgs({ severityFloor: 'critical' });
      expect(err?.isError).toBe(true);
      expect((err?.content[0] as { text: string }).text).toContain('severityFloor');
    });
    it('accepts a valid severityFloor', () => {
      expect(validateToolArgs({ severityFloor: 'high' })).toBeNull();
    });
    it('accepts severityFloor medium', () => {
      expect(validateToolArgs({ severityFloor: 'medium' })).toBeNull();
    });
    it('accepts severityFloor low', () => {
      expect(validateToolArgs({ severityFloor: 'low' })).toBeNull();
    });
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

  it('resolves TS testRunner precedence: stryker > global > env (cosmicray ignored)', () => {
    // For TypeScript the Stryker section wins; Mutmut's runner must NOT leak in.
    expect(
      buildRunOptions(
        {},
        { stryker: { testRunner: 'a' }, cosmicray: { testRunner: 'b' }, testRunner: 'c' },
        env(),
        '/sb',
        'typescript',
      ).testRunner,
    ).toBe('a');
    // Med#2: no stryker section → cosmicray must NOT be used for a TS target; fall
    // through to the global default instead.
    expect(
      buildRunOptions(
        {},
        { cosmicray: { testRunner: 'b' }, testRunner: 'c' },
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

  it('auto-scopes Vitest 3 command-runner audits to tests related to the target', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    try {
      const options = buildRunOptions(
        {},
        {},
        env({ testRunner: 'command', detectedRunner: 'vitest' }),
        '/sb',
        'typescript',
        'src/my module.ts',
      );

      expect(options.commandRunnerCommand).toBe("npx vitest related 'src/my module.ts' --run");
    } finally {
      platform.mockRestore();
    }
  });

  it('quotes unsafe POSIX targets and rejects unsafe Windows command strings', () => {
    expect(quoteCommandArg('src/app-file.ts')).toBe('src/app-file.ts');
    const platform = vi.spyOn(process, 'platform', 'get');
    try {
      platform.mockReturnValue('linux');
      expect(buildVitestRelatedCommand("src/a'b.ts")).toBe(
        "npx vitest related 'src/a'\\''b.ts' --run",
      );
      platform.mockReturnValue('win32');
      expect(buildVitestRelatedCommand('src/app.ts')).toBe('npx vitest related src/app.ts --run');
      expect(buildVitestRelatedCommand('src/my module.ts')).toBeUndefined();
      expect(buildVitestRelatedCommand('src/a&whoami.ts')).toBeUndefined();
      expect(buildVitestRelatedCommand('src/a"b.ts')).toBeUndefined();
    } finally {
      platform.mockRestore();
    }
  });

  it('does not invent a scoped command for native or non-Vitest runners', () => {
    expect(
      buildRunOptions(
        {},
        {},
        env({ testRunner: 'vitest', detectedRunner: 'vitest' }),
        '/sb',
        'typescript',
        'src/app.ts',
      ).commandRunnerCommand,
    ).toBeUndefined();
    expect(
      buildRunOptions(
        {},
        {},
        env({ testRunner: 'command', detectedRunner: 'node:test' }),
        '/sb',
        'typescript',
        'src/app.ts',
      ).commandRunnerCommand,
    ).toBeUndefined();
    expect(
      buildRunOptions(
        {},
        {},
        env({ testRunner: 'command', detectedRunner: 'vitest' }),
        '/sb',
        'python',
        'src/app.py',
      ).commandRunnerCommand,
    ).toBeUndefined();
  });

  it('falls back safely when resolving an unsupported project timeout', () => {
    expect(resolveAuditTimeoutMs({}, { defaultTimeoutMs: 1234 }, 'cobol' as never)).toBe(1234);
  });

  it('resolves Python testRunner from the cosmicray section, never from stryker', () => {
    // Both sections present → Python must take cosmicray's runner, not Stryker's.
    expect(
      buildRunOptions(
        {},
        { stryker: { testRunner: 'vitest' }, cosmicray: { testRunner: 'unittest' } },
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

  it('resolves concurrency from the engine section matching the project type', () => {
    // Rust audit reads rust.concurrency, NOT stryker.concurrency
    expect(
      buildRunOptions(
        {},
        { stryker: { concurrency: 9 }, rust: { concurrency: 3 } },
        env(),
        '/w',
        'rust',
      ).concurrency,
    ).toBe(3);
    // TS audit still reads stryker.concurrency
    expect(
      buildRunOptions(
        {},
        { stryker: { concurrency: 9 }, rust: { concurrency: 3 } },
        env(),
        '/w',
        'typescript',
      ).concurrency,
    ).toBe(9);
    // arg overrides the section; section overrides global
    expect(
      buildRunOptions({ concurrency: 5 }, { rust: { concurrency: 3 } }, env(), '/w', 'rust')
        .concurrency,
    ).toBe(5);
    expect(buildRunOptions({}, { concurrency: 7 }, env(), '/w', 'rust').concurrency).toBe(7);
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
        { cosmicray: { timeoutMs: 7 } },
        env({ projectType: 'python' }),
        '/sb',
        'python',
      ).timeoutMs,
    ).toBe(7);
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

  it('returns "cargo check" for Rust when Cargo.toml exists', () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith('Cargo.toml'));
    expect(resolvePrebuildCommand({}, env({ projectType: 'rust' }), 'rust')).toBe('cargo check');
  });

  it('returns null for a plain TypeScript or pip Python project', () => {
    expect(resolvePrebuildCommand({}, env(), 'typescript')).toBeNull();
    expect(
      resolvePrebuildCommand({}, env({ projectType: 'python', packageManager: 'pip' }), 'python'),
    ).toBeNull();
  });
});

// Mutation hardening: the baseline validator's per-arm survivors. The existing
// baseline tests assert only `.isError`, so a mutant that still errors (via a
// different arm/message) survives. These pin the *specific* message and the
// arms whose mutation would otherwise let a malformed entry through (or crash
// on a null deref) instead of returning a clean error.
describe('validateToolArgs — baseline arms', () => {
  /** Extract the error text from a CallToolResult. */
  const msg = (r: ReturnType<typeof validateToolArgs>): string =>
    (r?.content[0] as { text: string }).text;

  it('reports the "must be an object" message for a non-object baseline', () => {
    // Mutating `typeof b !== 'object' → false` lets a string fall through to the
    // generic "must contain at least one" message; pin the specific one.
    expect(msg(validateToolArgs({ baseline: 'nope' }))).toContain('must be an object');
  });

  it('accepts a baseline entry at the line lower bound of 1', () => {
    // Kills the `line < 1 → line <= 1` boundary mutant (which would reject 1).
    expect(
      validateToolArgs({ baseline: { survivors: [{ line: 1, mutators: { C: 1 } }] } }),
    ).toBeNull();
  });

  it('rejects a null baseline entry without dereferencing it', () => {
    // `entry === null → false` would skip the null guard and crash on `.line`.
    expect(validateToolArgs({ baseline: { survivors: [null] } })?.isError).toBe(true);
  });

  it('rejects a baseline entry whose mutators is null', () => {
    // `entry.mutators === null → false` would let null through to Object.keys().
    expect(
      validateToolArgs({ baseline: { survivors: [{ line: 1, mutators: null }] } })?.isError,
    ).toBe(true);
  });

  it('rejects a baseline entry whose mutators is a string', () => {
    // `typeof entry.mutators !== 'object' → false` would accept a string (whose
    // Object.keys are indices), inflating pairCount and passing validation.
    expect(
      validateToolArgs({ baseline: { survivors: [{ line: 1, mutators: 'x' }] } })?.isError,
    ).toBe(true);
  });

  it('reports the "must be an object" message for a null baseline', () => {
    // `b === null → false` would skip the null guard and crash dereferencing
    // b['survivors']; the real code returns the specific object-shape message.
    expect(msg(validateToolArgs({ baseline: null }))).toContain('must be an object');
  });
});

describe('buildRunOptions — mutation hardening', () => {
  it('never sources a testRunner from the cosmicray section for a non-cosmicray engine', () => {
    // `configKey === 'cosmicray' → true` would leak cosmicray's runner into a Rust run.
    expect(
      buildRunOptions(
        {},
        { cosmicray: { testRunner: 'leaked' } },
        env({ projectType: 'rust', testRunner: 'cargotest' }),
        '/sb',
        'rust',
      ).testRunner,
    ).toBe('cargotest');
  });

  it('ignores a non-number args.timeoutMs and falls back to config', () => {
    // `typeof args.timeoutMs === 'number' → true` would accept the coercible
    // numeric string '5' (since '5' > 0 is truthy) instead of falling back.
    expect(
      buildRunOptions({ timeoutMs: '5' }, { defaultTimeoutMs: 99 }, env(), '/sb', 'typescript')
        .timeoutMs,
    ).toBe(99);
  });

  it('honours outputFormat "json"', () => {
    // Kills `args.outputFormat === 'json' → false` and the '' string mutant.
    expect(
      buildRunOptions({ outputFormat: 'json' }, {}, env(), '/sb', 'typescript').outputFormat,
    ).toBe('json');
  });

  it('filters non-string entries out of ignorePatterns', () => {
    // Kills the dropped `.filter` and `typeof v === 'string' → true` mutants.
    expect(
      buildRunOptions({ ignorePatterns: ['a', 1, 'b', null] }, {}, env(), '/sb', 'typescript')
        .ignorePatterns,
    ).toEqual(['a', 'b']);
  });

  it('rejects an out-of-range args.concurrency of 0 in favour of the config fallback', () => {
    // isValidConcurrency's `v >= 1 → true` mutant would accept 0; assert the
    // config value wins instead. (Boundary below the lower bound of 1.)
    expect(
      buildRunOptions({ concurrency: 0 }, { concurrency: 3 }, env(), '/sb', 'typescript')
        .concurrency,
    ).toBe(3);
  });

  it('ignores a non-number args.perMutantTimeoutMs and falls back to config', () => {
    // isPositiveMs's `typeof v === 'number' → true` would accept the coercible
    // string '5' (since '5' > 0 is truthy) instead of falling back to config.
    expect(
      buildRunOptions(
        { perMutantTimeoutMs: '5' },
        { perMutantTimeoutMs: 20 },
        env(),
        '/sb',
        'typescript',
      ).perMutantTimeoutMs,
    ).toBe(20);
  });
});

// The prebuild opt-in gate. The config branch (`cfg.allowPrebuild === true`) is
// covered by handleToolCall tests, but the CHAOS_MCP_ALLOW_PREBUILD env-var
// branch was entirely untested — a gap on a security boundary (it gates running
// an arbitrary shell command that can escape the sandbox).
describe('isPrebuildAllowed', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.CHAOS_MCP_ALLOW_PREBUILD;
    delete process.env.CHAOS_MCP_ALLOW_PREBUILD;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CHAOS_MCP_ALLOW_PREBUILD;
    else process.env.CHAOS_MCP_ALLOW_PREBUILD = saved;
  });

  it('allows prebuild when config opts in, regardless of the env var', () => {
    expect(isPrebuildAllowed({ allowPrebuild: true })).toBe(true);
  });

  it('allows prebuild when the env var is exactly "1"', () => {
    process.env.CHAOS_MCP_ALLOW_PREBUILD = '1';
    expect(isPrebuildAllowed({})).toBe(true);
  });

  it('allows prebuild when the env var is exactly "true"', () => {
    process.env.CHAOS_MCP_ALLOW_PREBUILD = 'true';
    expect(isPrebuildAllowed({})).toBe(true);
  });

  it('does NOT allow prebuild for any other env-var value', () => {
    // Kills `flag === '1' || … → false`, the `|| → &&` swap, and each literal
    // mutation: only the exact tokens '1' / 'true' may enable it.
    for (const v of ['0', 'false', 'yes', 'TRUE', '']) {
      process.env.CHAOS_MCP_ALLOW_PREBUILD = v;
      expect(isPrebuildAllowed({})).toBe(false);
    }
  });

  it('does NOT allow prebuild when neither config nor env opts in', () => {
    expect(isPrebuildAllowed({})).toBe(false);
  });
});

describe('auditFile', () => {
  it('builds run options for the sandbox workDir and returns the engine result', async () => {
    const result = {
      target: 'src/x.ts',
      totalMutants: 2,
      killed: 2,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    };
    const run = vi.fn().mockResolvedValue(result);
    const out = await auditFile({
      targetFile: 'src/x.ts',
      env: env(),
      projectType: 'typescript',
      engine: { run } as never,
      args: {},
      config: {},
      workDir: '/tmp/sandbox',
      prebuildCmd: null,
    });
    expect(out).toBe(result);
    expect(run).toHaveBeenCalledWith(
      'src/x.ts',
      expect.objectContaining({ workDir: '/tmp/sandbox' }),
    );
  });
});
