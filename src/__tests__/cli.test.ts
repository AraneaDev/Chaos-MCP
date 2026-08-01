import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

// Mock the modules cli.ts depends on so runCli is exercised in-process.
vi.mock('../utils/config-loader.js', () => ({
  loadConfig: vi.fn(() => ({})),
  validateConfig: vi.fn(() => ({ config: {}, warnings: [] as string[], status: 'ok' as const })),
}));
vi.mock('../utils/logger.js', () => ({
  enableVerbose: vi.fn(),
  log: vi.fn(),
  isVerbose: vi.fn(() => false),
}));
vi.mock('../utils/container/doctor.js', () => ({
  inspectContainerRuntime: vi.fn(),
}));

import { checkNodeVersion, buildHelpText, runCli, MIN_NODE_VERSION } from '../cli.js';
import { loadConfig, validateConfig } from '../utils/config-loader.js';
import { enableVerbose, isVerbose, log } from '../utils/logger.js';
import { inspectContainerRuntime } from '../utils/container/doctor.js';

const mockLoadConfig = vi.mocked(loadConfig);
const mockValidateConfig = vi.mocked(validateConfig);
const mockEnableVerbose = vi.mocked(enableVerbose);
const mockIsVerbose = vi.mocked(isVerbose);
const mockLog = vi.mocked(log);
const mockInspectContainerRuntime = vi.mocked(inspectContainerRuntime);

/**
 * Real filesystem paths for the `--config <missing file>` check.
 *
 * `fs` is deliberately NOT mocked here: the CLI's existence check and the config
 * loader must agree on the SAME resolved path, and mocking `existsSync` would
 * let them disagree without any test noticing. This file is guaranteed to exist
 * (it is the one running); the other name is guaranteed not to.
 */
const existingConfigPath = fileURLToPath(import.meta.url);
const missingConfigPath = resolve(tmpdir(), 'chaos-mcp-no-such-config-9f3c1a.json');

