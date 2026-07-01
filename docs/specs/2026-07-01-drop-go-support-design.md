# Drop Go / go-mutesting Support — Design

**Date:** 2026-07-01
**Status:** Approved (design), pending implementation plan
**Author:** brainstorming session (Chaos-MCP engine roster change)

## Context

Chaos-MCP wraps four language-specific mutation tools: StrykerJS (TS/JS),
cosmic-ray (Python), go-mutesting (Go), cargo-mutants (Rust). The Go engine is
the least-capable of the four (weak concurrency, no line scoping, JSON reporter
never confirmed) **and we have no Go project to dogfood it against** — so its
behavior is effectively unverifiable in practice. An untested engine is a
liability, not a feature.

This is the **first** of three sequenced sub-projects in a broader engine
initiative (decomposition chosen during brainstorming, "Approach B"):

1. **Drop Go** (this spec) — shrink the surface before we grow it.
2. Add PHP via Infection — restores the fourth language, with a real dogfood
   target and native `--threads` concurrency.
3. Performance uplift for existing engines — cargo-mutants `-j` (+ optional
   `--in-diff`), then cosmic-ray concurrency (the isolated, risky part).

Each sub-project gets its own spec → plan → implementation cycle. PHP follows
**immediately** after this one.

## Goal

Remove Go as a supported language cleanly, leaving no Go-shaped special case
behind, with a green `npm run check` as proof.

### Non-goals

- No PHP work (next spec).
- No performance work on any engine (third spec).
- No behavior change to the TypeScript, Python, or Rust engines.
- No rewriting of historical design/plan docs (see "Docs" below).

## Decisions locked during brainstorming

1. **Post-removal `.go` behavior: treated as `unsupported`.** A `.go` file
   falls through to the normal "unsupported file type" path — identical to any
   language we never supported (`.rb`, `.java`). No tailored "Go was removed"
   message; no residual `projectType: 'go'`. Cleanest possible removal.
2. **README keeps the "4 languages" framing.** PHP lands right after this, so
   we do not churn the headline count down to 3 and back to 4. The go-mutesting
   *engine-specific* rows (install prereqs, `go install …@latest`, the tool
   table entry, the test-runner row, the GitHub link) **are** removed — they
   would point at a deleted engine. Net interim state: the README says "4"
   while detailing 3, until the PHP spec restores the fourth. This gap is
   intentional and short-lived.
3. **A `.go → unsupported` regression test is added** — cheap insurance that
   locks in decision (1) so Go can't half-return via a stray detection entry.

## Approach: tighten the type unions first, let `tsc` drive the rest to zero

The safety of a broad removal comes from the type system. The plan removes
`'go'` from three unions early:

- `ProjectType` — `src/utils/project-detector.ts:7`
- `ExecutableTool` — `src/utils/exec-classify.ts:8`
- the `configKey` union — `src/engines/registry.ts:28`

`SupportedProjectType = Exclude<ProjectType, 'unsupported'>` narrows
automatically. The compiler then **flags every surviving Go reference** — the
`Record<SupportedProjectType>` registry entry, the `canonicalizeMutator`
dispatch, config-section maps, etc. The removal is therefore not "grep and hope"
but "tighten the unions, then delete whatever `tsc` reddens." No reference can
silently survive a green build.

## Blast radius (inventory)

~230 references across 40+ files. Grouped by action:

### Deleted outright (whole files)

- `src/engines/go.ts`
- `src/__tests__/go-engine.test.ts`
- `src/__tests__/e2e-go.test.ts` (fixture + E2E)

### Deleted in place (Go-specific blocks)

- `src/enrich.ts` — `GO_MUTATOR_MAP` (lines ~120-134) and the
  `projectType === 'go'` dispatch in `canonicalizeMutator` (~201-202); its doc
  comment about Go JSON enrichment (~173-175).
- `src/utils/project-detector.ts` — `GO_ROOT_MARKERS`,
  `detectGoTestRunner`/`detectRawGoRunner`, `LANGUAGE_DETECTORS.go`, and `'go'`
  from `ProjectType`.
- `src/engines/registry.ts` — the `GoEngine` import, the `go` `ENGINE_REGISTRY`
  entry (incl. `prebuild: { marker: 'go.mod', command: 'go mod download' }`),
  and `'go'` from the `configKey` union.
