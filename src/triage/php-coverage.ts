import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionSession } from '../utils/execution.js';
import { invokeMutationTool } from '../utils/exec-classify.js';
import { harvestArtefact, type ReuseKey } from '../utils/reuse/store.js';

export const PHP_COVERAGE_DIR_NAME = '.chaos-infection-coverage';

export interface PhpCoverageInput {
  workDir: string;
  key: ReuseKey;
  fingerprint: string;
  timeoutMs: number;
  signal?: AbortSignal;
  executor?: ExecutionSession;
}

/** Generate and persist the project-wide PHPUnit coverage used by PHP audits. */
export async function producePhpCoverage(input: PhpCoverageInput): Promise<boolean> {
  const coveragePath = join(input.workDir, PHP_COVERAGE_DIR_NAME);
  const xmlPath = join(coveragePath, 'coverage-xml');
  const phpunit = existsSync(join(input.workDir, 'vendor', 'bin', 'phpunit'))
    ? './vendor/bin/phpunit'
    : 'phpunit';
  try {
    mkdirSync(xmlPath, { recursive: true });
    await invokeMutationTool(
      'Infection',
      phpunit,
      [`--coverage-xml=${xmlPath}`, `--log-junit=${join(coveragePath, 'junit.xml')}`],
      {
        cwd: input.workDir,
        timeoutMs: input.timeoutMs,
        env: { ...process.env, XDEBUG_MODE: 'coverage' },
        signal: input.signal,
        executor: input.executor,
      },
    );
    harvestArtefact(input.key, input.fingerprint, coveragePath);
    return true;
  } catch {
    try {
      rmSync(coveragePath, { recursive: true, force: true });
    } catch {
      // A failed producer only removes the optimisation.
    }
    return false;
  }
}
