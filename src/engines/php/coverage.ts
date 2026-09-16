import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionSession } from '../../utils/execution.js';
import { invokeMutationTool } from '../../utils/exec-classify.js';
import { harvestArtefact, type ReuseKey } from '../../utils/reuse/store.js';
import { splitCommandArgs } from '../../utils/shell-quote.js';
import type { PhpCoverageScope, PhpCoverageSelection } from './coverage-selection.js';
import { PHP_COVERAGE_DIR_NAME } from './config.js';

export { PHP_COVERAGE_DIR_NAME } from './config.js';

export interface PhpCoverageInput {
  workDir: string;
  key?: ReuseKey;
  fingerprint?: string;
  timeoutMs: number;
  testFrameworkOptions?: string;
  coverageSelection?: PhpCoverageSelection;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  executor?: ExecutionSession;
}

export interface PhpCoverageResult {
  generated: boolean;
  scope: PhpCoverageScope;
}

const diagnosticOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Generate and optionally persist the PHPUnit coverage used by PHP audits. */
export async function producePhpCoverage(input: PhpCoverageInput): Promise<PhpCoverageResult> {
  const coverageSelection = input.coverageSelection;
  const scope = coverageSelection?.scope ?? 'project';
  const coveragePath = join(input.workDir, PHP_COVERAGE_DIR_NAME);
  const xmlPath = join(coveragePath, 'coverage-xml');
  const junitPath = join(coveragePath, 'junit.xml');
  const infectionTmp = join(input.workDir, '.chaos-infection-tmp');
  const phpunit = existsSync(join(input.workDir, 'vendor', 'bin', 'phpunit'))
    ? './vendor/bin/phpunit'
    : 'phpunit';
  try {
    mkdirSync(infectionTmp, { recursive: true });
    mkdirSync(xmlPath, { recursive: true });
    await invokeMutationTool(
      'Infection',
      phpunit,
      [
        '--exclude-source-from-xml-coverage',
        `--coverage-xml=${xmlPath}`,
        `--log-junit=${junitPath}`,
        ...(input.testFrameworkOptions ? splitCommandArgs(input.testFrameworkOptions) : []),
        ...(coverageSelection?.args ?? []),
      ],
      {
        cwd: input.workDir,
        timeoutMs: input.timeoutMs,
        env: {
          ...(input.env ?? process.env),
          TMPDIR: infectionTmp,
          TMP: infectionTmp,
          TEMP: infectionTmp,
          XDEBUG_MODE: 'coverage',
        },
        signal: input.signal,
        executor: input.executor,
      },
    );
    if (coverageSelection) {
      const junit = readFileSync(junitPath, 'utf8');
      const aggregate = junit.match(/<testsuites\b[^>]*>/i)?.[0];
      if (aggregate && /\btests\s*=\s*["']0["']/i.test(aggregate)) {
        throw new Error('coverageTestFrameworkOptions collected zero tests.');
      }
    }
    if (input.key && input.fingerprint) {
      harvestArtefact(input.key, input.fingerprint, coveragePath);
    }
    return { generated: true, scope };
  } catch (error: unknown) {
    try {
      rmSync(coveragePath, { recursive: true, force: true });
    } catch {
      // A failed producer only removes the optimisation.
    }
    if (coverageSelection) {
      throw new Error(
        `PHP coverage selection failed for coverageTestFrameworkOptions: ${diagnosticOf(error)}`,
      );
    }
    return { generated: false, scope: 'project' };
  }
}
