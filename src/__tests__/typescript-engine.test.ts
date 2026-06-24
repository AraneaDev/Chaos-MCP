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

// Mock fs for report parsing
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
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

    await expect(engine.run('src/test.ts')).rejects.toThrow(/Failed to initialize StrykerJS/);
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

  it('passes mutatorAllowlist as --mutators flag', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', {
      mutatorAllowlist: ['ConditionalExpression', 'ArithmeticOperator'],
    });

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argArgsContain(argList, '--mutators', 'ConditionalExpression,ArithmeticOperator')).toBe(
      true,
    );
  });

  it('passes mutatorDenylist with ! prefix in --mutators', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', { mutatorDenylist: ['StringLiteral'] });

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argArgsContain(argList, '--mutators', '!StringLiteral')).toBe(true);
  });

  it('combines allowlist and denylist in --mutators', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', {
      mutatorAllowlist: ['ConditionalExpression'],
      mutatorDenylist: ['StringLiteral', 'BooleanLiteral'],
    });

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(
      argArgsContain(argList, '--mutators', 'ConditionalExpression,!StringLiteral,!BooleanLiteral'),
    ).toBe(true);
  });

  it('omits --mutators when neither allowlist nor denylist is provided', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts');

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).not.toContain('--mutators');
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
});

/** Helper: check if an args array contains a flag-value pair. */
function argArgsContain(args: string[], flag: string, value: string): boolean {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] === value;
}
