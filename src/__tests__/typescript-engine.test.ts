import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the async exec helper
vi.mock('../utils/exec.js', () => ({
  runShell: vi.fn(),
  ExecFailureError: class ExecFailureError extends Error {
    stdout = '';
    stderr = '';
    exit: number | null = null;
    signal: NodeJS.Signals | null = null;
    code: string | undefined;
    constructor(
      result: {
        stdout: string;
        stderr: string;
        exit: number | null;
        signal: NodeJS.Signals | null;
        code?: string;
      },
      message: string,
    ) {
      super(message);
      this.name = 'ExecFailureError';
      this.stdout = result.stdout;
      this.stderr = result.stderr;
      this.exit = result.exit;
      this.signal = result.signal;
      this.code = result.code;
    }
  },
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  log: vi.fn(),
  isVerbose: vi.fn().mockReturnValue(false),
}));

// Mock fs for report parsing and config-file writes (StrykerJS v9)
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

import { runShell, ExecFailureError } from '../utils/exec.js';
import { existsSync, readFileSync } from 'fs';
import { TypeScriptEngine } from '../engines/typescript.js';

const mockRunShell = vi.mocked(runShell);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

function makeExecResult(
  stdout = '',
  stderr = '',
): { stdout: string; stderr: string; exit: number; signal: null } {
  return { stdout, stderr, exit: 0, signal: null };
}

function makeExecFailure(opts: {
  exit?: number | null;
  signal?: NodeJS.Signals | null;
  code?: string;
  stdout?: string;
  stderr?: string;
}): Error {
  // ExecFailureError is imported at top level — vi.mock replaces it with the mock class
  return new ExecFailureError(
    {
      stdout: opts.stdout ?? '',
      stderr: opts.stderr ?? '',
      exit: opts.exit ?? null,
      signal: opts.signal ?? null,
      code: opts.code,
    },
    `Command failed`,
  );
}

function makeJsonReport(mutants: { status: string; mutatorName: string; line: number }[]) {
  return JSON.stringify({
    files: {
      'src/test.ts': {
        source: 'const x = 1;',
        mutants: mutants.map((m, i) => ({
          id: String(i + 1),
          mutatorName: m.mutatorName,
          replacement: '',
          location: {
            start: { line: m.line, column: 0 },
            end: { line: m.line, column: 10 },
          },
          status: m.status,
        })),
      },
    },
  });
}

