#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type GetPromptResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  TOOL_DEFINITION,
  TRIAGE_TOOL_DEFINITION,
  ESTIMATE_TOOL_DEFINITION,
} from './tool-schema.js';
import { handleToolCall } from './handler.js';
import { handleTriageCall } from './triage-handler.js';
import { handleEstimateCall } from './estimate-handler.js';
import { makeToolContext } from './tool-context.js';
import { listResources, readResource } from './resources.js';
import { listPrompts, getPrompt } from './prompts.js';
import { ChaosConfig } from './utils/config-loader.js';
import { runCli } from './cli.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Re-export the primary API so existing import paths (tests, consumers) keep
// working after the index.ts split. handleToolCall and TOOL_DEFINITION now live
// in dedicated modules; APP_VERSION stays here (see note below).
export { handleToolCall } from './handler.js';
export { TOOL_DEFINITION } from './tool-schema.js';

/**
 * Application version, synced with package.json.
 *
 * MUST remain `export const APP_VERSION = '<semver>';` in THIS file — release-please's
 * generic updater bumps this literal on release via the `x-release-please-version`
 * annotation below (configured in `release-please-config.json`'s `extra-files`), and
 * version-sync.test.ts imports it from here and asserts it matches package.json's
 * version. That check runs in CI on `main` (post-merge) — not on the release-please
 * Release PR, which is authored by GITHUB_TOKEN and so does not trigger pull_request
 * workflows — catching any drift if the two files ever fall out of lockstep.
 */
export const APP_VERSION = '1.3.1'; // x-release-please-version

/**
 * Create and start the MCP server.
 * Separated from module scope so importing this file for tests
 * does not trigger side effects.
 *
 * @param config - Optional ChaosConfig used by the CallToolRequest handler.
 */
export async function startServer(config?: ChaosConfig): Promise<void> {
  const server = new Server(
    {
      name: 'chaos-mcp',
      version: APP_VERSION,
    },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
    },
  );

  /**
   * List available tools.
   * Chaos-MCP exposes three tools: audit_code_resilience, triage_test_coverage, and estimate_audit.
   */
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [TOOL_DEFINITION, TRIAGE_TOOL_DEFINITION, ESTIMATE_TOOL_DEFINITION],
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: listResources(),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
    contents: [readResource(request.params.uri)],
  }));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: listPrompts() }));

  server.setRequestHandler(
    GetPromptRequestSchema,
    async (request) =>
      getPrompt(
        request.params.name,
        (request.params.arguments ?? {}) as Record<string, string>,
      ) as unknown as GetPromptResult,
  );

  /**
   * Dispatch tool calls to the appropriate handler.
   */
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const ctx = makeToolContext(request, extra as unknown as Parameters<typeof makeToolContext>[1]);
    if (request.params.name === 'triage_test_coverage') {
      return handleTriageCall(request, config, ctx);
    }
    if (request.params.name === 'estimate_audit') {
      return handleEstimateCall(request, config, ctx);
    }
    return handleToolCall(request, config, ctx);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Auto-start when run directly (not when imported for testing).
//
// `process.argv[1]` is the path the kernel saw when the entrypoint was
// exec'd. After `npm install -g .` that's the symlink name (e.g.
// "/usr/bin/chaos-mcp"), NOT the resolved .js path — using
// `argv[1].endsWith("/index.js")` therefore silently dropped `runCli` and
// the process exited 0 with no output (no --version, no MCP server).
// We resolve both paths via realpathSync and require exact identity; merely
// being named index.js/index.ts is not sufficient to auto-start this module.
const isDirectRun =
  // Stryker disable next-line all: Node always defines process; this guard exists for import safety in non-Node bundlers.
  typeof process !== 'undefined' &&
  // Stryker disable next-line all: argv[1] absence is not representable through the direct CLI execution path.
  process.argv[1] !== undefined &&
  (() => {
    // Stryker disable BlockStatement: an empty catch yields undefined, which is equally falsy for the sole direct-run guard consumer.
    try {
      return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
      return false;
    }
    // Stryker restore BlockStatement
  })();

if (isDirectRun) {
  runCli({ appVersion: APP_VERSION, startServer });
}
