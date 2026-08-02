/**
 * The cosmic-ray configuration a Python run is driven by.
 *
 * `buildCosmicRayConfig` is pure — the whole generated TOML is assertable as a
 * string — so it lives apart from the engine that writes it to disk.
 */

/** Per-mutant test timeout written into the cosmic-ray config (seconds). */
export const DEFAULT_PER_MUTANT_TIMEOUT_S = 30;
/**
 * Floor below which starting another cosmic-ray subcommand is pointless — the
 * process would be killed before it finished spawning. Mirrors the engine floor
 * the handler applies to the audit as a whole (`MIN_ENGINE_BUDGET_MS`).
 */
export const MIN_STEP_BUDGET_MS = 1_000;
/** Sandbox-relative names for the generated config + session DB. */
export const CONFIG_NAME = 'chaos-cosmic-ray.toml';
export const SESSION_NAME = 'chaos-cosmic-ray.sqlite';

export interface CosmicRayConfigOptions {
  /** Workspace-relative file to mutate (cosmic-ray `module-path`). */
  modulePath: string;
  /** Shell command cosmic-ray runs to execute the test suite per mutant. */
  testCommand: string;
  /** Per-mutant test timeout in seconds. */
  timeoutSeconds: number;
  /**
   * Operator-name regexes to exclude (read by `cr-filter-operators`). cosmic-ray
   * always enumerates its full operator set, so this is how the mutant count is
   * bounded on large files — matching mutants are marked skipped before exec.
   */
  excludeOperators?: string[];
}

/**
 * Build a cosmic-ray `config.toml`. cosmic-ray (unlike mutmut) mutates files in
 * place and runs the test-command from the project root, so a real app's
 * conftest (`from main import app`) resolves normally.
 *
 * Note: cosmic-ray always enumerates its full operator set (the
 * `[cosmic-ray.operators]` section only parameterizes operators, it is NOT an
 * allowlist). To bound the mutant count on large files, supply `excludeOperators`
 * — `cr-filter-operators` marks matching mutants skipped (see the engine).
 */
export function buildCosmicRayConfig(opts: CosmicRayConfigOptions): string {
  const lines = [
    '[cosmic-ray]',
    `module-path = ${JSON.stringify(opts.modulePath)}`,
    `timeout = ${opts.timeoutSeconds}`,
    `test-command = ${JSON.stringify(opts.testCommand)}`,
    '',
    '[cosmic-ray.distributor]',
    'name = "local"',
  ];
  if (opts.excludeOperators && opts.excludeOperators.length > 0) {
    lines.push(
      '',
      '[cosmic-ray.filters.operators-filter]',
      `exclude-operators = [${opts.excludeOperators.map((o) => JSON.stringify(o)).join(', ')}]`,
    );
  }
  return `${lines.join('\n')}\n`;
}
