/** Per-request capabilities derived from the MCP handler `extra`. */
export interface ToolContext {
  /** Abort signal for the request; aborting kills in-flight subprocesses. */
  signal?: AbortSignal;
  /** Token-gated progress reporter; undefined when the client sent no progressToken. */
  reportProgress?: (progress: number, total?: number, message?: string) => void;
}

interface RequestLike {
  params?: { _meta?: { progressToken?: string | number } };
}
interface ExtraLike {
  signal?: AbortSignal;
  sendNotification?: (n: unknown) => Promise<void>;
}

/**
 * Build a {@link ToolContext} from an MCP request + handler `extra`. The
 * progress reporter is created only when both a `progressToken` (request
 * `_meta`) and a `sendNotification` (extra) are available; otherwise it is
 * undefined and callers no-op via `ctx.reportProgress?.(…)`. Progress sends are
 * fire-and-forget — a rejected notification is swallowed so it can never break
 * an actual run.
 */
export function makeToolContext(request: RequestLike, extra?: ExtraLike): ToolContext {
  const token = request.params?._meta?.progressToken;
  const send = extra?.sendNotification;
  const ctx: ToolContext = { signal: extra?.signal };
  if (token !== undefined && send) {
    ctx.reportProgress = (progress: number, total?: number, message?: string) => {
      const params: Record<string, unknown> = { progressToken: token, progress };
      if (total !== undefined) params.total = total;
      if (message !== undefined) params.message = message;
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      void Promise.resolve(send({ method: 'notifications/progress', params })).catch(() => {});
    };
  }
  return ctx;
}
