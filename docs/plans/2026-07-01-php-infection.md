# Add PHP Support via Infection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PHP as a fourth first-class supported language backed by the Infection mutation-testing framework, mirroring the existing three engines, with a green `npm run check`.

**Architecture:** Grow the mirror image of the Go removal. First land two decoupled, self-contained pieces that compile green on their own — the `PhpEngine` (with `'Infection'` added to `ExecutableTool`) and the `infection` config section. Then perform the coupled "union grow" core: adding `'php'` to `ProjectType` and `'infection'` to the registry `configKey` union forces the compiler to flag every `Record<SupportedProjectType>` and `cfg[configKey]` site, which we satisfy in one commit (detector, registry, resources, config-to-RunOptions wiring, heuristic, per-language switches). A `.php → php` regression test and the 3→4 enumeration updates lock it in. Finally an opt-in E2E fixture and the living-docs restoration.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, ESLint + Prettier. External tool: [Infection](https://infection.github.io/) (PHP), invoked as a subprocess. Spec: `docs/specs/2026-07-01-php-infection-design.md`.

## Global Constraints

- **Gate:** `npm run check` (build → lint → format:check → test) must pass. Build first — `npm test` imports from `build/`.
- **ESM:** every relative import ends in `.js` even though the source is `.ts`.
- **Coarse engine:** PHP is `supportsLineScope: false`; it gets the same whole-file `scopeNote` path as Python/Rust. No line/diff scoping.
- **Config section key is `infection`** (matches the tool-named `stryker`/`cosmicray`).
- **Coverage driver (Xdebug or PCOV) is a documented prerequisite, never auto-installed.** No auto-prebuild for PHP.
- **README keeps the "4 languages" headline** (it already says 4 from the Go-removal interim); this plan restores the PHP detail rows.
- **Do NOT edit** any dated file under `docs/specs/`, `docs/plans/`, or `docs/superpowers/` except this plan's own checkboxes — they are historical records.
- **Preserve audit-tag comments** (`C2`, `H5`, `Med#10`, `A2`/`A3`, etc.) on any line you touch.
- Commits follow Conventional Commits. Work on branch `php-infection-support` (already created).
- **Infection CLI/JSON specifics that vary by version** — the `--threads=max` acceptance, the `--test-framework-options` flag name, and the JSON-log field names — are pinned to the documented current format in the unit tests; the opt-in E2E in Task 4 is the reality check that reconciles them against the installed Infection. If Task 4 reveals a mismatch, adjust the constants/flags in `php.ts` (not the tests' intent).

---

### Task 1: PhpEngine + `Infection` executable tool

The substantive new engine, written and unit-tested standalone before it is wired into the registry (Task 3). It shells out to Infection and parses Infection's JSON log. Adding `'Infection'` to `ExecutableTool` is a small, green-on-its-own change the engine depends on.

**Files:**
- Modify: `src/utils/exec-classify.ts` (`ExecutableTool` union ~8; `INSTALL_HINTS` ~36-41)
- Create: `src/engines/php.ts`
- Test: `src/__tests__/php-engine.test.ts`

**Interfaces:**
- Consumes: `BaseEngine`, `RunOptions`, `MutationResult`, `Vulnerability` from `./base.js`; `invokeMutationTool` from `../utils/exec-classify.js`; `log`/`isVerbose` from `../utils/logger.js`.
- Produces: `export class PhpEngine extends BaseEngine` with `run(filePath, options?)`; `export function parseInfectionJsonLog(logText: string, filePath: string): MutationResult`; `export function buildInfectionConfig(sourceDir: string, jsonLogName: string): string`; `export function inferSourceDir(filePath: string): string`. `ExecutableTool` gains `'Infection'`. `RunOptions.phpThreads?`/`phpTestFrameworkOptions?` are consumed here but ADDED in Task 3 — until then the engine reads them via optional chaining on the existing `RunOptions`, so Task 3 only needs to add the two optional fields (no signature change here).

- [ ] **Step 1: Add `Infection` to `ExecutableTool` + install hint**

In `src/utils/exec-classify.ts`, change the union (currently 3 members):

```typescript
export type ExecutableTool = 'StrykerJS' | 'cosmic-ray' | 'cargo-mutants' | 'Infection';
```

Add the matching `INSTALL_HINTS` entry (the `Record<ExecutableTool, string>` now requires it):

```typescript
const INSTALL_HINTS: Record<ExecutableTool, string> = {
  StrykerJS: 'npm install --save-dev @stryker-mutator/core',
  'cosmic-ray': 'pipx install cosmic-ray (or: pip install cosmic-ray in a virtualenv)',
  'cargo-mutants': 'cargo install cargo-mutants',
  Infection:
    'composer require --dev infection/infection (also enable a coverage driver: Xdebug or PCOV)',
};
```

- [ ] **Step 2: Build to confirm the union change compiles green**

Run: `npm run build`
Expected: PASS (adding a member to `ExecutableTool` + its `INSTALL_HINTS` entry is self-contained).

- [ ] **Step 3: Write the failing engine unit tests**

Create `src/__tests__/php-engine.test.ts`. These mock `invokeMutationTool` and the filesystem, mirroring the Rust/Python engine tests. The JSON-log sample matches Infection's documented `--logger-json` shape.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/exec-classify.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/exec-classify.js')>(
    '../utils/exec-classify.js',
  );
  return { ...actual, invokeMutationTool: vi.fn() };
});
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: vi.fn(), writeFileSync: vi.fn(), readFileSync: vi.fn() };
});

import { existsSync, writeFileSync, readFileSync } from 'fs';
import { invokeMutationTool, MutationToolStartupError } from '../utils/exec-classify.js';
import { ExecFailureError } from '../utils/exec.js';
import {
  PhpEngine,
  parseInfectionJsonLog,
  buildInfectionConfig,
  inferSourceDir,
} from '../engines/php.js';

const mockInvoke = vi.mocked(invokeMutationTool);
const mockExists = vi.mocked(existsSync);
const mockWrite = vi.mocked(writeFileSync);
const mockRead = vi.mocked(readFileSync);

// A minimal Infection JSON log: 3 killed, 1 timed-out, 1 escaped → killed 4, survived 1.
const SAMPLE_LOG = JSON.stringify({
  stats: { totalMutantsCount: 5, killedCount: 3, escapedCount: 1, timeOutCount: 1 },
  escaped: [
    {
      mutator: { mutatorName: 'GreaterThan', originalFilePath: 'src/Calculator.php', originalStartLine: 12 },
      diff: '--- Original\n+++ New\n@@ @@\n- return $a > $b;\n+ return $a >= $b;',
    },
  ],
  killed: [{}, {}, {}],
  timeouted: [{}],
});

beforeEach(() => {
  vi.clearAllMocks();
  mockExists.mockReturnValue(false);
  mockWrite.mockReturnValue(undefined);
});

