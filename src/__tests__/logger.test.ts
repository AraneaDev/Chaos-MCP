import { describe, it, expect, beforeEach, vi } from 'vitest';

let stderrOutput: string[] = [];

// Dynamic import functions — re-imported per test block to reset module state
let enableVerbose: typeof import('../utils/logger.js').enableVerbose;
let isVerbose: typeof import('../utils/logger.js').isVerbose;
let log: typeof import('../utils/logger.js').log;
let warn: typeof import('../utils/logger.js').warn;

beforeEach(async () => {
  // Reset module cache so verboseEnabled starts fresh
  vi.resetModules();

  // Re-import logger with clean module state
  const fresh = await import('../utils/logger.js');
  enableVerbose = fresh.enableVerbose;
  isVerbose = fresh.isVerbose;
  log = fresh.log;
  warn = fresh.warn;

  stderrOutput = [];

  // Mock stderr.write to capture output
  vi.spyOn(process.stderr, 'write').mockImplementation(((
    chunk: string,
    _encoding?: string,
    cb?: () => void,
  ) => {
    stderrOutput.push(typeof chunk === 'string' ? chunk : chunk.toString());
    if (cb) cb();
    return true;
  }) as typeof process.stderr.write);
});

describe('logger', () => {
  describe('enableVerbose / isVerbose', () => {
    it('starts with verbose disabled', () => {
      expect(isVerbose()).toBe(false);
    });

    it('returns true after enableVerbose() is called', () => {
      enableVerbose();
      expect(isVerbose()).toBe(true);
    });

    it('stays true after repeated enableVerbose() calls', () => {
      enableVerbose();
      enableVerbose();
      expect(isVerbose()).toBe(true);
    });
  });

  describe('log', () => {
    it('does NOT write to stderr when verbose is disabled', () => {
      log('should not appear');
      expect(stderrOutput).toHaveLength(0);
    });

    it('writes to stderr when verbose is enabled', () => {
      enableVerbose();
      log('hello world');
      expect(stderrOutput.length).toBeGreaterThan(0);
      const joined = stderrOutput.join('');
      expect(joined).toContain('hello world');
      expect(joined).toContain('[chaos-mcp]');
    });

    it('joins multiple arguments with spaces', () => {
      enableVerbose();
      log('a', 42, { key: 'val' });
      const joined = stderrOutput.join('');
      expect(joined).toContain('a 42');
      expect(joined).toContain('[object Object]');
    });

    it('writes each call as a separate line', () => {
      enableVerbose();
      log('first');
      log('second');
      expect(stderrOutput.length).toBe(2);
    });
  });

  describe('warn', () => {
    it('writes to stderr regardless of verbose mode', () => {
      warn('something is wrong');
      expect(stderrOutput.length).toBeGreaterThan(0);
      const joined = stderrOutput.join('');
      expect(joined).toContain('something is wrong');
      expect(joined).toContain('[chaos-mcp:warn]');
    });

    it('still writes when verbose is enabled', () => {
      enableVerbose();
      warn('both modes');
      expect(stderrOutput.length).toBeGreaterThan(0);
      const joined = stderrOutput.join('');
      expect(joined).toContain('both modes');
    });

    it('joins multiple arguments with spaces', () => {
      warn('code', 500, 'message');
      const joined = stderrOutput.join('');
      expect(joined).toContain('code 500 message');
    });

    it('writes each warn call as separate output', () => {
      warn('first warning');
      warn('second warning');
      expect(stderrOutput.length).toBe(2);
    });
  });
});
