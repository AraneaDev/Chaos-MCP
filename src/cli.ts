import { loadConfig, validateConfig, ChaosConfig } from './utils/config-loader.js';
import { enableVerbose, log, isVerbose } from './utils/logger.js';

/** Minimum Node.js version required by Chaos-MCP (matches package.json `engines.node`). */
const MIN_NODE_VERSION = '18.0.0';

/**
 * Check that the current Node.js runtime meets the minimum version requirement.
 * Throws an error with a helpful message if the runtime is too old.
 * Called at startup (only when run directly, not when imported for tests).
 */
export function checkNodeVersion(): void {
  const current = process.versions.node;
  const [currentMajor, currentMinor] = current.split('.').map(Number);
  const [minMajor, minMinor] = MIN_NODE_VERSION.split('.').map(Number);

  if (currentMajor < minMajor || (currentMajor === minMajor && currentMinor < minMinor)) {
    console.error(
      `chaos-mcp requires Node.js >= ${MIN_NODE_VERSION}, but you are running ${current}. ` +
        `Please upgrade your Node.js runtime. See https://nodejs.org/ for downloads.`,
    );
    process.exit(1);
  }
}

/** Build the --help text for the given application version. */
export function buildHelpText(appVersion: string): string {
  return `chaos-mcp v${appVersion} — On-demand micro-mutation sandbox for AI test verification

Usage:
  chaos-mcp [flags]

Flags:
  --version          Print version and exit
  --help             Show this help text and exit
  --config           Path to a JSON config file with default settings (chaos-mcp.config.json)
  --validate-config  Load and validate the config file, report warnings, then exit
  --strict           Used with --validate-config: exit 2 on warnings (fatal in CI)
  --verbose          Enable diagnostic logging to stderr

Description:
  Chaos-MCP is a Model Context Protocol (MCP) server that exposes a single tool,
  "audit_code_resilience", which runs isolated mutation testing against a target
  source file to identify weaknesses in the local test suite.

  It supports TypeScript/JavaScript (via StrykerJS), Python (via cosmic-ray),
  Rust (via cargo-mutants), and PHP (via Infection). All mutation runs execute inside temporary sandbox
  directories — your real working tree is never touched.

Configuration (chaos-mcp.config.json):
  {
    "defaultTimeoutMs": 300000,
    "stryker": { "concurrency": 4, "perMutantTimeoutMs": 10000 },
    "rust": { "timeoutMs": 600000 }
  }

  Engine-specific sections ("stryker", "cosmicray", "rust", "infection") override the
  corresponding global defaults. Stryker sections support: timeoutMs, concurrency,
  mutatorDenylist, perMutantTimeoutMs, dryRun, incremental.
  All other engine sections support: timeoutMs. cosmicray also supports:
  testRunner, testSelection, excludeOperators.

Tool: audit_code_resilience
  Parameters:
    filePath (required)  — Workspace-relative path to the file to audit (.ts/.js/.py/.rs/.php).
    timeoutMs            — Max run time in ms (default: 300000 / 5 min).
    lineScope            — { start, end } 1-based line range (StrykerJS only).
    mutatorAllowlist     — (unsupported in StrykerJS v9 — ignored; use mutatorDenylist).
    mutatorDenylist      — string[] of Stryker mutator names to exclude.
    concurrency          — number of parallel mutation workers (StrykerJS only).
    dryRun               — boolean, validate test suite only (StrykerJS only).
    outputFormat         — 'json' (default) or 'text' for human-readable output.
    incremental          — boolean, reuse previous run results (StrykerJS only).
    ignorePatterns       — string[] of substring patterns to exclude from sandbox copy.
    prebuildCommand      — shell command to run before mutation (e.g. "npm run build", "cargo build").
                           Disabled by default; enable with "allowPrebuild": true or CHAOS_MCP_ALLOW_PREBUILD=1.
    perMutantTimeoutMs   — max ms per individual mutant test (StrykerJS only).

  Example via MCP client:
    { "filePath": "src/utils/math.ts", "timeoutMs": 60000 }
    { "filePath": "src/billing.py", "mutatorDenylist": ["StringLiteral"] }
    { "filePath": "src/main.rs" }

Links:
  https://codebuff.com/docs
  https://stryker-mutator.io
  https://github.com/sixty-north/cosmic-ray
  https://github.com/sourcefrog/cargo-mutants
  https://infection.github.io
`;
}

/** Dependencies injected by the entry module (index.ts) to avoid an import cycle. */
interface CliDeps {
  appVersion: string;
  startServer: (config?: ChaosConfig) => Promise<void>;
}

/**
 * Extract the value following a flag (e.g. `--config <path>`) from argv, guarding
 * against the flag being the last token or its "value" itself being another flag
 * (e.g. `--config --strict`, where `--strict` would otherwise be mistaken for the
 * config path). Prints a warning to stderr and returns `undefined` in that case,
 * mirroring the `diffBase`-must-not-start-with-"-" guard on the MCP side
 * (src/handler.ts).
 */
function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  if (index + 1 >= args.length) {
    console.error(`Warning: ${flag} expects a path but got no value; ignoring.`);
    return undefined;
  }
  const value = args[index + 1];
  if (value.startsWith('-')) {
    console.error(`Warning: ${flag} expects a path but got "${value}"; ignoring.`);
    return undefined;
  }
  return value;
}

/**
 * Parse argv and run the appropriate CLI action: print version/help, validate a
 * config and exit, or load config and start the MCP server.
 *
 * Extracted from index.ts so the entry module stays thin. The version constant
 * and server factory are injected because they live in index.ts (the npm
 * `version` lifecycle hook rewrites APP_VERSION there).
 */
export function runCli({ appVersion, startServer }: CliDeps): void {
  // Enforce minimum Node.js version before anything else
  checkNodeVersion();

  const args = process.argv.slice(2);

  if (args.includes('--version')) {
    console.log(`chaos-mcp v${appVersion}`);
    process.exit(0);
  }

  if (args.includes('--help')) {
    console.log(buildHelpText(appVersion));
    process.exit(0);
  }

  // --validate-config flag
  if (args.includes('--validate-config')) {
    const configPath = getFlagValue(args, '--config');
    const strict = args.includes('--strict');

    const { warnings } = validateConfig(configPath);
    if (warnings.length > 0) {
      console.error('Config validation warnings:');
      for (const w of warnings) {
        console.error(`  - ${w}`);
      }
      process.exit(strict ? 2 : 1);
    }
    console.error('Config is valid — no warnings.');
    process.exit(0);
  }

  // --verbose flag
  if (args.includes('--verbose')) {
    enableVerbose();
    log('Verbose mode enabled');
  }

  // --config <path> flag
  const configPath = getFlagValue(args, '--config');

  let loadedConfig: ChaosConfig | undefined;
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

  startServer(loadedConfig);
}
