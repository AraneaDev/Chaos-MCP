// Vitest globalSetup. Runs ONCE per `vitest run` / `vitest --watch` invocation
// BEFORE any test file is loaded, in the main process (not a worker).
//
// The setup rebuilds ./build/index.js only when:
//   - the compiled output is missing, OR
//   - any tracked production source (NON-TEST) is newer than build/index.js.
//
// This pins the cli-version / cli-help / cli-smoke baseline failures: those
// tests spawn `node ./build/index.js --version` and assert stdout matches the
// live APP_VERSION. Without an mtime-gated rebuild, a developer who edits
// only test files (no src rebuild) sees the tests fail against a stale
// binary.
//
// StrykerJS skip: when Stryker runs tests once per mutant, this globalSetup
// fires for EVERY mutant (~12 × ~10 s = ~2 min of pure overhead, and
// `build/index.js` is irrelevant under Stryker since vitest tests inherit
// mutated source via vitest's transformer). StrykerJS exposes its presence via
// env vars — `STRYKER_MUTANT_*` under the vitest-runner and
// `__STRYKER_ACTIVE_MUTANT__` under the command runner — so we short-circuit on
// any env key containing `STRYKER` to cover both runners.

import { statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const OUTPUT = './build/index.js';
// Exclusion pathspec for git ls-files — we want to enumerate the COMPILE
// INPUT set (every .ts that tsc emits), NOT test files whose edits shouldn't
// force a rebuild. Using `git ls-files` with a literal exclude glob:
const SOURCE_GLOB = ['src/**/*.ts', ':!src/__tests__/**', ':!**/*.test.ts'];

function rebuild(reason: string): void {
  // Windows installs `npm` as a `npm.cmd` shim, which execFileSync cannot run
  // directly (ENOENT on 'npm', EINVAL on 'npm.cmd' without a shell). Select the
  // `.cmd` name and route through a shell on win32 so the rebuild stays
  // cross-platform for Windows contributors.
  const isWindows = process.platform === 'win32';
  execFileSync(isWindows ? 'npm.cmd' : 'npm', ['run', 'build'], {
    stdio: 'inherit',
    shell: isWindows,
  });
  console.log(`[vitest global-setup] ${reason} - ran npm run build.`);
}

async function globalSetup(): Promise<void> {
  // Stryker skip: process.env is populated BEFORE vitest forks workers, so
  // this guard fires once per Stryker mutant-test invocation and avoids
  // hundreds of wasted rebuild cycles during a mutation run.
  if (Object.keys(process.env).some((k) => k.includes('STRYKER'))) {
    return;
  }

  if (!existsSync(OUTPUT)) {
    rebuild(`build/${OUTPUT} missing`);
    return;
  }

  let inputs: string[];
  try {
    const out = execFileSync('git', ['ls-files', ...SOURCE_GLOB], {
      encoding: 'utf8',
    }).trim();
    inputs = out.split('\n').filter(Boolean);
  } catch {
    // No git on this runner (archive download) - let cli-* tests throw
    // inside `beforeAll` so the failure is loud rather than silent.
    return;
  }

  const outputMtime = statSync(OUTPUT).mtimeMs;
  for (const f of inputs) {
    if (!existsSync(f)) continue;
    if (statSync(f).mtimeMs > outputMtime) {
      rebuild(`${f} is newer than ${OUTPUT}`);
      return;
    }
  }
}

export default globalSetup;
