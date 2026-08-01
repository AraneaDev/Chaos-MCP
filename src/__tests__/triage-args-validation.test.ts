import { describe, it, expect } from 'vitest';
import { TRIAGE_ARG_VALIDATORS } from '../core/triage-args-validation.js';
import { MAX_TIMEOUT_MS } from '../utils/constants.js';
import type { ToolArgs } from '../core/tool-args-validation.js';

/** Run the ordered table exactly as `validateTriageArgs` does: first failure wins. */
const firstError = (args: ToolArgs): string | null => {
  for (const validate of TRIAGE_ARG_VALIDATORS) {
    const message = validate(args);
    if (message !== null) return message;
  }
  return null;
};

/**
 * `tool-schema.ts` declares `maximum` for both budgets, but the MCP SDK does
 * NOT validate arguments against `inputSchema` — so until these rules existed
 * nothing enforced the cap at runtime. A value above it is clamped by Node to
 * 1 ms, which aborts the run instantly instead of granting more time.
 */
describe('triage timeout arguments are capped at MAX_TIMEOUT_MS', () => {
  const base = { paths: ['src'] };

  it('accepts totalTimeoutMs exactly at the cap', () => {
    expect(firstError({ ...base, totalTimeoutMs: MAX_TIMEOUT_MS })).toBeNull();
  });

  it('rejects totalTimeoutMs one millisecond above the cap', () => {
    const message = firstError({ ...base, totalTimeoutMs: MAX_TIMEOUT_MS + 1 });
    expect(message).toContain('totalTimeoutMs');
    expect(message).toContain(String(MAX_TIMEOUT_MS));
    expect(message).toContain('clamped to 1ms');
  });

  it('accepts timeoutMs exactly at the cap', () => {
    expect(firstError({ ...base, timeoutMs: MAX_TIMEOUT_MS })).toBeNull();
  });

  it('rejects timeoutMs one millisecond above the cap', () => {
    const message = firstError({ ...base, timeoutMs: MAX_TIMEOUT_MS + 1 });
    expect(message).toContain('timeoutMs');
    expect(message).toContain(String(MAX_TIMEOUT_MS));
    expect(message).toContain('clamped to 1ms');
  });

  it('still rejects a non-positive budget with the original wording', () => {
    // The cap branch must not displace the positivity branch: 0 and -1 are
    // "not a positive number", not "above the maximum".
    expect(firstError({ ...base, totalTimeoutMs: 0 })).toBe(
      'totalTimeoutMs must be a positive number. Example: 900000.',
    );
    expect(firstError({ ...base, timeoutMs: -1 })).toBe(
      'timeoutMs must be a positive number. Example: 300000.',
    );
  });

  it('leaves both budgets optional', () => {
    expect(firstError(base)).toBeNull();
  });
});

/**
 * `validateOutputFormatArg` was entirely unexercised: a mutation audit found its
 * condition, both sub-conditions, the return block AND the message all survive
 * mutation, because nothing ever passed an invalid `outputFormat` to triage.
 *
 * The valid cases matter as much as the invalid one. Forcing `outputFormat !== 'json'`
 * to true (or swapping it to `===`, or blanking the 'json' literal) only shows up
 * when a legitimate value is asserted to pass.
 */
describe('triage outputFormat validation', () => {
  const base = { paths: ['src'] };

  it('accepts "text"', () => {
    expect(firstError({ ...base, outputFormat: 'text' })).toBeNull();
  });

  it('accepts "json"', () => {
    expect(firstError({ ...base, outputFormat: 'json' })).toBeNull();
  });

  it('leaves outputFormat optional', () => {
    expect(firstError(base)).toBeNull();
  });

  it('rejects an unsupported format and names the permitted ones', () => {
    const message = firstError({ ...base, outputFormat: 'xml' });
    expect(message).toContain('outputFormat must be one of "text" or "json"');
  });
});