- `src/utils/config-loader.ts` — `'go'` from `KNOWN_KEYS`, `KNOWN_GO_KEYS`,
  `GoMutestingConfig`, `ChaosConfig.go?`, `ENGINE_CONFIG_SECTIONS.go`.
- `src/utils/exec-classify.ts` — `'go-mutesting'` from `ExecutableTool`, its
  `INSTALL_HINTS` entry.
- `src/baseline-timing.ts` — the Go baseline command
  (`{ command: 'go', args: ['test', './...'] }`).
- `src/test-file.ts` — the `${base}_test.go` candidate(s).
- `src/triage.ts` — `.go` from `SUPPORTED_EXT`.
- `src/tool-schema.ts` — `.go` from the accepted extensions, "Go (go-mutesting)"
  from the tool description, `.go` from the resource description.
- `src/cli.ts` — "Go (via go-mutesting)" help text, the `src/logic.go` /
  `go build ./...` examples, the go-mutesting link.
- `src/resources.ts` — `ENGINE_NAMES.go`, the `go` config-schema key doc.
- `src/estimate.ts` — Go mentions in the heuristic comments (~95, ~130).
- `src/engines/base.ts` — drop "go-mutesting" from the "Ignored by:" /
  wrapped-message comments (~79, ~99, ~159, ~232) so docs match reality.
- `src/handler.ts` — Go mentions in the timeout-only-section comment (~406) and
  the auto-prebuild comment (~496-497).

### Tests edited (drop the Go case, keep the file)

`baseline-timing.test.ts`, `config-loader.test.ts`, `enrich-canonicalize.test.ts`,
`enrich-group.test.ts`, `estimate.test.ts`, `format-enrich.test.ts`,
`handler-helpers.test.ts`, `handler.test.ts`, `project-detector.test.ts`,
`registry.test.ts`, `resources.test.ts`, `test-file.test.ts`,
`exec-classify.test.ts`.

Watch for **count/enumeration assertions** (e.g. registry has N languages,
resources list all engines, `chaos://languages` contents) — these must move from
4→3 languages, not just have a row deleted.

### Test added

- A regression test asserting a `.go` file routes to the `unsupported` path in
  both the audit and estimate handlers (locks decision 1).

### Docs updated (living docs only)

- `README.md` — remove go-mutesting engine rows (tool table, prereqs,
  `go install …`, Go test-runner row, GitHub link). **Keep** the "4 languages"
  headline (decision 2).
- `CLAUDE.md` — "four language-specific mutation tools" → "three"; drop
  "go-mutesting (Go)" from the line-7 summary.
- `CONTRIBUTING.md` — remove the `go.ts` directory-structure line and
  go-mutesting from the version-bump list.

### Docs deliberately NOT touched

All dated files under `docs/specs/` and `docs/plans/` (and the
`docs/superpowers/` equivalents) mention Go as part of past work. They are
**historical records** — rewriting them to erase Go would falsify the project's
own history. They stay exactly as written. Only living, forward-facing docs
(README/CLAUDE/CONTRIBUTING) are updated.

## Testing & validation

- **Gate:** `npm run check` (build → lint → format:check → test) must pass on
  the branch. Because the unions are tightened first, a green build is strong
  evidence no Go-shaped reference remains.
- **Positive regression:** the new `.go → unsupported` test.
- **Enumeration audit:** manually confirm every "list of languages/engines"
  assertion (registry, resources, `chaos://languages`) reflects 3 engines.
- **Self-check:** `npm test` requires a prior `build/`; the removal must not
  break the `build-output` / `version-sync` / `audit-self` / `meta-test`
  imports (none reference Go, but re-run to be sure).

## Risks

- **Missed reference → red build.** Mitigated by the union-first strategy; `tsc`
  surfaces stragglers.
- **Silent enumeration drift.** A test that counts languages could pass with a
  stale hardcoded 4. Mitigated by the explicit enumeration audit step above.
- **Config back-compat.** A user's existing `chaos-mcp.config.json` may carry a
  `go` section. With `go` removed from `KNOWN_KEYS`, confirm the loader treats
  an unknown section as ignorable (warn, not fatal) rather than throwing —
  verify the existing unknown-key handling covers this, add a test if not.

## Out of scope / follow-ups

- PHP / Infection engine — **next spec, immediately after.**
- Engine performance uplift (cargo `-j`, cosmic-ray concurrency) — third spec.
