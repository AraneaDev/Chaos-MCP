#!/usr/bin/env node
/**
 * Print a shields.io endpoint badge for the current coverage run.
 *
 * The badge is self-hosted: CI publishes this JSON to the `gh-pages` branch and the README
 * points shields at it. No third-party coverage account is involved, so the number can never
 * silently go stale behind an unconfigured integration the way a Codecov badge reads
 * "unknown" until someone activates the repository.
 *
 * Reads `coverage/coverage-summary.json`, which vitest writes under the `json-summary`
 * reporter. Exits non-zero when that file is missing rather than emitting a placeholder: a
 * badge that reports a made-up number is worse than a badge that fails to publish.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SUMMARY = join(process.cwd(), 'coverage', 'coverage-summary.json');

/** Shields' own scale, so the colour means the same thing here as on any other badge. */
function colourFor(pct) {
  if (pct >= 90) return 'brightgreen';
  if (pct >= 80) return 'green';
  if (pct >= 70) return 'yellowgreen';
  if (pct >= 60) return 'yellow';
  if (pct >= 50) return 'orange';
  return 'red';
}

let summary;
try {
  summary = JSON.parse(readFileSync(SUMMARY, 'utf8'));
} catch (error) {
  process.stderr.write(`coverage-badge: cannot read ${SUMMARY}: ${error.message}\n`);
  process.stderr.write('Run the coverage task first; it must include the json-summary reporter.\n');
  process.exit(1);
}

const lines = summary.total?.lines;
if (typeof lines?.pct !== 'number') {
  process.stderr.write('coverage-badge: summary has no total.lines.pct\n');
  process.exit(1);
}

const pct = Math.round(lines.pct * 10) / 10;
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    label: 'coverage',
    message: `${pct}%`,
    color: colourFor(pct),
  })}\n`,
);