describe('TypeScriptEngine', () => {
  let engine: TypeScriptEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new TypeScriptEngine();
    mockExistsSync.mockReturnValue(true);
  });

  it('returns correct metrics when all mutants are killed', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(
      makeJsonReport([
        { status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 },
        { status: 'Killed', mutatorName: 'ConditionalExpression', line: 2 },
        { status: 'Killed', mutatorName: 'ArithmeticOperator', line: 3 },
      ]),
    );

    const result = await engine.run('src/test.ts');

    expect(result.totalMutants).toBe(3);
    expect(result.killed).toBe(3);
    expect(result.survived).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
  });

  it('excludes Ignored mutants (e.g. denylisted) from the score denominator', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(
      makeJsonReport([
        { status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 },
        { status: 'Ignored', mutatorName: 'StringLiteral', line: 2 },
        { status: 'Ignored', mutatorName: 'StringLiteral', line: 3 },
        { status: 'Survived', mutatorName: 'ConditionalExpression', line: 4 },
      ]),
    );

    const result = await engine.run('src/test.ts');

    expect(result.totalMutants).toBe(2);
    expect(result.killed).toBe(1);
    expect(result.survived).toBe(1);
    expect(result.mutationScore).toBe('50.00%');
    // Ignored mutants must not surface as vulnerabilities either.
    expect(result.vulnerabilities).toHaveLength(1);
  });

  it('reports surviving mutants as vulnerabilities', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(
      makeJsonReport([
        { status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 },
        { status: 'Survived', mutatorName: 'ConditionalExpression', line: 42 },
        { status: 'Survived', mutatorName: 'ArithmeticOperator', line: 88 },
      ]),
    );

    const result = await engine.run('src/billing.ts');

    expect(result.survived).toBe(2);
    expect(result.vulnerabilities).toHaveLength(2);
    expect(result.vulnerabilities[0].line).toBe(42);
  });

  it('throws descriptive error when Stryker is not installed (ENOENT)', async () => {
    mockRunShell.mockRejectedValue(makeExecFailure({ code: 'ENOENT' }));

    await expect(engine.run('src/test.ts')).rejects.toThrow(/StrykerJS is not installed/);
    await expect(engine.run('src/test.ts')).rejects.toThrow(/@stryker-mutator\/core/);
  });

  it('handles Stryker exit 2 (threshold not met) and still parses report', async () => {
    mockRunShell.mockRejectedValue(makeExecFailure({ exit: 2, stderr: 'threshold not met' }));
    mockReadFileSync.mockReturnValue(
      makeJsonReport([{ status: 'Survived', mutatorName: 'ArithmeticOperator', line: 10 }]),
    );

    const result = await engine.run('src/test.ts');
    expect(result.survived).toBe(1);
  });

  it('throws on Stryker exit 1 (config/internal error)', async () => {
    mockRunShell.mockRejectedValue(
      makeExecFailure({ exit: 1, stderr: 'stryker.config.js not found' }),
    );

    await expect(engine.run('src/test.ts')).rejects.toThrow(/configuration or internal error/);
    // The stderr tail is interpolated into the message — pin it so its
    // string-literal / slice survives mutation.
    await expect(engine.run('src/test.ts')).rejects.toThrow(/stryker\.config\.js not found/);
  });

  it('maps the "No tests were executed" ConfigError to an actionable no-tests message', async () => {
    mockRunShell.mockRejectedValue(
      makeExecFailure({
        exit: 1,
        stderr:
          'ConfigError: No tests were executed. Stryker will exit prematurely. Please check your configuration.\n    at DryRunExecutor.execute (file:///x/3-dry-run-executor.js:47)',
      }),
    );

    await expect(engine.run('src/orphan.ts')).rejects.toThrow(/zero tests/);
    await expect(engine.run('src/orphan.ts')).rejects.toThrow(/src\/orphan\.ts/);
    // The raw Stryker stack trace must not leak through.
    await expect(engine.run('src/orphan.ts')).rejects.not.toThrow(/DryRunExecutor/);
  });

  it('throws on timeout (TIMEOUT code)', async () => {
    mockRunShell.mockRejectedValue(makeExecFailure({ code: 'TIMEOUT' }));

    await expect(engine.run('src/test.ts')).rejects.toThrow(/timed out/);
  });

  it('throws on signal-based crash', async () => {
    mockRunShell.mockRejectedValue(
      makeExecFailure({ signal: 'SIGSEGV', exit: null, stderr: 'segfault' }),
    );

    await expect(engine.run('src/test.ts')).rejects.toThrow(/crashed unexpectedly.*SIGSEGV/);
  });

  // ─── RunOptions tests ───────────────────────────────────────────────────

  it('uses testRunner from RunOptions', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/test.ts', { testRunner: 'jest' });

    const callArgs = mockRunShell.mock.calls[0];
    const argList = callArgs?.[1] as string[];
    expect(argList).toContain('--testRunner');
    expect(argArgsContain(argList, '--testRunner', 'jest')).toBe(true);
  });

  it('uses workDir from RunOptions as cwd', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/test.ts', { workDir: '/tmp/sandbox' });

    expect(mockRunShell).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cwd: '/tmp/sandbox' }),
    );
  });

  it('uses custom timeoutMs from RunOptions', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/test.ts', { timeoutMs: 120000 });

    expect(mockRunShell).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 120000 }),
    );
  });

  it('defaults to 5-minute timeout when no timeoutMs provided', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/test.ts');

    expect(mockRunShell).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 300_000 }),
    );
  });

  it('passes concurrency as --concurrency flag when provided', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', { concurrency: 4 });

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argArgsContain(argList, '--concurrency', '4')).toBe(true);
  });

  it('omits --concurrency when not provided (lets Stryker auto-detect)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts');

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).not.toContain('--concurrency');
  });

  it('scopes --mutate to line range when lineScope is provided', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', { lineScope: { start: 10, end: 50 } });

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argArgsContain(argList, '--mutate', 'src/app.ts:10-50')).toBe(true);
  });

  it('does not include line range in --mutate when lineScope is absent', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts');

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argArgsContain(argList, '--mutate', 'src/app.ts')).toBe(true);
  });

  it('throws when lineScope.start is not an integer (M12 regression)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await expect(engine.run('src/app.ts', { lineScope: { start: 2.5, end: 50 } })).rejects.toThrow(
      /lineScope.start must be an integer/,
    );
  });

  it('throws when lineScope.start < 1 (M12 regression)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await expect(engine.run('src/app.ts', { lineScope: { start: 0, end: 50 } })).rejects.toThrow(
      /lineScope.start must be an integer >= 1/,
    );
  });

  it('throws when lineScope.end < lineScope.start (M12 regression)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await expect(engine.run('src/app.ts', { lineScope: { start: 50, end: 10 } })).rejects.toThrow(
      /lineScope.end must be an integer >= start/,
    );
  });

  it('passes mutatorDenylist via stryker.config.json in sandbox (StrykerJS v9)', async () => {
    // We need a real temp dir for the config file write. Use workDir.
    const { writeFileSync } = await import('fs');
    const mockWrite = vi.mocked(writeFileSync);

    // No pre-existing stryker.config.json in the sandbox (report path still exists).
    mockExistsSync.mockImplementation((p: string) => p !== '/tmp/test-sandbox/stryker.config.json');
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', {
      workDir: '/tmp/test-sandbox',
      mutatorDenylist: ['StringLiteral', 'BooleanLiteral'],
    });

    // Should have written the config file to the sandbox
    expect(mockWrite).toHaveBeenCalledWith(
      '/tmp/test-sandbox/stryker.config.json',
      expect.stringContaining('"StringLiteral"'),
      'utf-8',
    );
    // Stryker's schema exposes exclusions as mutator.excludedMutations — the
    // former top-level `mutators` map is not a Stryker option and was ignored.
    const written = JSON.parse(mockWrite.mock.calls[0][1] as string);
    expect(written).toEqual({
      mutator: { excludedMutations: ['StringLiteral', 'BooleanLiteral'] },
    });
    // Should NOT have --mutators CLI args
    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList.filter((a) => a.includes('mutators'))).toHaveLength(0);
  });

  it('merges excludedMutations into an existing stryker.config.json instead of clobbering it', async () => {
    const { writeFileSync } = await import('fs');
    const mockWrite = vi.mocked(writeFileSync);
    const configPath = '/tmp/test-sandbox/stryker.config.json';
    const existingConfig = JSON.stringify({
      testRunner: 'vitest',
      mutate: ['src/**/*.ts'],
      mutator: { plugins: null, excludedMutations: ['ConditionalExpression'] },
    });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: string) =>
      p === configPath ? existingConfig : makeJsonReport([]),
    );
    mockRunShell.mockResolvedValue(makeExecResult());

    await engine.run('src/app.ts', {
      workDir: '/tmp/test-sandbox',
      mutatorDenylist: ['StringLiteral', 'ConditionalExpression'],
    });

    const writtenCall = mockWrite.mock.calls.find((c) => c[0] === configPath);
    expect(writtenCall).toBeDefined();
    const written = JSON.parse((writtenCall?.[1] ?? '{}') as string);
    // The project's own settings must survive.
    expect(written.testRunner).toBe('vitest');
    expect(written.mutate).toEqual(['src/**/*.ts']);
    expect(written.mutator.plugins).toBeNull();
    // The denylist is unioned (deduped) with the existing exclusions.
    expect(written.mutator.excludedMutations).toEqual(['ConditionalExpression', 'StringLiteral']);
  });

  it('migrates a legacy top-level `mutators` map into mutator.excludedMutations', async () => {
    const { writeFileSync } = await import('fs');
    const mockWrite = vi.mocked(writeFileSync);
    const configPath = '/tmp/test-sandbox/stryker.config.json';
    // The shape earlier Chaos-MCP versions wrote — never a valid Stryker option.
    const existingConfig = JSON.stringify({
      mutators: { ConditionalExpression: false, BooleanLiteral: true },
    });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: string) =>
      p === configPath ? existingConfig : makeJsonReport([]),
    );
    mockRunShell.mockResolvedValue(makeExecResult());

    await engine.run('src/app.ts', {
      workDir: '/tmp/test-sandbox',
      mutatorDenylist: ['StringLiteral'],
    });

    const writtenCall = mockWrite.mock.calls.find((c) => c[0] === configPath);
    const written = JSON.parse((writtenCall?.[1] ?? '{}') as string);
    // Disabled legacy entries fold into excludedMutations; enabled ones don't.
    expect(written.mutator.excludedMutations).toEqual(['ConditionalExpression', 'StringLiteral']);
    // The invalid key must not be re-emitted.
    expect(written.mutators).toBeUndefined();
  });

  it('treats an empty mutatorDenylist as a no-op (no config written)', async () => {
    const { writeFileSync } = await import('fs');
    const mockWrite = vi.mocked(writeFileSync);
    mockWrite.mockClear();
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', { mutatorDenylist: [] });

    // `length > 0` guard must be strict — an empty list writes nothing.
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('treats an empty mutatorAllowlist as a no-op (does not throw)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    // An empty allowlist must NOT trip the "unsupported" guard (length > 0).
    await expect(engine.run('src/app.ts', { mutatorAllowlist: [] })).resolves.toBeDefined();
  });

  it('throws when mutatorAllowlist is provided (unsupported in StrykerJS v9)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await expect(
      engine.run('src/app.ts', { mutatorAllowlist: ['ConditionalExpression'] }),
    ).rejects.toThrow(/mutatorAllowlist is not supported in StrykerJS v9/);
  });

  it('omits mutator denylist args when none provided', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts');

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList.filter((a) => a.startsWith('--mutators.'))).toHaveLength(0);
  });

  it('passes --dryRunOnly for dryRun mode (StrykerJS v9)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', { dryRun: true });

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).toContain('--dryRunOnly');
    expect(argList).not.toContain('--dryRun');
  });

  // ─── Timeout-status mutant tests ────────────────────────────────────────

  it('counts Timeout-status mutants as killed in the score', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(
      makeJsonReport([
        { status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 },
        { status: 'Killed', mutatorName: 'ConditionalExpression', line: 2 },
        { status: 'Timeout', mutatorName: 'ArithmeticOperator', line: 3 },
        { status: 'Survived', mutatorName: 'StringLiteral', line: 4 },
      ]),
    );

    const result = await engine.run('src/test.ts');

    // killed includes the Timeout mutant: 2 Killed + 1 Timeout = 3
    expect(result.killed).toBe(3);
    expect(result.survived).toBe(1);
    expect(result.totalMutants).toBe(4);
    // score = 3/4 * 100 = 75.00%
    expect(result.mutationScore).toBe('75.00%');
    // Only the Survived mutant should be a vulnerability
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].line).toBe(4);
  });

  it('counts all-Timeout mutants as fully killed', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(
      makeJsonReport([
        { status: 'Timeout', mutatorName: 'BooleanLiteral', line: 1 },
        { status: 'Timeout', mutatorName: 'ConditionalExpression', line: 2 },
      ]),
    );
    const result = await engine.run('src/test.ts');

    expect(result.killed).toBe(2);
    expect(result.survived).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
    expect(result.vulnerabilities).toHaveLength(0);
  });

  // ─── perMutantTimeoutMs tests ───────────────────────────────────────────

  it('adds --timeoutMs when perMutantTimeoutMs is provided', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(
      makeJsonReport([{ status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 }]),
    );

    await engine.run('src/app.ts', { perMutantTimeoutMs: 10000 });

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).toBeDefined();
    expect(argArgsContain(argList, '--timeoutMs', '10000')).toBe(true);
  });

  // ─── parseReport edge case tests ─────────────────────────────────────────

  it('throws when Stryker JSON report file is missing', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockExistsSync.mockReturnValue(false);

    await expect(engine.run('src/test.ts')).rejects.toThrow(/Stryker JSON report not found/);
  });

  it('throws when report JSON is malformed', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not valid json {{{');

    await expect(engine.run('src/test.ts')).rejects.toThrow(/Failed to parse Stryker JSON report/);
  });

  it('collects mutants from multiple files in the report', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        files: {
          'src/a.ts': {
            source: '',
            mutants: [
              {
                status: 'Killed',
                mutatorName: 'ArithmeticOperator',
                line: 1,
                id: '1',
                replacement: '',
                location: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
              },
            ],
          },
          'src/b.ts': {
            source: '',
            mutants: [
              {
                status: 'Survived',
                mutatorName: 'ConditionalExpression',
                line: 10,
                id: '2',
                replacement: '',
                location: { start: { line: 10, column: 0 }, end: { line: 10, column: 10 } },
              },
            ],
          },
        },
      }),
    );

    const result = await engine.run('src/app.ts');
    expect(result.totalMutants).toBe(2);
    expect(result.killed).toBe(1);
    expect(result.survived).toBe(1);
  });

  it('handles report with null/undefined files object gracefully', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({}));

    const result = await engine.run('src/app.ts');
    expect(result.totalMutants).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
  });

  it('skips files whose mutants field is not an array', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        files: {
          'src/a.ts': { source: '', mutants: 'not-an-array' },
          'src/b.ts': {
            source: '',
            mutants: [
              {
                status: 'Killed',
                mutatorName: 'ArithmeticOperator',
                line: 1,
                id: '1',
                replacement: '',
                location: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
              },
            ],
          },
        },
      }),
    );

    const result = await engine.run('src/app.ts');
    expect(result.totalMutants).toBe(1);
    expect(result.killed).toBe(1);
  });

  it('reports NoCoverage mutants as vulnerabilities alongside Survived', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      makeJsonReport([
        { status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 },
        { status: 'NoCoverage', mutatorName: 'BlockStatement', line: 5 },
        { status: 'Survived', mutatorName: 'ArithmeticOperator', line: 10 },
      ]),
    );

    const result = await engine.run('src/test.ts');
    expect(result.survived).toBe(1);
    expect(result.vulnerabilities).toHaveLength(2);
    expect(result.vulnerabilities[0].line).toBe(5);
    expect(result.vulnerabilities[0].description).toContain('NoCoverage');
    expect(result.vulnerabilities[1].line).toBe(10);
    expect(result.vulnerabilities[1].description).toContain('survived');
  });

  it('filters out CompileError and RuntimeError mutants', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      makeJsonReport([
        { status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 },
        { status: 'CompileError', mutatorName: 'ArithmeticOperator', line: 3 },
        { status: 'RuntimeError', mutatorName: 'ConditionalExpression', line: 5 },
      ]),
    );

    const result = await engine.run('src/test.ts');
    expect(result.totalMutants).toBe(1);
    expect(result.killed).toBe(1);
    expect(result.survived).toBe(0);
  });

  it('omits --timeoutMs when perMutantTimeoutMs is not provided', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(
      makeJsonReport([{ status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 }]),
    );

    await engine.run('src/app.ts');

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).toBeDefined();
    expect(argList).not.toContain('--timeoutMs');
  });

  // ─── Option guard edge cases ────────────────────────────────────────────

  it('omits --concurrency when concurrency is 0', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', { concurrency: 0 });

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).not.toContain('--concurrency');
  });

  it('omits --dryRunOnly when dryRun is not provided', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts');

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).not.toContain('--dryRunOnly');
  });

  it('omits --incremental when incremental is not provided', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts');

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).not.toContain('--incremental');
  });

  it('passes --incremental and --incrementalFile when incremental is true', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', { incremental: true });

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).toContain('--incremental');
    expect(argList).toContain('.stryker-incremental.json');
  });

  // ─── MutationToolStartupError and verbose paths ─────────────────────────

  it('throws MutationToolStartupError verbatim', async () => {
    const { MutationToolStartupError } = await import('../utils/exec-classify.js');
    mockRunShell.mockRejectedValue(new MutationToolStartupError('StrykerJS', 'not found', ''));

    await expect(engine.run('src/test.ts')).rejects.toThrow('not found');
  });

  it('logs stderr in verbose mode on non-zero exit', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockLog = vi.mocked(log);
    const mockVerbose = vi.mocked(isVerbose);

    mockVerbose.mockReturnValue(true);
    mockRunShell.mockRejectedValue(makeExecFailure({ exit: 2, stderr: 'threshold not met' }));
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/test.ts');

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('threshold not met'));
    // Reset for subsequent tests
    mockVerbose.mockReturnValue(false);
  });

  it('logs NoCoverage heads-up in verbose mode', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockLog = vi.mocked(log);
    const mockVerbose = vi.mocked(isVerbose);

    mockVerbose.mockReturnValue(true);
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(
      makeJsonReport([{ status: 'NoCoverage', mutatorName: 'BlockStatement', line: 5 }]),
    );

    const result = await engine.run('src/test.ts');
    expect(result.vulnerabilities).toHaveLength(1);
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('NoCoverage'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('vulnerabilities'));
    // Reset for subsequent tests
    mockVerbose.mockReturnValue(false);
  });

  it('throws non-ExecFailureError non-MutationToolStartupError errors as-is', async () => {
    mockRunShell.mockRejectedValue(new Error('something unexpected'));

    await expect(engine.run('src/test.ts')).rejects.toThrow('something unexpected');
  });

  it('throws non-Error rejection as string', async () => {
    mockRunShell.mockRejectedValue('plain string failure');

    await expect(engine.run('src/test.ts')).rejects.toThrow(/Stryker execution failed/);
  });

  // ─── Mutation hardening ──────────────────────────────────────────────────

  it('passes the exact base Stryker CLI argument array', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/math.ts', { testRunner: 'vitest', workDir: '/sb' });

    // Pins every static flag/value in the args array (the 126–141 cluster).
    expect(mockRunShell).toHaveBeenCalledWith(
      'npx',
      [
        '--no-install',
        'stryker',
        'run',
        '--mutate',
        'src/math.ts',
        '--testRunner',
        'vitest',
        '--reporters',
        'json',
        '--logLevel',
        'off',
        '--cleanTempDir',
        'true',
        '--tempDirName',
        '.stryker-tmp',
      ],
      expect.objectContaining({ cwd: '/sb' }),
    );
  });

  it('accepts lineScope at the boundaries (start=1, end=start)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    // start=1 and end===start are both valid; the `< 1` / `< start` guards must
    // use strict-less-than (a `<=` mutant would wrongly throw here).
    await engine.run('src/math.ts', { lineScope: { start: 1, end: 1 } });
    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).toContain('src/math.ts:1-1');
  });

  it('reads the report from the canonical Stryker JSON report path', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/math.ts', { workDir: '/sb' });

    expect(mockReadFileSync).toHaveBeenCalledWith('/sb/reports/mutation/mutation.json', 'utf-8');
  });

  it('does not log anything when verbose mode is off', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    vi.mocked(isVerbose).mockReturnValue(false);
    const mockLog = vi.mocked(log);
    mockLog.mockClear();
    mockRunShell.mockResolvedValue(makeExecResult());
    // Include a NoCoverage mutant so the parseReport verbose branch is also exercised.
    mockReadFileSync.mockReturnValue(
      makeJsonReport([{ status: 'NoCoverage', mutatorName: 'BooleanLiteral', line: 4 }]),
    );

    await engine.run('src/math.ts');

    expect(mockLog).not.toHaveBeenCalled();
  });

  // ─── Mutation hardening (round 2) ────────────────────────────────────────

  it('defaults the test runner to "command" when none is provided', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));
    await engine.run('src/app.ts');
    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argArgsContain(argList, '--testRunner', 'command')).toBe(true);
  });

  it('explains the denylist alternative and echoes the requested allowlist', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));
    const run = engine.run('src/app.ts', { mutatorAllowlist: ['Alpha', 'Beta'] });
    await expect(run).rejects.toThrow(/Use mutatorDenylist instead/);
    // The `.join(', ')` separator and the echoed list are their own mutants.
    await expect(engine.run('src/app.ts', { mutatorAllowlist: ['Alpha', 'Beta'] })).rejects.toThrow(
      /Requested allowlist: Alpha, Beta/,
    );
  });

  it('passes the --incrementalFile flag (not just its value) in incremental mode', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));
    await engine.run('src/app.ts', { incremental: true });
    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argArgsContain(argList, '--incrementalFile', '.stryker-incremental.json')).toBe(true);
  });

  it('omits --timeoutMs when perMutantTimeoutMs is exactly 0 (strict > 0 guard)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));
    await engine.run('src/app.ts', { perMutantTimeoutMs: 0 });
    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).not.toContain('--timeoutMs');
  });

  it('logs the exact stryker invocation (sliced past npx/--no-install) in verbose mode', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    vi.mocked(isVerbose).mockReturnValue(true);
    const mockLog = vi.mocked(log);
    mockLog.mockClear();
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/math.ts');

    expect(mockLog).toHaveBeenCalledWith(
      'TypeScriptEngine: npx stryker stryker run --mutate src/math.ts --testRunner command ' +
        '--reporters json --logLevel off --cleanTempDir true --tempDirName .stryker-tmp',
    );
    vi.mocked(isVerbose).mockReturnValue(false);
  });

  it('rethrows a plain Error verbatim without the "Stryker execution failed" wrapper', async () => {
    mockRunShell.mockRejectedValue(new Error('boom-xyz'));
    await expect(engine.run('src/test.ts')).rejects.toThrow('boom-xyz');
    await expect(engine.run('src/test.ts')).rejects.not.toThrow(/Stryker execution failed/);
  });

  it('does not log stderr when verbose is off even on a non-zero exit', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    vi.mocked(isVerbose).mockReturnValue(false);
    const mockLog = vi.mocked(log);
    mockLog.mockClear();
    mockRunShell.mockRejectedValue(makeExecFailure({ exit: 2, stderr: 'threshold not met' }));
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/test.ts');

    expect(mockLog).not.toHaveBeenCalled();
  });

  it('does not log stderr in verbose mode when stderr is empty', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    vi.mocked(isVerbose).mockReturnValue(true);
    const mockLog = vi.mocked(log);
    mockLog.mockClear();
    mockRunShell.mockRejectedValue(makeExecFailure({ exit: 2, stderr: '' }));
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/test.ts');

    // The `&& error.stderr` arm must suppress the log when stderr is empty.
    const stderrLogs = mockLog.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('expected'),
    );
    expect(stderrLogs).toHaveLength(0);
    vi.mocked(isVerbose).mockReturnValue(false);
  });

  // ─── A1: original / mutated population ─────────────────────────────────

  it('A1: populates original (sliced from source) and mutated (replacement)', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        files: {
          'src/x.ts': {
            source: 'const x = a > b;\n',
            mutants: [
              {
                id: '1',
                mutatorName: 'ConditionalExpression',
                replacement: 'a >= b',
                location: { start: { line: 1, column: 11 }, end: { line: 1, column: 16 } },
                status: 'Survived',
              },
            ],
          },
        },
      }),
    );
    const result = engine.parseReport('/wd', 'src/x.ts');
    const vuln = result.vulnerabilities.find((v) => v.line === 1);
    expect(vuln?.original).toBe('a > b');
    expect(vuln?.mutated).toBe('a >= b');
  });

  it('A1: omits original (no throw) when location is out of range, still sets mutated', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        files: {
          'src/x.ts': {
            source: 'short\n',
            mutants: [
              {
                id: '2',
                mutatorName: 'BooleanLiteral',
                replacement: 'false',
                location: { start: { line: 99, column: 1 }, end: { line: 99, column: 5 } },
                status: 'Survived',
              },
            ],
          },
        },
      }),
    );
    const result = engine.parseReport('/wd', 'src/x.ts');
    const vuln = result.vulnerabilities.find((v) => v.mutator === 'BooleanLiteral');
    expect(vuln?.original).toBeUndefined();
    expect(vuln?.mutated).toBe('false');
  });

  it('A1: leaves original/mutated unset when replacement is empty and span unsliceable', () => {
    // Mirrors the existing makeJsonReport fixtures (column 0, empty replacement).
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        files: {
          'src/x.ts': {
            source: 'const x = 1;',
            mutants: [
              {
                id: '3',
                mutatorName: 'ArithmeticOperator',
                replacement: '',
                location: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
                status: 'Survived',
              },
            ],
          },
        },
      }),
    );
    const result = engine.parseReport('/wd', 'src/x.ts');
    const vuln = result.vulnerabilities[0];
    expect(vuln.original).toBeUndefined();
    expect(vuln.mutated).toBeUndefined();
  });

  it('A1: slices a multi-line original span across lines', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        files: {
          'src/x.ts': {
            source: 'a >\nb',
            mutants: [
              {
                id: '1',
                mutatorName: 'ConditionalExpression',
                replacement: 'a >= b',
                location: { start: { line: 1, column: 1 }, end: { line: 2, column: 2 } },
                status: 'Survived',
              },
            ],
          },
        },
      }),
    );
    const result = engine.parseReport('/wd', 'src/x.ts');
    expect(result.vulnerabilities[0].original).toBe('a >\nb');
  });

  // ─── A2: lineRanges multi-range scoping ─────────────────────────────────

  it('A2: emits one --mutate range for a single lineScope (unchanged behavior)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));
    await engine.run('src/app.ts', { lineScope: { start: 10, end: 20 } });
    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argArgsContain(argList, '--mutate', 'src/app.ts:10-20')).toBe(true);
  });

  it('A2: emits comma-joined --mutate patterns for multiple lineRanges', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));
    await engine.run('src/app.ts', {
      lineRanges: [
        { start: 3, end: 5 },
        { start: 20, end: 20 },
      ],
    });
    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argArgsContain(argList, '--mutate', 'src/app.ts:3-5,src/app.ts:20-20')).toBe(true);
  });

  it('A2: lineRanges takes precedence over lineScope', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));
    await engine.run('src/app.ts', {
      lineScope: { start: 1, end: 2 },
      lineRanges: [{ start: 40, end: 44 }],
    });
    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argArgsContain(argList, '--mutate', 'src/app.ts:40-44')).toBe(true);
  });

  it('does not emit the NoCoverage heads-up when there are zero NoCoverage mutants', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    vi.mocked(isVerbose).mockReturnValue(true);
    const mockLog = vi.mocked(log);
    mockLog.mockClear();
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(
      makeJsonReport([{ status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 }]),
    );

    await engine.run('src/test.ts');

    // `noCoverage > 0` must be strict — zero NoCoverage mutants log nothing.
    const noCovLogs = mockLog.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('NoCoverage'),
    );
    expect(noCovLogs).toHaveLength(0);
    vi.mocked(isVerbose).mockReturnValue(false);
  });
});

/** Helper: check if an args array contains a flag-value pair. */
function argArgsContain(args: string[], flag: string, value: string): boolean {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] === value;
}
