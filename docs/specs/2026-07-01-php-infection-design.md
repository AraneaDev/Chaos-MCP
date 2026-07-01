# Add PHP Support via Infection — Design

**Date:** 2026-07-01
**Status:** Approved (design), pending implementation plan
**Author:** brainstorming session (Chaos-MCP engine roster change)

## Context

Chaos-MCP wraps language-specific mutation tools behind a single `BaseEngine`
contract, with `ENGINE_REGISTRY` as the per-language source of truth. After the
Go removal it supports three: StrykerJS (TS/JS), cosmic-ray (Python),
cargo-mutants (Rust). The README still frames the product as "4 languages
supported" — a deliberate, short-lived gap the Go spec left for this work to
close.

This is the **second** of three sequenced sub-projects in the broader engine
initiative:

1. Drop Go (done) — shrank the surface before growing it.
2. **Add PHP via Infection** (this spec) — restores the fourth language, with a
   real dogfood target and native `--threads` concurrency.
3. Performance uplift for existing engines — cargo-mutants `-j` (+ optional
   `--in-diff`), then cosmic-ray concurrency.

Adding PHP is the mirror image of the Go removal: regrow the same three type
unions (`ProjectType`, `ExecutableTool`, the registry `configKey`) and add one
entry to each of the seven integration points a language touches.

## Goal

