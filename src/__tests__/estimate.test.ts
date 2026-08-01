import { describe, it, expect, vi } from 'vitest';

// The stub for MutationToolStartupError carries `reason`, because that is what
// `computeCount` now branches on: only a genuinely missing binary
// ('NOT_INSTALLED') may degrade to the heuristic. A reason-less stub would make
// every case here look like the non-recoverable default.
vi.mock('../utils/exec-classify.js', () => ({
  invokeMutationTool: vi.fn(),
  MutationToolStartupError: class extends Error {
    constructor(
      public readonly tool: string,
      message: string,
      public readonly reason = 'UNKNOWN',
    ) {
      super(message);
      this.name = 'MutationToolStartupError';
    }
  },
}));

// Partial mock: only `runShell` is stubbed. `ExecFailureError` now lives in
// `exec-error.js`, which is left unmocked, so `isCancel` (imported by
// estimate.ts) still narrows with `instanceof` against the same class these
// tests construct.
vi.mock('../utils/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/exec.js')>()),
  runShell: vi.fn(),
}));

import { invokeMutationTool, MutationToolStartupError } from '../utils/exec-classify.js';
import { runShell } from '../utils/exec.js';
import { ExecFailureError } from '../utils/exec-error.js';
import { estimateAudit, estimateNeedsSandbox } from '../estimate.js';
import { projectTimingRange } from '../baseline-timing.js';
import type { EnvironmentInfo } from '../utils/project-detector.js';

const mockInvoke = vi.mocked(invokeMutationTool);
const mockRunShell = vi.mocked(runShell);

const baseEnv = (): EnvironmentInfo => ({
  projectType: 'typescript',
  testRunner: 'vitest',
  detectedRunner: 'npm',
  packageManager: 'npm',
  workspaceRoot: '/ws',
});

describe('estimateNeedsSandbox', () => {
  it('needs a sandbox for rust or when timing', () => {
    expect(estimateNeedsSandbox('rust', false)).toBe(true);
    expect(estimateNeedsSandbox('typescript', true)).toBe(true);
    expect(estimateNeedsSandbox('typescript', false)).toBe(false);
    expect(estimateNeedsSandbox('python', false)).toBe(false);
    expect(estimateNeedsSandbox('php', false)).toBe(false);
  });
});

