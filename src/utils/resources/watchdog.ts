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
  /**
   * `false` disables ONLY the critical-stop sampling in `tick()` (the
   * `resources.watchdog` config key): sizing and the admission gate keep
   * using the real probe. Defaults to `true`. This must never be simulated by
   * handing `probe` a fake `'unavailable'` snapshot, because `admit()` and
   * `drainWaiting()` treat that source as "disable this judgement too" and
   * would stop enforcing `admissionBytes` along with the critical stop.
   */
  criticalStopEnabled?: boolean;
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
  //
  // Also carries ADMISSION LEASES (see `drainWaiting` below): a waiter's cost
  // is added here the moment it is admitted out of `waiting`, before its file
  // has actually registered a run, so a later waiter drained in the SAME pass
  // is judged against memory that is already spoken for.
  let reservedBytes = 0;
  // Admission leases created by `drainWaiting` that no `register()` call has
  // claimed yet, keyed by the exact cost reserved. A lease's bytes are ALREADY
  // included in `reservedBytes`; this map exists only so `register()` can tell
  // "this cost was already reserved at admission" from "this run never went
  // through admission" and avoid reserving it a second time (Finding 1).
  //
  // A lease whose file never calls `register()` at all (an unsupported
  // project type discovered after admission, or the sweep deadline expiring
  // first) is adopted by the next run that registers the SAME cost, since the
  // map is keyed by amount rather than by waiter identity; the two are
  // fungible bytes in `reservedBytes`, not a specific run's money. Any lease
  // still unclaimed when the watchdog stops is swept in `stop()`, so it can
  // never sit reserved for the rest of this watchdog's life either way.
  const unclaimedLeasesByCost = new Map<number, number>();

  // Admit whatever fits in `snapshot`, oldest waiter first. Shared by `tick()`
  // (on its own sampled snapshot) and `release()` (on a fresh probe taken the
  // moment a reservation is freed), so a waiter blocked purely on another
  // run's reservation does not sit until the next sampler interval once that
  // memory is actually back. An 'unavailable' snapshot disables this too,
  // same as every other judgement in this file.
  function drainWaiting(snapshot: MemorySnapshot): void {
    if (snapshot.source === 'unavailable') return;
    while (waiting.length > 0) {
      const next = waiting[0];
      if (snapshot.availableBytes - next.costBytes - reservedBytes < options.admissionBytes) {
        break;
      }
      waiting.shift();
      next.cleanup?.();
      // Reserve THIS waiter's cost immediately, before resolving the next one
      // in the loop, so a later waiter in the SAME drain sees it too (Finding
      // 1): without this, every waiter in one drain pass was judged against
      // the SAME `reservedBytes`, so several that each fit alone but not
      // together were all admitted together, and their files started
      // simultaneously, which is exactly what this gate exists to prevent.
      reservedBytes += next.costBytes;
      unclaimedLeasesByCost.set(
        next.costBytes,
        (unclaimedLeasesByCost.get(next.costBytes) ?? 0) + 1,
      );
      next.resolve('admitted');
    }
  }

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
      if (costBytes) {
        // Hand an existing admission lease over to this run instead of
        // reserving a second time (Finding 1): `drainWaiting` already added
        // `costBytes` to `reservedBytes` for whichever waiter this run
        // resumed from, so claiming it here (rather than adding again) is
        // what keeps a reservation from ever being counted twice, once as
        // the admission lease and once at registration. A run that never
        // went through `admit()` at all (no lease outstanding at this cost,
        // e.g. the single-file audit path) still reserves fresh, exactly as
        // before.
        const pending = unclaimedLeasesByCost.get(costBytes);
        if (pending) {
          if (pending === 1) unclaimedLeasesByCost.delete(costBytes);
          else unclaimedLeasesByCost.set(costBytes, pending - 1);
        } else {
          reservedBytes += costBytes;
        }
      }
      return {
        release() {
          const index = live.indexOf(controller);
          if (index >= 0) live.splice(index, 1);
          if (costBytes && !released) {
            released = true;
            reservedBytes = Math.max(0, reservedBytes - costBytes);
            // The reservation just freed may be exactly what a waiter needed;
            // drain now rather than leaving it to wait out the rest of the
            // sampler interval.
            drainWaiting(options.probe());
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
          if (signal) {
            signal.removeEventListener('abort', abortListener);
          }
        };

        waiting.push(entry);
        signal?.addEventListener('abort', abortListener, { once: true });
      });
    },

    tick() {
      // One snapshot for both judgements below: the critical check and the
      // admission drain must agree on the same reading within a tick, rather
      // than risk the probe (a file read or a shell-out) returning two
      // different figures for a single tick.
      const snapshot = options.probe();
      if (snapshot.source === 'unavailable') return;

      if (
        (options.criticalStopEnabled ?? true) &&
        snapshot.availableBytes < options.criticalBytes &&
        now() - lastTripAt >= cooldownMs
      ) {
        // A controller can already be aborted (its run finished, or something
        // else aborted it) without having been released yet. Popping straight
        // into that one would count a trip and start the cooldown while an
        // older, still-live run keeps going unsupervised. Skip past aborted
        // entries to the newest one that is actually still running.
        let newest = live.pop();
        while (newest && newest.signal.aborted) {
          newest = live.pop();
        }
        if (newest) {
          trips++;
          lastTripAt = now();
          newest.abort(new ResourceExhaustedError(snapshot.availableBytes, options.criticalBytes));
        }
      }

      drainWaiting(snapshot);
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
      // Any admission lease still unclaimed at this point never will be:
      // nothing else calls `register()` against a stopped watchdog. Release
      // it here rather than leaving it reserved forever (Finding 1's "release
      // it if the file never starts"), the last of the three exit paths
      // (cancel, sweep deadline, watchdog stop) a lease must never leak on.
      for (const [cost, count] of unclaimedLeasesByCost) {
        reservedBytes = Math.max(0, reservedBytes - cost * count);
      }
      unclaimedLeasesByCost.clear();
    },
  };

  return api;
}