Add PHP as a first-class, fourth supported language backed by the
[Infection](https://infection.github.io/) mutation-testing framework, following
the exact structural pattern of the existing three engines, with a green
`npm run check` (including the enumeration assertions moving 3→4) as proof.

### Non-goals

- **No phpspec / Codeception** — PHPUnit only for v1. Projects on other
  frameworks are still served through the hybrid-config rule (below) if they
  ship their own `infection.json`.
- **No line/diff-scoping for PHP** — PHP is a coarse engine
  (`supportsLineScope: false`), like Python and Rust. Infection's git-diff
  filters are a possible later item, not this spec.
- **No performance work** on any engine (third sub-project).
- **No behavior change** to the TypeScript, Python, or Rust engines.
- **No auto-install** of PHP, Composer deps, PHPUnit, or a coverage driver.

## Decisions locked during brainstorming

1. **Hybrid configuration (Approach C).** If the sandbox already contains an
   `infection.json` or `infection.json5`, the engine uses it as-is and only adds
   `--filter`. Otherwise it writes a minimal `infection.json` before running.
   This matches the "just works" ergonomics of the Python engine (which
   generates cosmic-ray's `config.toml`) while honoring a project's real
   mutator/exclude settings when it has them.
2. **PHPUnit only (Approach A) for v1.** Detection keys on
   `phpunit.xml` / `phpunit.xml.dist`; the generated fallback sets
   `testFramework: "phpunit"`. A PHP project with only phpspec/Codeception and
   no Infection config routes to a clear baseline/setup error.
3. **Full unit coverage + one opt-in E2E (Approach A).** Mirror how the other
   engines are validated: mock-subprocess unit tests by default, plus one
   `E2E_PHP=1` test running real Infection against a tiny bundled fixture. The
   E2E stays out of the normal CI gate, exactly like `E2E_STRYKER`.
4. **Config section key = `infection`.** Matches the tool-named `stryker` /
   `cosmicray` sections and names the tool whose knobs it holds.
5. **PHP is a coarse engine.** `supportsLineScope: false`; `estimateFidelity`
   is `approx` (source-parse heuristic), like TS/JS and Python.

## Integration points (the seven touch-points)

`ENGINE_REGISTRY` is the single source of truth per language; adding PHP means
one entry in each of the places the Go removal cleared:

1. **`src/engines/php.ts`** — new `PhpEngine extends BaseEngine` (the substantive
   new code; see below).
2. **`src/engines/registry.ts`** — regrow the `configKey` union to
   `'stryker' | 'cosmicray' | 'rust' | 'infection'`; add the `php` entry:
   `{ make: () => new PhpEngine(), configKey: 'infection', supportsLineScope: false }`
   (no auto-`prebuild`). `SupportedProjectType` picks it up automatically.
3. **`src/utils/project-detector.ts`** — add `'php'` to `ProjectType`;
   `PHP_ROOT_MARKERS = ['composer.json']`; `detectPhpTestRunner` (PHPUnit-only,
   returns `'phpunit'`; raw runner mirrors it); a `LANGUAGE_DETECTORS.php` entry
   matching `\.php$`.
4. **`src/utils/config-loader.ts`** — add `'infection'` to the known keys, an
   `InfectionConfig` type + `KNOWN_INFECTION_KEYS`, `ChaosConfig.infection?`, and
   the `ENGINE_CONFIG_SECTIONS.infection` mapping. Fields: `timeoutMs`,
   `threads` (number | `"max"`), `testFrameworkOptions` (string). Precedence
   remains args > engine section > global > detected default.
5. **`src/utils/exec-classify.ts`** — add `'Infection'` to `ExecutableTool` and
   an `INSTALL_HINTS` entry:
   `composer require --dev infection/infection` (note it also needs a coverage
   driver).
6. **`src/resources.ts`** — `ENGINE_NAMES.php = 'Infection'`; a `configSchemaJson`
   key doc for the `infection` section.
7. **`src/estimate.ts` / `src/estimate-heuristic.ts`** — PHP uses the approx
   heuristic (`estimateNeedsSandbox('php', false) === false`), plus a small
   `php` branch in `stripNoise` that also strips `#` line comments (PHP's
   third comment style). `#[...]` attributes being dropped as comments is an
   acceptable approximation for an estimate.

Peripheral doc/schema strings that were de-Go'd get a PHP row where symmetric:
`src/tool-schema.ts` (accepted extensions + tool/resource descriptions),
`src/cli.ts` (help text / examples). These follow the same shape the Go removal
touched, in reverse.

## The engine (`php.ts`)

**Invocation.** Build and run:

```
infection \
  --filter=<workspace-relative target .php> \
  --logger-json=<sandbox-tmp>/infection-log.json \
  --no-progress --no-interaction \
  --threads=<concurrency | "max">
```

via `invokeMutationTool('Infection', <bin>, [...], { cwd, timeoutMs, signal })`.
Binary resolution prefers `vendor/bin/infection` when it exists in the sandbox,
falling back to a global `infection` on `PATH`. Default timeout 300 000 ms
(5 min), overridable via the `infection` config section / args, consistent with
the other engines.

**Configuration (hybrid, decision 1).** Before running:

- If `infection.json` or `infection.json5` exists at the sandbox root, run
  against it unchanged (only append `--filter` and the JSON logger path).
- Else, synthesize a minimal `infection.json` at the sandbox root:
  `{ "source": { "directories": [<inferred>] }, "testFramework": "phpunit",
  "logs": { "json": <tmp> } }`. The inferred source directory is the top-level
  segment of the target's workspace-relative path (e.g. `src` for
  `src/Calculator.php`), falling back to `.` — Infection needs a source root to
  enumerate, while `--filter` narrows mutation to the single file.

**Result parsing.** Read the JSON log and map into `MutationResult`:

- `totalMutants` / `killed` / `survived` from the log's stats
  (killed-by-tests + timed-out counted as killed; escaped counted as survived).
- `mutationScore` from the MSI (or recomputed `killed/total` for parity with the
  other engines' formatting).
- Each **escaped** mutant → a `Vulnerability`:
  `{ line: originalStartLine, mutator: <mutatorName>,
  description: "Mutation survived at line N. The PHP test suite did not catch
  this change.", mutated: <diff snippet> }`.
- **Timed-out** mutants are treated as killed (the suite detected them by
  hanging), matching the Rust engine's TIMEOUT handling.
- **Not-covered** mutants are excluded from survivors (they indicate missing
  coverage, not a killed/escaped signal); they are not counted as survivors and
  do not inflate the denominator beyond Infection's own totals.

**Coarse scoping.** `supportsLineScope: false`. `lineScope` / `diffBase` /
`baseline` yield the standard scopeNote ("line scoping not supported for php;
whole file mutated") emitted by the handler for non-TypeScript engines — no
engine-side work beyond the registry flag.

**Error handling.** Reuse `BaseEngine.toExecFailure('Infection')`:

- Missing binary (ENOENT) → `MutationToolStartupError` with the install hint.
- Non-zero exit with an empty/failed JSON log → throw a clear baseline error:
  "Infection's initial test run failed — ensure `vendor/bin/phpunit` passes and
  a coverage driver (Xdebug or PCOV) is enabled." (Infection cannot run without
  coverage; this is the single most likely first-run failure and deserves a
  targeted message.)
- Non-zero exit **with** a parseable JSON log (escaped mutants present) is the
  normal survivors case — parse and return, do not throw.

## Sandbox change

Add `vendor` to `SYMLINK_DIRS` in `src/utils/sandbox.ts` (and keep it out of
`ALWAYS_EXCLUDE`). `vendor/` holds `bin/infection` and the Composer autoloader;
it is large and **read-only** during a mutation run (Infection writes only to
its `tmpDir`), so symlinking it is safe — the same rationale that governs
`node_modules` / `.venv`. This is deliberately *unlike* Rust's `target/`, which
is copied-not-symlinked because Rust writes build artifacts into it (audit H1).

## Prerequisites (documented, not auto-installed)

- PHP runtime and Composer dependencies installed (`vendor/` present).
- PHPUnit configured (`phpunit.xml` / `phpunit.xml.dist`) — or a project-supplied
  `infection.json` pointing at its framework.
- A coverage driver: **Xdebug or PCOV** (Infection runs the suite once with
  coverage before mutating).
- No auto-prebuild: `composer install` is arbitrary-command territory, available
  through the existing gated `prebuildCommand` (`allowPrebuild`), consistent
  with how build commands are treated for every language.

Living docs (`README.md`, `CLAUDE.md`, `CONTRIBUTING.md`) get the PHP/Infection
rows restored: the language list, tool/install table (with the coverage-driver
note), test-runner table, `CLAUDE.md` "three → four tools" line, and the
`CONTRIBUTING.md` engine-structure line.

## Testing & validation

- **Gate:** `npm run check` (build → lint → format:check → test) must pass.
  Because the type unions regrow first, `tsc` flags every place a fourth
  language must be handled.
- **Unit tests (default):** a new `php-engine.test.ts` mocking
  `invokeMutationTool` — flag construction, hybrid config detection vs.
  generation, JSON-log parsing (escaped→vulnerabilities, timed-out→killed,
  MSI→score, not-covered excluded), coarse-scoping scopeNote, and the
  baseline-failure / coverage-driver error path. Plus additions to
  `registry.test.ts`, `project-detector.test.ts`, `resources.test.ts`,
  `config-loader.test.ts`, `exec-classify.test.ts`, `estimate.test.ts`.
- **Enumeration audit (3→4):** every "list of languages/engines" assertion —
  registry key count, `chaos://languages`, `ENGINE_NAMES` — must reflect four
  engines, not just gain a row. (The inverse of the Go removal's 4→3 audit.)
- **Opt-in E2E (`E2E_PHP=1`):** a tiny bundled fixture (`Calculator.php` +
  PHPUnit test + `composer.json`) exercising real Infection end-to-end. Gated
  off by default and excluded from the normal CI gate, like `e2e-stryker`.

## Risks

- **Coverage-driver friction.** The most likely first-run failure is a missing
  Xdebug/PCOV. Mitigated by the targeted baseline error message and the
  documented prerequisite.
- **Generated-config source-root guess.** Inferring `source.directories` from
  the target path can miss unconventional layouts. Mitigated by the hybrid rule
  (a project's own `infection.json` always wins) and the `--filter` narrowing.
- **`vendor/` symlink assumption.** If a project vendors a tool that writes into
  `vendor/` during tests, the symlink could touch the host tree. This is rare
  (vendor is conventionally read-only); the risk mirrors the accepted
  `node_modules` symlink and is bounded by Infection writing to its own tmpDir.
- **Enumeration drift.** A stale hardcoded "3" could pass a subset check.
  Mitigated by the explicit 3→4 enumeration audit.
- **Infection version variance.** JSON-log field names and some CLI flags
  (`--threads=max`, `--test-framework-options`) can differ across Infection
  releases. Mitigated by defensive parsing (stats with array-length fallbacks)
  and the opt-in E2E as the reality check that reconciles them.

## Out of scope / follow-ups

- phpspec / Codeception support — a later increment if demand appears.
- PHP line/diff-scoping via Infection's git-diff filters — possible perf item.
- Engine performance uplift (cargo `-j`, cosmic-ray concurrency) — third spec.
