# Rust Concurrency (cargo-mutants `-j`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Rust engine an out-of-box mutation-testing speedup by passing cargo-mutants `-j`, resolved from `RunOptions.concurrency` with a conservative default, plus fill the test gap on the PHP `--threads` path.

**Architecture:** Four independent, individually-green tasks: (1) add a `concurrency` key to the Rust config section, (2) add a pure `resolveCargoJobs` helper + wire `-j` into `rust.ts`, (3) make `buildRunOptions`' concurrency resolution engine-aware so Rust reads `rust.concurrency` (and PHP/Rust stop wrongly reading `stryker.concurrency`), (4) fix the `RunOptions.concurrency` contract doc + add PHP threads test coverage.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, ESLint + Prettier. Spec: `docs/specs/2026-07-01-rust-concurrency-design.md`.

## Global Constraints

- **Gate:** `npm run check` (build → lint → format:check → test) must pass. Build precedes test (`npm test` imports from `build/`).
- **Rust default is a LOW FIXED cap, not core-scaled:** `-j2` when `cpus >= 3`, else serial (no `-j`). Explicit `concurrency` (arg or `rust.concurrency` config) overrides and is honored as-is.
- **Concurrency bounds:** integer **1–64** (same as StrykerJS).
- **PHP stays at `--threads=max`** — no behavior change; this plan only adds test coverage for it.
- **Non-goals:** cosmic-ray concurrency, cargo-mutants `--in-diff`, any StrykerJS change.
- Preserve audit-tag comments (`Med#9`, `Med#2`, `H5`, etc.) on any touched line.
- ESM: relative imports end in `.js`. Conventional Commits. Work on branch `rust-concurrency` (already created; spec committed at `711932a`).

---

### Task 1: Add `concurrency` to the Rust config section

**Files:**
- Modify: `src/utils/config-loader.ts` (`CargoMutantsConfig` ~102; `KNOWN_RUST_KEYS` ~49; rename `parseTimeoutOnlyConfig` ~279 → `parseCargoMutantsConfig` and add `concurrency`; `ENGINE_CONFIG_SECTIONS` rust entry ~331)
- Test: `src/__tests__/config-loader.test.ts`

**Interfaces:**
- Produces: `CargoMutantsConfig { timeoutMs?: number; concurrency?: number }`. `ENGINE_CONFIG_SECTIONS` rust entry parses via `parseCargoMutantsConfig`. `cfg.rust.concurrency` is now a validated integer 1–64.

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/config-loader.test.ts` (reuse the file's existing config-writing/`validateConfig` helpers, matching sibling tests):

```typescript
it('parses rust.concurrency and rejects out-of-range values', () => {
  const good = writeConfigAndValidate({ rust: { timeoutMs: 60000, concurrency: 2 } });
  expect(good.config.rust).toEqual({ timeoutMs: 60000, concurrency: 2 });
  expect(good.warnings.filter((w) => w.includes('concurrency'))).toHaveLength(0);

  const bad = writeConfigAndValidate({ rust: { concurrency: 65 } });
  expect(bad.config.rust?.concurrency).toBeUndefined();
  expect(bad.warnings.some((w) => w.includes('rust.concurrency'))).toBe(true);
});
```

If the file has no `writeConfigAndValidate` helper, follow whatever pattern the neighboring rust/stryker config tests already use to write a temp config and call `validateConfig` — do not invent a new harness.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/config-loader.test.ts -t 'rust.concurrency'`
Expected: FAIL — `concurrency` is currently an unknown key in the rust section (dropped, and warned as unknown).

- [ ] **Step 3: Add the config-loader support**

In `src/utils/config-loader.ts`:

(a) Extend the interface (~line 102):

```typescript
export interface CargoMutantsConfig {
  /** Timeout override for cargo-mutants runs (ms). */
  timeoutMs?: number;
  /** Parallel job count forwarded to cargo-mutants `-j` (integer 1–64). */
  concurrency?: number;
}
```

(b) Add the key (~line 49):

```typescript
const KNOWN_RUST_KEYS = new Set(['timeoutMs', 'concurrency']);
```

