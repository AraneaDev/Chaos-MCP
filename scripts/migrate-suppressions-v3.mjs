#!/usr/bin/env node
/**
 * Prepare a v2 suppressions corpus for migration to v3.
 *
 * v2 identified a suppression by `(line, mutator)`. v3 identifies it by the
 * mutator plus the CHANGE it makes (`original → mutated`). That change cannot
 * be derived from source: it names WHICH mutant, and only an audit knows which
 * mutants exist. So this script does not invent it. It does the two things that
 * CAN be done offline, and reports everything else for a human:
 *
 *   1. Re-points entries whose stored line moved but whose line CONTENT is
 *      unchanged — tier 2 of the runtime ladder, and safe for the same reason:
 *      the fingerprint must match exactly one line in the file. Two matches, or
 *      none, is refused.
 *   2. Emits a per-file `suppress` payload carrying each entry's re-pointed
 *      line, mutator and hand-written reason, ready to replay through
 *      `audit_code_resilience` — whose write path resolves each change from
 *      that run's survivors and refuses the ambiguous ones.
 *
 * The rule that makes this safe is the one `scripts/restamp-suppressions.mjs`
 * broke: NEVER re-point an entry on a line number alone. That script assumed
 * stored line numbers were correct at the base revision; they were not, per
 * entry, and it corrupted the corpus. Here a fingerprint that matches nothing —
 * or matches twice — is reported and left exactly as it was.
 *
 * Usage:
 *   node scripts/migrate-suppressions-v3.mjs [--write]
 *
 * Without `--write` it only reports. With it, the re-pointed lines are saved
 * back to the corpus (still v2 — the `change` fields come from the replay).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const CORPUS = '.chaos-mcp/suppressions.json';
const PAYLOADS = '.chaos-mcp/v3-replay.json';
const write = process.argv.includes('--write');

const normalize = (s) => s.trim().replace(/\s+/g, ' ');
const fingerprintOfLine = (s) =>
  createHash('sha256').update(normalize(s)).digest('hex').slice(0, 12);

const doc = JSON.parse(readFileSync(CORPUS, 'utf8'));
if (doc.version >= 3) {
  console.log('Corpus is already v3; nothing to prepare.');
  process.exit(0);
}

const replay = {};
const problems = [];
let held = 0;
let moved = 0;

for (const [rel, entries] of Object.entries(doc.entries)) {
  let source;
  try {
    source = readFileSync(rel, 'utf8').split(/\r?\n/);
  } catch {
    problems.push(`${rel}: file cannot be read — every entry left untouched`);
    continue;
  }
  const suppress = [];
  for (const entry of entries) {
    if (entry.fingerprint === undefined) {
      problems.push(`${rel}:${entry.line} ${entry.mutator}: no fingerprint, cannot be placed`);
      continue;
    }
    if (fingerprintOfLine(source[entry.line - 1] ?? '') === entry.fingerprint) {
      held += 1;
    } else {
      const hits = [];
      source.forEach((text, i) => {
        if (fingerprintOfLine(text) === entry.fingerprint) hits.push(i + 1);
      });
      if (hits.length !== 1) {
        // Ambiguous or vanished. Refuse — this is the exact guess that
        // corrupted the corpus the last time it was attempted by hand.
        problems.push(
          `${rel}:${entry.line} ${entry.mutator}: fingerprint matches ${hits.length} lines, NOT re-pointed`,
        );
        continue;
      }
      entry.line = hits[0];
      moved += 1;
    }
    suppress.push({
      line: entry.line,
      mutator: entry.mutator,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    });
  }
  if (suppress.length > 0) replay[rel] = suppress;
}

if (problems.length > 0) {
  console.error(`Unresolved (${problems.length}):\n  ${problems.join('\n  ')}\n`);
}
console.log(
  `${held} entries held their line, ${moved} re-pointed, ${problems.length} need a human.`,
);
console.log(`${Object.keys(replay).length} files to replay.`);

if (write) {
  writeFileSync(CORPUS, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  writeFileSync(PAYLOADS, `${JSON.stringify(replay, null, 2)}\n`, 'utf8');
  console.log(`Wrote re-pointed lines to ${CORPUS} and replay payloads to ${PAYLOADS}.`);
} else {
  console.log('Dry run — pass --write to save the re-pointed lines and replay payloads.');
}
