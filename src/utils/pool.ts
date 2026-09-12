export interface MapPoolOptions<T> {
  /**
   * Called before each item starts. Resolving 'cancelled' skips the item and
   * leaves its result slot undefined, which is how the memory admission gate
   * declines to start work the machine cannot hold.
   */
  admit?: (item: T, index: number) => Promise<'admitted' | 'cancelled'>;
}

/**
 * Run `fn` over `items` with at most `concurrency` tasks in flight, returning
 * results in INPUT order. A throwing `fn` stores the thrown Error in that slot
 * and does not abort the remaining work (callers that wrap their own errors
 * never hit this path; it is a safety net).
 *
 * When `options.admit` is given, claiming the next item and running its
 * admission check is serialized across workers: a new item's admission does
 * not begin until the previous item's `fn` has been INVOKED. That only means
 * the previous item's promise has started running, not that it has done
 * anything yet — `fn` is released the moment it is called, which for the
 * mutation-audit callers is well before that file's sandbox copy finishes and
 * long before its engine actually allocates memory. So several files can be
 * admitted back-to-back against a memory reading taken before any of them
 * has consumed a byte of what it asked for; the serialization only bounds how
 * many admission checks run AT ONCE; it does not make later ones see earlier
 * ones' real cost (see `Watchdog.admit`'s in-flight reservation for the gate
 * that actually charges for it). The work itself still runs concurrently once
 * admitted; only the start of each item is staggered. Without `options.admit`
 * this serialization is skipped entirely, so every existing caller keeps the
 * original, cheaper bare loop.
 */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  options?: MapPoolOptions<T>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const admit = options?.admit;

  const runOne = async (i: number): Promise<void> => {
    try {
      results[i] = await fn(items[i], i);
    } catch (e) {
      results[i] = (e instanceof Error ? e : new Error(String(e))) as unknown as R;
    }
  };

  if (!admit) {
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await runOne(i);
      }
    };
    await Promise.all(Array.from({ length: limit }, () => worker()));
    return results;
  }

  let turn: Promise<void> = Promise.resolve();

  const gatedWorker = async (): Promise<void> => {
    for (;;) {
      const myTurn = turn;
      let releaseTurn!: () => void;
      turn = new Promise((resolve) => {
        releaseTurn = resolve;
      });
      await myTurn;

      const i = next++;
      if (i >= items.length) {
        releaseTurn();
        return;
      }

      let pending: Promise<R> | undefined;
      try {
        if ((await admit(items[i], i)) === 'cancelled') {
          releaseTurn();
          continue;
        }
        pending = fn(items[i], i);
      } catch (e) {
        releaseTurn();
        results[i] = (e instanceof Error ? e : new Error(String(e))) as unknown as R;
        continue;
      }
      releaseTurn();

      try {
        results[i] = await pending;
      } catch (e) {
        results[i] = (e instanceof Error ? e : new Error(String(e))) as unknown as R;
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, () => gatedWorker()));
  return results;
}
