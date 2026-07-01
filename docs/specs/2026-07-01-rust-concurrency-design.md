# Rust Concurrency (Engine Perf Uplift, Part 1) — Design

**Date:** 2026-07-01
**Status:** Approved (design), pending implementation plan
**Author:** brainstorming session (Chaos-MCP engine parity/perf initiative, sub-project C)

## Context

Third sub-project of the engine parity/perf initiative (Approach B decomposition;
A = drop Go [done], B = add PHP/Infection [done, agent-authored]). The user's
priority for the initiative is **performance**. After A and B, the concurrency
state across engines is:

| Engine | Parallel today? |
|---|---|
| TypeScript (StrykerJS) | ✅ honors `--concurrency` |
| PHP (Infection) | ✅ `--threads=<n\|max>` (rogue-built, unreviewed) |
| Rust (cargo-mutants) | ❌ invoked `['mutants','--file',x]`, no `-j` |
| Python (cosmic-ray) | ❌ hardcoded serial `distributor.name = "local"` |

`RunOptions.concurrency` is already computed and threaded (`handler.ts` →
`buildRunOptions`), but only StrykerJS (and PHP, via a separate `phpThreads`
field) consume it. **Rust ignores it.**

This sub-project wires concurrency into the Rust engine and verifies the PHP
concurrency path. **cosmic-ray concurrency is explicitly a separate, later
sub-project** (it needs per-worker sandbox isolation — the risky part — and the
user chose "Rust now, Python separate").

## Goal

Deliver an out-of-box Rust mutation-testing speedup by passing cargo-mutants
`-j`, resolved from `RunOptions.concurrency` with a conservative default; and
verify + test the existing PHP `--threads` path.

### Non-goals

- cosmic-ray / Python concurrency (own sub-project).
- cargo-mutants `--in-diff` / diff-aware Rust scoping (own feature; touches the
  TS-only line/diff-scoping architecture).
- Any StrykerJS/TypeScript change.
- Reworking the `estimate_audit` timing projection to match real job counts
  (it is approximate; noted as a follow-up, not done here).

## Key facts (cargo-mutants, confirmed via current docs — mutants.rs)

1. **Default is serial** (`-j1`); parallelism is opt-in via `-j`/`--jobs`.
2. **Do NOT core-scale `-j` for Rust.** Docs: "Unlike with `make`, simply
   scaling `-j` with the number of cores is not effective due to the aggressive
   parallelization already present in Rust's build and test tools. Start
   conservatively with `-j2` or `-j3`."
3. **Each parallel job needs its own `target/` directory** (can be several GB) —
   real disk cost, on top of the sandbox's copied `target/`.
4. **Parallel results are deterministic** — identical to serial, differing only
   in output order. So `-j` is correctness-safe (no score/vulnerability change).

These facts drive the Rust-specific conservative default below and explicitly
override the generic "scale with cores" instinct.

## Decisions locked during brainstorming

1. **Scope: Rust concurrency only** (+ PHP verification). cosmic-ray deferred.
2. **`--in-diff` excluded** — concurrency only.
3. **Rust default is a low fixed cap, not core-scaled:** `-j2` when the machine
   has spare cores (`cpus >= 3`), else omit `-j` (serial). Overridable up/down
   via `concurrency` arg or `rust.concurrency` config.
4. **PHP stays at `--threads=max`** (design refinement, flagged for review):
   capping PHP down to the Rust default would *regress* PHP speed for no real
   benefit — Infection has no per-job build-copy, so the disk/thrash rationale
   that justifies capping Rust does not apply. PHP work here is verify + test
   only, not a behavior change. **If the reviewer prefers cross-engine default
   consistency over PHP throughput, this is the one knob to revisit.**

## Design

### 1. Rust engine — `src/engines/rust.ts`

Compute a jobs value and, when > 1, append `-j <n>` to the `cargo mutants`
args (before/after `--file`, order irrelevant):

- If `options.concurrency` is a valid integer ≥ 1 → use it.
- Else compute the conservative default: `cpus >= 3 ? 2 : 1`.
- When the resolved value is `1`, omit `-j` entirely (let cargo-mutants run its
  native serial path) — avoids emitting a redundant `-j1`.

