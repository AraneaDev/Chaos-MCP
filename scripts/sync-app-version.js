#!/usr/bin/env node
/**
 * Auto-sync `APP_VERSION` in `src/index.ts` with the version in `package.json`.
 *
 * Triggered by npm's `version` lifecycle hook — i.e. when running
 * `npm version patch | minor | major`. The hook fires AFTER the package.json
 * bump but BEFORE npm's auto-commit + auto-tag, so this script's edit to
 * `src/index.ts` gets folded into the same commit.
 *
 * Reads:  ./package.json (post-bump version)
 * Writes: ./src/index.ts APP_VERSION constant
 *
 * The MCP `Server` whose metadata lives in `startServer({ ..., version: APP_VERSION })`
 * is structurally derived, so there is no third version literal to sync.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkgJsonPath = path.join(root, 'package.json');
const indexPath = path.join(root, 'src', 'index.ts');

const newVersion = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).version;
const indexTs = fs.readFileSync(indexPath, 'utf8');

const pattern = /export const APP_VERSION = '([^']+)';?/;
const match = indexTs.match(pattern);

if (!match) {
  console.error(
    `[sync-app-version] Could not find APP_VERSION constant in ${indexPath}. ` +
      `Expected pattern: export const APP_VERSION = '<semver>';`,
  );
  process.exit(1);
}

const oldVersion = match[1];
if (oldVersion === newVersion) {
  console.log(`[sync-app-version] APP_VERSION already at ${newVersion}; no change needed.`);
  process.exit(0);
}

const updated = indexTs.replace(pattern, `export const APP_VERSION = '${newVersion}';`);
fs.writeFileSync(indexPath, updated);
console.log(`[sync-app-version] Bumped APP_VERSION: ${oldVersion} -> ${newVersion}`);
