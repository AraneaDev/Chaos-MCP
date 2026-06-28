# Phase 5 — Protocol Upgrades

**Date:** 2026-06-28
**Status:** Approved design (pending written-spec sign-off)
**Branch:** `feat/phase5-protocol-upgrades`
**Roadmap:** `2026-06-27-chaos-mcp-agent-improvements-roadmap.md` (final phase)

## Goal

Make Chaos-MCP a well-behaved long-running MCP citizen and self-describing to agents:

- **#13 progress notifications + cancellation** — long audit/triage runs become observable
  (progress) and abortable (cancellation).
- **#14 MCP resources + prompts** — expose supported languages, the config schema, a capabilities
  overview, and two canonical workflow prompts.

Both are additive protocol surface. The three existing tools keep their behavior; new context
plumbing is **optional** so every existing handler test (which calls `handler(request, config)`)
still passes unchanged.

Verified feasible against the installed SDK **1.29.0**: handler `extra` carries `signal: AbortSignal`
and `sendNotification`; `_meta.progressToken` is on requests; `ListResources`/`ReadResource`/
`ListPrompts`/`GetPrompt` request schemas and `Progress`/`Cancelled` notification schemas all exist;
Node `execFile`/`exec` accept an `AbortSignal`.

## Approved decisions

1. **Progress granularity:** triage emits per-file `X/N`; audit emits coarse phase milestones;
   estimate emits none. (Engines run as a single subprocess — no per-mutant stream is possible.)
2. **Cancellation depth:** wire the request `AbortSignal` through to the subprocess for **all**
   subprocess-running tools (audit, triage, estimate native + withTiming), with sandbox cleanup
   preserved.
3. **Resources:** `chaos://languages`, `chaos://config-schema`, `chaos://capabilities`.
4. **Prompts:** `harden_file(filePath)`, `triage_changes(diffBase)`.

## Component 1 — Request context plumbing (`src/tool-context.ts`)

The SDK calls `setRequestHandler(schema, (request, extra) => …)`. `extra` is
`RequestHandlerExtra` with `signal: AbortSignal` and `sendNotification`. The progress token lives
at `request.params._meta?.progressToken` (string|number).

```ts
export interface ToolContext {
  signal?: AbortSignal;
  /** No-op when the client supplied no progressToken. */
  reportProgress?: (progress: number, total?: number, message?: string) => void;
}

export function makeToolContext(
  request: { params?: { _meta?: { progressToken?: string | number } } },
  extra?: { signal?: AbortSignal; sendNotification?: (n: unknown) => Promise<void> },
): ToolContext;
```

- `makeToolContext` reads `progressToken` from the request `_meta`. When a token AND
  `sendNotification` are present, `reportProgress` sends
  `{ method: 'notifications/progress', params: { progressToken, progress, total?, message? } }`
  (fire-and-forget; a send failure is swallowed — progress must never break a run). When no token,
  `reportProgress` is `undefined` (callers guard with `ctx.reportProgress?.(…)`).
- The three tool handlers gain an **optional** trailing `ctx?: ToolContext` parameter. `index.ts`
  builds `ctx = makeToolContext(request, extra)` and passes it. Tests that omit `ctx` are unaffected.

## Component 2 — Progress (#13)

- **triage (`triage-handler.ts`):** a shared completed-counter; each `auditOne` calls
  `ctx?.reportProgress?.(++done, files.length, \`audited ${done}/${files.length}\`)` on completion
  (inside the pool, so it reflects real completions, not input order). Fired regardless of
  success/error per file (a file that errors still advances the count).
- **audit (`handler.ts`):** milestones at phase boundaries — `reportProgress(1, 4, 'validating')`,
  `(2, 4, 'provisioning sandbox')`, `(3, 4, 'running mutation engine')`, `(4, 4, 'complete')`.
  The verify-mode and no-changes short-circuits report a terminal `(4,4,'complete')`.
- **estimate:** none.
- All calls are guarded (`ctx?.reportProgress?.(…)`), so absent token → zero overhead.

## Component 3 — Cancellation (#13)

- **`utils/exec.ts`:** `runShell` / `runShellCommand` options gain `signal?: AbortSignal`, passed
  straight into `execFile`/`exec` options. Node kills the child with SIGTERM on abort; the existing
  `ExecFailureError` classification already handles signal-killed processes.
- **`utils/exec-classify.ts`:** `invokeMutationTool` options already forward `{ cwd, timeoutMs, env }`;
  add `signal` to that forwarded set.
- **`engines/base.ts`:** `RunOptions` gains `signal?: AbortSignal`. Each of the four engines
  (`typescript`/`python`/`go`/`rust`) forwards `options?.signal` into its `invokeMutationTool`
  call(s). `BaseEngine.toExecFailure` is unaffected.