/** A process.exit stub that throws so control flow halts like the real exit. */
class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe('cli', () => {
  // Typed per spied function — a bare `ReturnType<typeof vi.spyOn>` resolves to
  // the generic `(...args: unknown[]) => unknown` instance, which the concrete
  // `process.exit` spy is not assignable to.
  let exitSpy: MockInstance<typeof process.exit>;
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;
  const origArgv = process.argv;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({});
    mockValidateConfig.mockReturnValue({ config: {}, warnings: [], status: 'ok' });
    mockIsVerbose.mockReturnValue(false);
    process.exitCode = undefined;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.argv = origArgv;
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = undefined;
  });

  /** Run cli with the given flags; returns the injected startServer spy. */
  function run(flags: string[]) {
    process.argv = ['node', 'chaos-mcp', ...flags];
    const startServer = vi.fn(async () => undefined);
    let exitCode: number | undefined;
    try {
      runCli({ appVersion: '9.9.9', startServer });
    } catch (e) {
      if (e instanceof ExitError) exitCode = e.code;
      else throw e;
    }
    return { startServer, exitCode };
  }

  // ── buildHelpText ──
  describe('buildHelpText', () => {
    it('embeds the supplied version in the banner', () => {
      expect(buildHelpText('1.2.3')).toContain('chaos-mcp v1.2.3');
    });

    it('documents every CLI flag and the tool name', () => {
      const help = buildHelpText('1.2.3');
      for (const flag of [
        '--version',
        '--help',
        '--config',
        '--validate-config',
        '--container-doctor',
        '--strict',
        '--verbose',
      ]) {
        expect(help).toContain(flag);
      }
      expect(help).toContain('audit_code_resilience');
    });
  });

  // ── checkNodeVersion ──
  describe('checkNodeVersion', () => {
    const origVersions = process.versions;
    afterEach(() => {
      Object.defineProperty(process, 'versions', { value: origVersions, configurable: true });
    });

    function setNode(version: string) {
      Object.defineProperty(process, 'versions', {
        value: { ...origVersions, node: version },
        configurable: true,
      });
    }

    it('passes on a supported runtime (no exit)', () => {
      setNode('24.0.0');
      expect(() => checkNodeVersion()).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('accepts exactly the minimum version', () => {
      setNode(MIN_NODE_VERSION);
      expect(() => checkNodeVersion()).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('exits 1 on an unsupported runtime with the full upgrade message', () => {
      // Below the floor. This used to be a version the check ACCEPTED: the
      // constant had drifted to 18 while package.json required >= 22, so a
      // Node 18 user passed here and failed obscurely later instead.
      setNode('18.20.0');
      expect(() => checkNodeVersion()).toThrow(ExitError);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining(`requires Node.js >= ${MIN_NODE_VERSION}`),
      );
      // Second half of the template literal (its own StringLiteral mutant).
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('you are running 18.20.0'));
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('Please upgrade your Node.js runtime'),
      );
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('https://nodejs.org/'));
    });

    it('exits 1 on the major version directly below the floor', () => {
      // NOTE: this does NOT exercise the `currentMajor === minMajor` arm, despite
      // what its previous name claimed — 21 < 22 is decided by the first clause
      // alone. That second arm is in fact unreachable while MIN_NODE_VERSION has
      // a minor of 0, since `currentMinor < 0` can never hold. It becomes live
      // (and testable) the moment the floor gains a non-zero minor.
      setNode('21.9.0');
      expect(() => checkNodeVersion()).toThrow(ExitError);
    });

    it('accepts a runtime above the floor in both major and minor', () => {
      setNode('24.5.1');
      expect(() => checkNodeVersion()).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  // ── runCli ──
  describe('runCli', () => {
    it('--version prints the version and exits 0 without starting the server', () => {
      const { startServer, exitCode } = run(['--version']);
      expect(logSpy).toHaveBeenCalledWith('chaos-mcp v9.9.9');
      expect(exitCode).toBe(0);
      expect(startServer).not.toHaveBeenCalled();
    });

    it('--help prints help text and exits 0 without starting the server', () => {
      const { startServer, exitCode } = run(['--help']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('chaos-mcp v9.9.9'));
      expect(exitCode).toBe(0);
      expect(startServer).not.toHaveBeenCalled();
    });

    it('--container-doctor reports all image states without starting the server', async () => {
      mockLoadConfig.mockReturnValue({ container: { mode: 'container' } });
      mockInspectContainerRuntime.mockResolvedValue({
        runtime: 'docker',
        available: true,
        serverVersion: '27.0.0',
        mode: 'container',
        images: {
          typescript: { image: 'ts', present: true },
          python: { image: 'py', present: true },
          rust: { image: 'rs', present: true },
          php: { image: 'php', present: true },
        },
      });

      const { startServer } = run(['--container-doctor']);
      const report = await mockInspectContainerRuntime.mock.results[0]?.value;
      await vi.waitFor(() => expect(logSpy).toHaveBeenCalledWith(JSON.stringify(report, null, 2)));

      expect(mockInspectContainerRuntime).toHaveBeenCalledWith({ mode: 'container' });
      expect(process.exitCode).toBe(0);
      expect(startServer).not.toHaveBeenCalled();
    });

    it('--container-doctor honors --config and fails when one image is missing', async () => {
      mockLoadConfig.mockReturnValue({ container: { mode: 'auto' } });
      mockInspectContainerRuntime.mockResolvedValue({
        runtime: 'podman',
        available: true,
        mode: 'auto',
        images: {
          typescript: { image: 'ts', present: true },
          python: { image: 'py', present: false },
          rust: { image: 'rs', present: true },
          php: { image: 'php', present: true },
        },
      });

      run(['--container-doctor', '--config', '/tmp/custom.json']);
      await vi.waitFor(() => expect(process.exitCode).toBe(1));

      expect(mockLoadConfig).toHaveBeenCalledWith('/tmp/custom.json');
      expect(mockInspectContainerRuntime).toHaveBeenCalledWith({ mode: 'auto' });
    });

    it('--container-doctor fails when the runtime is unavailable', async () => {
      mockInspectContainerRuntime.mockResolvedValue({
        runtime: 'docker',
        available: false,
        mode: 'native',
        images: {
          typescript: { image: 'ts', present: true },
          python: { image: 'py', present: true },
          rust: { image: 'rs', present: true },
          php: { image: 'php', present: true },
        },
      });

      run(['--container-doctor']);
      await vi.waitFor(() => expect(process.exitCode).toBe(1));
    });

    it('--container-doctor reports configuration load failures and stops', () => {
      mockLoadConfig.mockImplementationOnce(() => {
        throw new Error('bad config');
      });

      const { startServer } = run(['--container-doctor']);

      expect(errSpy).toHaveBeenCalledWith('Container doctor could not load config: bad config');
      expect(process.exitCode).toBe(1);
      expect(mockInspectContainerRuntime).not.toHaveBeenCalled();
      expect(startServer).not.toHaveBeenCalled();
    });

    it('--container-doctor reports asynchronous diagnostic failures', async () => {
      mockInspectContainerRuntime.mockRejectedValueOnce(new Error('daemon failed'));

      run(['--container-doctor']);
      await vi.waitFor(() =>
        expect(errSpy).toHaveBeenCalledWith('Container doctor failed: daemon failed'),
      );

      expect(process.exitCode).toBe(1);
    });

    it('--validate-config with no warnings reports valid, exits 0, and passes no config path', () => {
      mockValidateConfig.mockReturnValue({ config: {}, warnings: [], status: 'ok' });
      const { startServer, exitCode } = run(['--validate-config']);
      // Exact, not `stringContaining('valid')` — the FAILURE banner is "Config
      // validation warnings:", which contains "valid" too, so the loose form
      // passes whichever branch was taken.
      expect(errSpy).toHaveBeenCalledWith('Config is valid — no warnings.');
      expect(errSpy).not.toHaveBeenCalledWith('Config validation warnings:');
      expect(exitCode).toBe(0);
      expect(startServer).not.toHaveBeenCalled();
      // No --config flag → path must be undefined (not args[0]).
      expect(mockValidateConfig).toHaveBeenCalledWith(undefined);
    });

    it('--validate-config prints each warning line but exits 0 (non-strict)', () => {
      // Advisory warnings are not failures without --strict. Exiting 1 here
      // made --strict's documented purpose ("exit 2 on warnings (fatal in
      // CI)") false, since warnings were already fatal without it.
      mockValidateConfig.mockReturnValue({
        config: {},
        warnings: ['bad key', 'other'],
        status: 'ok',
      });
      const { exitCode } = run(['--validate-config']);
      expect(errSpy).toHaveBeenCalledWith('Config validation warnings:');
      // The loop body must actually emit each warning line.
      expect(errSpy).toHaveBeenCalledWith('  - bad key');
      expect(errSpy).toHaveBeenCalledWith('  - other');
      expect(exitCode).toBe(0);
    });

    it('--validate-config exits 1 when the config file cannot be parsed', () => {
      mockValidateConfig.mockReturnValue({
        config: {},
        warnings: ['Failed to parse config file "/tmp/cfg.json": Unexpected token'],
        status: 'unreadable',
      });
      const { exitCode } = run(['--validate-config', '--config', '/tmp/cfg.json']);
      expect(exitCode).toBe(1);
      // The banner distinguishes an unreadable file from advisory warnings, and
      // the loop body is the only thing that tells the operator WHICH file and
      // WHY — an exit code alone sends them looking through the whole config.
      expect(errSpy).toHaveBeenCalledWith('Config error:');
      expect(errSpy).toHaveBeenCalledWith(
        '  - Failed to parse config file "/tmp/cfg.json": Unexpected token',
      );
    });

    it('--validate-config exits 0 when no config exists at the DEFAULT path', () => {
      // Running on defaults is a valid configuration, not a failure.
      mockValidateConfig.mockReturnValue({
        config: {},
        warnings: ['Config file not found: /work/chaos-mcp.config.json'],
        status: 'not-found',
      });
      const { exitCode } = run(['--validate-config']);
      expect(exitCode).toBe(0);
      // Wording matters as much as the exit code: this is the reassuring case,
      // and calling it "Config error:" would send an operator hunting for a
      // problem that does not exist.
      expect(errSpy).toHaveBeenCalledWith('Config not found — using built-in defaults:');
      expect(errSpy).toHaveBeenCalledWith('  - Config file not found: /work/chaos-mcp.config.json');
    });

    it('--validate-config exits 1 when an EXPLICIT --config path does not exist', () => {
      // A mistyped path the operator named themselves must never read as success.
      mockValidateConfig.mockReturnValue({
        config: {},
        warnings: ['Config file not found: /tmp/nope.json'],
        status: 'not-found',
      });
      const { exitCode } = run(['--validate-config', '--config', '/tmp/nope.json']);
      expect(exitCode).toBe(1);
      // Same branch, opposite verdict — the operator named this file, so a
      // missing one IS an error and must not read as "using defaults".
      expect(errSpy).toHaveBeenCalledWith('Config error:');
      expect(errSpy).not.toHaveBeenCalledWith('Config not found — using built-in defaults:');
      expect(errSpy).toHaveBeenCalledWith('  - Config file not found: /tmp/nope.json');
    });

    it('--validate-config --strict exits 2 on warnings', () => {
      mockValidateConfig.mockReturnValue({ config: {}, warnings: ['bad key'], status: 'ok' });
      const { exitCode } = run(['--validate-config', '--strict']);
      expect(exitCode).toBe(2);
    });

    it('--validate-config passes the --config path through', () => {
      mockValidateConfig.mockReturnValue({ config: {}, warnings: [], status: 'ok' });
      run(['--validate-config', '--config', '/tmp/cfg.json']);
      expect(mockValidateConfig).toHaveBeenCalledWith('/tmp/cfg.json');
    });

    it('--validate-config --config (as the LAST token) warns instead of reading past the end', () => {
      // `--config` with nothing after it: the bounds check is the only thing
      // between this and indexing one past the end of argv, where `undefined`
      // reaches `.startsWith` and takes the whole CLI down with a TypeError.
      mockValidateConfig.mockReturnValue({ config: {}, warnings: [], status: 'ok' });
      const { exitCode } = run(['--validate-config', '--config']);
      expect(mockValidateConfig).toHaveBeenCalledWith(undefined);
      expect(errSpy).toHaveBeenCalledWith(
        'Warning: --config expects a path but got no value; ignoring.',
      );
      expect(exitCode).toBe(0);
    });

    it('stays silent about --config when the flag was never passed', () => {
      // `indexOf` returns -1 when the flag is absent, and -1 + 1 === 0 indexes
      // the FIRST argument. Without the early return the first token is read as
      // the config path — and a warning is printed about an argument the
      // operator never wrote.
      mockValidateConfig.mockReturnValue({ config: {}, warnings: [], status: 'ok' });
      run(['--validate-config', '--strict']);
      expect(mockValidateConfig).toHaveBeenCalledWith(undefined);
      expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('--config expects a path'));
    });

    it('--validate-config --config --strict does not treat --strict as the path, and warns (L2)', () => {
      mockValidateConfig.mockReturnValue({ config: {}, warnings: [], status: 'ok' });
      run(['--validate-config', '--config', '--strict']);
      expect(mockValidateConfig).toHaveBeenCalledWith(undefined);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('--config expects a path but got "--strict"; ignoring.'),
      );
    });

    it('--verbose enables verbose logging, logs the banner, then starts the server', () => {
      const { startServer } = run(['--verbose']);
      expect(mockEnableVerbose).toHaveBeenCalled();
      expect(mockLog).toHaveBeenCalledWith('Verbose mode enabled');
      expect(startServer).toHaveBeenCalledTimes(1);
    });

    it('default run loads config, starts the server, and does NOT enable verbose or log config', () => {
      mockLoadConfig.mockReturnValue({ defaultTimeoutMs: 1234 });
      const { startServer } = run([]);
      expect(mockLoadConfig).toHaveBeenCalledWith(undefined);
      expect(startServer).toHaveBeenCalledWith({ defaultTimeoutMs: 1234 });
      // Verbose branch (line 142) and the verbose config-log gate (line 155) must stay off.
      expect(mockEnableVerbose).not.toHaveBeenCalled();
      expect(mockLog).not.toHaveBeenCalledWith('Config loaded:', expect.anything());
    });

    it('does NOT log the loaded config in verbose mode when the config is empty', () => {
      mockIsVerbose.mockReturnValue(true);
      mockLoadConfig.mockReturnValue({});
      run(['--verbose']);
      // length > 0 gate: an empty config must not produce a "Config loaded:" line.
      expect(mockLog).not.toHaveBeenCalledWith('Config loaded:', expect.anything());
    });

    it('passes the --config path to loadConfig', () => {
      run(['--config', existingConfigPath]);
      expect(mockLoadConfig).toHaveBeenCalledWith(existingConfigPath);
    });

    // ── --config <missing file> (audit finding 18) ──
    //
    // `readConfigRaw` treats a nonexistent path as "no config" and returns null,
    // so `loadConfig` returns {} WITHOUT throwing: the catch below it never
    // fires, and the verbose branch is gated on a NON-empty config, so it stayed
    // silent too. The server started on built-in defaults and a mistyped
    // --config path was indistinguishable from a working one.
    it('warns on stderr when an explicit --config path does not exist', () => {
      const { startServer } = run(['--config', missingConfigPath]);
      // Names the RESOLVED path — the same one the loader looked for, via the
      // resolver imported from parse.ts — so the operator can see the typo.
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining(`config file not found at ${resolve(missingConfigPath)}`),
      );
      // …and says what happened instead, which is the actionable half.
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('using built-in defaults'));
      // Advisory only: --validate-config owns the fatal variant, so the server
      // still starts and the exit code is untouched.
      expect(startServer).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
    });

    it('resolves a RELATIVE --config path before reporting it missing', () => {
      // A bare filename must not be reported as-is: the loader resolves it
      // against cwd, and reporting the unresolved string sends the operator
      // looking in the wrong directory.
      run(['--config', 'nope-chaos-mcp.config.json']);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining(resolve('nope-chaos-mcp.config.json')),
      );
    });

    it('stays silent when the explicit --config path exists', () => {
      run(['--config', existingConfigPath]);
      expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('config file not found at'));
    });

    it('stays silent about a missing config when --config was never passed', () => {
      // No config at the DEFAULT location is the ordinary case — running on
      // built-in defaults is a valid configuration, not something to warn about.
      const { startServer } = run([]);
      expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('config file not found at'));
      expect(startServer).toHaveBeenCalledTimes(1);
    });

    it('does not warn when --config was given no usable value', () => {
      // `getFlagValue` already warned and returned undefined; a second warning
      // about a path the operator never wrote would be noise.
      run(['--config', '--strict']);
      expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('config file not found at'));
    });

    it('--config --strict does not treat --strict as the path, warns, and still starts the server (L2)', () => {
      const { startServer } = run(['--config', '--strict']);
      expect(mockLoadConfig).toHaveBeenCalledWith(undefined);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('--config expects a path but got "--strict"; ignoring.'),
      );
      expect(startServer).toHaveBeenCalledTimes(1);
    });

    it('logs the loaded config in verbose mode when it is non-empty', () => {
      mockIsVerbose.mockReturnValue(true);
      mockLoadConfig.mockReturnValue({ defaultTimeoutMs: 1234 });
      run(['--verbose']);
      expect(mockLog).toHaveBeenCalledWith('Config loaded:', expect.stringContaining('1234'));
    });

    it('reports a server startup failure instead of an unhandled rejection', async () => {
      // startServer awaits server.connect(transport), which rejects on any
      // transport-setup failure. runCli returns void and is called at module top
      // level, so an unhandled rejection here kills the process with a raw
      // ERR_UNHANDLED_REJECTION stack under Node's default
      // --unhandled-rejections=throw — instead of the clean diagnostic every
      // other runCli failure path prints.
      process.argv = ['node', 'chaos-mcp'];
      const startServer = vi.fn(() => Promise.reject(new Error('stdio transport gone')));

      runCli({ appVersion: '9.9.9', startServer });

      await vi.waitFor(() =>
        expect(errSpy).toHaveBeenCalledWith('chaos-mcp failed to start: stdio transport gone'),
      );
      expect(process.exitCode).toBe(1);
    });

    it('stringifies a non-Error startup rejection', async () => {
      // The `error instanceof Error ? … : String(error)` arm — a thrown string
      // or object must still produce a message, not "[object Object]"-less noise.
      process.argv = ['node', 'chaos-mcp'];
      const startServer = vi.fn(() => Promise.reject('boom'));

      runCli({ appVersion: '9.9.9', startServer });

      await vi.waitFor(() =>
        expect(errSpy).toHaveBeenCalledWith('chaos-mcp failed to start: boom'),
      );
      expect(process.exitCode).toBe(1);
    });

    it('leaves the exit code untouched when the server starts cleanly', () => {
      // The catch must not fire on the happy path.
      const { startServer } = run([]);
      expect(startServer).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
      expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('failed to start'));
    });

    it('still starts the server when loadConfig throws', () => {
      mockLoadConfig.mockImplementation(() => {
        throw new Error('broken config');
      });
      const { startServer } = run([]);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('broken config'));
      expect(startServer).toHaveBeenCalledTimes(1);
    });
  });
});
