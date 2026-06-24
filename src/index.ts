#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { TypeScriptEngine } from './engines/typescript.js';
import { PythonEngine } from './engines/python.js';
import { GoEngine } from './engines/go.js';
import { RustEngine } from './engines/rust.js';
import { RunOptions } from './engines/base.js';
import { detectProjectType, detectEnvironment } from './utils/project-detector.js';
import { createSandbox } from './utils/sandbox.js';
import { loadConfig, ChaosConfig } from './utils/config-loader.js';
import { enableVerbose, log, isVerbose } from './utils/logger.js';

/**
 * Tool definition for audit_code_resilience.
 */
export const TOOL_DEFINITION = {
  name: 'audit_code_resilience',
  description:
    'Runs on-demand, sandbox-isolated mutation testing against a single source file to identify gaps in unit test coverage. ' +
    'Chaos-MCP generates mutants (logical faults like changing `>` to `>=`) and checks whether the local test suite catches them. ' +
    'Surviving mutants indicate test coverage holes. Supports TypeScript/JavaScript (StrykerJS), Python (Mutmut), Go (go-mutesting), and Rust (cargo-mutants).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      filePath: {
        type: 'string',
        description:
          'Workspace-relative path to the file to audit. ' +
          'Must end in .ts, .js, .tsx, .jsx, .py, .go, or .rs. ' +
          'Example: "src/utils/math.ts"',
      },
      timeoutMs: {
        type: 'number',
        description:
          'Maximum time in milliseconds for the entire mutation run. ' +
          'Default: 300000 (5 minutes). Increase for large files or slow test suites. ' +
          'Example: 120000 for a 2-minute cap.',
      },
      lineScope: {
        type: 'object',
        description:
          'Constrain mutations to a 1-based line range (inclusive). Only supported by StrykerJS; ignored for Python and Go targets. ' +
          'Useful for surgically auditing a specific function or block. ' +
          'Example: { "start": 10, "end": 45 }',
        properties: {
          start: {
            type: 'number',
            description: 'Start line (1-based, inclusive).',
          },
          end: {
            type: 'number',
            description: 'End line (1-based, inclusive). Must be >= start.',
          },
        },
      },
      mutatorAllowlist: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Stryker mutator names to include — all others are skipped. StrykerJS only. ' +
          'Common mutators: "ArithmeticOperator", "ConditionalExpression", "BooleanLiteral", "StringLiteral". ' +
          'Example: ["ConditionalExpression", "BooleanLiteral"]',
      },
      mutatorDenylist: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Stryker mutator names to exclude — these are filtered out. StrykerJS only. ' +
          'Useful for skipping noisy or irrelevant mutators. ' +
          'Example: ["StringLiteral"]',
      },
      concurrency: {
        type: 'number',
        description:
          'Number of parallel mutation workers (StrykerJS only). ' +
          'When omitted, StrykerJS auto-detects CPU core count. ' +
          'Lower this on memory-constrained machines; raise it on CI with spare cores. ' +
          'Example: 4',
      },
      dryRun: {
        type: 'boolean',
        description:
          'If true, run only the dry-run phase to validate the test suite passes before mutation testing (StrykerJS only). ' +
          'Useful for pre-flight checks. Example: false',
      },
      outputFormat: {
        type: 'string',
        enum: ['json', 'text'],
        description:
          'Output format for the result. "json" (default) returns a structured MutationResult object. ' +
          '"text" returns a human-readable summary. Example: "json"',
      },
      incremental: {
        type: 'boolean',
        description:
          'Enable incremental mode to reuse results from a previous run and skip unchanged mutants (StrykerJS only). ' +
          'Speeds up repeat audits of the same file. Example: true',
      },
      ignorePatterns: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Substring patterns for files/directories to exclude from the sandbox copy, applied in addition to built-in exclusions. ' +
          'Any path containing the pattern string is skipped. Example: [".test.ts", "fixtures/", "snapshots/"]',
      },
    },
    required: ['filePath'],
    additionalProperties: false,
  },
};

/**
 * Format a MutationResult as a human-readable text summary.
 * Used when the caller requests `outputFormat: 'text'`.
 */