describe('estimateAudit', () => {
  it('uses the heuristic for typescript (approx)', async () => {
    const r = await estimateAudit({
      absFile: __filename, // this test file — has plenty of constructs
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
    });
    expect(r.fidelity).toBe('approx');
    expect(r.language).toBe('typescript');
    expect(r.mutants).toBeGreaterThan(0);
    expect(r.basis).toMatch(/heuristic/);
  });

  it('reports zero mutants instead of crashing when the source cannot be read', async () => {
    // A missing or unreadable file must degrade to "nothing to estimate" — this
    // is a cheap pre-flight, so it must never be the thing that fails the call.
    const r = await estimateAudit({
      absFile: '/nonexistent/does-not-exist.ts',
      relFile: 'does-not-exist.ts',
      projectType: 'typescript',
    });
    expect(r.mutants).toBe(0);
    expect(r.basis).toBe('source heuristic: 0 constructs');
  });

  it('states the construct count as its basis, with nothing appended', async () => {
    // `basis` is what the caller reads to judge whether the number is
    // trustworthy. The default empty `basisSuffix` is only visible here — the
    // rust/no-sandbox paths always pass a suffix, so nothing else pins it.
    const r = await estimateAudit({
      absFile: __filename,
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
    });
    expect(r.basis).toMatch(/^source heuristic: \d+ constructs$/);
  });

  it('labels the heuristic as approximate and points at the exact tool', async () => {
    // Both halves of the note are concatenated; blanking either leaves a
    // still-plausible sentence that either drops the "this is an estimate"
    // caveat or the instruction for getting a real number.
    const r = await estimateAudit({
      absFile: __filename,
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
    });
    expect(r.note).toBe(
      'Approximate mutant count from a source-parse heuristic; the real audit may differ. ' +
        'Run audit_code_resilience for exact results.',
    );
  });

  it('uses cargo-mutants --list for rust (exact)', async () => {
    mockInvoke.mockResolvedValueOnce({
      stdout: 'src/lib.rs:1:1: replace foo -> bar\nsrc/lib.rs:2:3: replace a + b with a - b\n',
      stderr: '',
    } as never);
    const r = await estimateAudit({
      absFile: '/ws/src/lib.rs',
      relFile: 'src/lib.rs',
      projectType: 'rust',
      workDir: '/sandbox',
    });
    expect(r.fidelity).toBe('exact');
    expect(r.mutants).toBe(2);
    expect(r.basis).toMatch(/cargo-mutants/);
  });

  it('forwards the container session to exact counting and baseline timing', async () => {
    const executor = {
      kind: 'container' as const,
      workDir: '/sandbox',
      run: vi.fn().mockResolvedValue({
        stdout: '',
        stderr: '',
        exit: 0,
        signal: null,
      }),
      runCommand: vi.fn(),
      dispose: vi.fn(),
    };
    mockInvoke.mockResolvedValueOnce({
      stdout: 'src/lib.rs:1:1: replace foo -> bar\n',
      stderr: '',
    } as never);

    await estimateAudit({
      absFile: '/ws/src/lib.rs',
      relFile: 'src/lib.rs',
      projectType: 'rust',
      workDir: '/sandbox',
      withTiming: true,
      env: {
        projectType: 'rust',
        testRunner: 'cargo',
        detectedRunner: 'cargo',
        packageManager: 'cargo',
        workspaceRoot: '/ws',
      },
      executor,
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      'cargo-mutants',
      'cargo',
      expect.any(Array),
      expect.objectContaining({ executor }),
    );
    expect(executor.run).toHaveBeenCalledWith(
      'cargo',
      ['test'],
      expect.objectContaining({ cwd: '/sandbox', killTree: true }),
    );
    expect(mockRunShell).not.toHaveBeenCalled();
  });

  it('falls back to heuristic when cargo-mutants is missing', async () => {
    // Real constructor: (tool: ExecutableTool, message: string, reason).
    // The reason is now load-bearing — it is the ONLY startup class that may
    // degrade to an approximate answer instead of failing the call.
    mockInvoke.mockRejectedValueOnce(
      new MutationToolStartupError(
        'cargo-mutants' as never,
        'cargo-mutants not found',
        'NOT_INSTALLED' as never,
      ),
    );
    const r = await estimateAudit({
      absFile: __filename,
      relFile: 'src/x.rs',
      projectType: 'rust',
      workDir: '/sandbox',
    });
    expect(r.fidelity).toBe('approx');
    expect(r.basis).toMatch(/not installed|heuristic/);
  });

  it('says WHY it fell back to the heuristic when cargo-mutants is missing', async () => {
    // The `/not installed|heuristic/` assertion above passes on a blank suffix,
    // because the heuristic basis already says "heuristic". The reason for the
    // downgrade — the tool is not installed — is the actionable half, and only
    // an explicit check keeps it.
    mockInvoke.mockRejectedValueOnce(
      new MutationToolStartupError(
        'cargo-mutants' as never,
        'cargo-mutants not found',
        'NOT_INSTALLED' as never,
      ),
    );
    const r = await estimateAudit({
      absFile: __filename,
      relFile: 'src/x.rs',
      projectType: 'rust',
      workDir: '/sandbox',
    });
    expect(r.basis).toContain(' (cargo-mutants not installed)');
  });

  // ── Only "not installed" may degrade; every other startup class must fail ──

  it.each([
    ['TIMEOUT', 'cargo-mutants timed out after 60000ms.'],
    ['OUTPUT_TRUNCATED', 'cargo-mutants produced more output than Chaos-MCP can capture'],
    ['CRASHED', 'cargo-mutants crashed unexpectedly (signal SIGSEGV)'],
    ['UNKNOWN', 'something went wrong'],
  ])(
    'rethrows a %s startup failure instead of reporting "cargo-mutants not installed"',
    async (reason, message) => {
      // This catch used to swallow the WHOLE MutationToolStartupError class and
      // return normally with '(cargo-mutants not installed)' appended. So a
      // timed-out `cargo mutants --list`, and output that overflowed the capture
      // cap, were both reported to the caller as a missing binary — wrapped in a
      // SUCCESSFUL structuredContent estimate, since estimate-handler's
      // `isCancel`/error path only runs when something actually throws.
      mockInvoke.mockRejectedValueOnce(
        new MutationToolStartupError('cargo-mutants' as never, message, reason as never),
      );

      await expect(
        estimateAudit({
          absFile: __filename,
          relFile: 'src/x.rs',
          projectType: 'rust',
          workDir: '/sandbox',
        }),
      ).rejects.toThrow(message);
    },
  );

  it('propagates a cancelled cargo-mutants --list rather than returning an estimate', async () => {
    // The cancellation half of the same finding. `invokeMutationTool` now
    // rethrows an ABORTED ExecFailureError untouched instead of relabelling it
    // a signal crash, and `computeCount` — which has no request context and so
    // cannot consult `ctx.signal.aborted` — must let it out. Previously a
    // cancelled `estimate_audit` on a .rs file returned a successful heuristic
    // estimate for work the caller had already abandoned.
    const aborted = new ExecFailureError(
      { stdout: '', stderr: '', exit: null, signal: 'SIGKILL', code: 'ABORTED' },
      'Command was cancelled: cargo',
    );
    mockInvoke.mockRejectedValueOnce(aborted);

    const controller = new AbortController();
    controller.abort();

    await expect(
      estimateAudit({
        absFile: __filename,
        relFile: 'src/x.rs',
        projectType: 'rust',
        workDir: '/sandbox',
        signal: controller.signal,
      }),
    ).rejects.toBe(aborted);
  });

  it('labels the exact rust result with its language and how it was obtained', async () => {
    mockInvoke.mockResolvedValueOnce({
      stdout: 'src/lib.rs:1:1: replace foo -> bar\n',
      stderr: '',
    } as never);
    const r = await estimateAudit({
      absFile: '/ws/src/lib.rs',
      relFile: 'src/lib.rs',
      projectType: 'rust',
      workDir: '/sandbox',
    });
    // UPDATED (audit: Rust's "exact" count over-claims). The old assertions
    // pinned `basis: 'cargo-mutants --list'` and
    // 'Exact mutant count from cargo-mutants --list (no tests were run).' —
    // a claim the audit does not honour. `cargo mutants --list` enumerates
    // every GENERATED mutant, including ones that will not compile (routine on
    // files with generics or trait bounds), whereas `scoreCounts` in
    // engines/rust.ts computes totalMutants = caught + timeout + missed and
    // reports the unviable ones separately as `incompetent`. So "exact: 120"
    // was routinely followed by an audit reporting 88. The COUNT is unchanged —
    // it is the right input for timing, since an unviable mutant still costs a
    // compile — only the claim is now accurate about what it counts.
    expect(r.language).toBe('rust');
    expect(r.basis).toBe('cargo-mutants --list (generated mutants)');
    expect(r.note).toContain('GENERATES');
    expect(r.note).toContain('no tests were run');
    // The actionable half: the audit's denominator will be smaller.
    expect(r.note).toContain('incompetent');
    expect(r.note).toMatch(/audit scores fewer/i);
  });

  it('counts entries whose line and column are multi-digit', async () => {
    // The `:\d+:\d+:` shape must accept real coordinates, not just the
    // single-digit ones every other fixture here uses. If either `+` is lost the
    // pattern matches nothing, the count silently falls back to "every non-empty
    // line", and the summary line is reported as a third mutant — an "exact"
    // answer that is wrong.
    mockInvoke.mockResolvedValueOnce({
      stdout:
        'src/lib.rs:12:34: replace foo -> bar\nsrc/lib.rs:567:8: replace a + b with a - b\nFound 2 mutants in 1 file.\n',
      stderr: '',
    } as never);
    const r = await estimateAudit({
      absFile: '/ws/src/lib.rs',
      relFile: 'src/lib.rs',
      projectType: 'rust',
      workDir: '/sandbox',
    });
    expect(r.fidelity).toBe('exact');
    expect(r.mutants).toBe(2);
  });

  it('falls back to heuristic when rust has no workDir (defensive path)', async () => {
    const r = await estimateAudit({
      absFile: __filename,
      relFile: 'src/x.rs',
      projectType: 'rust',
      // no workDir
    });
    expect(r.fidelity).toBe('approx');
    expect(r.basis).toContain('no sandbox');
  });

  it('rethrows non-startup errors from invokeMutationTool', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('boom'));
    await expect(
      estimateAudit({
        absFile: __filename,
        relFile: 'src/x.rs',
        projectType: 'rust',
        workDir: '/sandbox',
      }),
    ).rejects.toThrow('boom');
  });

  it('excludes summary lines when counting cargo-mutants output (Fix 1)', async () => {
    mockInvoke.mockResolvedValueOnce({
      stdout:
        'src/lib.rs:1:1: replace foo -> bar\nsrc/lib.rs:2:3: replace a + b with a - b\nFound 2 mutants in 1 file.\n',
      stderr: '',
    } as never);
    const r = await estimateAudit({
      absFile: '/ws/src/lib.rs',
      relFile: 'src/lib.rs',
      projectType: 'rust',
      workDir: '/sandbox',
    });
    expect(r.fidelity).toBe('exact');
    expect(r.mutants).toBe(2);
  });

  it('does not count a whitespace-only line as a mutant in the fallback path', async () => {
    // The fallback counts every non-empty line, so the `.trim()` is what makes
    // "non-empty" mean "has content". Without it an indented blank line — which
    // cargo-mutants emits between sections — inflates an "exact" count.
    mockInvoke.mockResolvedValueOnce({
      stdout: 'some line\n   \nanother line\n',
      stderr: '',
    } as never);
    const r = await estimateAudit({
      absFile: '/ws/src/lib.rs',
      relFile: 'src/lib.rs',
      projectType: 'rust',
      workDir: '/sandbox',
    });
    expect(r.mutants).toBe(2);
  });

  it('falls back to all non-empty lines when no :n:n: entries match', async () => {
    mockInvoke.mockResolvedValueOnce({
      stdout: 'some line\nanother line\n',
      stderr: '',
    } as never);
    const r = await estimateAudit({
      absFile: '/ws/src/lib.rs',
      relFile: 'src/lib.rs',
      projectType: 'rust',
      workDir: '/sandbox',
    });
    expect(r.fidelity).toBe('exact');
    expect(r.mutants).toBe(2);
  });
});

