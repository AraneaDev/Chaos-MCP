#!/usr/bin/env node
/**
 * Type-check the WHOLE source tree (tests included) against a descending
 * baseline.
 *
 * Why a baseline instead of a plain pass/fail gate: `tsconfig.json` excludes
 * `src/__tests__` so tests are never emitted, and Vitest transpiles via esbuild
 * without type information — so nothing ever type-checked the test suite. By the
 * time that gap was found, 271 pre-existing errors had accumulated. Turning a
 * hard gate on immediately would just make CI permanently red, so this ratchets:
 * new type errors in tests fail the build, and the baseline can only be lowered.
 *
 * Run `node scripts/typecheck-tests.mjs --update` after fixing errors to record
 * the new (lower) count. The goal is a baseline of 0, after which this can be
 * replaced by `tsc -p tsconfig.tests.json`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'typecheck-tests-baseline.json');

const res = spawnSync(
  process.execPath,
  [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.tests.json'],
  { cwd: ROOT, encoding: 'utf-8' },
);

const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
const errorLines = output.split('\n').filter((l) => /error TS\d+:/.test(l));
const count = errorLines.length;

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
const allowed = baseline.errors;

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ ...baseline, errors: count }, null, 2)}\n`);
  console.log(`Baseline updated: ${allowed} -> ${count}`);
  process.exit(0);
}

if (count > allowed) {
  // Show only the errors, not the whole tsc banner — the new ones are what matter.
  console.error(output.trim());
  console.error(
    `\n✗ Test type errors increased: ${count} (baseline ${allowed}).\n` +
      `  Fix the new errors above. Do not raise the baseline.`,
  );
  process.exit(1);
}

if (count < allowed) {
  console.log(
    `✓ Test type errors down to ${count} (baseline ${allowed}).\n` +
      `  Lock it in: node scripts/typecheck-tests.mjs --update`,
  );
  process.exit(0);
}

console.log(`✓ Test type errors at baseline (${count}).`);
