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
 * version, guarding that the bump stays in lockstep.
 */
export const APP_VERSION = '1.2.0'; // x-release-please-version

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

// Auto-start when run directly (not when imported for testing)
const isDirectRun =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('/index.js') || process.argv[1].endsWith('/index.ts'));

if (isDirectRun) {
  runCli({ appVersion: APP_VERSION, startServer });
}