(c) Rename `parseTimeoutOnlyConfig` → `parseCargoMutantsConfig` and add concurrency parsing. `parseTimeoutOnlyConfig` is used ONLY by the rust section today (infection has `parseInfectionConfig`), so first confirm with `grep -n "parseTimeoutOnlyConfig" src` — it should appear only at its definition and the rust `ENGINE_CONFIG_SECTIONS` entry. Replace the function body:

```typescript
/**
 * Parse the cargo-mutants (Rust) config section: a positive `timeoutMs` and an
 * optional `concurrency` (integer 1–64, forwarded to cargo-mutants `-j`).
 * Returns `undefined` when the section is absent, malformed, or has no valid field.
 */
function parseCargoMutantsConfig(raw: unknown): CargoMutantsConfig | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  const result: CargoMutantsConfig = {};
  let hasAny = false;

  if (typeof s.timeoutMs === 'number' && s.timeoutMs > 0) {
    result.timeoutMs = s.timeoutMs;
    hasAny = true;
  }
  if (
    typeof s.concurrency === 'number' &&
    Number.isInteger(s.concurrency) &&
    s.concurrency >= 1 &&
    s.concurrency <= 64
  ) {
    result.concurrency = s.concurrency;
    hasAny = true;
  }

  return hasAny ? result : undefined;
}
```

(d) Point the rust entry at it (~line 331):

```typescript
  { key: 'rust', knownKeys: KNOWN_RUST_KEYS, parse: parseCargoMutantsConfig },
```

(`validateEngineSection` already validates a `concurrency` key as an integer 1–64 for any section whose `knownKeys` includes it, so no change is needed there — the out-of-range warning in the test comes for free.)

- [ ] **Step 4: Run the config tests**

Run: `npm run build && npx vitest run src/__tests__/config-loader.test.ts`
Expected: PASS (new test + all existing).

- [ ] **Step 5: Commit**

```bash
git add src/utils/config-loader.ts src/__tests__/config-loader.test.ts
git commit -m "feat(config): add rust.concurrency (cargo-mutants -j) config key"
```

---

### Task 2: `resolveCargoJobs` helper + wire `-j` into the Rust engine

**Files:**
- Modify: `src/engines/rust.ts` (add `os` import + `resolveCargoJobs` + `-j` in the args ~165)
- Test: `src/__tests__/rust-engine.test.ts` (or the existing rust engine test file — confirm the name with `ls src/__tests__ | grep -i rust`)

**Interfaces:**
- Consumes: `RunOptions.concurrency` (already exists, `number | undefined`).
- Produces: `export function resolveCargoJobs(concurrency: number | undefined, cpuCount: number): number` — returns the job count (`1` = serial). The engine appends `-j <n>` only when the result is `> 1`.

- [ ] **Step 1: Write the failing test**

Add to the rust engine test file:

```typescript
import { resolveCargoJobs } from '../engines/rust.js';

describe('resolveCargoJobs', () => {
  it('honors an explicit concurrency as-is', () => {
    expect(resolveCargoJobs(4, 8)).toBe(4);
    expect(resolveCargoJobs(1, 8)).toBe(1);
  });
  it('defaults to 2 jobs when the machine has spare cores (cpus >= 3)', () => {
    expect(resolveCargoJobs(undefined, 8)).toBe(2);
    expect(resolveCargoJobs(undefined, 3)).toBe(2);
  });
  it('defaults to serial (1) on low-core machines (cpus < 3)', () => {
    expect(resolveCargoJobs(undefined, 2)).toBe(1);
    expect(resolveCargoJobs(undefined, 1)).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/rust-engine.test.ts -t 'resolveCargoJobs'`
Expected: FAIL — `resolveCargoJobs` is not exported yet.

- [ ] **Step 3: Implement the helper and wire it in**

In `src/engines/rust.ts`, add the import at the top:

```typescript
import { cpus } from 'node:os';
```

Add the exported helper (near the top, after the imports / before the class):

