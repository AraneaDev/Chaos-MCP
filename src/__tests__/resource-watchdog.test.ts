import { describe, it, expect } from 'vitest';
import { createWatchdog } from '../utils/resources/watchdog.js';
import { isResourceExhausted } from '../utils/resources/errors.js';

const GIB = 1024 ** 3;
const snap = (availableBytes: number) =>
  ({ availableBytes, limitBytes: 8 * GIB, source: 'host' }) as const;

describe('watchdog', () => {
  it('aborts the most recently registered run when memory hits the critical floor', () => {
    let available = 4 * GIB;
    const dog = createWatchdog({
      probe: () => snap(available),
      criticalBytes: 1 * GIB,
      admissionBytes: 2 * GIB,
      now: () => 0,
    });
    const first = new AbortController();
    const second = new AbortController();
    dog.register(first);
    dog.register(second);

    available = 512 * 1024 ** 2;
    dog.tick();

    expect(second.signal.aborted).toBe(true);
    expect(first.signal.aborted).toBe(false);
    expect(isResourceExhausted(second.signal.reason)).toBe(true);
    expect(dog.trips).toBe(1);
  });

  it('does not abort again during the cooldown', () => {
    let clock = 0;
    const dog = createWatchdog({
      probe: () => snap(0),
      criticalBytes: 1 * GIB,
      admissionBytes: 2 * GIB,
      cooldownMs: 10_000,
      now: () => clock,
    });
    const a = new AbortController();
    const b = new AbortController();
    dog.register(a);
    dog.register(b);

    dog.tick();
    clock = 5_000;
    dog.tick();
    expect(dog.trips).toBe(1);

    clock = 11_000;
    dog.tick();
    expect(dog.trips).toBe(2);
  });

  it('aborts a lone run rather than letting the machine run out', () => {
    const dog = createWatchdog({
      probe: () => snap(0),
      criticalBytes: 1 * GIB,
      admissionBytes: 2 * GIB,
      now: () => 0,
    });
    const only = new AbortController();
    dog.register(only);
    dog.tick();
    expect(only.signal.aborted).toBe(true);
  });

  it('ignores a released run', () => {
    const dog = createWatchdog({
      probe: () => snap(0),
      criticalBytes: 1 * GIB,
      admissionBytes: 2 * GIB,
      now: () => 0,
    });
    const done = new AbortController();
    const live = new AbortController();
    const handle = dog.register(done);
    dog.register(live);
    handle.release();
    dog.tick();
    expect(done.signal.aborted).toBe(false);
    expect(live.signal.aborted).toBe(true);
  });

  it('admits immediately when the memory is there', async () => {
    const dog = createWatchdog({
      probe: () => snap(6 * GIB),
      criticalBytes: 1 * GIB,
      admissionBytes: 2 * GIB,
      now: () => 0,
    });
    await expect(dog.admit(1 * GIB)).resolves.toBe('admitted');
  });

  it('waits for memory, then admits on a later tick', async () => {
    let available = 2 * GIB;
    const dog = createWatchdog({
      probe: () => snap(available),
      criticalBytes: 1 * GIB,
      admissionBytes: 2 * GIB,
      now: () => 0,
    });
    const pending = dog.admit(2 * GIB);
    available = 8 * GIB;
    dog.tick();
    await expect(pending).resolves.toBe('admitted');
  });

  it('gives up waiting when the request is cancelled', async () => {
    const dog = createWatchdog({
      probe: () => snap(0),
      criticalBytes: 1 * GIB,
      admissionBytes: 2 * GIB,
      now: () => 0,
    });
    const controller = new AbortController();
    const pending = dog.admit(4 * GIB, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBe('cancelled');
  });

  it('never trips when the probe is unavailable', () => {
    const dog = createWatchdog({
      probe: () => ({ availableBytes: 0, limitBytes: 0, source: 'unavailable' }) as const,
      criticalBytes: 1 * GIB,
      admissionBytes: 2 * GIB,
      now: () => 0,
    });
    const run = new AbortController();
    dog.register(run);
    dog.tick();
    expect(run.signal.aborted).toBe(false);
  });

  it('charges the in-flight cost of a registered-but-not-released run against admission', async () => {
    // IMPORTANT 4: admission must not be near-inert against a run that has
    // already started but whose memory the probe has not caught up with yet.
    // Available memory alone would admit a second 2 GiB request against 4
    // GiB free, but a 3 GiB run already registered (and not yet released)
    // must be charged too, leaving only 1 GiB, below the 2 GiB floor.
    const dog = createWatchdog({
      probe: () => snap(4 * GIB),
      criticalBytes: 1 * GIB,
      admissionBytes: 2 * GIB,
      now: () => 0,
    });
    const handle = dog.register(new AbortController(), 3 * GIB);

    // Declined rather than admitted immediately: aborting right after proves
    // `admit` took the waiting branch instead of resolving synchronously.
    const controller = new AbortController();
    const pending = dog.admit(2 * GIB, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBe('cancelled');

    // Releasing the reservation frees the charge, so the same request now
    // clears immediately.
    handle.release();
    await expect(dog.admit(2 * GIB)).resolves.toBe('admitted');
  });

  it('does not charge anything when register is called with no cost', async () => {
    const dog = createWatchdog({
      probe: () => snap(4 * GIB),
      criticalBytes: 1 * GIB,
      admissionBytes: 2 * GIB,
      now: () => 0,
    });
    dog.register(new AbortController());
    await expect(dog.admit(2 * GIB)).resolves.toBe('admitted');
  });

  it('cancels pending waiters on stop, not admits them', async () => {
    const dog = createWatchdog({
      probe: () => snap(0),
      criticalBytes: 1 * GIB,
      admissionBytes: 2 * GIB,
      now: () => 0,
    });
    const pending = dog.admit(4 * GIB);
    dog.stop();
    await expect(pending).resolves.toBe('cancelled');
  });
});
