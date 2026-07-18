#!/usr/bin/env node
// scripts/mutate.mjs — scoped INTERNAL mutation testing via StrykerJS's command runner.
//
// Why a wrapper: the command runner runs ONE test command per mutant and can't
// per-mutant scope. A whole-repo run would therefore execute the FULL suite for
// every mutant (thousands of suite runs — it will peg the machine). This wrapper
// keeps every run bounded by scoping BOTH the mutated files AND the test command
// to an explicit target:
//
//   npm run mutation -- src/gate.ts                    # one file
//   npm run mutation -- src/utils                      # a directory (recursed)
//   npm run mutation -- src/gate.ts src/format.ts      # several files
//   npm run mutation -- src/gate.ts --concurrency 4    # more workers
//   npm run mutation -- src/gate.ts --tests src/__tests__/gate.test.ts
//
// By default the test command is `vitest related <targets> --run`, which runs
// exactly the tests whose module graph includes the mutated files — the correct
// superset for mutation testing (a mutant is only killable by a test that
// actually exercises it). Pass --tests to run explicit test file(s) instead
// (individual-test targeting). Extra flags after `--` pass through to Stryker.

import { existsSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function fail(message) {
  console.error(`mutate: ${message}`);
  process.exit(1);
}

const USAGE =
  'Usage: npm run mutation -- <source-file-or-dir>... [--tests <test-file>...] ' +
  '[--concurrency N] [-- <extra stryker args>]\n' +
  'Example: npm run mutation -- src/gate.ts';

// ── Parse args ──
const argv = process.argv.slice(2);
const targets = [];
let tests = null;
let concurrency = '2';
const passthrough = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--') {
    passthrough.push(...argv.slice(i + 1));
    break;
  } else if (arg === '--tests') {
    tests = tests ?? [];
    while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) tests.push(argv[++i]);
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

// ── Build the scoped test command ──
const testCommand =
  tests && tests.length > 0
    ? `npx vitest run ${tests.join(' ')}`
    : `npx vitest related ${sources.join(' ')} --run`;

console.error(`mutate: mutating ${sources.length} file(s); per-mutant tests: ${testCommand}`);

// ── Run Stryker with the scope wired into both --mutate and the command ──
// Windows installs npx as npx.cmd, which spawnSync cannot exec directly without
// a shell (same handling as tests/global-setup.ts).
const isWindows = process.platform === 'win32';
const result = spawnSync(
  isWindows ? 'npx.cmd' : 'npx',
  ['stryker', 'run', '--mutate', sources.join(','), '--concurrency', concurrency, ...passthrough],
  {
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, STRYKER_TEST_COMMAND: testCommand },
  },
);
process.exit(result.status ?? 1);
