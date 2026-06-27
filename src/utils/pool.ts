/**
 * Run `fn` over `items` with at most `concurrency` tasks in flight, returning
 * results in INPUT order. A throwing `fn` stores the thrown Error in that slot
 * and does not abort the remaining work (callers that wrap their own errors
 * never hit this path; it is a safety net).
 */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = (e instanceof Error ? e : new Error(String(e))) as unknown as R;
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
