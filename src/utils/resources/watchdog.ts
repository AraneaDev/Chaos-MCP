/**
 * Memory watchdog.
 *
 * Estimates are what crashed this box before, so the guarantee cannot rest on
 * them: this samples the real figure and stops the NEWEST run when memory nears
 * exhaustion. Newest, because it has done the least work and because stopping
 * it leaves the oldest runs free to finish and release their memory.
 *
 * The cooldown stops one pressure spike from cascading through every run: after
 * a trip, memory needs a moment to come back before the next judgement.
 *
 * An 'unavailable' probe disables every judgement, which reproduces today's
 * behaviour rather than guessing.
 */
import type { MemorySnapshot } from './memory-probe.js';
import { ResourceExhaustedError } from './errors.js';

export interface WatchdogOptions {
  probe: () => MemorySnapshot;
  criticalBytes: number;
  admissionBytes: number;
  /** Sampling period for the internal timer. Tests drive `tick()` directly. */
  intervalMs?: number;
  cooldownMs?: number;
  now?: () => number;
}

export interface RunHandle {
  release(): void;
}

export interface Watchdog {
  /**
   * `costBytes`, when given, is CHARGED against admission (see `admit`) from
   * this call until the returned handle's `release()`, the gate's answer to
   * `mapPool`'s admission checks running well before a run has actually
   * allocated anything (utils/pool.ts docblock). Optional so a caller with no
   * cost figure (or a test) gets the pre-existing behaviour unchanged.
   */
  register(controller: AbortController, costBytes?: number): RunHandle;
  admit(costBytes: number, signal?: AbortSignal): Promise<'admitted' | 'cancelled'>;
  tick(): void;
  stop(): void;
  readonly trips: number;
}

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_COOLDOWN_MS = 10_000;

export function createWatchdog(options: WatchdogOptions): Watchdog {
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const live: AbortController[] = [];
  interface WaitingEntry {
    costBytes: number;
    resolve: (value: 'admitted' | 'cancelled') => void;
    cleanup?: () => void;
  }
  const waiting: WaitingEntry[] = [];
  let trips = 0;
  let lastTripAt = Number.NEGATIVE_INFINITY;
  // Sum of `costBytes` for runs that have been REGISTERED (started) but not
  // yet RELEASED (finished). Charged against every admission check in
  // addition to the probe's own reading, because the probe cannot see memory
  // a just-started run has not allocated yet, see `admit`'s docblock and
  // `utils/pool.ts`'s admission-serialization comment for the gap this closes.
  let reservedBytes = 0;

  const timer = setInterval(() => api.tick(), options.intervalMs ?? DEFAULT_INTERVAL_MS);
  // Never hold the process open for a sampler.
  timer.unref?.();

  const api: Watchdog = {
    get trips() {
      return trips;
    },

    register(controller, costBytes) {
      live.push(controller);
      let released = false;
      if (costBytes) reservedBytes += costBytes;
      return {
        release() {
          const index = live.indexOf(controller);
          if (index >= 0) live.splice(index, 1);
          if (costBytes && !released) {
            released = true;
            reservedBytes = Math.max(0, reservedBytes - costBytes);
          }
        },
      };
    },

    admit(costBytes, signal) {
      const snapshot = options.probe();
      if (snapshot.source === 'unavailable') return Promise.resolve('admitted');
      if (snapshot.availableBytes - costBytes - reservedBytes >= options.admissionBytes) {
        return Promise.resolve('admitted');
      }
      if (signal?.aborted) return Promise.resolve('cancelled');

      return new Promise((resolve) => {
        const entry: WaitingEntry = {
          costBytes,
          resolve: resolve as (value: 'admitted' | 'cancelled') => void,
        };

        const abortListener = () => {
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
          resolve('cancelled');
        };

        entry.cleanup = () => {
          if (signal && abortListener) {
            signal.removeEventListener('abort', abortListener);
          }
        };

        waiting.push(entry);
        signal?.addEventListener('abort', abortListener, { once: true });
      });
    },

    tick() {
      const snapshot = options.probe();
      if (snapshot.source === 'unavailable') return;

      if (snapshot.availableBytes < options.criticalBytes && now() - lastTripAt >= cooldownMs) {
        const newest = live.pop();
        if (newest) {
          trips++;
          lastTripAt = now();
          newest.abort(new ResourceExhaustedError(snapshot.availableBytes, options.criticalBytes));
        }
      }

      // Admit whatever now fits, oldest waiter first.
      while (waiting.length > 0) {
        const next = waiting[0];
        if (options.probe().availableBytes - next.costBytes - reservedBytes < options.admissionBytes) {
          break;
        }
        waiting.shift();
        next.cleanup?.();
        next.resolve('admitted');
      }
    },

    stop() {
      clearInterval(timer);
      // Resolve pending waiters as 'cancelled', not 'admitted'. 'admitted' tells
      // the caller to start the file, but if we stop before admitting, the file
      // must be skipped, never run unsupervised without the watchdog.
      for (const entry of waiting.splice(0)) {
        entry.cleanup?.();
        entry.resolve('cancelled');
      }
    },
  };

  return api;
}
