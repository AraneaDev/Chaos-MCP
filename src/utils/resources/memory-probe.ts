/**
 * Available-memory probe.
 *
 * Reports the SMALLER of host headroom and cgroup headroom, because a container
 * sees the host's /proc/meminfo and would otherwise believe it has memory its
 * cgroup will never hand out.
 *
 * `os.freemem()` is deliberately never used on macOS: it excludes inactive and
 * cached pages, so it reads far below what the machine can actually give, and a
 * watchdog fed that number would fire constantly. macOS reads `vm_stat` instead
 * and reports 'unavailable' when that fails, which disables the watchdog rather
 * than making it wrong.
 *
 * Every input arrives through {@link ProbeDeps} so the whole ladder is testable
 * without touching a real machine.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';

export interface MemorySnapshot {
  /** Bytes the run may still take. 0 when `source` is 'unavailable'. */
  availableBytes: number;
  /** Effective ceiling: the cgroup limit when there is one, else total host memory. */
  limitBytes: number;
  source: 'host' | 'cgroup' | 'unavailable';
}

export interface ProbeDeps {
  platform: NodeJS.Platform;
  /** Returns file contents, or undefined when the file cannot be read. */
  readFile: (path: string) => string | undefined;
  freemem: () => number;
  totalmem: () => number;
  /** Returns `vm_stat` output, or undefined when it cannot be run. */
  runVmStat: () => string | undefined;
}

const CGROUP_V2_MAX = '/sys/fs/cgroup/memory.max';
const CGROUP_V2_CURRENT = '/sys/fs/cgroup/memory.current';
const CGROUP_V1_MAX = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
const CGROUP_V1_CURRENT = '/sys/fs/cgroup/memory/memory.usage_in_bytes';

/**
 * A cgroup v1 "no limit" is a sentinel close to 2^63, not a readable flag, so
 * anything at or above this is treated as unlimited.
 */
const V1_UNLIMITED_FLOOR = 2 ** 53;

function readNumber(deps: ProbeDeps, path: string): number | undefined {
  const raw = deps.readFile(path)?.trim();
  if (raw === undefined || raw === '' || raw === 'max') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function hostAvailable(
  deps: ProbeDeps,
): { availableBytes: number; limitBytes: number } | undefined {
  if (deps.platform === 'linux') {
    const meminfo = deps.readFile('/proc/meminfo');
    const match = meminfo?.match(/^MemAvailable:\s+(\d+) kB$/m);
    if (!match) return undefined;
    return { availableBytes: Number(match[1]) * 1024, limitBytes: deps.totalmem() };
  }
  if (deps.platform === 'darwin') {
    const out = deps.runVmStat();
    if (!out) return undefined;
    const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
    const pages = (label: string) =>
      Number(out.match(new RegExp(`^Pages ${label}:\\s+(\\d+)\\.`, 'm'))?.[1] ?? 0);
    const free = pages('free') + pages('inactive') + pages('speculative');
    if (free === 0) return undefined;
    return { availableBytes: free * pageSize, limitBytes: deps.totalmem() };
  }
  return { availableBytes: deps.freemem(), limitBytes: deps.totalmem() };
}

function cgroupAvailable(
  deps: ProbeDeps,
): { availableBytes: number; limitBytes: number } | undefined {
  if (deps.platform !== 'linux') return undefined;
  for (const [maxPath, currentPath] of [
    [CGROUP_V2_MAX, CGROUP_V2_CURRENT],
    [CGROUP_V1_MAX, CGROUP_V1_CURRENT],
  ]) {
    const limit = readNumber(deps, maxPath);
    const used = readNumber(deps, currentPath);
    if (limit === undefined || used === undefined) continue;
    if (limit >= V1_UNLIMITED_FLOOR) continue;
    return { availableBytes: Math.max(0, limit - used), limitBytes: limit };
  }
  return undefined;
}

export function probeMemory(deps: ProbeDeps): MemorySnapshot {
  const host = hostAvailable(deps);
  const cgroup = cgroupAvailable(deps);

  // Host and cgroup ceilings are independent: a small active cgroup can sit
  // inside a large host with more headroom, or the reverse. Reporting only
  // the winner's OWN limitBytes discards whichever ceiling did not win, so
  // floors get computed against a limit this run is not actually bound by.
  // Both figures must come back as the smaller of the two, independently.
  if (host && cgroup) {
    return {
      availableBytes: Math.min(host.availableBytes, cgroup.availableBytes),
      limitBytes: Math.min(host.limitBytes, cgroup.limitBytes),
      source: cgroup.availableBytes <= host.availableBytes ? 'cgroup' : 'host',
    };
  }
  if (cgroup) return { ...cgroup, source: 'cgroup' };
  if (host) return { ...host, source: 'host' };
  return { availableBytes: 0, limitBytes: 0, source: 'unavailable' };
}

export function defaultProbeDeps(): ProbeDeps {
  return {
    platform: process.platform,
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf-8');
      } catch {
        return undefined;
      }
    },
    freemem,
    totalmem,
    runVmStat: () => {
      try {
        return execFileSync('vm_stat', { encoding: 'utf-8', timeout: 2000 });
      } catch {
        return undefined;
      }
    },
  };
}
