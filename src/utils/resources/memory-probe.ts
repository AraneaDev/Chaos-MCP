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
 * On Linux, the cgroup reading resolves the process's own cgroup from
 * `/proc/self/cgroup` first, and walks from that cgroup up to the hierarchy
 * mount root looking for `memory.max`/`memory.current` (v2) or
 * `memory.limit_in_bytes`/`memory.usage_in_bytes` (v1) at each level, since a
 * limit can sit on an ancestor rather than the process's own cgroup. Only when
 * that file cannot be read or parsed does it fall back to the fixed
 * hierarchy-root paths.
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

const CGROUP_SELF = '/proc/self/cgroup';
const CGROUP_V2_ROOT = '/sys/fs/cgroup';
const CGROUP_V1_MEMORY_ROOT = '/sys/fs/cgroup/memory';
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

interface CgroupLevel {
  availableBytes: number;
  limitBytes: number;
}

/**
 * Reads one candidate cgroup directory's limit/usage pair, applying the same
 * "unlimited sentinel" filter used for the fixed-root reads below.
 */
function readCgroupLevel(
  deps: ProbeDeps,
  dir: string,
  maxFile: string,
  currentFile: string,
): CgroupLevel | undefined {
  const limit = readNumber(deps, `${dir}/${maxFile}`);
  const used = readNumber(deps, `${dir}/${currentFile}`);
  if (limit === undefined || used === undefined) return undefined;
  if (limit >= V1_UNLIMITED_FLOOR) return undefined;
  return { availableBytes: Math.max(0, limit - used), limitBytes: limit };
}

/**
 * Every directory from the process's own cgroup up to (and including) the
 * hierarchy mount root, leaf first. A limit set on an ancestor constrains the
 * process just as much as one on its own cgroup, so every level is a
 * candidate.
 */
function ancestorDirs(root: string, relativePath: string): string[] {
  const cleaned = relativePath.replace(/\s*\(deleted\)$/, '');
  const segments = cleaned.split('/').filter((segment) => segment.length > 0);
  const dirs: string[] = [];
  for (let count = segments.length; count >= 0; count--) {
    const suffix = segments.slice(0, count).join('/');
    dirs.push(suffix ? `${root}/${suffix}` : root);
  }
  return dirs;
}

/** The smallest headroom among valid levels is the one the process is actually bound by. */
function mostRestrictive(levels: CgroupLevel[]): CgroupLevel | undefined {
  return levels.reduce<CgroupLevel | undefined>(
    (best, level) =>
      best === undefined || level.availableBytes < best.availableBytes ? level : best,
    undefined,
  );
}

/** The `0::<path>` line of `/proc/self/cgroup`, relative to the cgroup v2 mount. */
function selfCgroupV2Path(deps: ProbeDeps): string | undefined {
  const content = deps.readFile(CGROUP_SELF);
  if (!content) return undefined;
  for (const line of content.split('\n')) {
    const match = /^0::(.*)$/.exec(line.trim());
    if (match) return match[1];
  }
  return undefined;
}

/** The path named on the `memory` controller's line of `/proc/self/cgroup` (cgroup v1). */
function selfCgroupV1MemoryPath(deps: ProbeDeps): string | undefined {
  const content = deps.readFile(CGROUP_SELF);
  if (!content) return undefined;
  for (const line of content.split('\n')) {
    const match = /^\d+:([^:]*):(.*)$/.exec(line.trim());
    if (!match) continue;
    const controllers = match[1].split(',');
    if (controllers.includes('memory')) return match[2];
  }
  return undefined;
}

function cgroupAvailable(
  deps: ProbeDeps,
): { availableBytes: number; limitBytes: number } | undefined {
  if (deps.platform !== 'linux') return undefined;

  const v2Path = selfCgroupV2Path(deps);
  if (v2Path !== undefined) {
    const best = mostRestrictive(
      ancestorDirs(CGROUP_V2_ROOT, v2Path)
        .map((dir) => readCgroupLevel(deps, dir, 'memory.max', 'memory.current'))
        .filter((level): level is CgroupLevel => level !== undefined),
    );
    if (best) return best;
  }

  const v1Path = selfCgroupV1MemoryPath(deps);
  if (v1Path !== undefined) {
    const best = mostRestrictive(
      ancestorDirs(CGROUP_V1_MEMORY_ROOT, v1Path)
        .map((dir) => readCgroupLevel(deps, dir, 'memory.limit_in_bytes', 'memory.usage_in_bytes'))
        .filter((level): level is CgroupLevel => level !== undefined),
    );
    if (best) return best;
  }

  // Fallback for when /proc/self/cgroup cannot be read or parsed: the fixed
  // hierarchy-root paths this probe always checked, which still catch the
  // common case of an unnested cgroup sitting at the mount root.
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