describe('inferSourceDir', () => {
  it('returns the top path segment', () => {
    expect(inferSourceDir('src/Calculator.php')).toBe('src');
    expect(inferSourceDir('app/Service/Math.php')).toBe('app');
  });
  it('returns "." for a bare filename', () => {
    expect(inferSourceDir('Calculator.php')).toBe('.');
  });
});

describe('buildInfectionConfig', () => {
  it('generates minimal phpunit config with the json log path', () => {
    const cfg = JSON.parse(buildInfectionConfig('src', 'chaos-infection-log.json'));
    expect(cfg.source.directories).toEqual(['src']);
    expect(cfg.testFramework).toBe('phpunit');
    expect(cfg.logs.json).toBe('chaos-infection-log.json');
  });
});

describe('parseInfectionJsonLog', () => {
  it('maps escaped→survivors, timed-out→killed, and computes killed/(killed+survived)', () => {
    const r = parseInfectionJsonLog(SAMPLE_LOG, 'src/Calculator.php');
    expect(r.killed).toBe(4); // 3 killed + 1 timed-out
    expect(r.survived).toBe(1);
    expect(r.totalMutants).toBe(5);
    expect(r.mutationScore).toBe('80.00%');
    expect(r.vulnerabilities).toHaveLength(1);
    expect(r.vulnerabilities[0]).toMatchObject({ line: 12, mutator: 'GreaterThan' });
    expect(r.vulnerabilities[0].mutated).toContain('>=');
  });

  it('excludes notCovered/errored from the denominator', () => {
    const log = JSON.stringify({
      stats: { killedCount: 1, escapedCount: 1 },
      escaped: [{ mutator: { mutatorName: 'Plus', originalStartLine: 3 } }],
      killed: [{}],
      notCovered: [{}, {}],
      errored: [{}],
    });
    const r = parseInfectionJsonLog(log, 'src/X.php');
    expect(r.killed).toBe(1);
    expect(r.survived).toBe(1);
    expect(r.totalMutants).toBe(2); // notCovered + errored NOT counted
    expect(r.mutationScore).toBe('50.00%');
  });

  it('returns a clean 100% when there are zero scored mutants', () => {
    const r = parseInfectionJsonLog(JSON.stringify({ stats: {}, escaped: [] }), 'src/X.php');
    expect(r.totalMutants).toBe(0);
    expect(r.mutationScore).toBe('100.00%');
    expect(r.vulnerabilities).toEqual([]);
  });
});