function formatResultAsText(result: {
  target: string;
  totalMutants: number;
  killed: number;
  survived: number;
  mutationScore: string;
  vulnerabilities: { line: number; replacement: string; description: string }[];
}): string {
  const lines: string[] = [
    `Chaos-MCP Audit Report: ${result.target}`,
    `══════════════════════════════════════════════════`,
    `  Total mutants:  ${result.totalMutants}`,
    `  Killed:         ${result.killed}`,
    `  Survived:       ${result.survived}`,
    `  Mutation score: ${result.mutationScore}`,
    ``,
  ];

  if (result.vulnerabilities.length === 0) {
    lines.push('✅ No surviving mutants — your tests caught all mutations.');
  } else {
    lines.push(`⚠️  ${result.vulnerabilities.length} surviving mutant(s) found:`);
    lines.push('');
    for (const v of result.vulnerabilities) {
      lines.push(`  Line ${v.line}: [${v.replacement}]`);
      lines.push(`    ${v.description}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Handle tool invocations.
 * Dispatches to the appropriate mutation engine based on file extension.
 *
 * Extracted as a named export so it can be unit-tested without starting the server.
 *
 * @param request - The MCP tool call request.
 * @param config - Optional ChaosConfig loaded from a config file. Tool call arguments
 *   override config defaults.
 */
export async function handleToolCall(request: CallToolRequest, config?: ChaosConfig) {
  if (request.params.name !== 'audit_code_resilience') {
    throw new Error(`Method unrecognized: ${request.params.name}`);
  }

  const filePath = request.params.arguments?.filePath as string;

  try {
    const projectType = detectProjectType(filePath);

    if (projectType === 'unsupported') {
      return {
        content: [
          { type: 'text', text: `Error: Extension unsupported for file target ${filePath}` },
        ],
        isError: true,
      };
    }

    // Auto-detect the workspace environment (test runner, workspace root)
    const env = detectEnvironment(filePath);

    const engine =
      projectType === 'typescript'
        ? new TypeScriptEngine()
        : projectType === 'python'
          ? new PythonEngine()
          : projectType === 'go'
            ? new GoEngine()
            : new RustEngine();

    // Provision a sandbox so mutation runs never touch the real workspace tree
    // Parse ignorePatterns early so we can pass them to the sandbox
    const earlyArgs = request.params.arguments ?? {};
    const earlyIgnorePatterns = Array.isArray(earlyArgs.ignorePatterns)
      ? (earlyArgs.ignorePatterns as string[]).filter((v) => typeof v === 'string')
      : undefined;

    let sandbox;
    try {
      sandbox = createSandbox(filePath, env.workspaceRoot, earlyIgnorePatterns);
    } catch {
      return {
        content: [
          {
            type: 'text',
            text: `Chaos Engine Halted: Failed to provision sandbox isolation for ${filePath}. Ensure the file exists and the workspace is accessible.`,
          },
        ],
        isError: true,
      };
    }

    try {
      // Build RunOptions from the tool call arguments, merging with config defaults.
      // Tool call arguments take precedence over config values.
      const args = request.params.arguments ?? {};
      const cfg = config ?? {};

      if (isVerbose()) {
        log('Tool call: audit_code_resilience');
        log(`  filePath: ${filePath}`);
        log(`  projectType: ${projectType}`);
        log(`  testRunner: ${env.testRunner} (detected: ${env.detectedRunner})`);
        log(`  workspaceRoot: ${env.workspaceRoot}`);
        log(`  sandboxDir: ${sandbox.workDir}`);
        if (cfg.defaultTimeoutMs) log(`  config.timeoutMs: ${cfg.defaultTimeoutMs}`);
        if (cfg.mutatorDenylist) log(`  config.mutatorDenylist: ${cfg.mutatorDenylist.join(', ')}`);
      }

      const runOptions: RunOptions = {
        testRunner: env.testRunner,
        workDir: sandbox.workDir,
        timeoutMs:
          typeof args.timeoutMs === 'number' && args.timeoutMs > 0
            ? args.timeoutMs
            : cfg.defaultTimeoutMs,
        lineScope:
          typeof args.lineScope === 'object' &&
          args.lineScope !== null &&
          !Array.isArray(args.lineScope) &&
          typeof (args.lineScope as Record<string, unknown>).start === 'number' &&
          typeof (args.lineScope as Record<string, unknown>).end === 'number'
            ? {
                start: (args.lineScope as Record<string, number>).start,
                end: (args.lineScope as Record<string, number>).end,
              }
            : undefined,
        mutatorAllowlist: Array.isArray(args.mutatorAllowlist)
          ? (args.mutatorAllowlist as string[]).filter((v) => typeof v === 'string')
          : cfg.mutatorAllowlist,
        mutatorDenylist: Array.isArray(args.mutatorDenylist)
          ? (args.mutatorDenylist as string[]).filter((v) => typeof v === 'string')
          : cfg.mutatorDenylist,
        concurrency:
          typeof args.concurrency === 'number' && args.concurrency > 0
            ? args.concurrency
            : cfg.concurrency,
        dryRun: typeof args.dryRun === 'boolean' ? args.dryRun : undefined,
        outputFormat:
          args.outputFormat === 'text' || args.outputFormat === 'json'
            ? args.outputFormat
            : undefined,
        incremental: typeof args.incremental === 'boolean' ? args.incremental : undefined,
        ignorePatterns: Array.isArray(args.ignorePatterns)
          ? (args.ignorePatterns as string[]).filter((v) => typeof v === 'string')
          : undefined,
      };

      // Apply output format to the final response
      const auditResults = await engine.run(filePath, runOptions);

      if (runOptions.outputFormat === 'text') {
        const textSummary = formatResultAsText(auditResults);
        return {
          content: [{ type: 'text', text: textSummary }],
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(auditResults, null, 2) }],
      };
    } finally {
      // Always clean up the sandbox, even if the engine threw
      sandbox.cleanup();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Chaos Engine Halted: ${message}` }],
      isError: true,
    };
  }
}

