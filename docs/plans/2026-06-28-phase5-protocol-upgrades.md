# Phase 5 — Protocol Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MCP progress notifications + cancellation to long runs, and expose resources + prompts, all additively.

**Architecture:** An optional `ToolContext` (signal + token-gated progress reporter) is built from the SDK handler `extra` and threaded into the three tool handlers. Cancellation flows `exec → invokeMutationTool → RunOptions → 4 engines`. Resources and prompts are pure modules wired into `index.ts` as new request handlers.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Vitest, `@modelcontextprotocol/sdk` 1.29.0, Node `child_process` (execFile/exec with AbortSignal).

## Global Constraints

- ESM throughout: every relative import uses a `.js` specifier resolving to `.ts`.
- `npm test` REQUIRES a prior `npm run build` (tests import `../build/index.js`).
- Each task runs the FULL gate before committing: `npm run build && npm run lint && npm run format:check && npm test`. Fix formatting via `npm run format`.
- Preserve audit-tag comments (`C2`, `H5`, `Med#`, `A2`/`A3`, `A9`, etc.) on lines you touch.
- `APP_VERSION` stays the literal `export const APP_VERSION = '<semver>';` in `src/index.ts` — do not touch.
- Importing `index.ts` must stay side-effect free (the `isDirectRun` guard).
- **`ToolContext` is OPTIONAL on every handler** — existing tests call `handler(request, config)` with no ctx and MUST stay green.
- Progress is best-effort: no `progressToken` → no-op; a `sendNotification` rejection is swallowed and never breaks a run.
- Cancellation must preserve sandbox cleanup (the per-run `finally` always removes the sandbox).
- No `any` in `src/` (tests may use `Record<string, unknown>` casts, matching existing style).
- Conventional Commits.

---

### Task 1: ToolContext (`src/tool-context.ts`)

**Files:**
- Create: `src/tool-context.ts`
- Test: `src/__tests__/tool-context.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ToolContext {
    signal?: AbortSignal;
    reportProgress?: (progress: number, total?: number, message?: string) => void;
  }
  export function makeToolContext(
    request: { params?: { _meta?: { progressToken?: string | number } } },
    extra?: { signal?: AbortSignal; sendNotification?: (n: unknown) => Promise<void> },
  ): ToolContext;
  ```
  When a `progressToken` AND `sendNotification` are present, `reportProgress` sends a `notifications/progress` message; otherwise `reportProgress` is `undefined`. `signal` is copied from `extra.signal`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/__tests__/tool-context.test.ts
import { describe, it, expect, vi } from 'vitest';
import { makeToolContext } from '../tool-context.js';