`cpus` from `os.cpus().length`. A small exported helper
(`resolveCargoJobs(concurrency, cpuCount)`) keeps this pure and unit-testable,
mirroring the existing `resolveStrykerConcurrency` helper pattern. Parsing and
result handling are unchanged (parallel output is deterministic).

### 2. Concurrency plumbing — make resolution engine-aware

`buildRunOptions` (`src/handler.ts`) currently hardcodes:

```ts
concurrency: resolveConcurrency(args.concurrency, cfg.stryker?.concurrency ?? cfg.concurrency),
```

Generalize the config fallback to the **already-resolved engine section**
(`engCfg = cfg[configKey]`, computed just above), so each engine reads its own
section:

```ts
concurrency: resolveConcurrency(args.concurrency, engCfgConcurrency ?? cfg.concurrency),
```

where `engCfgConcurrency` reads `.concurrency` off the engine section when
present (Stryker + Rust have it; a narrow typed access / `'concurrency' in`
guard handles the union). StrykerJS behavior is unchanged (its section still
supplies `concurrency`); Rust now picks up `rust.concurrency`. PHP's threads
continue to flow via the separate `phpThreads` field (unchanged).

### 3. Rust config section — `src/utils/config-loader.ts`

Add a `concurrency` key to the Rust engine section:
- `CargoMutantsConfig` gains `concurrency?: number`.
- `KNOWN_RUST_KEYS` gains `'concurrency'`.
- The Rust section currently parses via the shared `parseTimeoutOnlyConfig`.
  Because that helper may also back other timeout-only sections, do **not**
  extend it (that would leak a `concurrency` key into them). Instead add a
  **dedicated** `parseCargoMutantsConfig(raw)` that validates `timeoutMs` (as
  before) **plus** `concurrency` as an integer 1–64 (same bounds as Stryker),
  and point the Rust entry in `ENGINE_CONFIG_SECTIONS` at it. Out-of-range /
  non-integer `concurrency` is warned-and-dropped by `validateConfig`
  (extend `validateEngineSection`'s numeric-key handling to cover it for Rust).

### 4. Contract docs — `src/engines/base.ts`

Update the `RunOptions.concurrency` doc comment: it currently says
"**Supported by:** StrykerJS … **Ignored by:** cosmic-ray, go-mutesting,
cargo-mutants." Correct to: honored by StrykerJS, cargo-mutants (`-j`), and
Infection (`--threads`); ignored by cosmic-ray. Note the Rust per-job `target/`
disk cost and the conservative-default rationale.

### 5. PHP verification — `src/engines/php.ts` (no behavior change)

Confirm `concurrency` → `--threads` flows (`phpThreads ?? concurrency ?? 'max'`)
and add the missing unit coverage. Leave the default at `max`.

## Testing

- **`rust.test.ts`** — `resolveCargoJobs`: explicit concurrency respected; default
  `2` when `cpus >= 3`; `1`/serial (no `-j`) when `cpus < 3`; and the engine
  appends `-j <n>` to the args only when > 1 (assert via the `invokeMutationTool`
  mock's captured args).
- **`config-loader.test.ts`** — `rust.concurrency` parsed; out-of-range
  (`0`, `65`, non-integer) warned and dropped; `timeoutMs` still works.
- **handler tests** — engine-aware resolution: a Rust audit resolves concurrency
  from `rust.concurrency`; a TS audit still from `stryker.concurrency`; arg
  overrides section; section overrides global `concurrency`.
- **`php-engine.test.ts`** — `--threads` present; default `max`; `concurrency`
  arg and `infection.threads` config both honored (fills the rogue-code gap).
- Full gate `npm run check` green.

## Risks

- **Disk on parallel Rust.** Each `-j` job copies `target/`. Mitigated by the
  low fixed default (`-j2`) and by it being overridable/serial-capable. Documented.
- **Engine-aware resolution regressing Stryker.** Mitigated by a handler test
  pinning that TS still reads `stryker.concurrency` and behaves identically.
- **PHP `max` default (unreviewed rogue code).** This sub-project adds the first
  real test coverage for it; if the tests reveal the flow is wrong, fix within
  scope.

## Out of scope / follow-ups

- **cosmic-ray concurrency** — next perf sub-project (http distributor +
  per-worker isolation).
- **`--in-diff` diff-aware Rust** — separate feature.
- **Independent review of the rogue PHP engine** beyond the threads path.
- Aligning `estimate_audit` timing to real per-engine job counts.
