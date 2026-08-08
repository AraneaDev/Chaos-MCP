import { existsSync } from 'fs';
import { loadConfig, validateConfig, ChaosConfig } from './utils/config-loader.js';
import { resolveConfigPath } from './utils/config/parse.js';
import { enableVerbose, log, isVerbose } from './utils/logger.js';
import { inspectContainerRuntime } from './utils/container/doctor.js';

/**
 * Minimum Node.js version required by Chaos-MCP.
 *
 * MUST stay in lockstep with package.json's `engines.node` — version-sync.test.ts
 * asserts it. It had drifted to 18.0.0 while the package required >= 22, so a
 * Node 18 user passed this check and then hit an obscure runtime failure
 * instead of the clear upgrade message this function exists to print.
 */
export const MIN_NODE_VERSION = '22.0.0';

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
  --container-doctor Check the OCI runtime and all four configured language images
  --strict           Used with --validate-config: exit 2 on warnings (fatal in CI)
  --verbose          Enable diagnostic logging to stderr

Exit codes (--validate-config):
  0  Valid, or advisory warnings without --strict, or no config at the default path
  1  Config unreadable/unparseable, or an explicit --config path does not exist
  2  Advisory warnings with --strict

Environment:
  CHAOS_ALLOWED_ROOTS             Extra workspace roots this server may audit
                                  (path-delimited; default: the working directory only)
  CHAOS_MCP_ALLOW_PREBUILD=1      Permit a caller-supplied prebuildCommand
  CHAOS_MCP_ALLOW_REPO_TEST_COMMAND=1
                                  Permit a Python test command declared by the AUDITED
                                  project (pyproject.toml [tool.mutmut] runner) to be
                                  executed by cosmic-ray. Bare executable names are
                                  always allowed; this opens it to full command lines.

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
    "rust": { "timeoutMs": 600000 },
    "container": { "mode": "auto", "runtime": "docker", "cpus": 2 }
  }

  Engine-specific sections ("stryker", "cosmicray", "rust", "infection") override the
  corresponding global defaults. Stryker sections support: timeoutMs, concurrency,
  mutatorDenylist, perMutantTimeoutMs, dryRun, incremental.
  All other engine sections support: timeoutMs. cosmicray also supports:
  testRunner, testSelection, excludeOperators.
  The shared "container" section supports native/container/auto mode, Docker or
  Podman, resource limits (cpus, memoryMb, pidsLimit, tmpfsSizeMb), network
  selection, and per-language image overrides.

Tool: audit_code_resilience
  Parameters:
    filePath (required)  — Workspace-relative path to the file to audit (.ts/.js/.py/.rs/.php).
    timeoutMs            — Max run time in ms (default: 300000 / 5 min).
    lineScope            — { start, end } 1-based line range (StrykerJS only).
    mutatorAllowlist     — NOT SUPPORTED (StrykerJS v9 has no allowlist): REJECTED with an error
                           when passed as a tool argument. Use mutatorDenylist instead, or supply
                           your own stryker.config.json.
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
  https://github.com/AraneaDev/Chaos-MCP
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
  //
  // Exit codes are the contract this flag is used through in CI, so they are
  // graded by what actually went wrong rather than by "were there any strings
  // to print". Previously ANY warning exited 1 — including the purely
  // informational "no config file here" — which made the documented meaning of
  // --strict ("exit 2 on warnings (fatal in CI)") false: warnings were already
  // fatal without it.
  //
  //   0 — valid, or advisory warnings without --strict, or no config file at
  //       the default location (running on defaults is a valid configuration)
  //   1 — the file could not be read/parsed, or an explicitly-named --config
  //       file does not exist (a mistyped path must never look like success)
  //   2 — advisory warnings with --strict
  if (args.includes('--validate-config')) {
    const configPath = getFlagValue(args, '--config');
    const strict = args.includes('--strict');

    const { warnings, status } = validateConfig(configPath);

    if (status === 'unreadable') {
      console.error('Config error:');
      for (const w of warnings) console.error(`  - ${w}`);
      process.exit(1);
    }
    if (status === 'not-found') {
      // Only an error when the operator named the file themselves.
      const explicit = configPath !== undefined;
      console.error(explicit ? 'Config error:' : 'Config not found — using built-in defaults:');
      for (const w of warnings) console.error(`  - ${w}`);
      process.exit(explicit ? 1 : 0);
    }
    if (warnings.length > 0) {
      console.error('Config validation warnings:');
      for (const w of warnings) {
        console.error(`  - ${w}`);
      }
      process.exit(strict ? 2 : 0);
    }
    console.error('Config is valid — no warnings.');
    process.exit(0);
  }

  if (args.includes('--container-doctor')) {
    const configPath = getFlagValue(args, '--config');
    let config: ChaosConfig = {};
    try {
      config = loadConfig(configPath);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Container doctor could not load config: ${message}`);
      process.exitCode = 1;
      return;
    }
    void inspectContainerRuntime(config.container)
      .then((report) => {
        console.log(JSON.stringify(report, null, 2));
        process.exitCode =
          report.available && Object.values(report.images).every((image) => image.present) ? 0 : 1;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Container doctor failed: ${message}`);
        process.exitCode = 1;
      });
    return;
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
    // A --config path that does not exist is NOT an error to `loadConfig`:
    // `readConfigRaw` treats a missing file as "no config" and returns null, so
    // `loadConfig` returns {} without throwing and the catch below never fires.
    // --verbose stayed silent too, because it only logs a NON-empty config. The
    // server therefore started on built-in defaults with no signal at all that
    // the operator's tuning had been ignored — a mistyped path is indis-
    // tinguishable from a working one (audit finding 18).
    //
    // Only a path the operator NAMED is worth warning about; no file at the
    // default location is the ordinary case. The same resolver `loadConfig`
    // used is imported rather than reimplemented, so this reports the exact
    // path that was looked for. Deliberately a warning, not a throw: the fatal
    // variant of this check is --validate-config's job (it exits 1), and this
    // path must keep starting the server on defaults.
    if (configPath !== undefined) {
      const resolved = resolveConfigPath(configPath);
      if (!existsSync(resolved)) {
        console.error(
          `Warning: config file not found at ${resolved} — using built-in defaults. ` +
            `Run with --validate-config to make a missing --config path a hard error.`,
        );
      }
    }
    if (isVerbose() && loadedConfig && Object.keys(loadedConfig).length > 0) {
      log('Config loaded:', JSON.stringify(loadedConfig));
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: ${message}`);
    // Continue without config — the tool still works with defaults
  }

  // The returned promise MUST be handled. `runCli` is called at module top level
  // (index.ts), so an unhandled rejection from `server.connect(transport)` takes
  // the process down with a raw ERR_UNHANDLED_REJECTION stack under Node's
  // default --unhandled-rejections=throw, instead of the clean diagnostic every
  // other failure path here prints. Same idiom as --container-doctor above.
  void startServer(loadedConfig).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`chaos-mcp failed to start: ${message}`);
    process.exitCode = 1;
  });
}
