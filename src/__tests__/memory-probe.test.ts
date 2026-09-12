import { describe, it, expect } from 'vitest';
import { probeMemory, type ProbeDeps } from '../utils/resources/memory-probe.js';

const GIB = 1024 ** 3;

const linuxDeps = (files: Record<string, string>): ProbeDeps => ({
  platform: 'linux',
  readFile: (path) => files[path],
  freemem: () => 0,
  totalmem: () => 16 * GIB,
  runVmStat: () => undefined,
});

describe('probeMemory', () => {
  it('reads MemAvailable from /proc/meminfo on linux', () => {
    const snap = probeMemory(
      linuxDeps({
        '/proc/meminfo': 'MemTotal:       16305408 kB\nMemAvailable:    6291456 kB\n',
      }),
    );
    expect(snap.source).toBe('host');
    expect(snap.availableBytes).toBe(6 * GIB);
  });

  it('prefers the cgroup v2 headroom when it is smaller', () => {
    const snap = probeMemory(
      linuxDeps({
        '/proc/meminfo': 'MemAvailable:    6291456 kB\n',
        '/sys/fs/cgroup/memory.max': `${2 * GIB}\n`,
        '/sys/fs/cgroup/memory.current': `${1 * GIB}\n`,
      }),
    );
    expect(snap.source).toBe('cgroup');
    expect(snap.availableBytes).toBe(1 * GIB);
    expect(snap.limitBytes).toBe(2 * GIB);
  });

  it('preserves the cgroup ceiling when host headroom is smaller (MAJOR 3)', () => {
    // A 16 GiB host with 2 GiB available, inside a 4 GiB cgroup with 3 GiB
    // available (1 GiB used): host has LESS headroom (2 GiB < 3 GiB) so it
    // wins the source, but the cgroup's 4 GiB ceiling is still the real limit
    // this run is bound by. Reporting the host's 16 GiB `limitBytes` here
    // would size floors (resolveFloors) off a number 4x too large for the
    // cgroup this process is actually confined to.
    const snap = probeMemory(
      linuxDeps({
        '/proc/meminfo': `MemAvailable:    ${(2 * GIB) / 1024} kB\n`,
        '/sys/fs/cgroup/memory.max': `${4 * GIB}\n`,
        '/sys/fs/cgroup/memory.current': `${1 * GIB}\n`,
      }),
    );
    expect(snap.source).toBe('host');
    expect(snap.availableBytes).toBe(2 * GIB);
    expect(snap.limitBytes).toBe(4 * GIB);
  });

  it('ignores a cgroup v2 limit of "max"', () => {
    const snap = probeMemory(
      linuxDeps({
        '/proc/meminfo': 'MemAvailable:    6291456 kB\n',
        '/sys/fs/cgroup/memory.max': 'max\n',
        '/sys/fs/cgroup/memory.current': `${1 * GIB}\n`,
      }),
    );
    expect(snap.source).toBe('host');
    expect(snap.availableBytes).toBe(6 * GIB);
  });

  it('falls back to cgroup v1 files', () => {
    const snap = probeMemory(
      linuxDeps({
        '/proc/meminfo': 'MemAvailable:    6291456 kB\n',
        '/sys/fs/cgroup/memory/memory.limit_in_bytes': `${4 * GIB}\n`,
        '/sys/fs/cgroup/memory/memory.usage_in_bytes': `${3 * GIB}\n`,
      }),
    );
    expect(snap.source).toBe('cgroup');
    expect(snap.availableBytes).toBe(1 * GIB);
  });

  it('reports unavailable when nothing can be read', () => {
    const snap = probeMemory(linuxDeps({}));
    expect(snap.source).toBe('unavailable');
    expect(snap.availableBytes).toBe(0);
  });

  it('parses vm_stat on macOS, counting free, inactive and speculative pages', () => {
    const vmStat = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                               65536.',
      'Pages inactive:                          131072.',
      'Pages speculative:                        65536.',
      'Pages active:                            999999.',
    ].join('\n');
    const snap = probeMemory({
      platform: 'darwin',
      readFile: () => undefined,
      freemem: () => 1 * GIB,
      totalmem: () => 32 * GIB,
      runVmStat: () => vmStat,
    });
    expect(snap.source).toBe('host');
    // (65536 + 131072 + 65536) pages * 16384 bytes = 4 GiB
    expect(snap.availableBytes).toBe(4 * GIB);
  });

  it('reports unavailable on macOS when vm_stat fails, never os.freemem', () => {
    const snap = probeMemory({
      platform: 'darwin',
      readFile: () => undefined,
      freemem: () => 1 * GIB,
      totalmem: () => 32 * GIB,
      runVmStat: () => undefined,
    });
    expect(snap.source).toBe('unavailable');
  });

  it('uses os.freemem on windows', () => {
    const snap = probeMemory({
      platform: 'win32',
      readFile: () => undefined,
      freemem: () => 3 * GIB,
      totalmem: () => 8 * GIB,
      runVmStat: () => undefined,
    });
    expect(snap).toEqual({ availableBytes: 3 * GIB, limitBytes: 8 * GIB, source: 'host' });
  });
});
