/**
 * The Infection configuration and sandbox setup a PHP run needs.
 *
 * Covers the hybrid-config decision (use the project's own `infection.json`
 * when it ships one, else generate a minimal one), the source-root inference
 * that config depends on, and the per-run temp isolation.
 */
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Name of the config we generate when the project ships none. */
export const GENERATED_CONFIG_NAME = 'infection.json';
/** Config files Infection already recognises — if present, we do NOT overwrite. */
export const PROJECT_CONFIG_NAMES = ['infection.json', 'infection.json5'];
/**
 * PHPUnit configuration files Infection looks for at the project root. Our
 * generated config targets PHPUnit, so when none of these exist Infection has
 * no test runner to drive — a project using a different or custom runner.
 */
export const PHPUNIT_CONFIG_NAMES = [
  'phpunit.xml',
  'phpunit.xml.dist',
  'phpunit.dist.xml',
  'phpunit.yml',
  'phpunit.yml.dist',
  'phpunit.dist.yml',
  'phpunit.php',
];
/** Sandbox-relative JSON log path we always read results from. */
export const JSON_LOG_NAME = 'chaos-infection-log.json';

/**
 * Top path segment of the audit target, used as the generated config's
 * `source.directories` root (hybrid fallback only — a project shipping its own
 * infection.json keeps it).
 *
 * NORMALISE BEFORE SLICING. Taking `indexOf('/')` on the raw path answered `"."`
 * for two shapes callers actually pass: `./src/Calculator.php` (first slash at
 * index 1, so the slice is the literal `"."`) and an absolute
 * `/sandbox/src/Calculator.php` (first slash at index 0, which the `slash > 0`
 * guard rejects). `"."` is not a harmless default here: it tells Infection the
 * ENTIRE project tree is mutable source, which pulls in `tests/` and the
 * `vendor/` that utils/dependency-dirs.ts links into the sandbox — the same
 * over-broad coverage scope `diagnoseInfectionStartupFailure` (./failures.js)
 * diagnoses as case (2).
 *
 * `assertLogDescribes` already normalised a leading `./` on the very same
 * input, so before this fix two functions in this file disagreed about what
 * `./src/X.php` meant.
 *
 * Order of preference:
 *  1. the first segment of the (normalised, cwd-relative) path — `src`;
 *  2. failing that, the file's OWN directory, which is still narrower than the
 *     project root — an absolute target outside `cwd` lands here;
 *  3. `"."` only when there is genuinely nothing better: a root-level file, or
 *     a directory that is a bare ancestor chain (`../..`), which would be
 *     BROADER than the project root rather than narrower.
 *
 * @param cwd — the directory the generated `infection.json` is written to and
 *   that Infection resolves `source.directories` against (the sandbox), so an
 *   absolute target is expressed relative to it.
 */
export function inferSourceDir(filePath: string, cwd: string = process.cwd()): string {
  const toPosix = (p: string): string => p.replace(/\\/g, '/');
  // Strip any number of leading `./` segments: `./src/X.php` and `././src/X.php`
  // both denote `src/X.php`.
  const norm = toPosix(filePath).replace(/^(?:\.\/)+/, '');
  // Windows drive letters count as absolute too, so `C:/sb/src/X.php` is not
  // mistaken for a relative path whose first segment is `C:`.
  const isAbs = /^(?:[A-Za-z]:)?\//.test(norm);
  const rel = isAbs ? toPosix(relative(toPosix(cwd), norm)) : norm;

  const slash = rel.indexOf('/');
  const first = slash > 0 ? rel.slice(0, slash) : '';
  // `..` is an ancestor, not a source root; `.` is the project-root default we
  // are trying to avoid.
  if (first !== '' && first !== '.' && first !== '..') return first;

  // Fall back to the file's own directory rather than the project root. A path
  // with no separator at all (`Calculator.php`) has no directory — `slice` on a
  // -1 index would silently chop its last character instead.
  const lastSlash = rel.lastIndexOf('/');
  const dir = lastSlash > 0 ? rel.slice(0, lastSlash) : lastSlash === 0 ? '/' : '';
  const usable =
    dir !== '' &&
    dir !== '.' &&
    !/^(?:[A-Za-z]:)?\//.test(dir) && // still absolute → not expressible as a source root
    dir.split('/').some((seg) => seg !== '..'); // pure `../..` is broader than `.`
  return usable ? dir : '.';
}

/** Build a minimal Infection config for a bare PHPUnit project (hybrid fallback). */
export function buildInfectionConfig(sourceDir: string, jsonLogName: string): string {
  return (
    JSON.stringify(
      {
        source: { directories: [sourceDir] },
        testFramework: 'phpunit',
        logs: { json: jsonLogName },
      },
      null,
      2,
    ) + '\n'
  );
}

/**
 * True when a PHPUnit configuration makes a warning fail the run.
 *
 * Only the root element counts, and comments are stripped first: a config that
 * merely *mentions* the attribute — the shape one acquires right after reading
 * about this trap — does not have it set.
 */
