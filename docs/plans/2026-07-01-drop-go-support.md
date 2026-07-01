# Drop Go / go-mutesting Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Go as a supported language so Chaos-MCP carries only engines we can dogfood, leaving no Go-shaped special case and a green `npm run check`.

**Architecture:** Removal proceeds leaf-first: strip Go from runtime data/branches that compile fine while `'go'` is still in the type unions (enrichment, config section, peripheral strings), committing a green build after each. The final task performs the irreducible "union flip" — removing `'go'` from `ProjectType`, `ExecutableTool`, and the `configKey` union — after which the TypeScript compiler flags every structural straggler, and the test suite flags every behavioral one. Docs come last.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, ESLint + Prettier. Spec: `docs/specs/2026-07-01-drop-go-support-design.md`.

## Global Constraints

- **Gate:** `npm run check` (build → lint → format:check → test) must pass. Copy verbatim: build first — `npm test` imports from `build/`.
- **Post-removal `.go` behavior:** treated as `unsupported` — no tailored message, no residual `projectType: 'go'`.
- **README keeps the "4 languages" headline** (PHP restores the fourth next). Only go-mutesting *engine-specific* rows are removed.
- **Do NOT edit** any dated file under `docs/specs/`, `docs/plans/`, or `docs/superpowers/` except this plan's own checkboxes — they are historical records.
- **Preserve audit-tag comments** (`C2`, `H5`, `Med#10`, `A2`/`A3`, etc.) on any line you touch.
- Commits follow Conventional Commits. Work on branch `drop-go-support` (already created).
- ESM: every relative import ends in `.js` even though the source is `.ts`.

---

### Task 1: Remove Go enrichment

**Files:**
- Modify: `src/enrich.ts` (remove `GO_MUTATOR_MAP` ~127-134, the `projectType === 'go'` branch ~201-203, and the Go bullet in the `canonicalizeMutator` doc-comment ~173-175)
- Test: `src/__tests__/enrich-canonicalize.test.ts`, `src/__tests__/enrich-group.test.ts`

**Interfaces:**
- Consumes: `canonicalizeMutator(rawMutator, projectType, changeText?)` — signature unchanged.
- Produces: nothing new; `canonicalizeMutator` no longer accepts `'go'` behavior (still typed to `SupportedProjectType`, which still contains `'go'` until Task 4).

- [ ] **Step 1: Remove the Go mutator map**

In `src/enrich.ts`, delete the entire `GO_MUTATOR_MAP` block including its doc comment:

```typescript
/**
 * go-mutesting mutator name → canonical category. go-mutesting names its
 * mutators "<group>/<name>" (e.g. "branch/if"). Unmapped names → unknown.
 *
 * Go severity enrichment activates once go-mutesting emits structured output
 * carrying mutator names (via its JSON reporter). Enabling the structured
 * reporter is pending confirmation on an environment with go-mutesting installed.
 */
const GO_MUTATOR_MAP: Record<string, string> = {
  'branch/if': 'ConditionalExpression',
  'branch/else': 'ConditionalExpression',
  'branch/case': 'ConditionalExpression',
  'expression/comparison': 'EqualityOperator',
  'expression/remove': 'MethodExpression',
  'statement/remove': 'BlockStatement',
};
```

- [ ] **Step 2: Remove the Go dispatch branch**

In `canonicalizeMutator`, delete:

```typescript
  if (projectType === 'go') {
    return GO_MUTATOR_MAP[rawMutator] ?? 'unknown';
  }
```

Then delete the `- Go: maps ...` bullet (3 lines) from the function's doc-comment above it, leaving the TypeScript/Rust/Python bullets.

- [ ] **Step 3: Remove Go cases from the enrichment tests**

In `src/__tests__/enrich-canonicalize.test.ts` and `src/__tests__/enrich-group.test.ts`, delete every test case / assertion that passes `'go'` as the projectType or asserts a `GO_MUTATOR_MAP` mapping (e.g. the `branch/if → ConditionalExpression` cases). Leave the TS/Python/Rust cases intact.

- [ ] **Step 4: Build and run the enrichment tests**

Run: `npm run build && npx vitest run src/__tests__/enrich-canonicalize.test.ts src/__tests__/enrich-group.test.ts`
Expected: PASS, no references to `GO_MUTATOR_MAP` or `projectType === 'go'` remain (`grep -n "GO_MUTATOR_MAP\|'go'" src/enrich.ts` returns nothing).