- **Handlers:** thread `ctx?.signal` into the engine run (audit via `buildRunOptions`/`auditFile`;
  triage per file; estimate native `cargo mutants --list` + the `withTiming` baseline `runShell`).
  Check `ctx?.signal?.aborted` at phase boundaries — **before** the expensive sandbox copy and
  **before** the engine run — to short-circuit with a cancelled result without wasted work.
- **On abort:** the subprocess is killed, the per-run `finally` still removes the sandbox (no leak),
  and the handler returns a clean tool result `"Operation cancelled."` (a normal result, not
  `isError`; harmless if the client already discarded the request). Triage marks remaining files as
  not-audited and returns what completed.

## Component 4 — Resources (#14, `src/resources.ts`)

Capability `resources: {}`. `index.ts` registers `ListResourcesRequestSchema` and
`ReadResourceRequestSchema` handlers delegating to this module.

```ts
export function listResources(): { uri: string; name: string; description: string; mimeType: string }[];
export function readResource(uri: string): { uri: string; mimeType: string; text: string };  // throws on unknown uri
```

- `chaos://languages` (application/json) — built from `ENGINE_REGISTRY`: per language `{ engine,
  supportsLineScope, estimateFidelity: 'exact'|'approx', configKey, autoPrebuild }`.
- `chaos://config-schema` (application/json) — config keys (from `config-loader` `KNOWN_KEYS`) each
  with type, bounds, and a one-line meaning.
- `chaos://capabilities` (text/markdown or json) — the three tools, their key args, and the
  triage→audit→write-tests→verify loop in one place.
- Unknown URI → throw a McpError (the SDK maps it to a proper JSON-RPC error). All content is
  derived from existing single-sources-of-truth (registry/config) so it cannot drift.

## Component 5 — Prompts (#14, `src/prompts.ts`)

Capability `prompts: {}`. `index.ts` registers `ListPromptsRequestSchema` and
`GetPromptRequestSchema` handlers delegating here.

```ts
export function listPrompts(): { name: string; description: string; arguments: { name: string; description: string; required: boolean }[] }[];
export function getPrompt(name: string, args: Record<string, string>): { description: string; messages: { role: 'user'; content: { type: 'text'; text: string } }[] };  // throws on unknown name
```

- `harden_file` (arg `filePath`, required) — a user-role message walking the loop: optionally
  `estimate_audit` first; `audit_code_resilience` the file; for each survivor write/strengthen a
  test; re-run with the returned `runId` to verify; repeat until clean; suppress only true
  equivalents.
- `triage_changes` (arg `diffBase`, required) — `triage_test_coverage` with `diffBase` to rank the
  PR's changed files weakest-first, then `harden_file` the weakest.
- Unknown prompt name → McpError. A missing required argument → McpError with a clear message.

## Component 6 — Server wiring (`src/index.ts`)

- Capabilities become `{ tools: {}, resources: {}, prompts: {} }`.
- Register four new handlers (list/read resources, list/get prompts) delegating to the modules.
- In the existing `CallToolRequestSchema` handler, build `const ctx = makeToolContext(request, extra)`
  and pass it to `handleToolCall`/`handleTriageCall`/`handleEstimateCall`.
- Keep `index.ts` import side-effect free (the `isDirectRun` guard).

## Error handling

- No `progressToken` → `reportProgress` undefined → all progress calls no-op.
- `sendNotification` rejection → swallowed (progress is best-effort).
- Abort → subprocess killed, sandbox cleaned in `finally`, cancelled result returned; never a leak.
- Unknown resource URI / unknown prompt name / missing required prompt arg → McpError.
- Existing tool error paths unchanged.

## Testing

- `makeToolContext`: token present → reporter sends a well-formed notification; token absent →
  reporter undefined; `sendNotification` rejection swallowed.
- Progress: triage emits `done/total` per completed file (mock the pool/engine); audit emits the
  four milestones in order; estimate emits none.
- Cancellation: a pre-aborted signal short-circuits before sandbox/engine; `runShell` passes the
  signal to `execFile` (assert via a mock) and an abort mid-run yields a cancelled result with the
  sandbox cleaned; per-engine signal forwarding (assert `invokeMutationTool` received it).
- Resources: `listResources` shape; `readResource` for each URI returns valid JSON/markdown built
  from the registry/config; unknown URI throws.
- Prompts: `listPrompts` shape + argument defs; `getPrompt` for each renders messages including the
  passed arg; unknown name throws; missing required arg throws.
- `index.ts`: capabilities include resources+prompts; the four new handlers are registered; the tool
  dispatch passes a `ctx`. Existing ListTools/registration tests updated only as needed.
- Gate: `npm run check` green on Node 22/24; ALL existing handler/triage/estimate tests stay green
  (ctx optional); self-mutation smoke best-effort.

## Out of scope (Phase 5 / roadmap end)

- Per-mutant progress (engines don't expose it).
- Resource subscriptions / templated resources, prompt completions, sampling, auth.
- Any new audit/triage/estimate behavior — this phase only adds protocol surface + observability.
- There is no Phase 6; this completes the 14-item roadmap.