export function phpunitFailsOnWarning(configXml: string): boolean {
  const root = /<phpunit\b[^>]*>/i.exec(configXml.replace(/<!--[\s\S]*?-->/g, ''));
  return root !== null && /\bfailOnWarning\s*=\s*(["'])true\1/i.test(root[0]);
}

/**
 * The advisory attached to a PHP result that reports survivors while the
 * project's PHPUnit config lets warnings pass.
 *
 * Infection sets `stopOnDefect="true"` in the config it writes for each mutant,
 * so the suite halts as soon as a mutant proves itself killed. That is sound
 * only while a defect also means a non-zero exit code. A PHP warning is a
 * defect for `stopOnDefect` but is not a failure under `failOnWarning="false"`,
 * so a mutant whose effect makes an *earlier* test warn stops the run with exit
 * 0 — and Infection records it as escaped without ever reaching the test that
 * asserts the mutated behaviour.
 *
 * Measured on Knossos-MCP: one such mutant halted the suite after 86 of 1,858
 * tests, and the file reported ten survivors at 96%. With `failOnWarning="true"`
 * the same file reports zero survivors at 100% — every one had been a phantom.
 *
 * The error is one-directional: scores are depressed, never inflated. That
 * makes it expensive rather than dangerous, because it sends a reader off
 * writing tests for mutants their suite already kills.
 */
export const WARNING_FIDELITY_NOTE =
  'Survivors may be overstated: this project\'s PHPUnit config does not set failOnWarning="true". ' +
  'Infection sets stopOnDefect="true" for each mutant, so a mutant whose effect makes an earlier ' +
  'test emit a PHP warning halts the suite with exit 0 and is recorded as escaped before the test ' +
  'that would assert the change ever runs. Confirm a survivor by applying its mutation by hand and ' +
  'running the covering test file; if that fails, set failOnWarning="true" and re-audit.';

/**
 * Prepare the sandbox so an Infection run's output is unambiguously its own.
 *
 * Three pieces of side-effect setup, all of which must happen before the CLI is
 * invoked:
 *  1. Delete any `chaos-infection-log.json` copied in with the workspace.
 *  2. Hybrid config: write a minimal `infection.json` only when the project
 *     ships none.
 *  3. Create a per-run temp directory to point TMPDIR/TMP/TEMP at.
 *
 * @returns `hasProjectConfig` (drives the failure diagnosis and the log-read
 *   hint), the absolute `jsonLogPath` to read results from, and the `env` to
 *   run Infection with.
 * @throws only when the generated config cannot be written — without it
 *   Infection has nothing to run.
 */
export function prepareInfectionWorkspace(
  cwd: string,
  filePath: string,
): { hasProjectConfig: boolean; jsonLogPath: string; env: NodeJS.ProcessEnv } {
  const jsonLogPath = join(cwd, JSON_LOG_NAME);

  // The sandbox is a copy of the workspace, so an earlier audit's
  // `chaos-infection-log.json` is copied in along with it. The failure path
  // below treats "a log exists" as proof that Infection ran, so a stale copy
  // silently stood in for a run that never happened — auditing one file
  // returned a hours-old 100% score computed for a different file entirely.
  // Removing it first makes any log read below necessarily this run's output.
  try {
    rmSync(jsonLogPath, { force: true });
  } catch {
    // Best-effort. If the stale log cannot be removed, the provenance check in
    // parseInfectionJsonLog is the remaining guard against reporting it.
  }

  // Hybrid config: only generate when the project ships none.
  const hasProjectConfig = PROJECT_CONFIG_NAMES.some((n) => existsSync(join(cwd, n)));
  if (!hasProjectConfig) {
    try {
      writeFileSync(
        join(cwd, GENERATED_CONFIG_NAME),
        // `cwd` is the sandbox: the directory this config is written to, and the
        // one Infection resolves `source.directories` against.
        buildInfectionConfig(inferSourceDir(filePath, cwd), JSON_LOG_NAME),
        'utf8',
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to write generated infection.json: ${message}`);
    }
  }

  // Isolate Infection's working files per run. Infection (and the phpunit it
  // spawns) write to `sys_get_temp_dir()/infection` — a FIXED shared path. Two
  // concurrent runs (e.g. a parallel `triage_test_coverage` sweep, each in its
  // own sandbox) clobber each other there: one run's phpunit ends up loading a
  // DIFFERENT sandbox's Composer autoloader and dies with
  // `Cannot declare class ComposerAutoloaderInit… already in use`, failing the
  // initial test run. Pointing TMPDIR/TMP/TEMP at a per-run dir inside the
  // sandbox gives each run its own `sys_get_temp_dir()`, so they never collide.
  const infectionTmp = join(cwd, '.chaos-infection-tmp');
  try {
    mkdirSync(infectionTmp, { recursive: true });
  } catch {
    // Best-effort: if we can't create it, fall through and let Infection use
    // its default temp dir (the pre-existing single-run behaviour).
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: infectionTmp,
    TMP: infectionTmp,
    TEMP: infectionTmp,
  };

  return { hasProjectConfig, jsonLogPath, env };
}
