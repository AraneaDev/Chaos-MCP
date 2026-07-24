#!/usr/bin/env node
/**
 * Post-install hook — prints setup guidance after `npm install -g chaos-mcp`.
 *
 * This runs in the consumer's Node.js environment, not the development
 * environment, so we use only synchronous operations and guard against
 * missing dev deps.
 */

import { chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Defensive chmod: ensure the CLI entrypoint is executable after npm copies
// tarball files into node_modules. npm's `pkg.bin` → chmod step is not
// reliable across all npm versions/platforms, so we redo it explicitly.
// Runs for both local and global installs (the local .bin/ symlink also
// needs +x on the underlying file).
try {
  const binPath = path.resolve(__dirname, '..', 'build', 'index.js');
  chmodSync(binPath, 0o755);
} catch (err) {
  // ENOENT means the package was installed without a build (e.g. a
  // downstream consumer who only imported types). Skip silently there.
  // Any other failure (EACCES on a read-only filesystem, etc.) is real —
  // surface it via stderr without failing the whole install.
  if (err && err.code !== 'ENOENT') {
    console.error(
      `postinstall: failed to chmod bin (${err.code}): ${err.message}`,
    );
  }
}

// Only show the message when installed globally (not during dev installs).
// npm sets `npm_config_global` to "true" when installing with -g.
const isGlobal = process.env.npm_config_global === 'true';

if (!isGlobal) {
  // Dev install (npm install in a checkout) — skip the user-facing message.
  process.exit(0);
}

const BOLD = '\x1b[1m';
const CYAN = '\x1b[0;36m';
const NC = '\x1b[0m';

console.log(`
${BOLD}${CYAN}Chaos-MCP${NC} — mutation-testing sandbox for AI test verification

  ${BOLD}Quick start:${NC}
    chaos-mcp                        Start the MCP server
    chaos-mcp --help                 Show all flags
    chaos-mcp --verbose              Start with diagnostic logging
    chaos-mcp --validate-config      Validate your config file

  ${BOLD}Config (optional):${NC}
    Create chaos-mcp.config.json in your workspace:
    {
      "defaultTimeoutMs": 300000,
      "stryker": { "concurrency": 4, "perMutantTimeoutMs": 10000 }
    }

  ${BOLD}MCP client setup:${NC}
    {
      "chaos-mcp": {
        "command": "chaos-mcp",
        "args": ["--verbose"]
      }
    }

  ${BOLD}Docs:${NC} https://github.com/codebuff/chaos-mcp
`);