```typescript
/**
 * Resolve the cargo-mutants `-j` job count. Explicit `concurrency` (from a tool
 * arg or `rust.concurrency` config, already validated to 1–64) is honored as-is.
 * Otherwise a deliberately LOW default: `2` when the machine has spare cores
 * (`cpuCount >= 3`), else `1` (serial). cargo-mutants' own docs warn against
 * core-scaling `-j` for Rust — its build/test tooling is already parallel, and
 * each job needs its own multi-GB `target/` copy — so the default stays small.
 * A result of `1` means "serial"; the engine omits `-j` entirely in that case.
 */
export function resolveCargoJobs(concurrency: number | undefined, cpuCount: number): number {
  if (typeof concurrency === 'number' && Number.isInteger(concurrency) && concurrency >= 1) {
    return concurrency;
  }
  return cpuCount >= 3 ? 2 : 1;
}
```

Then in `RustEngine.run`, replace the args construction (currently `['mutants', '--file', filePath]` at ~line 165). Build the args first and conditionally add `-j`:

```typescript
    const jobs = resolveCargoJobs(options?.concurrency, cpus().length);
    const args = ['mutants', '--file', filePath];
    if (jobs > 1) args.push('-j', String(jobs));
```

and pass `args` to `invokeMutationTool('cargo-mutants', 'cargo', args, { cwd, timeoutMs, signal: options?.signal })`. Update the verbose log line (~155) to include the jobs, e.g. ``log(`RustEngine: cargo mutants --file "${filePath}"${jobs > 1 ? ` -j ${jobs}` : ''}`)``. Leave the `--file` glob comment (Med#9) intact.

- [ ] **Step 4: Add an engine-level args test**

Add a test that mocks `invokeMutationTool` and asserts the flag is passed for an explicit concurrency (deterministic regardless of the host's CPU count) and omitted for serial. Follow the existing rust-engine test's mocking pattern for `invokeMutationTool`:

```typescript
it('passes -j to cargo-mutants when concurrency > 1, omits it when serial', async () => {
  const spy = /* the file's existing invokeMutationTool mock */;
  spy.mockResolvedValue({ stdout: 'MISSED src/x.rs:1:1: x', stderr: '' });

  await new RustEngine().run('src/x.rs', { concurrency: 4, workDir: '/tmp' });
  expect(spy.mock.calls[0][2]).toEqual(['mutants', '--file', 'src/x.rs', '-j', '4']);

  spy.mockClear();
  await new RustEngine().run('src/x.rs', { concurrency: 1, workDir: '/tmp' });
  expect(spy.mock.calls[0][2]).toEqual(['mutants', '--file', 'src/x.rs']);
});
```

Match the file's real mock mechanics (how it spies on `invokeMutationTool`, argument positions) rather than the placeholder `spy` above.

- [ ] **Step 5: Run the rust tests**

Run: `npm run build && npx vitest run src/__tests__/rust-engine.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engines/rust.ts src/__tests__/rust-engine.test.ts
git commit -m "feat(rust): pass cargo-mutants -j with conservative default"
```

---

### Task 3: Engine-aware concurrency resolution in `buildRunOptions`

**Files:**
- Modify: `src/handler.ts` (`buildRunOptions` concurrency line ~430)
- Test: `src/__tests__/handler-helpers.test.ts` (the `buildRunOptions` unit tests)

**Interfaces:**
- Consumes: `CargoMutantsConfig.concurrency` (Task 1), `engCfg = cfg[configKey]` (already computed at handler.ts:400).
- Produces: `RunOptions.concurrency` resolved from `args.concurrency → <engine section>.concurrency → cfg.concurrency`. Rust reads `rust.concurrency`; TS still reads `stryker.concurrency`; PHP/cosmicray sections (no `concurrency` key) fall back to global `cfg.concurrency`.

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/handler-helpers.test.ts` (reuse its existing `buildRunOptions` call pattern — it already constructs `args`/`cfg`/`env`/`workDir`/`projectType`):

```typescript
it('resolves concurrency from the engine section matching the project type', () => {
  const env = /* the file's standard EnvironmentInfo builder */;

  // Rust audit reads rust.concurrency, NOT stryker.concurrency
  const rust = buildRunOptions({}, { stryker: { concurrency: 9 }, rust: { concurrency: 3 } }, env, '/w', 'rust');
  expect(rust.concurrency).toBe(3);

  // TS audit still reads stryker.concurrency
  const ts = buildRunOptions({}, { stryker: { concurrency: 9 }, rust: { concurrency: 3 } }, env, '/w', 'typescript');
  expect(ts.concurrency).toBe(9);

  // arg overrides the section; section overrides global
  expect(buildRunOptions({ concurrency: 5 }, { rust: { concurrency: 3 } }, env, '/w', 'rust').concurrency).toBe(5);
  expect(buildRunOptions({}, { concurrency: 7 }, env, '/w', 'rust').concurrency).toBe(7);
});
```

Match the file's real `env` construction and `buildRunOptions` signature/argument order (`args, cfg, env, workDir, projectType`).

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/handler-helpers.test.ts -t 'engine section matching'`
Expected: FAIL — a Rust audit currently resolves `concurrency` from `cfg.stryker?.concurrency` (would be `9`, not `3`).

- [ ] **Step 3: Make the resolution engine-aware**

In `src/handler.ts`, add a tiny typed accessor (near the other resolve helpers, ~line 372) — `concurrency` exists only on the Stryker and Rust section types, so narrow with `in`:

```typescript
/** Concurrency declared on an engine config section, when that section has one. */
function sectionConcurrency(section: unknown): number | undefined {
  return typeof section === 'object' && section !== null && 'concurrency' in section
    ? (section as { concurrency?: unknown }).concurrency as number | undefined
    : undefined;
}
```

Then change the `concurrency` line in `buildRunOptions` (~430) from:

```typescript
    concurrency: resolveConcurrency(args.concurrency, cfg.stryker?.concurrency ?? cfg.concurrency),
```

to:

```typescript
    // Resolve from the section matching THIS engine (not always stryker): a Rust
    // audit must read rust.concurrency, a PHP audit must not inherit stryker's.
    concurrency: resolveConcurrency(args.concurrency, sectionConcurrency(engCfg) ?? cfg.concurrency),
```

`resolveConcurrency` already re-validates via `isValidConcurrency` (integer 1–64), so a bogus section value is ignored safely.

- [ ] **Step 4: Run the handler tests**

Run: `npm run build && npx vitest run src/__tests__/handler-helpers.test.ts`
Expected: PASS (new test + existing; the existing TS-concurrency tests must be unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/handler.ts src/__tests__/handler-helpers.test.ts
git commit -m "fix(handler): resolve concurrency from the engine's own config section"
```

---

### Task 4: Contract doc fix + PHP threads test coverage

**Files:**
- Modify: `src/engines/base.ts` (`RunOptions.concurrency` doc ~76-85)
- Test: `src/__tests__/php-engine.test.ts`

**Interfaces:**
- No new runtime interface. Documentation + tests only.

- [ ] **Step 1: Fix the `concurrency` contract doc**

In `src/engines/base.ts`, the `concurrency?` field doc currently says it's supported by StrykerJS and "**Ignored by:** cosmic-ray, go-mutesting, cargo-mutants." Replace that block so it reads (keep the surrounding JSDoc structure):

```typescript
  /**
   * Concurrency hint for mutation engines that support parallel execution.
   *
   * **Honored by:**
   *  - StrykerJS — `--concurrency` (auto-detects cores when omitted).
   *  - cargo-mutants — `-j` (Rust). Defaults low (`-j2` on machines with spare
   *    cores, else serial); each job needs its own multi-GB `target/` copy, so
   *    it is deliberately not core-scaled.
   *  - Infection — `--threads` (PHP; defaults to `max`).
   * **Ignored by:** cosmic-ray (Python) — runs its own (currently serial) distributor.
   *
   * When omitted, each engine uses its own default.
   */
  concurrency?: number;
```

(go-mutesting no longer exists; do not mention it.)

- [ ] **Step 2: Write the PHP threads coverage test**

The rogue-built `php.ts` reads `phpThreads ?? (concurrency ? String(concurrency) : 'max')` and emits `--threads=<value>`, but has no unit coverage for it. Add to `src/__tests__/php-engine.test.ts` (match the file's existing `invokeMutationTool` mock pattern and `PhpEngine` construction):

```typescript
it('builds --threads: phpThreads wins, then concurrency, else max', async () => {
  const spy = /* the file's existing invokeMutationTool mock */;
  spy.mockResolvedValue({ stdout: '', stderr: '' }); // parser reads the JSON log file separately

  const argsOf = () => spy.mock.calls[0][2] as string[];

  await new PhpEngine().run('src/A.php', { phpThreads: '3', workDir: '/tmp' }).catch(() => {});
  expect(argsOf().some((a) => a === '--threads=3')).toBe(true);

  spy.mockClear();
  await new PhpEngine().run('src/A.php', { concurrency: 4, workDir: '/tmp' }).catch(() => {});
  expect(argsOf().some((a) => a === '--threads=4')).toBe(true);

  spy.mockClear();
  await new PhpEngine().run('src/A.php', { workDir: '/tmp' }).catch(() => {});
  expect(argsOf().some((a) => a === '--threads=max')).toBe(true);
});
```

`.catch(() => {})` guards against the engine throwing when it later fails to read a real JSON log — we only care about the args passed to the mocked `invokeMutationTool`. If the file's existing tests already stub the JSON-log read, follow that instead and drop the `.catch`.

- [ ] **Step 3: Run it to verify it fails / passes**

Run: `npm run build && npx vitest run src/__tests__/php-engine.test.ts -t 'threads'`
Expected: PASS if the rogue `--threads` logic is correct (this test documents/pins it). If it FAILS, the rogue logic is wrong — fix `php.ts`'s threads resolution to match the spec (`phpThreads ?? concurrency ?? 'max'`) and note it in the report.

- [ ] **Step 4: Full gate**

Run: `npm run check`
Expected: PASS (build, lint, format:check, all tests).

- [ ] **Step 5: Commit**

```bash
git add src/engines/base.ts src/__tests__/php-engine.test.ts
git commit -m "docs(base): correct concurrency support matrix; test PHP --threads"
```

---

## Self-Review

**Spec coverage:**
- "Rust engine `-j` with conservative default" → Task 2 (`resolveCargoJobs`, `-j2`/serial, honors explicit). ✓
- "Engine-aware concurrency plumbing" → Task 3 (`sectionConcurrency`, `args → section → global`). ✓
- "Rust config `concurrency` key (dedicated parser, 1–64, warned)" → Task 1 (rename→`parseCargoMutantsConfig`, `KNOWN_RUST_KEYS`, free `validateEngineSection`). ✓
- "base.ts contract doc" → Task 4 Step 1. ✓
- "PHP verification (no behavior change, add coverage)" → Task 4 Step 2. ✓
- "Bounds 1–64; low fixed default; PHP stays max" → Global Constraints + Tasks 2/4. ✓

**Placeholder scan:** The `spy = /* the file's existing invokeMutationTool mock */` and `env = /* … builder */` markers are deliberate pointers to reuse each test file's real harness (inventing a parallel one is worse); the surrounding assertions are concrete. No "TBD"/"handle edge cases"/"similar to Task N".

**Type consistency:** `resolveCargoJobs(concurrency, cpuCount): number` used identically in Tasks 2. `CargoMutantsConfig.concurrency?: number` (Task 1) consumed by `sectionConcurrency` (Task 3). `buildRunOptions(args, cfg, env, workDir, projectType)` order matches handler.ts:390. `parseCargoMutantsConfig` name consistent between definition and `ENGINE_CONFIG_SECTIONS` entry.

## Out of scope / follow-ups

- **cosmic-ray concurrency** — next perf sub-project (http distributor + per-worker isolation).
- **cargo-mutants `--in-diff`** — separate diff-aware feature.
- **`estimate_audit` timing** alignment to real per-engine job counts — approximate; deferred.
- **Independent review of the rogue PHP engine** beyond the `--threads` path.