describe('PhpEngine.run', () => {
  it('generates a config when none exists, filters to the file, and parses the log', async () => {
    // existsSync: no infection.json/.json5, no vendor/bin/infection, but the log IS produced.
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const engine = new PhpEngine();
    const result = await engine.run('src/Calculator.php', { workDir: '/sb' });

    // Generated config written (no project config present).
    expect(mockWrite).toHaveBeenCalledWith(
      expect.stringContaining('infection.json'),
      expect.stringContaining('"testFramework"'),
      'utf8',
    );
    // Invoked with --filter scoped to the file and the json logger.
    const [, bin, args] = mockInvoke.mock.calls[0];
    expect(bin).toBe('infection'); // no vendor/bin/infection → global fallback
    expect(args).toContain('--filter=src/Calculator.php');
    expect(args).toContain('--logger-json=chaos-infection-log.json');
    expect(args).toContain('--no-progress');
    expect(args).toContain('--no-interaction');
    expect(result.survived).toBe(1);
  });

  it('does NOT overwrite an existing project infection.json and prefers vendor/bin/infection', async () => {
    mockExists.mockImplementation((p) => {
      const s = String(p);
      return (
        s.endsWith('infection.json') ||
        s.endsWith('vendor/bin/infection') ||
        s.endsWith('chaos-infection-log.json')
      );
    });
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const engine = new PhpEngine();
    await engine.run('src/Calculator.php', { workDir: '/sb' });

    expect(mockWrite).not.toHaveBeenCalled(); // project config respected
    const [, bin] = mockInvoke.mock.calls[0];
    expect(String(bin)).toContain('vendor/bin/infection');
  });

  it('parses the log even when Infection exits non-zero (mutants escaped)', async () => {
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockRejectedValue(
      new ExecFailureError(
        { stdout: '', stderr: 'MSI below threshold', exit: 1, signal: null, code: undefined },
        'nonzero',
      ),
    );

    const engine = new PhpEngine();
    const result = await engine.run('src/Calculator.php', { workDir: '/sb' });
    expect(result.survived).toBe(1);
  });

  it('throws a coverage-driver hint when no JSON log is produced', async () => {
    mockExists.mockReturnValue(false); // no log file ever appears
    mockInvoke.mockRejectedValue(
      new ExecFailureError(
        { stdout: '', stderr: 'No code coverage driver found', exit: 1, signal: null, code: undefined },
        'nonzero',
      ),
    );

    const engine = new PhpEngine();
    await expect(engine.run('src/Calculator.php', { workDir: '/sb' })).rejects.toThrow(
      /Xdebug or PCOV/,
    );
  });

  it('rethrows the install hint when the binary is missing', async () => {
    mockExists.mockReturnValue(false);
    mockInvoke.mockRejectedValue(new MutationToolStartupError('Infection', 'Infection is not installed. Install it with: composer require --dev infection/infection'));

    const engine = new PhpEngine();
    await expect(engine.run('src/Calculator.php', { workDir: '/sb' })).rejects.toThrow(
      /composer require --dev infection\/infection/,
    );
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm run build && npx vitest run src/__tests__/php-engine.test.ts`
Expected: FAIL — `../engines/php.js` does not exist yet.

- [ ] **Step 5: Implement `src/engines/php.ts`**

```typescript
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BaseEngine, RunOptions, MutationResult, Vulnerability } from './base.js';
import { invokeMutationTool } from '../utils/exec-classify.js';
import { log, isVerbose } from '../utils/logger.js';

/** Default timeout for the whole Infection run (5 minutes). */
const DEFAULT_TIMEOUT_MS = 300_000;
/** Name of the config we generate when the project ships none. */
const GENERATED_CONFIG_NAME = 'infection.json';
/** Config files Infection already recognises — if present, we do NOT overwrite. */
const PROJECT_CONFIG_NAMES = ['infection.json', 'infection.json5'];
/** Sandbox-relative JSON log path we always read results from. */
const JSON_LOG_NAME = 'chaos-infection-log.json';

/** Top path segment of a workspace-relative file, used as the generated `source.directories` root. */
export function inferSourceDir(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/');
  const slash = norm.indexOf('/');
  return slash > 0 ? norm.slice(0, slash) : '.';
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

/** One mutant entry in Infection's JSON log. */
interface InfectionMutant {
  mutator?: { mutatorName?: string; originalFilePath?: string; originalStartLine?: number };
  diff?: string;
}
interface InfectionJsonLog {
  stats?: {
    totalMutantsCount?: number;
    killedCount?: number;
    escapedCount?: number;
    timeOutCount?: number;
    timedOutCount?: number;
  };
  escaped?: InfectionMutant[];
  killed?: InfectionMutant[];
  timeouted?: InfectionMutant[];
  timedOut?: InfectionMutant[];
}

/**
 * Parse Infection's `--logger-json` output into a MutationResult.
 *
 * Consistent with the Python/Rust engines: the denominator is `killed + survived`
 * only. `escaped` mutants are the reported survivors (real coverage gaps).
 * Timed-out mutants are counted as killed (the suite detected them by hanging).
 * `notCovered`/`errored` are excluded from the score entirely (missing coverage or
 * a crashed mutation — not a scored pass/fail), mirroring how the Python engine
 * drops `incompetent`.
 *
 * Field names read defensively (stats when present, array lengths as fallback;
 * `timeOutCount`/`timedOutCount` and `timeouted`/`timedOut` both tolerated) so a
 * minor Infection version bump does not silently zero the count. The E2E in
 * Task 4 is the reality check.
 */
export function parseInfectionJsonLog(logText: string, filePath: string): MutationResult {
  let parsed: InfectionJsonLog;
  try {
    parsed = JSON.parse(logText) as InfectionJsonLog;
  } catch {
    return blankResult(filePath);
  }

  const escaped = Array.isArray(parsed.escaped) ? parsed.escaped : [];
  const killedArr = Array.isArray(parsed.killed) ? parsed.killed : [];
  const timedOutArr = Array.isArray(parsed.timeouted)
    ? parsed.timeouted
    : Array.isArray(parsed.timedOut)
      ? parsed.timedOut
      : [];

  const stats = parsed.stats ?? {};
  const survived = stats.escapedCount ?? escaped.length;
  const timeouts = stats.timeOutCount ?? stats.timedOutCount ?? timedOutArr.length;
  const killed = (stats.killedCount ?? killedArr.length) + timeouts;
  const totalMutants = killed + survived;

  const vulnerabilities: Vulnerability[] = escaped.map((e) => {
    const line = e.mutator?.originalStartLine ?? 0;
    const mutator = e.mutator?.mutatorName ?? 'PHP Mutation Operator';
    const vuln: Vulnerability = {
      line,
      mutator,
      description: `Mutation survived at line ${line}. The PHP test suite did not catch this change.`,
    };
    if (e.diff) vuln.mutated = e.diff.trim();
    return vuln;
  });

  const score = totalMutants > 0 ? ((killed / totalMutants) * 100).toFixed(2) : '100.00';
  return {
    target: filePath,
    totalMutants,
    killed,
    survived,
    mutationScore: `${score}%`,
    vulnerabilities,
  };
}

function blankResult(filePath: string): MutationResult {
  return {
    target: filePath,
    totalMutants: 0,
    killed: 0,
    survived: 0,
    mutationScore: '100.00%',
    vulnerabilities: [],
  };
}

/**
 * Mutation testing engine for PHP files, backed by the Infection CLI.
 *
 * Flow (inside the sandbox `workDir`): hybrid config (use the project's
 * infection.json/.json5 if present, else write a minimal one) → run
 * `infection --filter=<file> --logger-json=<tmp> --no-progress --no-interaction
 * --threads=<n|max>` → read + parse the JSON log.
 *
 * Coarse: no line scoping (`supportsLineScope: false`). Requires a coverage
 * driver (Xdebug or PCOV); a missing driver surfaces as the baseline error below.
 */
export class PhpEngine extends BaseEngine {
  async run(filePath: string, options?: RunOptions): Promise<MutationResult> {
    const cwd = options?.workDir ?? process.cwd();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const jsonLogPath = join(cwd, JSON_LOG_NAME);

    // Hybrid config: only generate when the project ships none.
    const hasProjectConfig = PROJECT_CONFIG_NAMES.some((n) => existsSync(join(cwd, n)));
    if (!hasProjectConfig) {
      try {
        writeFileSync(
          join(cwd, GENERATED_CONFIG_NAME),
          buildInfectionConfig(inferSourceDir(filePath), JSON_LOG_NAME),
          'utf8',
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to write generated infection.json: ${message}`);
      }
    }

    // Prefer the vendored binary; fall back to a global `infection` on PATH.
    const vendored = join(cwd, 'vendor', 'bin', 'infection');
    const bin = existsSync(vendored) ? vendored : 'infection';

    const threads =
      options?.phpThreads ?? (options?.concurrency ? String(options.concurrency) : 'max');
    const args = [
      `--filter=${filePath}`,
      `--logger-json=${JSON_LOG_NAME}`,
      '--no-progress',
      '--no-interaction',
      `--threads=${threads}`,
    ];
    if (options?.phpTestFrameworkOptions) {
      args.push(`--test-framework-options=${options.phpTestFrameworkOptions}`);
    }

    if (isVerbose()) log(`PhpEngine: ${bin} ${args.join(' ')}`);

    let stderr = '';
    try {
      const res = await invokeMutationTool('Infection', bin, args, {
        cwd,
        timeoutMs,
        signal: options?.signal,
      });
      stderr = res.stderr;
    } catch (error: unknown) {
      // Startup failures (missing binary/timeout/crash) rethrow via toExecFailure.
      const execErr = this.toExecFailure(error, 'Infection');
      stderr = execErr.stderr;
      // Infection exits non-zero when mutants escape (MSI below threshold). That
      // is the normal survivors case AS LONG AS the JSON log was produced. If no
      // log exists, the initial (coverage) run failed — surface the likely cause.
      if (!existsSync(jsonLogPath)) {
        throw new Error(
          `Infection failed (exit ${execErr.exit}) without producing a JSON log. This usually means ` +
            `the initial test run failed — ensure the PHPUnit suite passes (vendor/bin/phpunit) and a ` +
            `coverage driver (Xdebug or PCOV) is enabled. stderr: ${execErr.stderr?.slice(0, 500) ?? ''}`,
        );
      }
    }

    if (isVerbose() && stderr) log(`Infection stderr: ${stderr.slice(0, 500)}`);

    let logText: string;
    try {
      logText = readFileSync(jsonLogPath, 'utf8');
    } catch {
      throw new Error(
        `Infection produced no readable JSON log at ${JSON_LOG_NAME}. Ensure a coverage driver ` +
          `(Xdebug or PCOV) is enabled and the PHPUnit suite runs from the project root.`,
      );
    }

    return parseInfectionJsonLog(logText, filePath);
  }
}
```

- [ ] **Step 6: Run the engine tests to verify they pass**

Run: `npm run build && npx vitest run src/__tests__/php-engine.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 7: Commit**

```bash
git add src/utils/exec-classify.ts src/engines/php.ts src/__tests__/php-engine.test.ts
git commit -m "feat(php): add Infection-backed PhpEngine (unwired) + Infection executable tool"
```

---

### Task 2: The `infection` config section

Self-contained: adds a new optional config section parsed and validated like the existing `rust`/`cosmicray` sections. Compiles green independent of the union grow.

**Files:**
- Modify: `src/utils/config-loader.ts` (`KNOWN_KEYS` ~7-25; add `InfectionConfig` interface + `KNOWN_INFECTION_KEYS`; `ChaosConfig` interface + doc-comment ~108-169; `ENGINE_CONFIG_SECTIONS` key union + array ~280-288; add `parseInfectionConfig`)
- Test: `src/__tests__/config-loader.test.ts`

**Interfaces:**
- Consumes: `ChaosConfig`, `validateConfig`, `loadConfig` — signatures unchanged.
- Produces: `export interface InfectionConfig { timeoutMs?: number; threads?: number | 'max'; testFrameworkOptions?: string }`; `ChaosConfig.infection?: InfectionConfig`; `ENGINE_CONFIG_SECTIONS` `key` union becomes `'stryker' | 'cosmicray' | 'rust' | 'infection'`. Task 3 relies on `cfg.infection?.timeoutMs`/`.threads`/`.testFrameworkOptions`.

- [ ] **Step 1: Write the failing config tests**

Add to `src/__tests__/config-loader.test.ts` (reuse the file's existing `loadConfig`/`validateConfig` mock-fs setup — copy the pattern from the neighbouring `rust`/`cosmicray` section tests):

```typescript
describe('infection config section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it('parses a valid infection section (timeoutMs, threads, testFrameworkOptions)', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        infection: { timeoutMs: 120000, threads: 4, testFrameworkOptions: '--testsuite=unit' },
      }),
    );
    const config = loadConfig('/tmp/config.json');
    expect(config.infection).toEqual({
      timeoutMs: 120000,
      threads: 4,
      testFrameworkOptions: '--testsuite=unit',
    });
  });

  it('accepts threads: "max"', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ infection: { threads: 'max' } }));
    expect(loadConfig('/tmp/config.json').infection).toEqual({ threads: 'max' });
  });

  it('drops an all-invalid infection section and warns', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ infection: { timeoutMs: -1 } }));
    const { config, warnings } = validateConfig('/tmp/config.json');
    expect(config.infection).toBeUndefined();
    expect(warnings.some((w) => w.includes('infection'))).toBe(true);
  });

  it('warns on an unknown key inside the infection section', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ infection: { timeoutMs: 1000, bogus: true } }),
    );
    const { warnings } = validateConfig('/tmp/config.json');
    expect(warnings.some((w) => w.includes('"bogus"') && w.includes('infection'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run build && npx vitest run src/__tests__/config-loader.test.ts -t infection`
Expected: FAIL — `infection` is an unknown key; `config.infection` is undefined.

- [ ] **Step 3: Add `infection` to the known top-level keys**

In `src/utils/config-loader.ts`, in the `KNOWN_KEYS` set, add `'infection'` after `'rust'`:

```typescript
  'stryker',
  'cosmicray',
  'rust',
  'infection',
]);
```

- [ ] **Step 4: Add the known section keys + `InfectionConfig` interface**

After the `KNOWN_RUST_KEYS` line, add:

```typescript
/** Valid keys within an InfectionConfig section. */
const KNOWN_INFECTION_KEYS = new Set(['timeoutMs', 'threads', 'testFrameworkOptions']);
```

After the `CargoMutantsConfig` interface, add:

```typescript
/**
 * Infection (PHP)-specific config overrides.
 */
export interface InfectionConfig {
  /** Timeout override for the whole Infection run (ms). */
  timeoutMs?: number;
  /** Worker count passed to Infection's `--threads` (positive integer, or "max"). */
  threads?: number | 'max';
  /** Extra options forwarded to the PHP test framework (e.g. "--testsuite=unit"). */
  testFrameworkOptions?: string;
}
```

- [ ] **Step 5: Add `ChaosConfig.infection` + update its doc-comment**

In the `ChaosConfig` doc-comment, change `Engine-specific sections (\`stryker\`, \`cosmicray\`, \`rust\`)` to `(\`stryker\`, \`cosmicray\`, \`rust\`, \`infection\`)`. Then, after the `rust?: CargoMutantsConfig;` property, add:

```typescript
  /** Infection (PHP)-specific overrides (precedence over global defaults). */
  infection?: InfectionConfig;
```

- [ ] **Step 6: Add the `parseInfectionConfig` parser**

After `parseTimeoutOnlyConfig`, add:

```typescript
function parseInfectionConfig(raw: unknown): InfectionConfig | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  const result: InfectionConfig = {};
  let hasAny = false;

  if (typeof s.timeoutMs === 'number' && s.timeoutMs > 0) {
    result.timeoutMs = s.timeoutMs;
    hasAny = true;
  }
  if (s.threads === 'max') {
    result.threads = 'max';
    hasAny = true;
  } else if (typeof s.threads === 'number' && Number.isInteger(s.threads) && s.threads >= 1) {
    result.threads = s.threads;
    hasAny = true;
  }
  if (typeof s.testFrameworkOptions === 'string' && s.testFrameworkOptions.length > 0) {
    result.testFrameworkOptions = s.testFrameworkOptions;
    hasAny = true;
  }

  return hasAny ? result : undefined;
}
```

- [ ] **Step 7: Register the section in `ENGINE_CONFIG_SECTIONS`**

Change the `key` union type and append the entry:

```typescript
const ENGINE_CONFIG_SECTIONS: {
  key: 'stryker' | 'cosmicray' | 'rust' | 'infection';
  knownKeys: Set<string>;
  parse: (raw: unknown) => object | undefined;
}[] = [
  { key: 'stryker', knownKeys: KNOWN_STRYKER_KEYS, parse: parseStrykerConfig },
  { key: 'cosmicray', knownKeys: KNOWN_COSMICRAY_KEYS, parse: parseCosmicRayConfig },
  { key: 'rust', knownKeys: KNOWN_RUST_KEYS, parse: parseTimeoutOnlyConfig },
  { key: 'infection', knownKeys: KNOWN_INFECTION_KEYS, parse: parseInfectionConfig },
];
```

- [ ] **Step 8: Run the config tests**

Run: `npm run build && npx vitest run src/__tests__/config-loader.test.ts`
Expected: PASS, including the new `infection` cases. (If a pre-existing "all known keys" hardening fixture enumerates every top-level key, add `infection` to it so it stays exhaustive.)

- [ ] **Step 9: Commit**

```bash
git add src/utils/config-loader.ts src/__tests__/config-loader.test.ts
git commit -m "feat(config): add infection (PHP) config section"
```

---

### Task 3: Core wiring — grow the unions and register PHP end-to-end

The irreducible coupled task (mirror of the Go-removal's core task). Adding `'php'` to `ProjectType` and `'infection'` to the registry `configKey` union makes `tsc` flag every `Record<SupportedProjectType>` literal and `cfg[configKey]` site; satisfy each. Then add the coarse per-language switch cases, the detection entry, the RunOptions→engine wiring, the peripheral strings, the `.php → php` regression test, and the 3→4 enumeration updates. Ends with a green `npm run check`.

**Files:**
- Modify: `src/utils/project-detector.ts` (`ProjectType` ~7; add `PHP_ROOT_MARKERS`; add `detectPhpTestRunner`/`detectRawPhpRunner`; add `LANGUAGE_DETECTORS.php`)
- Modify: `src/engines/registry.ts` (import `PhpEngine`; `configKey` union ~28; add `php` entry)
- Modify: `src/resources.ts` (`ENGINE_NAMES.php`; `configSchemaJson` `infection` key)
- Modify: `src/engines/base.ts` (`RunOptions`: add `phpThreads?`, `phpTestFrameworkOptions?`)
- Modify: `src/handler.ts` (`buildRunOptions` return: wire `phpThreads`/`phpTestFrameworkOptions` from `cfg.infection`; fix the ~496 Go prebuild comment)
- Modify: `src/estimate-heuristic.ts` (`stripNoise`: add `php` to the `#`-comment branch)
- Modify: `src/test-file.ts` (`candidates`: add `case 'php'`)
- Modify: `src/baseline-timing.ts` (`resolveBaselineTestCommand`: add `case 'php'`)
- Modify: `src/triage.ts` (`SUPPORTED_EXT`; `TEST_FILE_RE`)
- Modify: `src/tool-schema.ts` (accepted extensions + engine lists; clean lingering "Go" words)
- Modify: `src/cli.ts` (help text extensions/engine list/links)
- Test: `src/__tests__/project-detector.test.ts`, `registry.test.ts`, `resources.test.ts`, `estimate.test.ts`, `exec-classify.test.ts` (+ any the compiler/suite flags)

**Interfaces:**
- Consumes: `PhpEngine` (Task 1), `InfectionConfig`/`cfg.infection` (Task 2), `ENGINE_REGISTRY`, `ProjectType`, `SupportedProjectType`.
- Produces: `type ProjectType = 'typescript' | 'python' | 'rust' | 'php' | 'unsupported'`; `EngineDescriptor.configKey` union `'stryker' | 'cosmicray' | 'rust' | 'infection'`; `ENGINE_REGISTRY.php = { make: () => new PhpEngine(), configKey: 'infection', supportsLineScope: false }`; `detectProjectType('x.php') === 'php'`; `RunOptions.phpThreads?: string`, `RunOptions.phpTestFrameworkOptions?: string`.

- [ ] **Step 1: Write the `.php → php` regression test first**

Add to `src/__tests__/project-detector.test.ts` (reuse its `detectProjectType`/`detectEnvironment` imports; place beside the existing `.go → unsupported` test):

```typescript
it('detects .php files as php with the phpunit runner', () => {
  expect(detectProjectType('src/Calculator.php')).toBe('php');
  mockExistsSync.mockImplementation((p) => String(p).endsWith('composer.json'));
  const env = detectEnvironment('src/Calculator.php');
  expect(env.projectType).toBe('php');
  expect(env.testRunner).toBe('phpunit');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/project-detector.test.ts -t 'detects .php'`
Expected: FAIL to compile / assert — `'php'` is not yet a `ProjectType` and `.php` currently returns `'unsupported'`.

- [ ] **Step 3: Grow `ProjectType` and add PHP detection**

In `src/utils/project-detector.ts`:

Change the union:

```typescript
export type ProjectType = 'typescript' | 'python' | 'rust' | 'php' | 'unsupported';
```

Add a root-marker constant beside the other markers (e.g. after `RUST_ROOT_MARKERS`):

```typescript
/** Marker files that indicate a PHP project root. */
const PHP_ROOT_MARKERS = ['composer.json'] as const;
```

Add a PHP test-runner detector (PHPUnit-only) — place it beside the Rust detector section:

```typescript
// ─── PHP test runner detection ───────────────────────────────────────────────

/**
 * Detect the PHP test runner. v1 targets PHPUnit only: presence of
 * phpunit.xml / phpunit.xml.dist (or a project-supplied infection.json which
 * carries its own framework) resolves to 'phpunit'. Returns 'phpunit' as the
 * default since Infection defaults to PHPUnit.
 *
 * @internal Exported for testing only.
 */
export function detectPhpTestRunner(_workspaceRoot: string): string {
  return 'phpunit';
}

/**
 * Detect the raw PHP test runner without mapping.
 * @internal Exported for testing only.
 */
export function detectRawPhpRunner(workspaceRoot: string): string {
  return detectPhpTestRunner(workspaceRoot);
}
```

Add the `php` entry to `LANGUAGE_DETECTORS` (the `Record<Exclude<ProjectType,'unsupported'>, ...>` now REQUIRES it — this is the compiler-forced part), after `rust`:

```typescript
  php: {
    matches: (p) => p.endsWith('.php'),
    markers: PHP_ROOT_MARKERS,
    testRunner: detectPhpTestRunner,
    rawRunner: detectRawPhpRunner,
  },
```

- [ ] **Step 4: Register PHP in the engine registry**

In `src/engines/registry.ts`:
- Add `import { PhpEngine } from './php.js';` beside the other engine imports.
- Grow the `configKey` union: `configKey: 'stryker' | 'cosmicray' | 'rust' | 'infection';`
- Add the entry (the `Record<SupportedProjectType, EngineDescriptor>` now REQUIRES it), after `rust`:

```typescript
  php: {
    make: () => new PhpEngine(),
    configKey: 'infection',
    supportsLineScope: false,
  },
```

- [ ] **Step 5: Add PHP to resources**

In `src/resources.ts`:
- Add to `ENGINE_NAMES` (compiler-forced `Record<SupportedProjectType, string>`): `php: 'Infection',`
- Add the config-schema key doc after the `rust` line:

```typescript
    infection: 'object — Infection (PHP)-specific overrides (timeoutMs, threads, testFrameworkOptions).',
```

- [ ] **Step 6: Add the two PHP RunOptions fields**

In `src/engines/base.ts`, in the `RunOptions` interface (after the `pythonExcludeOperators` field), add:

```typescript
  /**
   * Worker count forwarded to Infection's `--threads` (a positive integer as a
   * string, or "max"). Sourced from the `infection` config section.
   *
   * **PHP (Infection) only.**
   */
  phpThreads?: string;

  /**
   * Extra options forwarded to Infection's PHP test framework via
   * `--test-framework-options` (e.g. "--testsuite=unit").
   *
   * **PHP (Infection) only.**
   */
  phpTestFrameworkOptions?: string;
```

- [ ] **Step 7: Wire the PHP config into `buildRunOptions`**

In `src/handler.ts`, in the object returned by `buildRunOptions` (right after the `pythonExcludeOperators: cfg.cosmicray?.excludeOperators,` line), add:

```typescript
    // PHP (Infection) only: worker count + test-framework passthrough, sourced
    // from the infection config section; ignored by the other engines.
    phpThreads: cfg.infection?.threads !== undefined ? String(cfg.infection.threads) : undefined,
    phpTestFrameworkOptions: cfg.infection?.testFrameworkOptions,
```

Also fix the stale Go straggler comment at ~line 496: change `// rebuild can pass an explicit prebuildCommand. Go (\`go mod download\`) and` / `// Rust (\`cargo check\`) declare their auto-prebuild in the engine registry.` to reference only Rust:

```typescript
  // rebuild can pass an explicit prebuildCommand. Rust (`cargo check`) declares
  // its auto-prebuild in the engine registry. (PHP has none — Infection needs no build.)
```

- [ ] **Step 8: Add PHP to the coarse per-language switches + heuristic**

In `src/estimate-heuristic.ts`, `stripNoise`: PHP uses `#` line comments (like Python) in addition to C-family `//` and `/* */`. Change the python-only `#` branch to also cover PHP:

```typescript
  if (projectType === 'python') {
    s = s.replace(/'''[\s\S]*?'''/g, ' ').replace(/"""[\s\S]*?"""/g, ' ');
    s = s.replace(/#[^\n]*/g, ' ');
  } else {
    s = s.replace(/\/\/[^\n]*/g, ' ');
    // PHP also supports `#` line comments (and `#[Attr]` attributes, dropped as
    // comments — acceptable for an approximate estimate).
    if (projectType === 'php') s = s.replace(/#[^\n]*/g, ' ');
  }
```

In `src/test-file.ts`, `candidates`, add before `default:` (PHPUnit convention is `ClassNameTest.php` under `tests/`):

```typescript
    case 'php': {
      // PHPUnit convention: <ClassName>Test.php, conventionally under tests/.
      const cap = base.charAt(0).toUpperCase() + base.slice(1);
      return [j(dir, `${base}Test.php`), j('tests', `${cap}Test.php`), j('tests', `${base}Test.php`)];
    }
```

In `src/baseline-timing.ts`, `resolveBaselineTestCommand`, add before `default:`:

```typescript
    case 'php':
      return { command: 'vendor/bin/phpunit', args: [] };
```

- [ ] **Step 9: Add `.php` to triage discovery**

In `src/triage.ts`:
- `const SUPPORTED_EXT = ['.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.php'];`
- `TEST_FILE_RE` — add the PHPUnit `*Test.php` test-file pattern so triage skips PHP tests:

```typescript
const TEST_FILE_RE = /(\.test\.|\.spec\.|_test\.(py|rs)$|(^|\/)test_[^/]*\.py$|Test\.php$)/;
```

- [ ] **Step 10: Update tool-schema + CLI copy (add PHP; clean lingering "Go" words)**

In `src/tool-schema.ts` (these strings still name Go from the incomplete Go removal — fix while adding PHP):
- Main `description` (~12): `'...Python (cosmic-ray), and Rust (cargo-mutants).'` → `'...Python (cosmic-ray), Rust (cargo-mutants), and PHP (Infection).'`
- `filePath` description (~20): `'Must end in .ts, .js, .tsx, .jsx, .py, or .rs. '` → `'Must end in .ts, .js, .tsx, .jsx, .py, .rs, or .php. '`
- `lineScope` description (~33): `'...ignored for Python, Go, and Rust targets. '` → `'...ignored for Python, Rust, and PHP targets. '`
- `prebuildCommand` description (~104): change `'Essential for TypeScript projects ("npm run build"), Go projects ("go build ./..."), '` + `'and Rust projects ("cargo build"). '` → `'Essential for TypeScript projects ("npm run build") and Rust projects ("cargo build"). '`
- `diffBase` description (~125): `'Line-level scoping is StrykerJS-only; Go/Python/Rust targets run whole-file with a note. '` → `'Line-level scoping is StrykerJS-only; Python/Rust/PHP targets run whole-file with a note. '`
- `enrich` description (~185): `'Richest for TypeScript and Go; Python reports severity "unknown".'` → `'Richest for TypeScript; Python and PHP report severity "unknown".'`
- `TRIAGE_TOOL_DEFINITION` description (~253): `'(.ts/.js/.py/.rs)'` → `'(.ts/.js/.py/.rs/.php)'`
- `ESTIMATE_TOOL_DEFINITION` description (~366): `'a source heuristic for TS/JS/Python/Go, labeled'` → `'a source heuristic for TS/JS/Python/PHP, labeled'`

In `src/cli.ts`:
- Description (~46-47): `'It supports TypeScript/JavaScript (via StrykerJS), Python (via cosmic-ray),'` / `'and Rust (via cargo-mutants).'` → `'...Python (via cosmic-ray), Rust (via cargo-mutants), and PHP (via Infection).'`
- Engine-sections line (~57): `'Engine-specific sections ("stryker", "cosmicray", "rust") override the'` → `'...("stryker", "cosmicray", "rust", "infection") override the'`
- `filePath (required)` line (~65): `(.ts/.js/.py/.rs)` → `(.ts/.js/.py/.rs/.php)`
- Links (~88): add `  https://infection.github.io` after the cargo-mutants link.

- [ ] **Step 11: Build — let the compiler name every straggler**

Run: `npm run build`
Expected: may FAIL initially. Fix each error by adding the required PHP branch/entry the compiler points at (any remaining `Record<SupportedProjectType>` literal, or a `cfg[configKey]` access). Re-run until clean.

- [ ] **Step 12: Update the enumeration + detection tests (3→4)**

Run `npm test` and fix the flagged suites. Known edits:

`src/__tests__/registry.test.ts` — grow back to four:
```typescript
  it('exposes exactly the four supported languages', () => {
    expect(Object.keys(ENGINE_REGISTRY).sort()).toEqual(['php', 'python', 'rust', 'typescript']);
  });
```
Add `expect(ENGINE_REGISTRY.php.configKey).toBe('infection');`, `expect(ENGINE_REGISTRY.php.make()).toBeInstanceOf(PhpEngine);` (import `PhpEngine`), `expect(ENGINE_REGISTRY.php.supportsLineScope).toBe(false);`, and `expect(ENGINE_REGISTRY.php.prebuild).toBeUndefined();`.

`src/__tests__/resources.test.ts` — in the languages-JSON test add `expect(data.php.supportsLineScope).toBe(false);` and `expect(data.php.engine).toBe('Infection');` (the `Object.keys(data)` vs `ENGINE_REGISTRY` equality already covers the count).

`src/__tests__/project-detector.test.ts` — the `.php` regression test from Step 1 now passes; if there is a root-marker `it.each` table (rows like `['/repo/src/a.rs', 'Cargo.toml']`), add `['/repo/src/a.php', 'composer.json']`.

`src/__tests__/estimate.test.ts` — add `expect(estimateNeedsSandbox('php', false)).toBe(false);` to the sandbox test.

`src/__tests__/exec-classify.test.ts` — add an install-hint test mirroring the cargo-mutants one:
```typescript
  it('throws MutationToolStartupError with install hint for Infection ENOENT', async () => {
    const enoentError = new ExecFailureError(
      { stdout: '', stderr: '', exit: null, signal: null, code: 'ENOENT' },
      'Command not found',
    );
    mockRunShell.mockRejectedValue(enoentError);
    await expect(invokeMutationTool('Infection', 'infection', [])).rejects.toThrow(
      /composer require --dev infection\/infection/,
    );
  });
```

Re-run `npm test` until green. The `.php → php` regression test must pass.

- [ ] **Step 13: Full gate**

Run: `npm run check`
Expected: PASS (build, lint, format:check, test all green). Then confirm no stray Go words remain in the files you touched: `grep -rin "\bGo\b\|go build\|go-mutesting" src/tool-schema.ts src/cli.ts src/handler.ts` returns nothing.

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "feat(php): register PHP/Infection engine end-to-end (.php now supported)"
```

---

### Task 4: Opt-in E2E fixture (real Infection)

A single heavy test behind `E2E_PHP=1`, mirroring `e2e-rust.test.ts`. Off in the default gate. This is the reality check for the JSON-log field names and CLI flags pinned in Task 1.

**Files:**
- Create: `src/__tests__/e2e-php.test.ts`

**Interfaces:**
- Consumes: `PhpEngine` from `../engines/php.js`.
- Produces: nothing importable; a gated integration test.

- [ ] **Step 1: Write the gated E2E test with a bundled fixture**

Create `src/__tests__/e2e-php.test.ts` (mirror the `e2e-rust.test.ts` structure: env gate, toolchain detection, loud canary, heavy test):

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { PhpEngine } from '../engines/php.js';

/**
 * End-to-end Infection test against a tiny PHP + PHPUnit fixture.
 * Run with `E2E_PHP=1 npm test`. Otherwise it silently skips.
 *
 * Prerequisites: php, composer, a coverage driver (Xdebug or PCOV),
 * and `composer require --dev infection/infection phpunit/phpunit` in the fixture.
 */
const E2E_PHP_ENABLED = process.env.E2E_PHP === '1';

function detectPhp(): { available: boolean; reason: string } {
  const php = spawnSync('php', ['--version'], { stdio: 'pipe', timeout: 5000 });
  if (php.status !== 0) return { available: false, reason: 'php not found' };
  const composer = spawnSync('composer', ['--version'], { stdio: 'pipe', timeout: 5000 });
  if (composer.status !== 0) return { available: false, reason: 'composer not found' };
  return { available: true, reason: '' };
}

const phpDetect = detectPhp();
const it_canary = it;
const it_heavy = E2E_PHP_ENABLED && phpDetect.available ? it : it.skip;

interface PhpFixture {
  rootDir: string;
  remove: () => void;
}

function createPhpFixture(): PhpFixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'infection-e2e-'));
  const srcDir = join(rootDir, 'src');
  const testsDir = join(rootDir, 'tests');
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(testsDir, { recursive: true });

  writeFileSync(
    join(srcDir, 'Calculator.php'),
    `<?php
namespace App;
class Calculator {
    public function max(int $a, int $b): int {
        if ($a > $b) { return $a; }
        return $b;
    }
}
`,
  );

  // Test covers max() but NOT the equal-values boundary, so the > → >= mutant survives.
  writeFileSync(
    join(testsDir, 'CalculatorTest.php'),
    `<?php
use App\\Calculator;
use PHPUnit\\Framework\\TestCase;
class CalculatorTest extends TestCase {
    public function testMax(): void {
        $this->assertSame(5, (new Calculator())->max(5, 3));
    }
}
`,
  );

  writeFileSync(
    join(rootDir, 'composer.json'),
    JSON.stringify(
      {
        name: 'chaos/e2e-fixture',
        require: {},
        'require-dev': { 'phpunit/phpunit': '^10 || ^11', 'infection/infection': '^0.27 || ^0.29' },
        autoload: { 'psr-4': { 'App\\\\': 'src/' } },
        config: { 'allow-plugins': { 'infection/extension-installer': true } },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(rootDir, 'phpunit.xml'),
    `<?xml version="1.0"?>
<phpunit bootstrap="vendor/autoload.php" colors="true">
  <testsuites>
    <testsuite name="unit"><directory>tests</directory></testsuite>
  </testsuites>
  <source><include><directory>src</directory></include></source>
</phpunit>
`,
  );

  return {
    rootDir,
    remove: () => {
      try {
        rmSync(rootDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

describe('Infection E2E', () => {
  let fixture: PhpFixture;

  beforeAll(() => {
    if (!E2E_PHP_ENABLED || !phpDetect.available) return;
    fixture = createPhpFixture();
    // Install deps once (Infection + PHPUnit) inside the fixture.
    spawnSync('composer', ['install', '--no-interaction', '--quiet'], {
      cwd: fixture.rootDir,
      stdio: 'pipe',
      timeout: 180_000,
    });
  }, 200_000);

  afterAll(() => {
    if (fixture) fixture.remove();
  });

  it_canary('fails loudly when E2E_PHP=1 is set but toolchain is missing', () => {
    if (!E2E_PHP_ENABLED) return;
    if (!phpDetect.available) {
      throw new Error(`[e2e-php] E2E_PHP=1 set but toolchain unavailable — ${phpDetect.reason}.`);
    }
  });

  it_heavy(
    'runs real Infection and reflects the intentional coverage gap in the score',
    async () => {
      const engine = new PhpEngine();
      const result = await engine.run('src/Calculator.php', { workDir: fixture.rootDir });

      expect(result.totalMutants).toBeGreaterThanOrEqual(1);
      // The > → >= boundary mutant survives (equal-values path untested).
      expect(result.survived).toBeGreaterThanOrEqual(1);
      const score = parseFloat(result.mutationScore);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThan(100);
    },
    240_000,
  );
});
```

- [ ] **Step 2: Verify it skips cleanly with the flag unset**

Run: `npm run build && npx vitest run src/__tests__/e2e-php.test.ts`
Expected: PASS with the heavy test skipped (canary is a no-op when `E2E_PHP` is unset).

- [ ] **Step 3: (Optional, if a PHP toolchain is available) run the real E2E**

Run: `E2E_PHP=1 npm run build && E2E_PHP=1 npx vitest run src/__tests__/e2e-php.test.ts`
Expected: PASS. **If it fails on JSON-log parsing**, inspect the real `chaos-infection-log.json` and reconcile the field names/flags in `src/engines/php.ts` (per the Global Constraints note), then re-run Task 1's unit tests.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/e2e-php.test.ts
git commit -m "test(php): opt-in E2E Infection fixture (E2E_PHP=1)"
```

---

### Task 5: Restore PHP in the living docs

**Files:**
- Modify: `README.md` (language list ~16; tool/install table ~50-53; toolchain prereq note ~56; test-runner table ~470-475; Links ~558-565)
- Modify: `CLAUDE.md` (~7 summary)
- Modify: `CONTRIBUTING.md` (~62 dir structure; ~152 version-bump list)

**Interfaces:** none (docs only).

- [ ] **Step 1: README — add the PHP/Infection rows**

In `README.md`:
- Language list (~16): add `PHP (Infection)` so it reads `TypeScript/JavaScript (StrykerJS), Python (cosmic-ray), Rust (cargo-mutants), PHP (Infection)`.
- Install table (after the Rust row): `| PHP | [Infection](https://infection.github.io/) | \`composer require --dev infection/infection\` — also enable a coverage driver (Xdebug or PCOV) |`
- Toolchain prereq note (~56): append `, and PHP + Composer with a coverage driver (Xdebug or PCOV) for Infection` to the toolchain sentence.
- Test-runner table (after the Rust row): `| PHP | Infection | phpunit |`
- Links (~563 area): add `- [Infection](https://infection.github.io/)` after the cargo-mutants link.

- [ ] **Step 2: CLAUDE.md — four tools again**

In `CLAUDE.md` line ~7, change `wraps three language-specific mutation tools — StrykerJS (TS/JS), cosmic-ray (Python), cargo-mutants (Rust)` to `wraps four language-specific mutation tools — StrykerJS (TS/JS), cosmic-ray (Python), cargo-mutants (Rust), Infection (PHP)`.

- [ ] **Step 3: CONTRIBUTING.md — add php.ts + Infection**

In `CONTRIBUTING.md`, add a `php.ts # Infection engine` line to the `engines/` directory-structure block (after `rust.ts`), and add `Infection` to the major-version-bump list (`Stryker / Mutmut / cargo-mutants` → `Stryker / Mutmut / cargo-mutants / Infection`).

- [ ] **Step 4: Verify + final gate**

Run: `grep -rin "infection" README.md CLAUDE.md CONTRIBUTING.md` (expect the new rows) and `npm run check` (expect PASS).

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md CONTRIBUTING.md
git commit -m "docs: restore PHP/Infection in README, CLAUDE.md, CONTRIBUTING.md"
```

---

## Self-Review

**Spec coverage:**
- "Seven integration points" (engine, registry, detector, config-loader, exec-classify, resources, estimate) → Task 1 (engine + exec-classify), Task 2 (config-loader), Task 3 (detector, registry, resources, estimate-heuristic). ✓
- "Hybrid config (use project's / else generate)" → Task 1 `PhpEngine.run` + the two "generates" / "does NOT overwrite" tests. ✓
- "PHPUnit-only detection" → Task 3 `detectPhpTestRunner`. ✓
- "Coarse scoping, `supportsLineScope: false`" → Task 3 registry entry; scopeNote path is automatic (handler uses `ENGINE_REGISTRY[projectType].supportsLineScope`). ✓
- "JSON-log parse: escaped→survivors, timed-out→killed, not-covered→excluded, MSI→score" → Task 1 `parseInfectionJsonLog` + its three parse tests. ✓
- "vendor/ symlink" → **see note below.**
- "Coverage-driver prereq + baseline error" → Task 1 no-log error path + test; Task 5 docs. ✓
- "`infection` config section (timeoutMs, threads, testFrameworkOptions)" → Task 2. ✓
- "approx estimate, no sandbox" → Task 3 estimate-heuristic php branch + `estimateNeedsSandbox('php', false)` test; `computeCount` already routes non-rust to the heuristic (no change needed). ✓
- "Enumeration 3→4" → Task 3 Step 12 (registry, resources, exec-classify hint). ✓
- "Opt-in E2E_PHP fixture" → Task 4. ✓
- "Living docs restore, keep '4' headline" → Task 5 + Global Constraints. ✓

**Deviation logged — the `vendor/` sandbox symlink (spec §"Sandbox change"):** The spec calls for adding `vendor` to `SYMLINK_DIRS` in `src/utils/sandbox.ts`. It is intentionally **not** its own step above because it is a one-line change with a shared blast radius and its own test cycle. Fold it into **Task 3 as an extra step (Step 8b):** add `'vendor'` to the `SYMLINK_DIRS` array in `src/utils/sandbox.ts` (leave `ALWAYS_EXCLUDE` untouched), and add a sandbox test asserting a `vendor/` dir in the source tree becomes a symlink (mirror the existing `node_modules` symlink test in `src/__tests__/sandbox.test.ts`). Committed with Task 3. *(This keeps Task 3 the single "make PHP actually run end-to-end" commit.)*

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to". Task 3 Steps 11-12 use the same compiler-and-test-driven loop the Go removal used — legitimate for a union grow where `tsc`/`npm test` enumerate the work; the file/edit checklist bounds it. The two version-fragile Infection specifics (JSON field names, `--threads`/`--test-framework-options`) are pinned in unit tests and reconciled by the Task 4 E2E — this is called out in Global Constraints, not left vague.

**Type consistency:** `ProjectType` → 5 members (adds `'php'`); `SupportedProjectType = Exclude<…,'unsupported'>` → 4, forcing `LANGUAGE_DETECTORS`, `ENGINE_REGISTRY`, `ENGINE_NAMES` to add `php` (Task 3). `EngineDescriptor.configKey` and `ENGINE_CONFIG_SECTIONS.key` both → `'stryker' | 'cosmicray' | 'rust' | 'infection'` (Task 3 registry / Task 2 config-loader — same string, verified). `ExecutableTool` gains `'Infection'` (Task 1). `RunOptions.phpThreads?: string` / `phpTestFrameworkOptions?: string` defined in Task 3 (base.ts) and consumed in Task 1's `php.ts` via optional chaining (no earlier signature dependency) and populated in Task 3's `buildRunOptions` from `cfg.infection` (Task 2 `InfectionConfig`). Names align across tasks.

## Out of scope / follow-ups

- phpspec / Codeception support (v1 is PHPUnit-only; a project's own `infection.json` still serves other frameworks).
- PHP line/diff-scoping via Infection's git-diff filters — a candidate for the performance sub-project.
- Cleaning the remaining inert Go stragglers untouched by this work (`handler-phase3.test.ts` / `handler-phase5.test.ts` still `vi.mock('../engines/go.js')`; `format.test.ts` uses a `'...for go...'` scopeNote string; `src/utils/exec.ts` + `estimate-handler.test.ts` comments) — harmless, out of scope here.
- Engine performance uplift (cargo-mutants `-j`, cosmic-ray concurrency) — the third sub-project.
```

