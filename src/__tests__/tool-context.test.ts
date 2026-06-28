import { describe, it, expect, vi } from 'vitest';
import { makeToolContext } from '../tool-context.js';

describe('makeToolContext', () => {
  it('builds a reporter that sends a progress notification when a token is present', async () => {
    const sent: unknown[] = [];
    const sendNotification = vi.fn(async (n: unknown) => {
      sent.push(n);
    });
    const ctx = makeToolContext(
      { params: { _meta: { progressToken: 'tok1' } } },
      { sendNotification },
    );
    expect(ctx.reportProgress).toBeTypeOf('function');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    ctx.reportProgress!(3, 10, 'audited 3/10');
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(sent[0]).toEqual({
      method: 'notifications/progress',
      params: { progressToken: 'tok1', progress: 3, total: 10, message: 'audited 3/10' },
    });
  });

  it('reporter is undefined when no progressToken', () => {
    const ctx = makeToolContext({ params: { _meta: {} } }, { sendNotification: vi.fn() });
    expect(ctx.reportProgress).toBeUndefined();
  });

  it('reporter is undefined when no sendNotification', () => {
    const ctx = makeToolContext({ params: { _meta: { progressToken: 'x' } } }, {});
    expect(ctx.reportProgress).toBeUndefined();
  });

  it('copies the abort signal', () => {
    const ac = new AbortController();
    const ctx = makeToolContext({ params: {} }, { signal: ac.signal });
    expect(ctx.signal).toBe(ac.signal);
  });

  it('swallows a sendNotification rejection', () => {
    const sendNotification = vi.fn(async () => {
      throw new Error('boom');
    });
    const ctx = makeToolContext({ params: { _meta: { progressToken: 1 } } }, { sendNotification });
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(() => ctx.reportProgress!(1, 2)).not.toThrow();
  });

  it('omits total/message when not provided', () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const sendNotification = vi.fn(async () => {});
    const ctx = makeToolContext(
      { params: { _meta: { progressToken: 'p' } } },
      { sendNotification },
    );
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    ctx.reportProgress!(5);
    expect(sendNotification).toHaveBeenCalledWith({
      method: 'notifications/progress',
      params: { progressToken: 'p', progress: 5 },
    });
  });
});