/**
 * Create and start the MCP server.
 * Separated from module scope so importing this file for tests
 * does not trigger side effects.
 */
export async function startServer(): Promise<void> {
  const server = new Server(
    {
      name: 'chaos-mcp',
      version: '1.1.0',
    },
    {
      capabilities: { tools: {} },
    },
  );

  /**
   * List available tools.
   * Chaos-MCP exposes a single tool: audit_code_resilience.
   */
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [TOOL_DEFINITION],
    };
  });

  /**
   * Dispatch tool calls to the handler.
   */
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return handleToolCall(request, loadedConfig);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ─── CLI flags ───────────────────────────────────────────────────────────────

/** Application version, synced with package.json. */
export const APP_VERSION = '1.1.0';

const HELP_TEXT = `chaos-mcp v${APP_VERSION} — On-demand micro-mutation sandbox for AI test verification

Usage:
  chaos-mcp [flags]

Flags:
  --version   Print version and exit
  --help      Show this help text and exit
  --config    Path to a JSON config file with default settings (chaos-mcp.config.json)
  --verbose   Enable diagnostic logging to stderr

Description:
  Chaos-MCP is a Model Context Protocol (MCP) server that exposes a single tool,
  "audit_code_resilience", which runs isolated mutation testing against a target
  source file to identify weaknesses in the local test suite.

  It supports TypeScript/JavaScript (via StrykerJS), Python (via Mutmut),
  Go (via go-mutesting), and Rust (via cargo-mutants). All mutation runs execute inside temporary sandbox
  directories — your real working tree is never touched.

Configuration (chaos-mcp.config.json):
  { "defaultTimeoutMs": 300000, "mutatorDenylist": ["StringLiteral"] }

Tool: audit_code_resilience
  Parameters:
    filePath (required)  — Workspace-relative path to the file to audit (.ts/.js/.py/.go/.rs).
    timeoutMs            — Max run time in ms (default: 300000 / 5 min).
    lineScope            — { start, end } 1-based line range (StrykerJS only).
    mutatorAllowlist     — string[] of Stryker mutator names to include.
    mutatorDenylist      — string[] of Stryker mutator names to exclude.
    concurrency          — number of parallel mutation workers (StrykerJS only).
    dryRun               — boolean, validate test suite only (StrykerJS only).
    outputFormat         — 'json' (default) or 'text' for human-readable output.
    incremental          — boolean, reuse previous run results (StrykerJS only).
    ignorePatterns       — string[] of substring patterns to exclude from sandbox copy.

  Example via MCP client:
    { "filePath": "src/utils/math.ts", "timeoutMs": 60000 }
    { "filePath": "src/billing.py", "mutatorDenylist": ["StringLiteral"] }
    { "filePath": "src/logic.go" }
    { "filePath": "src/main.rs" }

Links:
  https://codebuff.com/docs
  https://stryker-mutator.io
  https://github.com/boxed/mutmut
  https://github.com/zimmski/go-mutesting
  https://github.com/sourcefrog/cargo-mutants
`;

// Auto-start when run directly (not when imported for testing)
const isDirectRun =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('/index.js') || process.argv[1].endsWith('/index.ts'));

// ── Load config (lazy, used by server's CallToolRequest handler) ───────────
let loadedConfig: ChaosConfig | undefined;

// Auto-start when run directly (not when imported for testing)
if (isDirectRun) {
  const args = process.argv.slice(2);

  if (args.includes('--version')) {
    console.log(`chaos-mcp v${APP_VERSION}`);
    process.exit(0);
  }

  if (args.includes('--help')) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  // --verbose flag
  if (args.includes('--verbose')) {
    enableVerbose();
    log('Verbose mode enabled');
  }

  // --config <path> flag
  const configIndex = args.indexOf('--config');
  const configPath =
    configIndex !== -1 && configIndex + 1 < args.length ? args[configIndex + 1] : undefined;

  try {
    loadedConfig = loadConfig(configPath);
    if (isVerbose() && loadedConfig && Object.keys(loadedConfig).length > 0) {
      log('Config loaded:', JSON.stringify(loadedConfig));
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: ${message}`);
    // Continue without config — the tool still works with defaults
  }

  startServer();
}
