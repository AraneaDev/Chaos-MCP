import { describe, it, expect } from 'vitest';
import { mapPool } from '../utils/pool.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('mapPool', () => {
  it('returns results in input order', async () => {
    const out = await mapPool([1, 2, 3, 4], 2, async (n) => {
      await tick();
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it('never exceeds the concurrency bound', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight--;
        return n;
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('still processes every item when concurrency is 0 (floored to 1)', async () => {
    // Math.max(1, …) floors the worker count: concurrency 0 must NOT mean "no
    // workers" (which would return an unfilled array). Kills the `Math.max → Math.min`
    // mutant, under which limit would be 0 and nothing would run.
    const out = await mapPool([1, 2, 3], 0, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30]);
  });

  it('does not let one rejection sink the others', async () => {
    const out = await mapPool([0, 1, 2], 3, async (n) => {
      if (n === 1) throw new Error('boom');
      await tick();
      return n;
    });
    expect(out[0]).toBe(0);
    expect(out[2]).toBe(2);
    expect(out[1]).toBeInstanceOf(Error);
  });

  it('actually runs the requested number of tasks in parallel', async () => {
    // `peak <= concurrency` alone cannot tell a working pool from a serial one.
    // This pins the LOWER bound too: with 10 items and concurrency 3, exactly 3
    // tasks must be in flight at once. Every mutant that collapses
    // `Math.min(concurrency, items.length || 1)` to 1 — `|| 1` forced to
    // true/false, or rewritten as `&& 1` — leaves the pool correct but serial,
    // which is invisible to an upper-bound assertion.
    let inFlight = 0;
    let peak = 0;
    await mapPool(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight--;
        return n;
      },
    );
    expect(peak).toBe(3);
  });

  it('never spawns more workers than there are items', async () => {
    // Pins the `Math.min(...)` against the item count: asking for 8 workers for
    // 2 items must not start 8.
    let inFlight = 0;
    let peak = 0;
    await mapPool([1, 2], 8, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      return n;
    });
    expect(peak).toBe(2);
  });

  it('returns an empty array for no items without hanging', async () => {
    // The `items.length || 1` fallback keeps at least one worker alive so
    // Promise.all resolves; a zero-worker pool would resolve too, but a
    // negative/NaN limit would make Array.from throw.
    await expect(mapPool([], 4, async (n: number) => n)).resolves.toEqual([]);
  });

  it('waits for admit before starting each item', async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const run = mapPool([1, 2], 2, async (n) => {
      order.push(`run:${n}`);
      return n;
    }, {
      admit: async (n) => {
        order.push(`admit:${n}`);
        if (n === 2) await gate;
        return 'admitted';
      },
    });

    await tick();
    expect(order).toEqual(['admit:1', 'run:1', 'admit:2']);
    release?.();
    await run;
    expect(order).toContain('run:2');
  });

  it('skips an item whose admission is cancelled', async () => {
    const ran: number[] = [];
    const out = await mapPool([1, 2, 3], 2, async (n) => {
      ran.push(n);
      return n;
    }, {
      admit: async (n) => (n === 2 ? 'cancelled' : 'admitted'),
    });
    expect(ran.sort()).toEqual([1, 3]);
    expect(out[1]).toBeUndefined();
  });

  it('returns results in input order on the gated (admit) path too', async () => {
    // Completion order is scrambled on purpose (item 1 finishes last), so this
    // only passes if results are written by index rather than by completion.
    const out = await mapPool(
      [1, 2, 3, 4],
      2,
      async (n) => {
        if (n === 1) await tick();
        return n * 10;
      },
      { admit: async () => 'admitted' },
    );
    expect(out).toEqual([10, 20, 30, 40]);
  });
});