describe('makeToolContext', () => {
  it('builds a reporter that sends a progress notification when a token is present', async () => {
    const sent: unknown[] = [];
    const sendNotification = vi.fn(async (n: unknown) => { sent.push(n); });
    const ctx = makeToolContext({ params: { _meta: { progressToken: 'tok1' } } }, { sendNotification });
    expect(ctx.reportProgress).toBeTypeOf('function');
    ctx.reportProgress!(3, 10, 'audited 3/10');
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(sent[0]).toEqual({
      method: 'notifications/progress',
      params: { progressToken: 'tok1', progress: 3, total: 10, message: 'audited 3/10' },
    });
  });

  it('reporter is undefined when no progressToken', () => {
    const ctx = makeToolContext({ params: { _meta: {} } }, { sendNotification: vi.fn() });
    expect(ctx.reportProgress).toBeUndefined();
  });

  it('reporter is undefined when no sendNotification', () => {
    const ctx = makeToolContext({ params: { _meta: { progressToken: 'x' } } }, {});
    expect(ctx.reportProgress).toBeUndefined();
  });

  it('copies the abort signal', () => {
    const ac = new AbortController();
    const ctx = makeToolContext({ params: {} }, { signal: ac.signal });
    expect(ctx.signal).toBe(ac.signal);
  });

  it('swallows a sendNotification rejection', () => {
    const sendNotification = vi.fn(async () => { throw new Error('boom'); });
    const ctx = makeToolContext({ params: { _meta: { progressToken: 1 } } }, { sendNotification });
    expect(() => ctx.reportProgress!(1, 2)).not.toThrow();
  });

  it('omits total/message when not provided', () => {
    const sendNotification = vi.fn(async () => {});
    const ctx = makeToolContext({ params: { _meta: { progressToken: 'p' } } }, { sendNotification });
    ctx.reportProgress!(5);
    expect(sendNotification).toHaveBeenCalledWith({
      method: 'notifications/progress',
      params: { progressToken: 'p', progress: 5 },
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/__tests__/tool-context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/tool-context.ts

/** Per-request capabilities derived from the MCP handler `extra`. */
export interface ToolContext {
  /** Abort signal for the request; aborting kills in-flight subprocesses. */
  signal?: AbortSignal;
  /** Token-gated progress reporter; undefined when the client sent no progressToken. */
  reportProgress?: (progress: number, total?: number, message?: string) => void;
}

interface RequestLike {
  params?: { _meta?: { progressToken?: string | number } };
}
interface ExtraLike {
  signal?: AbortSignal;
  sendNotification?: (n: unknown) => Promise<void>;
}

/**
 * Build a {@link ToolContext} from an MCP request + handler `extra`. The
 * progress reporter is created only when both a `progressToken` (request
 * `_meta`) and a `sendNotification` (extra) are available; otherwise it is
 * undefined and callers no-op via `ctx.reportProgress?.(…)`. Progress sends are
 * fire-and-forget — a rejected notification is swallowed so it can never break
 * an actual run.
 */
export function makeToolContext(request: RequestLike, extra?: ExtraLike): ToolContext {
  const token = request.params?._meta?.progressToken;
  const send = extra?.sendNotification;
  const ctx: ToolContext = { signal: extra?.signal };
  if (token !== undefined && send) {
    ctx.reportProgress = (progress: number, total?: number, message?: string) => {
      const params: Record<string, unknown> = { progressToken: token, progress };
      if (total !== undefined) params.total = total;
      if (message !== undefined) params.message = message;
      void Promise.resolve(send({ method: 'notifications/progress', params })).catch(() => {});
    };
  }
  return ctx;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/__tests__/tool-context.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/tool-context.ts src/__tests__/tool-context.test.ts
git commit -m "feat: ToolContext — signal + token-gated progress reporter"
```

---

### Task 2: Cancellation plumbing (`exec.ts`, `exec-classify.ts`, `engines/base.ts`, 4 engines)

This is the broad mechanical thread — keep it one task so a reviewer sees it whole.

**Files:**
- Modify: `src/utils/exec.ts` (`runShell` ~156, `runShellCommand` ~66 — add `signal` to options → execFile/exec)
- Modify: `src/utils/exec-classify.ts` (`invokeMutationTool` ~54 — add `signal` to forwarded options)
- Modify: `src/engines/base.ts` (`RunOptions` — add `signal?: AbortSignal`)
- Modify: `src/engines/typescript.ts:229`, `src/engines/python.ts:262,300`, `src/engines/go.ts:172`, `src/engines/rust.ts:162` (forward `options?.signal`)
- Test: `src/__tests__/exec-signal.test.ts`; extend an engine test if one exists for forwarding

**Interfaces:**
- Produces: `runShell`/`runShellCommand` options accept `signal?: AbortSignal`; `invokeMutationTool` options accept `signal?: AbortSignal`; `RunOptions.signal?: AbortSignal`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/exec-signal.test.ts
import { describe, it, expect, vi } from 'vitest';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
  exec: vi.fn(),
}));

import { runShell } from '../utils/exec.js';

describe('runShell signal', () => {
  it('forwards an AbortSignal into execFile options', () => {
    const ac = new AbortController();
    // execFile(file, args, options, cb) — capture options; invoke cb to resolve.
    execFileMock.mockImplementation((_f: string, _a: string[], opts: Record<string, unknown>, cb: (e: unknown, o: string, er: string) => void) => {
      expect(opts.signal).toBe(ac.signal);
      cb(null, 'ok', '');
      return { } as unknown;
    });
    return runShell('echo', ['hi'], { signal: ac.signal }).then((r) => {
      expect(r.stdout).toBe('ok');
    });
  });
});
```

Note: confirm the real `runShell` resolve/reject shape (it builds an `ExecResult` from the callback). Match the callback args (`err, stdout, stderr`) to the real implementation when mocking. If the existing exec tests already mock `child_process`, follow their exact mock shape instead of this sketch.

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run src/__tests__/exec-signal.test.ts`
Expected: FAIL — `opts.signal` is `undefined` (not yet forwarded).

- [ ] **Step 3: Implement**

`src/utils/exec.ts`:
- `runShell` options type → `{ cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal }`; destructure `signal`; add `signal` to the `execFile` options object (alongside `cwd`, `timeout`, `env`).
- `runShellCommand` options type → add `signal?: AbortSignal`; add `signal` to the `exec` options object.

`src/utils/exec-classify.ts`:
- `invokeMutationTool` options type → add `signal?: AbortSignal`. It already forwards the whole `options` object to `runShell`, so once the type includes `signal`, it flows through — but pass it explicitly if the call destructures. Verify it forwards `signal`.

`src/engines/base.ts`:
- Add to `RunOptions`:
  ```ts
  /** Abort signal; when aborted, the mutation subprocess is killed. */
  signal?: AbortSignal;
  ```

Each engine — add `signal: options?.signal` (or `options.signal`, matching how each reads RunOptions) to the options object passed to `invokeMutationTool`:
- `typescript.ts:229` → `invokeMutationTool('StrykerJS', args[0], args.slice(1), { cwd, timeoutMs, signal: options?.signal })`
- `python.ts:262` → add `signal: options?.signal` to that options object; `:300` (the `mutmut results` call) → add `signal: options?.signal` too.
- `go.ts:172` → add `signal: options?.signal`.
- `rust.ts:162` → add `signal: options?.signal`.
(Read each call's surrounding code to use the exact variable name the engine holds RunOptions under — it may be `options` or destructured.)

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run src/__tests__/exec-signal.test.ts && npm test`
Expected: PASS; full suite green (signal is additive/optional).

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/utils/exec.ts src/utils/exec-classify.ts src/engines/ src/__tests__/exec-signal.test.ts
git commit -m "feat: thread AbortSignal through exec, invokeMutationTool, RunOptions, and all engines"
```

---

### Task 3: Resources (`src/resources.ts`)

**Files:**
- Create: `src/resources.ts`
- Test: `src/__tests__/resources.test.ts`

**Interfaces:**
- Consumes: `ENGINE_REGISTRY`, `SupportedProjectType` from `./engines/registry.js`.
- Produces:
  ```ts
  export interface ResourceListing { uri: string; name: string; description: string; mimeType: string }
  export function listResources(): ResourceListing[];
  export function readResource(uri: string): { uri: string; mimeType: string; text: string }; // throws Error on unknown uri
  ```
  Three URIs: `chaos://languages`, `chaos://config-schema`, `chaos://capabilities`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/__tests__/resources.test.ts
import { describe, it, expect } from 'vitest';
import { listResources, readResource } from '../resources.js';

describe('resources', () => {
  it('lists exactly the three resources', () => {
    const uris = listResources().map((r) => r.uri).sort();
    expect(uris).toEqual(['chaos://capabilities', 'chaos://config-schema', 'chaos://languages']);
    for (const r of listResources()) {
      expect(r.name).toBeTruthy();
      expect(r.description).toBeTruthy();
      expect(r.mimeType).toBeTruthy();
    }
  });

  it('reads languages as JSON built from the engine registry', () => {
    const res = readResource('chaos://languages');
    expect(res.mimeType).toBe('application/json');
    const data = JSON.parse(res.text) as Record<string, { engine: string; supportsLineScope: boolean; estimateFidelity: string }>;
    expect(data.typescript.supportsLineScope).toBe(true);
    expect(data.rust.estimateFidelity).toBe('exact');
    expect(data.typescript.estimateFidelity).toBe('approx');
  });

  it('reads config-schema as JSON listing known keys', () => {
    const res = readResource('chaos://config-schema');
    expect(res.mimeType).toBe('application/json');
    const data = JSON.parse(res.text) as Record<string, unknown>;
    expect(data.defaultMaxSurvivors).toBeDefined();
    expect(data.suppressionsPath).toBeDefined();
  });

  it('reads capabilities (markdown) mentioning all three tools', () => {
    const res = readResource('chaos://capabilities');
    expect(res.text).toContain('audit_code_resilience');
    expect(res.text).toContain('triage_test_coverage');
    expect(res.text).toContain('estimate_audit');
  });

  it('throws on an unknown uri', () => {
    expect(() => readResource('chaos://nope')).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run src/__tests__/resources.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/resources.ts
import { ENGINE_REGISTRY, type SupportedProjectType } from './engines/registry.js';

export interface ResourceListing {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

const LANGUAGES_URI = 'chaos://languages';
const CONFIG_URI = 'chaos://config-schema';
const CAPABILITIES_URI = 'chaos://capabilities';

export function listResources(): ResourceListing[] {
  return [
    { uri: LANGUAGES_URI, name: 'Supported languages', description: 'Languages, their mutation engine, line-scope support, and estimate fidelity.', mimeType: 'application/json' },
    { uri: CONFIG_URI, name: 'Config schema', description: 'chaos-mcp.config.json keys with types and meaning.', mimeType: 'application/json' },
    { uri: CAPABILITIES_URI, name: 'Capabilities overview', description: 'The three tools, their arguments, and the triage→audit→verify workflow.', mimeType: 'text/markdown' },
  ];
}

/** Engine display names keyed by language (kept here as the doc-facing label). */
const ENGINE_NAMES: Record<SupportedProjectType, string> = {
  typescript: 'StrykerJS',
  python: 'Mutmut',
  go: 'go-mutesting',
  rust: 'cargo-mutants',
};

function languagesJson(): string {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(ENGINE_REGISTRY) as SupportedProjectType[]) {
    const entry = ENGINE_REGISTRY[key];
    out[key] = {
      engine: ENGINE_NAMES[key],
      supportsLineScope: entry.supportsLineScope,
      estimateFidelity: key === 'rust' ? 'exact' : 'approx',
      configKey: entry.configKey,
      autoPrebuild: Boolean(entry.prebuild),
    };
  }
  return JSON.stringify(out, null, 2);
}

function configSchemaJson(): string {
  const keys = {
    defaultTimeoutMs: 'integer ms — per-run mutation timeout.',
    perMutantTimeoutMs: 'integer ms — per-mutant timeout (StrykerJS).',
    mutatorDenylist: 'string[] — mutator names to skip.',
    defaultMaxSurvivors: 'integer ≥ 1 — cap on reported survivor groups (default 10).',
    defaultSeverityFloor: '"high"|"medium"|"low" — drop survivor groups below this severity.',
    defaultFileConcurrency: 'integer 1–64 — triage file-level worker pool size.',
    suppressionsPath: 'string — path to the equivalent-mutant suppressions file (default .chaos-mcp/suppressions.json).',
    runCacheTtlMs: 'integer > 0 — runId cache TTL (default 86400000).',
    runCacheMax: 'integer ≥ 1 — runId cache max entries (default 200).',
    allowPrebuild: 'boolean — allow caller-supplied prebuildCommand (default false).',
    stryker: 'object — StrykerJS-specific overrides.',
    mutmut: 'object — Mutmut-specific overrides.',
    go: 'object — go-mutesting-specific overrides.',
    rust: 'object — cargo-mutants-specific overrides.',
  };
  return JSON.stringify(keys, null, 2);
}

function capabilitiesMarkdown(): string {
  return [
    '# Chaos-MCP capabilities',
    '',
    '## Tools',
    '- **audit_code_resilience** — mutation-test one file. Args: filePath, lineScope/diffBase/baseline/runId, suppress/unsuppress, enrich, maxSurvivors, severityFloor, minScore, prebuildCommand. Returns survivors + a runId.',
    '- **triage_test_coverage** — rank a tree weakest-first. Args: paths and/or diffBase, maxFiles, survivorsPerFile, fileConcurrency, minScore. Returns a ranking + per-file runIds.',
    '- **estimate_audit** — cheap pre-flight mutant-count (no test cycle). Args: filePath, withTiming. Returns mutants + fidelity.',
    '',
    '## The loop',
    '1. `triage_test_coverage` (optionally with diffBase) to find the weakest files.',
    '2. `audit_code_resilience` the weakest file; write tests for the reported survivors.',
    '3. Re-run `audit_code_resilience` with the returned `runId` to verify those mutants are now killed.',
    '4. Use `minScore` to gate; suppress only genuinely-equivalent mutants.',
    '',
  ].join('\n');
}

export function readResource(uri: string): { uri: string; mimeType: string; text: string } {
  switch (uri) {
    case LANGUAGES_URI:
      return { uri, mimeType: 'application/json', text: languagesJson() };
    case CONFIG_URI:
      return { uri, mimeType: 'application/json', text: configSchemaJson() };
    case CAPABILITIES_URI:
      return { uri, mimeType: 'text/markdown', text: capabilitiesMarkdown() };
    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
}
```

Note: verify the real `SupportedProjectType` members and `ENGINE_REGISTRY` entry fields (`supportsLineScope`, `configKey`, `prebuild`) before finalizing; adjust `ENGINE_NAMES` keys to the exact union. If the registry already exposes an engine display name, prefer that over the local map.

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run src/__tests__/resources.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/resources.ts src/__tests__/resources.test.ts
git commit -m "feat: MCP resources — languages, config schema, capabilities"
```

---

### Task 4: Prompts (`src/prompts.ts`)

**Files:**
- Create: `src/prompts.ts`
- Test: `src/__tests__/prompts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PromptListing { name: string; description: string; arguments: { name: string; description: string; required: boolean }[] }
  export interface PromptResult { description: string; messages: { role: 'user'; content: { type: 'text'; text: string } }[] }
  export function listPrompts(): PromptListing[];
  export function getPrompt(name: string, args: Record<string, string>): PromptResult; // throws on unknown name / missing required arg
  ```
  Prompts: `harden_file` (arg `filePath`, required), `triage_changes` (arg `diffBase`, required).

- [ ] **Step 1: Write the failing tests**

```ts
// src/__tests__/prompts.test.ts
import { describe, it, expect } from 'vitest';
import { listPrompts, getPrompt } from '../prompts.js';

describe('prompts', () => {
  it('lists harden_file and triage_changes with their required args', () => {
    const byName = Object.fromEntries(listPrompts().map((p) => [p.name, p]));
    expect(byName.harden_file.arguments).toEqual([{ name: 'filePath', description: expect.any(String), required: true }]);
    expect(byName.triage_changes.arguments).toEqual([{ name: 'diffBase', description: expect.any(String), required: true }]);
  });

  it('renders harden_file with the file path interpolated', () => {
    const res = getPrompt('harden_file', { filePath: 'src/math.ts' });
    expect(res.messages[0].role).toBe('user');
    const text = res.messages[0].content.text;
    expect(text).toContain('src/math.ts');
    expect(text).toContain('audit_code_resilience');
    expect(text).toContain('runId');
  });

  it('renders triage_changes with the diff base interpolated', () => {
    const text = getPrompt('triage_changes', { diffBase: 'main' }).messages[0].content.text;
    expect(text).toContain('main');
    expect(text).toContain('triage_test_coverage');
  });

  it('throws on an unknown prompt name', () => {
    expect(() => getPrompt('nope', {})).toThrow();
  });

  it('throws when a required argument is missing', () => {
    expect(() => getPrompt('harden_file', {})).toThrow(/filePath/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run src/__tests__/prompts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/prompts.ts

export interface PromptListing {
  name: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
}
export interface PromptResult {
  description: string;
  messages: { role: 'user'; content: { type: 'text'; text: string } }[];
}

export function listPrompts(): PromptListing[] {
  return [
    {
      name: 'harden_file',
      description: 'Walk through hardening one file: audit → write tests for survivors → verify by runId → repeat.',
      arguments: [{ name: 'filePath', description: 'Path to the source file to harden.', required: true }],
    },
    {
      name: 'triage_changes',
      description: "Triage a PR's changed files weakest-first, then harden the weakest.",
      arguments: [{ name: 'diffBase', description: 'Git base to diff against (e.g. "main", "HEAD", "staged").', required: true }],
    },
  ];
}

function userMessage(text: string): PromptResult['messages'] {
  return [{ role: 'user', content: { type: 'text', text } }];
}

function requireArg(args: Record<string, string>, name: string): string {
  const v = args[name];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return v;
}

export function getPrompt(name: string, args: Record<string, string>): PromptResult {
  switch (name) {
    case 'harden_file': {
      const filePath = requireArg(args, 'filePath');
      return {
        description: `Harden ${filePath} against surviving mutants.`,
        messages: userMessage(
          [
            `Harden the test coverage of \`${filePath}\` using Chaos-MCP. Steps:`,
            `1. (Optional) Call estimate_audit on \`${filePath}\` to gauge size/cost.`,
            `2. Call audit_code_resilience on \`${filePath}\`. Note the returned runId and the survivor list.`,
            `3. For each surviving mutant, add or strengthen a test that would kill it (target the reported line + mutator).`,
            `4. Re-run audit_code_resilience with that runId to verify the previously-surviving mutants are now killed.`,
            `5. Repeat until clean. Only suppress a mutant (suppress arg) if it is genuinely equivalent (unkillable).`,
          ].join('\n'),
        ),
      };
    }
    case 'triage_changes': {
      const diffBase = requireArg(args, 'diffBase');
      return {
        description: `Triage files changed vs ${diffBase}.`,
        messages: userMessage(
          [
            `Find the weakest test coverage among the files changed versus \`${diffBase}\`:`,
            `1. Call triage_test_coverage with diffBase="${diffBase}" to rank the changed files weakest-first.`,
            `2. Take the weakest file from the ranking and harden it: audit_code_resilience → write tests for survivors → verify by runId.`,
            `3. Move down the ranking until the changed files meet your bar (use minScore to gate).`,
          ].join('\n'),
        ),
      };
    }
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run src/__tests__/prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/prompts.ts src/__tests__/prompts.test.ts
git commit -m "feat: MCP prompts — harden_file and triage_changes"
```

---

### Task 5: Audit progress + cancellation (`src/handler.ts`)

**Files:**
- Modify: `src/handler.ts` (`handleToolCall` ~821 — optional `ctx` param; milestones; thread signal; early abort)
- Test: `src/__tests__/handler.test.ts` or a new `src/__tests__/handler-phase5.test.ts`

**Interfaces:**
- Consumes: `ToolContext` from `./tool-context.js`; `RunOptions.signal` (Task 2).
- Produces: `handleToolCall(request, config?, ctx?: ToolContext)` — emits 4 milestones; threads `ctx.signal` into the engine run; short-circuits when already aborted.

- [ ] **Step 1: Write failing tests** — add a `ctx` with a recording `reportProgress` and assert the milestone sequence on a stubbed engine run, plus a pre-aborted-signal short-circuit. Follow the existing `handler.test.ts` engine-stub pattern. Minimum:
  - with `ctx.reportProgress`, a successful audit reports `(1,4,'validating')` … `(4,4,'complete')` in order.
  - a pre-aborted `ctx.signal` returns a cancelled result without provisioning a sandbox (assert `createSandbox` not called if the harness mocks it; else assert the cancelled message).
  If the harness can't stub the engine, cover the reachable seams and note the limit.

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run src/__tests__/handler-phase5.test.ts`
Expected: FAIL until wired.

- [ ] **Step 3: Implement**

In `handleToolCall`:
- Add optional 3rd param `ctx?: ToolContext`.
- At the very start (before validation), and again right before `createSandbox`, and before the engine run, check `if (ctx?.signal?.aborted) return toolError('Operation cancelled.');` (a normal tool result, not isError — `toolError` returns the standard error content; acceptable. If a non-error "cancelled" result is preferred, return `{ content: [{ type:'text', text:'Operation cancelled.' }] }`). Use the same shape for all abort checks.
- Emit milestones via `ctx?.reportProgress?.(...)`: `(1,4,'validating')` after entry; `(2,4,'provisioning sandbox')` just before `createSandbox`; `(3,4,'running mutation engine')` just before `auditFile`/engine.run; `(4,4,'complete')` just before the successful return (and in the no-changes / verify-mode short-circuit returns).
- Thread the signal: when building `RunOptions` for the engine (via `buildRunOptions`/`auditFile`), include `signal: ctx?.signal`. Find where `RunOptions` is assembled (`buildRunOptions` ~322) and pass `ctx?.signal` through to it (add a param or set it on the returned options before `engine.run`). The cleanest: after building runOptions, set `runOptions.signal = ctx?.signal;` before `engine.run`.

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run src/__tests__/handler-phase5.test.ts && npx vitest run src/__tests__/handler.test.ts`
Expected: PASS (existing handler tests unaffected — ctx optional).

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/handler.ts src/__tests__/handler-phase5.test.ts
git commit -m "feat: audit progress milestones + cancellation"
```

---

### Task 6: Triage progress + cancellation (`src/triage-handler.ts`)

**Files:**
- Modify: `src/triage-handler.ts` (`handleTriageCall` ~45 — optional `ctx`; per-file progress; thread signal; early abort)
- Test: `src/__tests__/triage-handler.test.ts` (append)

**Interfaces:**
- Consumes: `ToolContext`; `RunOptions.signal`.
- Produces: `handleTriageCall(request, config?, ctx?: ToolContext)` — per-file `reportProgress(done, total)`; threads signal per file; short-circuits on abort.

- [ ] **Step 1: Write failing tests** — with a `ctx.reportProgress` recorder over a stubbed multi-file run, assert progress fires `done/total` for each completed file (total = number of discovered files); and a pre-aborted signal yields a cancelled result. Follow the existing triage-handler test harness.

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run src/__tests__/triage-handler.test.ts -t 'progress'`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Add optional 3rd param `ctx?: ToolContext` to `handleTriageCall`.
- Early abort: `if (ctx?.signal?.aborted) return triageError('Operation cancelled.');` before file discovery and before the `mapPool` run.
- Progress: declare `let done = 0; const total = files.length;` before `mapPool`; inside `auditOne` (in a `finally` so it counts errors too), call `ctx?.reportProgress?.(++done, total, \`audited ${done}/${total}\`)`. Because `mapPool` runs concurrently, `++done` is a simple shared counter (single-threaded JS — no race) reflecting completions.
- Cancellation per file: thread `ctx?.signal` into each file's engine run — set `signal: ctx?.signal` on the `RunOptions`/`auditFile` options inside `auditOne` (the same place `lineRanges`/timeout are set). When aborted mid-pool, in-flight subprocesses are killed and their tasks resolve to errors; the pool completes and triage returns what finished. Optionally check `ctx?.signal?.aborted` at the top of `auditOne` to skip not-yet-started files quickly.

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run src/__tests__/triage-handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/triage-handler.ts src/__tests__/triage-handler.test.ts
git commit -m "feat: triage per-file progress + cancellation"
```

---

### Task 7: Estimate cancellation (`src/estimate-handler.ts`, `src/estimate.ts`)

**Files:**
- Modify: `src/estimate-handler.ts` (optional `ctx`; thread signal; early abort)
- Modify: `src/estimate.ts` (`EstimateOptions` gains `signal?`; pass into the `cargo mutants --list` `invokeMutationTool` call and the `withTiming` `runShell` call)
- Test: `src/__tests__/estimate.test.ts`, `src/__tests__/estimate-handler.test.ts` (append)

**Interfaces:**
- Consumes: `ToolContext`. Produces: `handleEstimateCall(request, config?, ctx?)`; `EstimateOptions.signal?: AbortSignal` forwarded to subprocesses. No progress (per spec).

- [ ] **Step 1: Write failing tests** — assert `estimateAudit` forwards `signal` into the mocked `invokeMutationTool` options (rust path) and into the mocked `runShell` (withTiming); a pre-aborted `ctx.signal` in `handleEstimateCall` returns a cancelled result.

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run src/__tests__/estimate.test.ts -t 'signal'`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `src/estimate.ts`: add `signal?: AbortSignal` to `EstimateOptions`. In `computeCount`'s rust branch, add `signal: opts.signal` to the `invokeMutationTool` options. In `applyTiming`, add `signal: opts.signal` to the `runShell` options.
- `src/estimate-handler.ts`: add optional `ctx?: ToolContext`; `if (ctx?.signal?.aborted) return toolError('Operation cancelled.');` before the boundary/sandbox work; pass `signal: ctx?.signal` into the `estimateAudit({...})` opts.

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run src/__tests__/estimate.test.ts src/__tests__/estimate-handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/estimate.ts src/estimate-handler.ts src/__tests__/estimate.test.ts src/__tests__/estimate-handler.test.ts
git commit -m "feat: estimate_audit cancellation"
```

---

### Task 8: Server wiring (`src/index.ts`)

**Files:**
- Modify: `src/index.ts` (capabilities; register resource/prompt handlers; build + pass `ctx`)
- Test: `src/__tests__/index.test.ts` (append)

**Interfaces:**
- Consumes: `makeToolContext` (Task 1), `listResources`/`readResource` (Task 3), `listPrompts`/`getPrompt` (Task 4), the ctx-accepting handlers (Tasks 5–7).

- [ ] **Step 1: Write failing tests** — assert the server advertises `resources` and `prompts` capabilities; that `resources/list` returns 3 and `resources/read` returns content for a known URI; that `prompts/list` returns 2 and `prompts/get` renders `harden_file`; and that the CallTool dispatch still routes all three tools. Follow `index.test.ts`'s existing server-construction/mock pattern (it likely mocks the handlers and inspects `setRequestHandler` registrations).

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run src/__tests__/index.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/index.ts`:
- Imports: `ListResourcesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema` from `@modelcontextprotocol/sdk/types.js`; `makeToolContext` from `./tool-context.js`; `listResources, readResource` from `./resources.js`; `listPrompts, getPrompt` from `./prompts.js`.
- Capabilities: `{ tools: {}, resources: {}, prompts: {} }`.
- Register handlers:
  ```ts
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: listResources() }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
    contents: [readResource(request.params.uri)],
  }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: listPrompts() }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) =>
    getPrompt(request.params.name, (request.params.arguments ?? {}) as Record<string, string>),
  );
  ```
- CallTool handler: change the callback to `async (request, extra) => { const ctx = makeToolContext(request, extra); ... }` and pass `ctx` as the 3rd arg to `handleTriageCall`/`handleEstimateCall`/`handleToolCall`.
- Update the ListTools JSDoc only if needed; keep `isDirectRun` guard intact.

Confirm the exact result shapes the SDK expects (`{ resources: [...] }`, `{ contents: [...] }`, `{ prompts: [...] }`, and the GetPrompt result `{ description, messages }`) against the installed SDK types; adjust if the SDK wraps differently.

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && npx vitest run src/__tests__/index.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run build && npm run lint && npm run format:check && npm test
git add src/index.ts src/__tests__/index.test.ts
git commit -m "feat: register resources/prompts capabilities + thread ToolContext into tool calls"
```

---

### Task 9: Docs + final gate + self-mutation smoke

**Files:**
- Modify: `README.md` (progress/cancellation behavior; resources + prompts the server exposes)
- Modify: `CLAUDE.md` (note `tool-context.ts`/`resources.ts`/`prompts.ts`, the resources/prompts capabilities, signal threading)

- [ ] **Step 1: Update README** — a "Protocol features" section: progress notifications (pass a `progressToken`; triage X/N + audit milestones), cancellation (cancel the request → run aborts, sandbox cleaned), resources (`chaos://languages`, `chaos://config-schema`, `chaos://capabilities`), prompts (`harden_file`, `triage_changes`).

- [ ] **Step 2: Update CLAUDE.md** — in Architecture, one line each for `tool-context.ts` (signal + progress), `resources.ts`, `prompts.ts`; note the server now advertises `resources`/`prompts` capabilities and threads an optional `ToolContext` (signal/progress) into the three tool handlers.

- [ ] **Step 3: Final gate + self-mutation smoke**

```bash
npm run check
node scripts/audit-self.js src/tool-context.ts || true
```
Note: `audit-self.js` needs `build/` + Stryker devDeps; if it can't run here, note it (best-effort).

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document progress/cancellation + MCP resources/prompts"
```

---

## Self-Review

**Spec coverage:**
- ToolContext (signal + token-gated progress) → Task 1. ✓
- Cancellation plumbing (exec → invokeMutationTool → RunOptions → 4 engines) → Task 2; threaded into handlers → Tasks 5/6/7. ✓
- Progress (triage per-file, audit milestones, estimate none) → Tasks 6/5/7. ✓
- Resources (languages/config-schema/capabilities) → Task 3; wired → Task 8. ✓
- Prompts (harden_file/triage_changes) → Task 4; wired → Task 8. ✓
- Capabilities + handler registration + ctx threading → Task 8. ✓
- Optional ctx preserves existing tests → Tasks 5/6/7/8 (optional param). ✓
- Docs → Task 9. ✓
- Out of scope (per-mutant progress, subscriptions, sampling, auth) → no tasks. ✓

**Placeholder scan:** pure modules (Tasks 1–4) carry complete code; the handler/index tasks (5–8) give exact wiring with code snippets and instruct reading the sibling harness for the real engine-stub/mocking pattern — guidance-with-code, not placeholders.

**Type consistency:** `ToolContext`/`makeToolContext` (Task 1) consumed verbatim in Tasks 5/6/7/8. `RunOptions.signal` (Task 2) consumed in 5/6/7. `listResources`/`readResource` (Task 3) and `listPrompts`/`getPrompt` (Task 4) consumed in Task 8 with the result shapes Task 8 wraps. Progress reporter signature `(progress, total?, message?)` consistent across Tasks 1/5/6.

**Known risks flagged for the executor:** (1) `runShell` mock shape — match the real callback args before asserting signal forwarding (Task 2). (2) `ENGINE_REGISTRY` entry fields + `SupportedProjectType` members — verify before building the languages resource (Task 3). (3) SDK result wrapper shapes for resources/prompts (`{resources}`, `{contents}`, `{prompts}`, `{description,messages}`) — confirm against installed `@modelcontextprotocol/sdk` types (Task 8). (4) the cancelled-result shape — decide `toolError('Operation cancelled.')` vs a non-error content block and use it consistently across Tasks 5/6/7. (5) where `RunOptions` is assembled in `handler.ts`/`triage-handler.ts` — set `signal` on it before `engine.run`.
