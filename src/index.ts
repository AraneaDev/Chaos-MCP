#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITION, TRIAGE_TOOL_DEFINITION } from './tool-schema.js';
import { handleToolCall } from './handler.js';
import { handleTriageCall } from './triage-handler.js';
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
 * MUST remain `export const APP_VERSION = '<semver>';` in THIS file — the npm
 * `version` lifecycle hook (scripts/sync-app-version.js) rewrites this literal
 * by regex, and version-sync.test.ts imports it from here.
 */
export const APP_VERSION = '1.1.1';

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
      capabilities: { tools: {} },
    },
  );

  /**
   * List available tools.
   * Chaos-MCP exposes two tools: audit_code_resilience and triage_test_coverage.
   */
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [TOOL_DEFINITION, TRIAGE_TOOL_DEFINITION],
    };
  });

  /**
   * Dispatch tool calls to the appropriate handler.
   */
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === 'triage_test_coverage') {
      return handleTriageCall(request, config);
    }
    return handleToolCall(request, config);
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