describe('estimateAudit withTiming', () => {
  it('runs baseline and sets estimatedMs + concurrency when withTiming=true', async () => {
    mockRunShell.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exit: 0,
      signal: null,
    } as never);

    const r = await estimateAudit({
      absFile: __filename,
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
      workDir: '/sandbox',
      withTiming: true,
      env: baseEnv(),
      concurrency: 2,
    });

    expect(r.fidelity).toBe('approx');
    expect(r.mutants).toBeGreaterThan(0);
    expect(r.baselineMs).toBeTypeOf('number');
    expect(r.concurrency).toBe(2);
    expect(r.estimatedMs).toBeTypeOf('number');
    expect(r.optimisticMs).toBe(Math.ceil((r.mutants * (r.baselineMs ?? 0)) / 2));
    expect(r.upperBoundMs).toBeGreaterThan(r.estimatedMs ?? 0);
    expect(r.timingConfidence).toBe('medium');
    // baselineMs = Date.now() - t0 must be a small elapsed duration. A `Date.now() + t0`
    // mutant would yield ~2× the epoch (>1e12); pin it to a sane upper bound.
    expect(r.baselineMs).toBeLessThan(60_000);
  });

  it('adds budget admission metadata when a timeout budget is supplied', async () => {
    mockRunShell.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exit: 0,
      signal: null,
    } as never);

    const r = await estimateAudit({
      absFile: __filename,
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
      workDir: '/sandbox',
      withTiming: true,
      env: { ...baseEnv(), testRunner: 'command', detectedRunner: 'vitest' },
      concurrency: 1,
      timeoutMs: 1,
    });

    expect(r.budgetMs).toBe(1);
    expect(r.fitsBudget).toBe(false);
    expect(r.recommendation).toMatch(/narrow|budget/i);
    expect(mockRunShell).toHaveBeenCalledWith(
      'npx',
      ['vitest', 'related', 'src/__tests__/estimate.test.ts', '--run'],
      expect.objectContaining({ timeoutMs: 1, killTree: true }),
    );
  });

  it('uses the command-runner projection only for TypeScript command-runner audits', async () => {
    mockRunShell.mockResolvedValue({
      stdout: '',
      stderr: '',
      exit: 0,
      signal: null,
    } as never);

    const command = await estimateAudit({
      absFile: __filename,
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
      workDir: '/sandbox',
      withTiming: true,
      env: { ...baseEnv(), testRunner: 'command' },
      concurrency: 1,
    });
    const native = await estimateAudit({
      absFile: __filename,
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
      workDir: '/sandbox',
      withTiming: true,
      env: { ...baseEnv(), testRunner: 'vitest' },
      concurrency: 1,
    });
    const nonTypeScript = await estimateAudit({
      absFile: __filename,
      relFile: 'src/app.py',
      projectType: 'python',
      workDir: '/sandbox',
      withTiming: true,
      env: { ...baseEnv(), testRunner: 'command' },
      concurrency: 1,
    });

    expect(command.timingConfidence).toBe('low');
    expect(native.timingConfidence).toBe('medium');
    expect(nonTypeScript.timingConfidence).toBe('medium');
  });

  // ── The runner the AUDIT resolved wins over the one detection reported ────

  it('projects with the command-runner model when the resolved runner overrides the env', async () => {
    // Scenario A of the estimate/audit divergence finding: config sets
    // `"stryker": { "testRunner": "command" }` on a project detected as vitest.
    // The audit runs the command runner; the estimate compared `env.testRunner`
    // ('vitest') against 'command', got false, and projected with the NATIVE
    // constants — perMutantOverheadMs 250 vs 1500, startupMs 5000 vs 10000,
    // estimateFactor 1.2 vs 1.5. For 200 mutants at a 300ms baseline that is
    // ~137s projected against ~550s actual: a 4× under-estimate handed to the
    // caller as `fitsBudget: true` for a run that will blow its budget.
    mockRunShell.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null } as never);

    const resolved = await estimateAudit({
      absFile: __filename,
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
      workDir: '/sandbox',
      withTiming: true,
      env: { ...baseEnv(), testRunner: 'vitest', detectedRunner: 'vitest' },
      testRunner: 'command', // what buildRunOptions resolved from the config file
      concurrency: 1,
    });

    expect(resolved.timingConfidence).toBe('low');
    // And the BASELINE is measured with the command the audit will actually
    // run, not the native `npx vitest` the detected runner implies.
    expect(mockRunShell).toHaveBeenLastCalledWith(
      'npx',
      ['vitest', 'related', 'src/__tests__/estimate.test.ts', '--run'],
      expect.objectContaining({ killTree: true }),
    );
  });

  it('falls back to env.testRunner when no resolved runner is supplied', async () => {
    // The other arm: callers without a config (and every direct caller) keep
    // the previous behaviour exactly.
    mockRunShell.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null } as never);

    const r = await estimateAudit({
      absFile: __filename,
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
      workDir: '/sandbox',
      withTiming: true,
      env: { ...baseEnv(), testRunner: 'command', detectedRunner: 'vitest' },
      concurrency: 1,
    });

    expect(r.timingConfidence).toBe('low');
  });

  it('treats an upper bound exactly equal to the budget as fitting', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    mockRunShell.mockResolvedValue({
      stdout: '',
      stderr: '',
      exit: 0,
      signal: null,
    } as never);
    const withoutBudget = await estimateAudit({
      absFile: __filename,
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
      workDir: '/sandbox',
      withTiming: true,
      env: { ...baseEnv(), testRunner: 'command' },
      concurrency: 1,
    });
    expect(withoutBudget.budgetMs).toBeUndefined();
    expect(withoutBudget.fitsBudget).toBeUndefined();
    expect(withoutBudget.recommendation).toBeUndefined();

    const exactBudget = projectTimingRange(withoutBudget.mutants, 0, 1, true).upperBoundMs;
    const atBoundary = await estimateAudit({
      absFile: __filename,
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
      workDir: '/sandbox',
      withTiming: true,
      env: { ...baseEnv(), testRunner: 'command' },
      concurrency: 1,
      timeoutMs: exactBudget,
    });
    expect(atBoundary.upperBoundMs).toBe(exactBudget);
    expect(atBoundary.fitsBudget).toBe(true);
    expect(atBoundary.recommendation).toBe('Estimated to fit the configured audit budget.');
    now.mockRestore();
  });

  it('omits timing fields and appends note when runShell throws', async () => {
    mockRunShell.mockRejectedValueOnce(new Error('test suite failed'));

    const r = await estimateAudit({
      absFile: __filename,
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
      workDir: '/sandbox',
      withTiming: true,
      env: baseEnv(),
    });

    expect(r.fidelity).toBe('approx');
    expect(r.mutants).toBeGreaterThan(0);
    expect(r.baselineMs).toBeUndefined();
    expect(r.estimatedMs).toBeUndefined();
    expect(r.concurrency).toBeUndefined();
    expect(r.note).toContain('timing unavailable');
  });

  it('propagates cancellation from the baseline run instead of reporting success', async () => {
    // The best-effort catch around the baseline run exists to tolerate a failing
    // or slow test suite — NOT to hide a deliberate abort. Swallowing an
    // ABORTED ExecFailureError here made handleEstimateCall's `isCancel` branch
    // unreachable for the timing phase, so a client that cancelled mid-baseline
    // was handed a successful EstimateResult (isError unset) for cancelled work.
    const aborted = new ExecFailureError(
      { stdout: '', stderr: '', exit: null, signal: 'SIGTERM', code: 'ABORTED' },
      'Command aborted',
    );
    mockRunShell.mockRejectedValueOnce(aborted);

    const controller = new AbortController();
    controller.abort();

    await expect(
      estimateAudit({
        absFile: __filename,
        relFile: 'src/__tests__/estimate.test.ts',
        projectType: 'typescript',
        workDir: '/sandbox',
        withTiming: true,
        env: baseEnv(),
        signal: controller.signal,
      }),
    ).rejects.toBe(aborted);
  });

  it('propagates an AbortError from the container executor baseline run', async () => {
    // Same contract on the container path, and via the other cancellation shape
    // (`name === 'AbortError'`) rather than an ExecFailureError code.
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    const executor = {
      kind: 'container' as const,
      workDir: '/sandbox',
      run: vi.fn().mockRejectedValue(abortError),
      runCommand: vi.fn(),
      dispose: vi.fn(),
    };

    // This file shares one module-level runShell mock across tests, so clear the
    // call log before asserting the executor path bypassed it.
    mockRunShell.mockClear();
    await expect(
      estimateAudit({
        absFile: __filename,
        relFile: 'src/__tests__/estimate.test.ts',
        projectType: 'typescript',
        workDir: '/sandbox',
        withTiming: true,
        env: baseEnv(),
        executor,
      }),
    ).rejects.toBe(abortError);
    expect(executor.run).toHaveBeenCalledTimes(1);
    expect(mockRunShell).not.toHaveBeenCalled();
  });

  it('still swallows a non-cancellation baseline failure (the other arm)', async () => {
    // Guards the `if (isCancel(err)) throw err` guard from being inverted or
    // removed: an ordinary suite failure must STILL degrade to a note, not throw.
    mockRunShell.mockRejectedValueOnce(
      new ExecFailureError(
        { stdout: '', stderr: '', exit: 1, signal: null, code: undefined },
        'tests failed',
      ),
    );

    const r = await estimateAudit({
      absFile: __filename,
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
      workDir: '/sandbox',
      withTiming: true,
      env: baseEnv(),
    });
    expect(r.note).toContain('timing unavailable');
    expect(r.baselineMs).toBeUndefined();
  });

  it('reports timing unavailable when no baseline command resolves for the project type', async () => {
    // resolveBaselineTestCommand returns undefined for an unrecognized type → the
    // `cmd === undefined` guard appends "(timing unavailable)" and returns without
    // running a baseline. Kills the guard + its block + the note string.
    const r = await estimateAudit({
      absFile: __filename,
      relFile: 'src/x.unknown',
      projectType: 'cobol' as never,
      workDir: '/sandbox',
      withTiming: true,
      env: baseEnv(),
    });
    expect(r.baselineMs).toBeUndefined();
    expect(r.estimatedMs).toBeUndefined();
    expect(r.note).toContain('timing unavailable');
  });

  it('omits timing when withTiming=true but env is missing', async () => {
    const r = await estimateAudit({
      absFile: __filename,
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
      workDir: '/sandbox',
      withTiming: true,
      // no env
    });
    expect(r.baselineMs).toBeUndefined();
  });

  it('omits timing when withTiming=true but workDir is missing', async () => {
    const r = await estimateAudit({
      absFile: __filename,
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
      withTiming: true,
      env: baseEnv(),
      // no workDir
    });
    expect(r.baselineMs).toBeUndefined();
  });

  it('rust + withTiming: sets timing fields when runShell resolves', async () => {
    mockInvoke.mockResolvedValueOnce({
      stdout: 'src/lib.rs:1:1: replace foo -> bar\nsrc/lib.rs:2:3: replace a + b with a - b\n',
      stderr: '',
    } as never);
    mockRunShell.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exit: 0,
      signal: null,
    } as never);

    const r = await estimateAudit({
      absFile: '/ws/src/lib.rs',
      relFile: 'src/lib.rs',
      projectType: 'rust',
      workDir: '/sandbox',
      withTiming: true,
      env: baseEnv(),
      concurrency: 2,
    });

    expect(r.fidelity).toBe('exact');
    expect(r.mutants).toBe(2);
    expect(r.baselineMs).toBeTypeOf('number');
    expect(r.concurrency).toBe(2);
    expect(r.estimatedMs).toBeTypeOf('number');
  });

  it('rust + withTiming: returns exact count with timing unavailable note when runShell rejects', async () => {
    mockInvoke.mockResolvedValueOnce({
      stdout: 'src/lib.rs:1:1: replace foo -> bar\n',
      stderr: '',
    } as never);
    mockRunShell.mockRejectedValueOnce(new Error('test suite failed'));

    const r = await estimateAudit({
      absFile: '/ws/src/lib.rs',
      relFile: 'src/lib.rs',
      projectType: 'rust',
      workDir: '/sandbox',
      withTiming: true,
      env: baseEnv(),
    });

    expect(r.fidelity).toBe('exact');
    expect(r.mutants).toBe(1);
    expect(r.baselineMs).toBeUndefined();
    expect(r.estimatedMs).toBeUndefined();
    expect(r.note).toContain('timing unavailable');
  });
});

