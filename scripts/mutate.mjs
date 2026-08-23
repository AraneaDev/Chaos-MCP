#!/usr/bin/env node
// scripts/mutate.mjs — scoped INTERNAL mutation testing via StrykerJS.
//
// Why a wrapper: `mutate` is an empty no-op in stryker.internal.mjs so that a
// bare `npx stryker run` cannot start an unbounded whole-repo sweep on a
// developer machine. This wrapper is the supported entry point — it passes an
// explicit `--mutate` scope so every run is bounded by a target you named:
//
//   npm run mutation -- src/core/gate.ts                     # one file
//   npm run mutation -- src/utils                            # a directory (recursed)
//   npm run mutation -- src/core/gate.ts src/core/format.ts  # several files
//   npm run mutation -- src/core/gate.ts --concurrency 4     # more workers
//
// Extra flags after `--` pass through to Stryker.
//
// Test selection is NOT this script's job any more. Under the old command
// runner it was: that runner grades a black-box process on its exit code, so
// the wrapper had to build a `vitest related <targets> --run` command and hand
// it over through STRYKER_TEST_COMMAND. The native vitest runner instruments
// coverage instead, so `coverageAnalysis: 'perTest'` picks the covering tests
// per mutant by itself — strictly narrower than a related-file set, and
// without a hand-built command to keep in sync.

import { existsSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function fail(message) {
  console.error(`mutate: ${message}`);
  process.exit(1);
}

// Non-default filename, so Stryker must be told where it is. See the header of
// stryker.internal.mjs for why it is not called `stryker.config.mjs`.
const CONFIG_FILE = 'stryker.internal.mjs';

const USAGE =
  'Usage: npm run mutation -- <source-file-or-dir>... ' +
  '[--concurrency N] [-- <extra stryker args>]\n' +
  'Example: npm run mutation -- src/core/gate.ts';

// ── Parse args ──
const argv = process.argv.slice(2);
const targets = [];
let concurrency = '2';
const passthrough = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--') {
    passthrough.push(...argv.slice(i + 1));
    break;
  } else if (arg === '--concurrency') {
    concurrency = argv[++i];
  } else if (arg.startsWith('--')) {
    passthrough.push(arg);
  } else {
    targets.push(arg);
  }
}

if (targets.length === 0) fail(`no target given.\n${USAGE}`);

// ── Expand directory targets to first-party .ts sources (never tests) ──
function expand(target) {
  if (!existsSync(target)) fail(`target not found: ${target}`);
  if (statSync(target).isFile()) return [target];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
    }
  };
  walk(target);
  return out;
}

const sources = [...new Set(targets.flatMap(expand))];
if (sources.length === 0) fail('no .ts source files under the given target(s).');

console.error(`mutate: mutating ${sources.length} file(s); per-mutant tests selected by coverage.`);

// ── Run Stryker with the scope wired into --mutate ──
// Windows installs npx as npx.cmd, which spawnSync cannot exec directly without
// a shell (same handling as tests/global-setup.ts).
const isWindows = process.platform === 'win32';
const result = spawnSync(
  isWindows ? 'npx.cmd' : 'npx',
  [
    'stryker',
    'run',
    CONFIG_FILE,
    '--mutate',
    sources.join(','),
    '--concurrency',
    concurrency,
    ...passthrough,
  ],
  {
    stdio: 'inherit',
    shell: isWindows,
  },
);
process.exit(result.status ?? 1);
