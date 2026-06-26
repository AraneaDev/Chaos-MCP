import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the modules cli.ts depends on so runCli is exercised in-process.
vi.mock('../utils/config-loader.js', () => ({
  loadConfig: vi.fn(() => ({})),
  validateConfig: vi.fn(() => ({ config: {}, warnings: [] as string[] })),
}));
vi.mock('../utils/logger.js', () => ({
  enableVerbose: vi.fn(),
  log: vi.fn(),
  isVerbose: vi.fn(() => false),
}));

import { checkNodeVersion, buildHelpText, runCli } from '../cli.js';
import { loadConfig, validateConfig } from '../utils/config-loader.js';
import { enableVerbose, isVerbose, log } from '../utils/logger.js';

const mockLoadConfig = vi.mocked(loadConfig);
const mockValidateConfig = vi.mocked(validateConfig);
const mockEnableVerbose = vi.mocked(enableVerbose);
const mockIsVerbose = vi.mocked(isVerbose);
const mockLog = vi.mocked(log);

/** A process.exit stub that throws so control flow halts like the real exit. */
class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe('cli', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const origArgv = process.argv;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({});
    mockValidateConfig.mockReturnValue({ config: {}, warnings: [] });
    mockIsVerbose.mockReturnValue(false);
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
      setNode('20.0.0');
      expect(() => checkNodeVersion()).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('accepts exactly the minimum version 18.0.0', () => {
      setNode('18.0.0');
      expect(() => checkNodeVersion()).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('exits 1 on an unsupported runtime with the full upgrade message', () => {
      setNode('16.20.0');
      expect(() => checkNodeVersion()).toThrow(ExitError);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('requires Node.js >= 18.0.0'));
      // Second half of the template literal (its own StringLiteral mutant).
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('you are running 16.20.0'));
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('Please upgrade your Node.js runtime'),
      );
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('https://nodejs.org/'));
    });

    it('exits 1 when only the minor is below the floor', () => {
      // 18.0 is the floor; nothing below 18 minor exists, but guard the major===min path
      setNode('17.9.0');
      expect(() => checkNodeVersion()).toThrow(ExitError);
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

    it('--validate-config with no warnings reports valid, exits 0, and passes no config path', () => {
      mockValidateConfig.mockReturnValue({ config: {}, warnings: [] });
      const { startServer, exitCode } = run(['--validate-config']);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('valid'));
      expect(exitCode).toBe(0);
      expect(startServer).not.toHaveBeenCalled();
      // No --config flag → path must be undefined (not args[0]).
      expect(mockValidateConfig).toHaveBeenCalledWith(undefined);
    });

    it('--validate-config with warnings prints each warning line and exits 1 (non-strict)', () => {
      mockValidateConfig.mockReturnValue({ config: {}, warnings: ['bad key', 'other'] });
      const { exitCode } = run(['--validate-config']);
      expect(errSpy).toHaveBeenCalledWith('Config validation warnings:');
      // The loop body must actually emit each warning line.
      expect(errSpy).toHaveBeenCalledWith('  - bad key');
      expect(errSpy).toHaveBeenCalledWith('  - other');
      expect(exitCode).toBe(1);
    });

    it('--validate-config --strict exits 2 on warnings', () => {
      mockValidateConfig.mockReturnValue({ config: {}, warnings: ['bad key'] });
      const { exitCode } = run(['--validate-config', '--strict']);
      expect(exitCode).toBe(2);
    });

    it('--validate-config passes the --config path through', () => {
      mockValidateConfig.mockReturnValue({ config: {}, warnings: [] });
      run(['--validate-config', '--config', '/tmp/cfg.json']);
      expect(mockValidateConfig).toHaveBeenCalledWith('/tmp/cfg.json');
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
      run(['--config', '/tmp/my.json']);
      expect(mockLoadConfig).toHaveBeenCalledWith('/tmp/my.json');
    });

    it('logs the loaded config in verbose mode when it is non-empty', () => {
      mockIsVerbose.mockReturnValue(true);
      mockLoadConfig.mockReturnValue({ defaultTimeoutMs: 1234 });
      run(['--verbose']);
      expect(mockLog).toHaveBeenCalledWith('Config loaded:', expect.stringContaining('1234'));
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
