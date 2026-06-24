# Contributing to Chaos-MCP

## Development Setup

### Prerequisites

- **Node.js** >= 18.0.0
- **npm** (bundled with Node.js)

### Setup

```bash
git clone https://github.com/codebuff/chaos-mcp
cd chaos-mcp
npm install
npm run build
```

## The `npm run check` Pipeline

All contributions must pass the full CI pipeline before being merged. Run it locally with:

```bash
npm run check
```

This single command runs four stages sequentially — **all must pass**:

| Stage | Command | Description |
|-------|---------|-------------|
| 1. Build | `npm run build` | TypeScript compilation (`tsc`) + postbuild (shebang restoration, `chmod +x`) |
| 2. Lint | `npm run lint` | ESLint with `typescript-eslint` strict + stylistic rules |
| 3. Format | `npm run format:check` | Prettier formatting verification |
| 4. Test | `npm run test` | Vitest — all unit, handler, and integration tests (build must exist first) |

### Individual Commands

You can run each stage independently during development:

```bash
npm run build           # Compile TypeScript + restore shebang
npm run lint            # ESLint check
npm run lint:fix        # Auto-fix lint issues
npm run format          # Prettier formatting (writes)
npm run format:check    # Prettier check (CI mode, no writes)
npm test                # Run all unit + integration tests (requires build)
npm run test:watch      # Watch mode for iterative development
npm run test:coverage   # Tests with coverage report
npx tsc --noEmit        # Typecheck without emitting files
```

> **Tip:** Use `npm run test:watch` during active development for instant feedback. Run `npm run check` before pushing.

## Project Structure

```
src/
├── index.ts                     # MCP server entry point, tool definition & handler
├── engines/
│   ├── base.ts                  # Abstract BaseEngine + RunOptions + MutationResult types
│   ├── typescript.ts            # StrykerJS engine (async, concurrency, dryRun, incremental)
│   ├── python.ts                # Mutmut engine (text results parsing)
│   ├── go.ts                    # go-mutesting engine
│   └── rust.ts                  # cargo-mutants engine
├── utils/
│   ├── exec.ts                  # Async runShell helper + ExecFailureError class
│   ├── logger.ts                # Verbose-mode logging utility
│   ├── sandbox.ts               # Sandbox isolation (os.tmpdir, symlinks, size guard)
│   ├── config-loader.ts         # chaos-mcp.config.json loader
│   └── project-detector.ts      # Auto-detect project types & test runners
└── __tests__/
    ├── handler.test.ts           # Tool dispatch + option wiring unit tests
    ├── typescript-engine.test.ts # Stryker engine unit tests
    ├── python-engine.test.ts     # Mutmut engine unit tests
    ├── go-engine.test.ts         # Go engine unit tests
    ├── rust-engine.test.ts       # Rust engine unit tests
    ├── project-detector.test.ts  # Detection logic unit tests
    ├── sandbox.test.ts           # Sandbox utility unit tests
    ├── config-loader.test.ts     # Config loader unit tests
    ├── mutmut-parser.test.ts     # Mutmut results text parser unit tests
    ├── build-output.test.ts      # Postbuild shebang restoration tests
    └── integration.test.ts       # End-to-end MCP server protocol test
```

## Adding a New Language Engine

1. Create `src/engines/<lang>.ts` extending `BaseEngine`
2. Implement `async run(filePath, options?)` returning `MutationResult`
3. Use `runShell()` from `src/utils/exec.ts` for async subprocess execution
4. Add file extension to `detectProjectType` in `project-detector.ts`
5. Add test runner detection (e.g. `detect<Lang>TestRunner`) if applicable
6. Add dispatch case in `handleToolCall` in `index.ts`
7. Add tests in `src/__tests__/<lang>-engine.test.ts`
8. Run `npm run check` to verify everything passes

## Commit Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — new feature
- `fix:` — bug fix
- `refactor:` — code restructure without behavior change
- `test:` — test additions or changes
- `docs:` — documentation updates
- `chore:` — tooling, dependencies, CI

Example: `feat: add Ruby engine via mutmut-ruby`

## Release Process

Releases are automated via the GitHub release workflow (`.github/workflows/release.yml`):

1. Update version in `package.json`
2. Update `APP_VERSION` in `src/index.ts`
3. Add entry to `CHANGELOG.md`
4. Run `npm run check`
5. Commit and tag: `git tag v1.x.x`
6. Push the tag — the release workflow will build, test, and publish to npm automatically

Alternatively, for manual releases: `npm publish` (runs `prepublishOnly` which executes `npm run build && npm run check`)

## CI

The CI pipeline (`.github/workflows/ci.yml`) runs `npm run check` on Node.js 18.x, 20.x, and 22.x for all pushes and pull requests to `main`. All three Node versions must pass.

## End-to-End Testing

E2E tests are **opt-in** — they're slow and have environmental dependencies (spawn a real MCP server, run actual Stryker mutations), so they don't run on every PR. A separate workflow (`.github/workflows/e2e.yml`) runs them on demand.

### Local invocation

```bash
E2E=1 npx vitest run src/__tests__/e2e-mcp.test.ts        # MCP audit pipeline (spawns server, runs audit_code_resilience against a fixture)
E2E_STRYKER=1 npx vitest run src/__tests__/e2e-stryker.test.ts  # StrykerJS programmatic mutations (fixture + real Stryker run)
```

Both flags must be set explicitly — without them the tests compile-load but noop (the env-var gate is in the test file itself).

### CI invocation (`.github/workflows/e2e.yml`)

Two trigger paths for the same workflow:

1. **Manual dispatch** — GitHub Actions tab → "E2E" workflow → "Run workflow" button.
2. **Label-triggered** — add the `run-e2e` label to any PR. The `if:` condition gates on `github.event.action == 'labeled'` (not just label presence) so re-edits or removal of the label don't cause spurious re-runs.

Both trigger paths run the full E2E suite (MCP pipeline + Stryker mutations) on Node 20.x with a 15-minute timeout.

### When to trigger an E2E run

- New engine implementation touching subprocess flow
- Sandbox, config-loader, or handler changes
- Stryker / Mutmut / cargo-mutants / go-mutesting major version bumps
- Any change that could affect the full happy-path sandboxing + mutation-test cycle

### What gets exercised

- **`e2e-mcp.test.ts`** — full-stdio JSON-RPC conversation with a real MCP server child process. Verifies tool registration, schema validation, and the `audit_code_resilience` happy path against a fixture project (uses `os.tmpdir()` + sandbox isolation). Has a leak detector that snapshots the tmpdir in `beforeAll` and only flags dirs created *by this run* (snapshot-relative, not absolute).
- **`e2e-stryker.test.ts`** — programmatic Stryker mutation test. Builds a temp fixture with a `divide()` function (intentional untested `b === 0` branch), symlinks the host's `node_modules` to avoid `npm install`, invokes `new Stryker({ testRunner: 'vitest', ... }).runMutationTest()`, and asserts at least one mutant killed + one surviving + a mutation score strictly between 0% and 100%.

If `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` majors get misaligned in `package.json`, the Stryker test self-skips with a `console.error` so the misconfiguration is loud in CI.
