#!/usr/bin/env node
/**
 * Samples the RSS of a process tree every 500 ms while a command runs, and
 * prints the peak.
 *
 * This script only samples. It never starts a mutation run on its own: the
 * command sampled is whatever is given after `--`, supplied by the caller,
 * so this script cannot trigger an audit or a sweep by itself.
 *
 * The sample walks the actual descendants of the spawned command (via
 * `pgrep -P`) rather than matching process names system-wide. This machine
 * runs several unrelated long-lived node and php processes (MCP servers,
 * php-fpm) at all times, and a name match against the whole process table
 * would count their RSS as if it belonged to the audit.
 *
 * Usage:
 *   node scripts/measure-worker-cost.mjs -- <command to run the audit>
 *
 * Read the printed peak, divide by the worker count the run reported (its
 * `resources.perFileWorkers` field for an audit_code_resilience call), and
 * that is the per-worker cost for that engine.
 */
import { spawn, execSync } from 'node:child_process';

const [, , ...rest] = process.argv;
const argv = rest[0] === '--' ? rest.slice(1) : rest;

if (argv.length === 0) {
  console.error('Usage: node scripts/measure-worker-cost.mjs -- <command to run the audit>');
  process.exit(1);
}

const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit' });

function descendantPids(rootPid) {
  const all = [rootPid];
  let frontier = [rootPid];
  while (frontier.length > 0) {
    const next = [];
    for (const pid of frontier) {
      try {
        const out = execSync(`pgrep -P ${pid}`, { encoding: 'utf-8' });
        for (const line of out.split('\n')) {
          const child = Number(line.trim());
          if (child) next.push(child);
        }
      } catch {
        // pgrep exits non-zero when a pid has no children; nothing to add.
      }
    }
    all.push(...next);
    frontier = next;
  }
  return all;
}

let peakKb = 0;
const sample = () => {
  try {
    const pids = descendantPids(child.pid);
    if (pids.length === 0) return;
    const out = execSync(`ps -o rss= -p ${pids.join(',')}`, { encoding: 'utf-8' });
    const total = out
      .split('\n')
      .map((line) => Number(line.trim()) || 0)
      .reduce((sum, n) => sum + n, 0);
    peakKb = Math.max(peakKb, total);
  } catch {
    // A sample that fails (e.g. the tree changed mid-snapshot) is skipped;
    // the peak already recorded is still a valid lower bound.
  }
};

const timer = setInterval(sample, 500);
child.on('exit', (code) => {
  clearInterval(timer);
  console.log(`peak tree RSS: ${(peakKb / 1024).toFixed(0)} MB`);
  process.exit(code ?? 0);
});
