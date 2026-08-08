#!/usr/bin/env node
/**
 * Re-confirm every stored suppression so it carries a content fingerprint.
 *
 * The committed file declared `"version": 2` while 125 of its 127 entries were
 * v1-shaped (no fingerprint), so `verifySuppressions` counted them all as
 * `unverified` and applied none of them — every recorded equivalence argument
 * was dormant. `writeFile` stamps the version unconditionally, which is how a
 * single v2 write over a v1 document promotes the header without the entries.
 *
 * This drives the PUBLIC write path (`addSuppressions`), which is documented as
 * a RE-CONFIRMATION: it re-stamps the fingerprint, preserves the original
 * `addedAt`, and merges the reason. Nothing here re-derives that logic.
 *
 * Run from the repo root, after `npm run build`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { addSuppressions, loadSuppressions, verifySuppressions } from '../build/utils/suppression.js';

const root = resolve(process.cwd());
const before = loadSuppressions(root);

let stamped = 0;
let unstamped = 0;
for (const [relFile, entries] of before) {
  const result = await addSuppressions(
    root,
    relFile,
    entries.map((e) => ({ line: e.line, mutator: e.mutator, reason: e.reason })),
  );
  stamped += result.stamped;
  unstamped += result.unstamped;
  if (result.unstamped > 0) {
    console.error(`  ${relFile}: ${result.unstamped} entr(ies) could not be stamped`);
  }
}

const after = loadSuppressions(root);
let applied = 0;
let unverified = 0;
for (const [relFile, entries] of after) {
  const verdict = verifySuppressions(root, relFile, entries);
  applied += verdict.applied.size;
  unverified += verdict.unverified;
}

console.log(`stamped ${stamped}, unstamped ${unstamped}`);
console.log(`now applicable: ${applied}; still unverified: ${unverified}`);
if (unverified > 0) process.exitCode = 1;
