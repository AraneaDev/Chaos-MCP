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

  it('resolves a nested cgroup v2 path from /proc/self/cgroup (MAJOR: cgroup resolution)', () => {
    // The process sits several levels below the mount root, and only ITS OWN
    // cgroup carries a limit; nothing is set at /sys/fs/cgroup itself. The old
    // code only ever checked the fixed root path, found nothing there, and
    // fell back to host headroom (6 GiB) even though this process is actually
    // capped at 2 GiB. Resolving /proc/self/cgroup is what catches that.
    const nestedDir = '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/app-1.scope';
    const snap = probeMemory(
      linuxDeps({
        '/proc/meminfo': 'MemAvailable:    6291456 kB\n',
        '/proc/self/cgroup': '0::/user.slice/user-1000.slice/app.slice/app-1.scope\n',
        [`${nestedDir}/memory.max`]: `${2 * GIB}\n`,
        [`${nestedDir}/memory.current`]: `${1 * GIB}\n`,
      }),
    );
    expect(snap.source).toBe('cgroup');
    expect(snap.availableBytes).toBe(1 * GIB);
    expect(snap.limitBytes).toBe(2 * GIB);
  });

  it('walks up to an ancestor cgroup v2 limit when the leaf has none', () => {
    // The leaf cgroup (app-1.scope) and its immediate parent (app.slice) carry
    // no memory files at all; the limit is set two levels up, on
    // user-1000.slice. The old code never looked past the fixed mount root, so
    // it would have missed this entirely and reported host headroom instead.
    const ancestorDir = '/sys/fs/cgroup/user.slice/user-1000.slice';
    const snap = probeMemory(
      linuxDeps({
        '/proc/meminfo': 'MemAvailable:    6291456 kB\n',
        '/proc/self/cgroup': '0::/user.slice/user-1000.slice/app.slice/app-1.scope\n',
        [`${ancestorDir}/memory.max`]: `${3 * GIB}\n`,
        [`${ancestorDir}/memory.current`]: `${1 * GIB}\n`,
      }),
    );
    expect(snap.source).toBe('cgroup');
    expect(snap.availableBytes).toBe(2 * GIB);
    expect(snap.limitBytes).toBe(3 * GIB);
  });

  it('takes the smallest ceiling and the smallest headroom from DIFFERENT cgroup levels', () => {
    // The binding pair is split across levels on purpose: the leaf caps the
    // process at 1 GiB while the ancestor, which the process can never exceed
    // anyway, happens to have less free right now. Reporting the level with the
    // least headroom wholesale returned the ancestor's 10 GiB ceiling, and the
    // caller then computed its memory floors from 10 GiB this process can never
    // reach, which can refuse every run inside a 1 GiB cgroup.
    const leaf = '/sys/fs/cgroup/user.slice/app.scope';
    const ancestor = '/sys/fs/cgroup/user.slice';
    const snap = probeMemory(
      linuxDeps({
        '/proc/meminfo': 'MemAvailable:    62914560 kB\n',
        '/proc/self/cgroup': '0::/user.slice/app.scope\n',
        [`${leaf}/memory.max`]: `${1 * GIB}\n`,
        [`${leaf}/memory.current`]: `${512 * 1024 ** 2}\n`,
        [`${ancestor}/memory.max`]: `${10 * GIB}\n`,
        [`${ancestor}/memory.current`]: `${10 * GIB - 100 * 1024 ** 2}\n`,
      }),
    );
    expect(snap.source).toBe('cgroup');
    // Least headroom: the ancestor's 100 MiB.
    expect(snap.availableBytes).toBe(100 * 1024 ** 2);
    // Lowest ceiling: the leaf's 1 GiB, NOT the ancestor's 10 GiB.
    expect(snap.limitBytes).toBe(1 * GIB);
  });

  it('resolves a nested cgroup v1 memory controller path from /proc/self/cgroup', () => {
    // /proc/self/cgroup lists multiple hierarchies; only the line naming the
    // "memory" controller is relevant, and its path is nested well below the
    // fixed /sys/fs/cgroup/memory root the old code exclusively checked there.
    const nestedDir = '/sys/fs/cgroup/memory/user.slice/user-1000.slice';
    const snap = probeMemory(
      linuxDeps({
        '/proc/meminfo': 'MemAvailable:    6291456 kB\n',
        '/proc/self/cgroup': [
          '10:cpu,cpuacct:/user.slice',
          '9:memory:/user.slice/user-1000.slice',
        ].join('\n'),
        [`${nestedDir}/memory.limit_in_bytes`]: `${2 * GIB}\n`,
        [`${nestedDir}/memory.usage_in_bytes`]: `${1 * GIB}\n`,
      }),
    );
    expect(snap.source).toBe('cgroup');
    expect(snap.availableBytes).toBe(1 * GIB);
    expect(snap.limitBytes).toBe(2 * GIB);
  });

  it('falls back to the fixed root paths when /proc/self/cgroup is unreadable or malformed', () => {
    // No /proc/self/cgroup entry at all (unreadable), and the limit sits at
    // the fixed mount root exactly as the pre-existing tests expect. This
    // guards against the resolution step swallowing the previously-working
    // root-path case when it has nothing useful to resolve.
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

  it('falls back to the fixed root paths when /proc/self/cgroup content is garbage', () => {
    const snap = probeMemory(
      linuxDeps({
        '/proc/meminfo': 'MemAvailable:    6291456 kB\n',
        '/proc/self/cgroup': 'not a cgroup line at all\n',
        '/sys/fs/cgroup/memory/memory.limit_in_bytes': `${4 * GIB}\n`,
        '/sys/fs/cgroup/memory/memory.usage_in_bytes': `${3 * GIB}\n`,
      }),
    );
    expect(snap.source).toBe('cgroup');
    expect(snap.availableBytes).toBe(1 * GIB);
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