describe('estimateAudit signal forwarding', () => {
  it('forwards signal into invokeMutationTool options on the rust path', async () => {
    mockInvoke.mockResolvedValueOnce({
      stdout: 'src/lib.rs:1:1: replace foo -> bar\n',
      stderr: '',
    } as never);

    const controller = new AbortController();
    await estimateAudit({
      absFile: '/ws/src/lib.rs',
      relFile: 'src/lib.rs',
      projectType: 'rust',
      workDir: '/sandbox',
      signal: controller.signal,
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      'cargo-mutants',
      'cargo',
      ['mutants', '--list', '--file', 'src/lib.rs'],
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('forwards a caller timeoutMs into the cargo-mutants invocation (not the default)', async () => {
    // Kills `opts.timeoutMs ?? ESTIMATE_TIMEOUT_MS → opts.timeoutMs && ESTIMATE_TIMEOUT_MS`,
    // under which a provided timeout would be discarded in favor of the default.
    mockInvoke.mockResolvedValueOnce({
      stdout: 'src/lib.rs:1:1: replace foo -> bar\n',
      stderr: '',
    } as never);
    await estimateAudit({
      absFile: '/ws/src/lib.rs',
      relFile: 'src/lib.rs',
      projectType: 'rust',
      workDir: '/sandbox',
      timeoutMs: 12_345,
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      'cargo-mutants',
      'cargo',
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 12_345 }),
    );
  });

  it('forwards signal into runShell options on the withTiming path', async () => {
    mockRunShell.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exit: 0,
      signal: null,
    } as never);

    const controller = new AbortController();
    await estimateAudit({
      absFile: __filename,
      relFile: 'src/__tests__/estimate.test.ts',
      projectType: 'typescript',
      workDir: '/sandbox',
      withTiming: true,
      env: baseEnv(),
      signal: controller.signal,
    });

    expect(mockRunShell).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

/**
 * `--file` takes a GLOB, not a literal path. The audit path escapes it; this
 * estimate path must too, and for a sharper reason: it labels its answer
 * `fidelity: 'exact'`, so a glob that selects the wrong file (or no file at all,
 * which cargo-mutants reports with exit 0) is returned as a confident count
 * rather than degrading to the heuristic.
 */
describe('estimateAudit escapes the cargo-mutants --file glob', () => {
  const listArgv = (): unknown[] => {
    const call = mockInvoke.mock.calls.at(-1);
    if (call === undefined) throw new Error('invokeMutationTool was never called');
    return call[2] as unknown[];
  };

  const estimateRust = async (relFile: string) => {
    mockInvoke.mockResolvedValueOnce({
      stdout: 'src/lib.rs:1:1: replace foo -> bar\n',
      stderr: '',
    } as never);
    return estimateAudit({
      absFile: `/ws/${relFile}`,
      relFile,
      projectType: 'rust',
      workDir: '/sandbox',
    });
  };

  it.each([
    ['src/parser/token[0].rs', 'src/parser/token[[]0[]].rs'],
    ['src/a*b.rs', 'src/a[*]b.rs'],
    ['src/q?.rs', 'src/q[?].rs'],
    ['src/br{ace}.rs', 'src/br[{]ace[}].rs'],
    ['a*b*c.rs', 'a[*]b[*]c.rs'],
  ])('passes %s to --file as %s', async (relFile, escaped) => {
    await estimateRust(relFile);
    expect(listArgv()).toEqual(['mutants', '--list', '--file', escaped]);
  });

  it('leaves ordinary paths byte-for-byte identical', async () => {
    // Every Rust estimate goes through the escape; rewriting the common case to
    // fix the rare one would be a worse bug than the one being fixed.
    await estimateRust('src/lib.rs');
    expect(listArgv()).toEqual(['mutants', '--list', '--file', 'src/lib.rs']);
  });

  it('reports the UNESCAPED path as `target` — that is display data, not a glob', async () => {
    const r = await estimateRust('src/parser/token[0].rs');
    expect(r.target).toBe('src/parser/token[0].rs');
    expect(r.fidelity).toBe('exact');
    expect(r.mutants).toBe(1);
  });
});
