# Chaos-MCP Agent-Experience Improvements — Roadmap

**Date:** 2026-06-27
**Status:** Approved (decomposition + sequencing)
**Scope:** 14 improvements to make Chaos-MCP better for the LLM agent that consumes it.

## Motivation

The natural agent loop is **triage a tree → drill into the weakest file → write tests →
re-verify those mutants → repeat**. The building blocks exist (`triage` → `audit` → `audit`
with `baseline`), but the agent has to hand-stitch them and shuttle a lot of state back and
forth. These 14 features target that seam: richer/cheaper output, a first-class scan, a
closed verify loop, new capability tools, and protocol polish.

Each phase is an independent spec → plan → implementation cycle and ships as its own PR.

## Phases

### Phase 1 — Output & enrichment layer (FIRST; foundational)
Everything downstream renders through the formatter, so this lands first.
- **#4** `structuredContent` output schema (additive: structured object + text block)
- **#5** enrich on-by-default, severity-ranked, capped at `maxSurvivors` (default 10, configurable)
- **#9** `suggestedTestFile` (project-aware discovery + conventional fallback)
- **#10** enrich Go now (go-mutesting JSON reporter + mutator→category map); Python stays `unknown`
- **#12** `severityFloor` report-time filter

Detailed spec: `2026-06-27-phase1-output-enrichment-design.md`.

### Phase 2 — Triage as a first-class scanner (builds on Phase 1 formatter)
- **#1** `diffBase` on `triage_test_coverage` (auto-discover changed files vs a git base)
- **#3** inline top survivors per ranked file (budgeted) to kill the follow-up round-trips
- **#11** bounded-parallel triage (per-file sandboxes already isolate; add a worker pool)

### Phase 3 — The verify loop & state (introduces persistence; architectural shift)
- **#2** `runId` returned from `audit`, baseline cached server-side so verify mode needs only the id
- **#8** equivalent-mutant suppression list (persisted ignore list keyed by file+line+mutator)

Open decision deferred to Phase 3 design: where state lives (`os.tmpdir()` cache vs a repo
file such as `.chaos-mcp/`). Also revisit Python enrichment (#10 remainder) here, since
`mutmut show <id>` per survivor fits a stateful flow better.

### Phase 4 — New capability tools
- **#6** `estimate_audit` — mutant count / cost estimate via a dry run, no full test cycle
- **#7** gate mode — `minScore` arg returning an explicit `passed: true/false`

### Phase 5 — Protocol upgrades
- **#13** progress notifications + cancellation (long runs become observable / abortable)
- **#14** MCP resources/prompts (expose supported languages, config schema, a canonical
  "harden this file" prompt)

## Sequencing rationale

Formatter first (Phase 1) because triage's inline survivors (#3) and any future per-file
reporting render through it. Triage next (Phase 2) because it's pure value with no new state.
State (Phase 3) is the riskiest change and benefits from the stable output contract underneath
it. New tools (Phase 4) and protocol polish (Phase 5) are additive and independent, so they
come last.