- [ ] **Step 5: Commit**

```bash
git add src/enrich.ts src/__tests__/enrich-canonicalize.test.ts src/__tests__/enrich-group.test.ts
git commit -m "refactor(enrich): remove Go/go-mutesting mutator mapping"
```

---

### Task 2: Remove the Go config section

**Files:**
- Modify: `src/utils/config-loader.ts` (remove `'go'` from `KNOWN_KEYS` ~24, `KNOWN_GO_KEYS` ~49, `GoMutestingConfig` interface ~99-105, `ChaosConfig.go?` ~179-180, the `go` entry in `ENGINE_CONFIG_SECTIONS` ~302, and `'go'` from that array's `key` union type ~296)
- Test: `src/__tests__/config-loader.test.ts`

**Interfaces:**
- Consumes: `ChaosConfig`, `loadConfig`, `validateConfig` — signatures unchanged.
- Produces: `ChaosConfig` no longer has a `go?` property; `ENGINE_CONFIG_SECTIONS` `key` union is `'stryker' | 'cosmicray' | 'rust'`. A user config with a `go` section now surfaces as an "Unknown config key" warning (non-fatal) and is dropped by `buildConfig` — this is the intended back-compat behavior.

- [ ] **Step 1: Write/adjust the back-compat test first**

In `src/__tests__/config-loader.test.ts`, remove existing tests that assert a parsed `go` section (search for `.go` config assertions / `GoMutestingConfig`). Then add a regression test proving a stray `go` section degrades gracefully:

```typescript
it('treats a legacy "go" config section as an ignorable unknown key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-cfg-'));
  const cfgPath = join(dir, 'chaos-mcp.config.json');
  writeFileSync(cfgPath, JSON.stringify({ go: { timeoutMs: 1000 }, defaultTimeoutMs: 5000 }));

  const { config, warnings } = validateConfig(cfgPath);

  expect(config).not.toHaveProperty('go');
  expect(config.defaultTimeoutMs).toBe(5000);
  expect(warnings.some((w) => w.includes('"go"'))).toBe(true);
});
```

(Match the file's existing import style for `mkdtempSync`/`tmpdir`/`writeFileSync`/`validateConfig` — reuse whatever the surrounding tests already import.)

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/config-loader.test.ts -t 'legacy "go"'`
Expected: FAIL — currently `go` is a known key, so no warning is produced.

- [ ] **Step 3: Remove Go from the config loader**

In `src/utils/config-loader.ts`, make these edits:
- In `KNOWN_KEYS`, delete the `'go',` line.
- Delete `const KNOWN_GO_KEYS = new Set(['timeoutMs']);`
- Delete the `GoMutestingConfig` interface (comment + body, ~99-105).
- Delete the `ChaosConfig.go?` property + its doc-comment (~179-180).
- In the `ENGINE_CONFIG_SECTIONS` array, change the `key` union type from `'stryker' | 'cosmicray' | 'go' | 'rust'` to `'stryker' | 'cosmicray' | 'rust'`, and delete the `{ key: 'go', knownKeys: KNOWN_GO_KEYS, parse: parseTimeoutOnlyConfig },` entry.
- In the `ChaosConfig` doc-comment, change "Engine-specific sections (`stryker`, `cosmicray`, `go`, `rust`)" to "(`stryker`, `cosmicray`, `rust`)".
- Leave `parseTimeoutOnlyConfig` — it is still used by the `rust` section.

- [ ] **Step 4: Run the config tests**

Run: `npm run build && npx vitest run src/__tests__/config-loader.test.ts`
Expected: PASS, including the new back-compat test.

- [ ] **Step 5: Commit**

```bash
git add src/utils/config-loader.ts src/__tests__/config-loader.test.ts
git commit -m "refactor(config): remove go-mutesting config section"
```

---

### Task 3: Remove peripheral Go references

**Files:**
- Modify: `src/baseline-timing.ts` (remove `case 'go'` ~19-20)
- Modify: `src/test-file.ts` (remove `case 'go'` ~28-29)
- Modify: `src/triage.ts` (`SUPPORTED_EXT` ~32, `TEST_FILE_RE` ~44)
- Modify: `src/tool-schema.ts` (description ~12, filePath doc ~20, resource description ~252)
- Modify: `src/cli.ts` (help text ~46-47, ~57, ~65, example ~82, link ~89)
- Modify: `src/estimate.ts` (comments ~95, ~130)
- Modify: `src/engines/base.ts` (comments ~79, ~99, ~159, ~232)
- Test: `src/__tests__/baseline-timing.test.ts`, `src/__tests__/test-file.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new. All edits are string-level or `switch`-case removals that compile while `'go'` remains in the unions (removed in Task 4).

- [ ] **Step 1: baseline-timing — drop the Go command**

In `src/baseline-timing.ts`, delete from the `switch`:

```typescript
    case 'go':
      return { command: 'go', args: ['test', './...'] };
```

- [ ] **Step 2: test-file — drop the Go candidate**

In `src/test-file.ts`, delete from the `switch`:

```typescript
    case 'go':
      return [j(dir, `${base}_test.go`)];
```

- [ ] **Step 3: triage — drop `.go` from extensions and the test-file regex**

In `src/triage.ts`:
- Change `const SUPPORTED_EXT = ['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs'];` to `const SUPPORTED_EXT = ['.ts', '.js', '.tsx', '.jsx', '.py', '.rs'];`
- Change `const TEST_FILE_RE = /(\.test\.|\.spec\.|_test\.(go|py|rs)$|(^|\/)test_[^/]*\.py$)/;` to `const TEST_FILE_RE = /(\.test\.|\.spec\.|_test\.(py|rs)$|(^|\/)test_[^/]*\.py$)/;`

- [ ] **Step 4: tool-schema — drop Go from description and accepted extensions**

In `src/tool-schema.ts`:
- In the tool `description`, change "Python (cosmic-ray), Go (go-mutesting), and Rust (cargo-mutants)" to "Python (cosmic-ray), and Rust (cargo-mutants)".
- In the `filePath` description, change "Must end in .ts, .js, .tsx, .jsx, .py, .go, or .rs." to "Must end in .ts, .js, .tsx, .jsx, .py, or .rs."
- At the resource description (~line 252), remove `.go` from any extension list the same way. (`grep -n "\.go" src/tool-schema.ts` to confirm none remain.)

- [ ] **Step 5: cli — drop Go from help text, examples, and links**

In `src/cli.ts`:
- Change "Python (via cosmic-ray), Go (via go-mutesting), and Rust (via cargo-mutants)." to "Python (via cosmic-ray), and Rust (via cargo-mutants)." (mind the line wrap at ~46-47).
- In the engine-sections line, change `"stryker", "cosmicray", "go", "rust"` to `"stryker", "cosmicray", "rust"`.
- In the `filePath (required)` line, change `(.ts/.js/.py/.go/.rs)` to `(.ts/.js/.py/.rs)`.
- Delete the `{ "filePath": "src/logic.go" }` example line.
- In `prebuildCommand` help, change the example `(e.g. "npm run build", "go build ./...")` to `(e.g. "npm run build", "cargo build")`.
- Delete the `https://github.com/zimmski/go-mutesting` link line.

- [ ] **Step 6: estimate + base — fix stale comments**

In `src/estimate.ts`, update the two comments (~95, ~130) that read "TS / Python / Go" → "TS / Python". In `src/engines/base.ts`, update the "Ignored by: cosmic-ray, go-mutesting, cargo-mutants" comments (~79, ~99, ~159) → "cosmic-ray, cargo-mutants", and the wrapped-message comment (~232) "(go-mutesting, cargo-mutants)" → "(cargo-mutants)".

- [ ] **Step 7: Fix the peripheral tests**

In `src/__tests__/baseline-timing.test.ts` delete the Go baseline-command test (~30-31). In `src/__tests__/test-file.test.ts` delete the Go test-file-suggestion assertion (~38). Leave all TS/Python/Rust cases.

- [ ] **Step 8: Build and run the touched tests**

Run: `npm run build && npx vitest run src/__tests__/baseline-timing.test.ts src/__tests__/test-file.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/baseline-timing.ts src/test-file.ts src/triage.ts src/tool-schema.ts src/cli.ts src/estimate.ts src/engines/base.ts src/__tests__/baseline-timing.test.ts src/__tests__/test-file.test.ts
git commit -m "refactor: remove peripheral Go references (triage, cli, schema, timing)"
```

---

### Task 4: Core removal — flip the unions and delete the engine

This is the irreducible atomic task: removing `'go'` from the type unions breaks compilation across the coupled cluster (registry, detector, resources, exec-classify) at once, so all of it lands in one commit that ends green. After the union edits, `tsc` names every straggler; after the build, the test suite names every behavioral one.

**Files:**
- Delete: `src/engines/go.ts`, `src/__tests__/go-engine.test.ts`, `src/__tests__/e2e-go.test.ts`
- Modify: `src/utils/project-detector.ts` (`ProjectType` ~7; `GO_ROOT_MARKERS` ~82; `detectGoTestRunner`/`detectRawGoRunner` ~409-440; `LANGUAGE_DETECTORS.go` ~523-528)
- Modify: `src/engines/registry.ts` (`GoEngine` import ~4; `configKey` union ~28; `go` registry entry ~59-64)
- Modify: `src/utils/exec-classify.ts` (`ExecutableTool` ~8; `INSTALL_HINTS['go-mutesting']` ~39)
- Modify: `src/resources.ts` (`ENGINE_NAMES.go` ~41; `configSchemaJson` `go` key ~79)
- Test: add `.go → unsupported` regression test; fix all remaining Go-referencing tests

**Interfaces:**
- Consumes: `ProjectType`, `SupportedProjectType`, `ENGINE_REGISTRY`, `ExecutableTool`.
- Produces: `type ProjectType = 'typescript' | 'python' | 'rust' | 'unsupported'`; `type ExecutableTool = 'StrykerJS' | 'cosmic-ray' | 'cargo-mutants'`; `EngineDescriptor.configKey` union is `'stryker' | 'cosmicray' | 'rust'`. `ENGINE_REGISTRY` has three keys; `detectProjectType('x.go')` returns `'unsupported'`.

- [ ] **Step 1: Write the regression test first**

Add to `src/__tests__/project-detector.test.ts` (reuse its existing `detectProjectType`/`detectEnvironment` imports):

```typescript
it('treats .go files as unsupported after Go removal', () => {
  expect(detectProjectType('src/main.go')).toBe('unsupported');
  const env = detectEnvironment('src/main.go');
  expect(env.projectType).toBe('unsupported');
  expect(env.testRunner).toBe('unknown');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/project-detector.test.ts -t 'unsupported after Go removal'`
Expected: FAIL — `detectProjectType('src/main.go')` currently returns `'go'`.

- [ ] **Step 3: Delete the engine and its two test files**

```bash
git rm src/engines/go.ts src/__tests__/go-engine.test.ts src/__tests__/e2e-go.test.ts
```

- [ ] **Step 4: Flip `ProjectType` and remove Go detection**

In `src/utils/project-detector.ts`:
- Change `export type ProjectType = 'typescript' | 'python' | 'go' | 'rust' | 'unsupported';` to `'typescript' | 'python' | 'rust' | 'unsupported'`.
- Delete `const GO_ROOT_MARKERS = ['go.mod'] as const;` and its comment.
- Delete the entire `detectGoTestRunner` and `detectRawGoRunner` functions (and the "─ Go test runner detection ─" section header).
- Delete the `go: { ... }` entry from `LANGUAGE_DETECTORS`.

- [ ] **Step 5: Remove Go from the registry**

In `src/engines/registry.ts`:
- Delete `import { GoEngine } from './go.js';`
- Change the `configKey` union `'stryker' | 'cosmicray' | 'go' | 'rust'` to `'stryker' | 'cosmicray' | 'rust'`.
- Delete the `go: { make: () => new GoEngine(), configKey: 'go', supportsLineScope: false, prebuild: { marker: 'go.mod', command: 'go mod download' } },` entry.

- [ ] **Step 6: Remove Go from exec-classify**

In `src/utils/exec-classify.ts`:
- Change `export type ExecutableTool = 'StrykerJS' | 'cosmic-ray' | 'go-mutesting' | 'cargo-mutants';` to drop `'go-mutesting'`.
- Delete the `'go-mutesting': 'go install ...',` line from `INSTALL_HINTS`.

- [ ] **Step 7: Remove Go from resources**

In `src/resources.ts`:
- Delete `go: 'go-mutesting',` from `ENGINE_NAMES`.
- Delete `go: 'object — go-mutesting-specific overrides.',` from `configSchemaJson`'s `keys`.

- [ ] **Step 8: Build — let the compiler name every straggler**

Run: `npm run build`
Expected: initially may FAIL. Fix each reported error by deleting the Go reference it points at (e.g. a `case 'go'`, a `Record<SupportedProjectType>` literal still listing `go`, a test-only type). Re-run until the build is clean. Then `grep -rin "go-mutesting" src && grep -rn "'go'" src` — both should return nothing.

- [ ] **Step 9: Run the full suite — fix the behavioral stragglers**

Run: `npm test`
Expected: initially FAIL in the Go-referencing tests. Update each: **delete** the Go case/assertion; where a test asserts a **language/engine count of 4** (e.g. registry has 4 entries, `chaos://languages` lists 4), change it to **3**. Known files to check: `registry.test.ts`, `project-detector.test.ts`, `resources.test.ts`, `handler.test.ts`, `handler-helpers.test.ts`, `exec-classify.test.ts`, `estimate.test.ts`, `format-enrich.test.ts`. Re-run until green. The new `.go → unsupported` test must pass.

- [ ] **Step 10: Full gate**

Run: `npm run check`
Expected: PASS (build, lint, format:check, test all green).

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: drop Go/go-mutesting support (.go now unsupported)"
```

---

### Task 5: Update living docs

**Files:**
- Modify: `README.md` (~16 language list, ~52 tool table, ~56 toolchain prereq, ~474 test-runner table, ~563 link)
- Modify: `CLAUDE.md` (~7 summary)
- Modify: `CONTRIBUTING.md` (~63 dir structure, ~152 version-bump list)

**Interfaces:** none (docs only).

- [ ] **Step 1: README — remove go-mutesting engine rows, keep "4"**

In `README.md`:
- **Keep** the "4 Languages Supported" headline (decision: PHP restores the fourth next).
- Remove the "Go (go-mutesting)" list entry, the go-mutesting row in the tool/installation table, the "Go toolchain" prerequisite line, the Go row in the test-runner support table (~474), and the go-mutesting GitHub reference link (~563).

- [ ] **Step 2: CLAUDE.md — three tools, not four**

In `CLAUDE.md` line ~7, change "wraps four language-specific mutation tools — StrykerJS (TS/JS), cosmic-ray (Python), go-mutesting (Go), cargo-mutants (Rust)" to "wraps three language-specific mutation tools — StrykerJS (TS/JS), cosmic-ray (Python), cargo-mutants (Rust)".

- [ ] **Step 3: CONTRIBUTING.md — remove go.ts and go-mutesting mentions**

In `CONTRIBUTING.md`, delete the `go.ts # go-mutesting engine` directory-structure line (~63) and remove "go-mutesting" from the major-version-bump list (~152).

- [ ] **Step 4: Verify no stray go-mutesting in living docs**

Run: `grep -rin "go-mutesting" README.md CLAUDE.md CONTRIBUTING.md`
Expected: no output.

- [ ] **Step 5: Final gate + commit**

Run: `npm run check`
Expected: PASS.

```bash
git add README.md CLAUDE.md CONTRIBUTING.md
git commit -m "docs: drop go-mutesting from README, CLAUDE.md, CONTRIBUTING.md"
```

---

## Self-Review

**Spec coverage:**
- "Deleted outright (whole files)" → Task 4 Step 3. ✓
- "Deleted in place" — enrich (Task 1), config (Task 2), detector/registry/exec-classify/resources (Task 4), baseline-timing/test-file/triage/tool-schema/cli/estimate/base (Task 3). ✓
- "Tighten type unions first" strategy → Task 4 Steps 4-7 flip the three unions, Steps 8-9 drive stragglers to zero. ✓
- "`.go → unsupported` regression test" → Task 4 Steps 1-2. ✓
- "Config back-compat" → Task 2 (validated as a warning-not-fatal test). ✓
- "Enumeration assertions 4→3" → Task 4 Step 9, called out explicitly. ✓
- "Docs updated; dated docs untouched" → Task 5 + Global Constraints. ✓
- "README keeps 4" → Task 5 Step 1 + Global Constraints. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to". Task 4 Steps 8-9 intentionally use a compiler-and-test-driven loop — legitimate for a type-union removal where `tsc`/`npm test` enumerate the work precisely; the file checklist bounds it.

**Type consistency:** `ProjectType` → 4 members; `SupportedProjectType = Exclude<…,'unsupported'>` narrows to 3 automatically; `ExecutableTool` → 3 members; `configKey`/`ENGINE_CONFIG_SECTIONS.key` unions → `'stryker' | 'cosmicray' | 'rust'` in both `registry.ts` and `config-loader.ts`. Consistent across tasks.

## Out of scope / follow-ups

- **PHP / Infection engine — next plan, immediately after** (restores the fourth language + the README detail).
- Engine performance uplift (cargo-mutants `-j`, cosmic-ray concurrency) — third plan.
