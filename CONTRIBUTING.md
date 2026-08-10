# Contributing to Chaos-MCP

## Development Setup

### Prerequisites

- **Node.js** >= 22.11.0
- **npm** (bundled with Node.js)

### Setup

```bash
git clone https://github.com/AraneaDev/Chaos-MCP.git
cd Chaos-MCP
npm install
npm run build
```

## The `npm run check` Pipeline

All contributions must pass the full CI pipeline before being merged. Run it locally with:

```bash
npm run check
```

This single command runs four stages sequentially — **all must pass**:

| Stage     | Command                | Description                                                                  |
| --------- | ---------------------- | ---------------------------------------------------------------------------- |
| 1. Build  | `npm run build`        | TypeScript compilation (`tsc`) + postbuild (shebang restoration, `chmod +x`) |
| 2. Lint   | `npm run lint`         | ESLint with `typescript-eslint` strict + stylistic rules                     |
| 3. Format | `npm run format:check` | Prettier formatting verification                                             |
| 4. Test   | `npm run test`         | Vitest — all unit, handler, and integration tests (build must exist first)   |

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

Abridged — the notable modules, not every file.

```
src/
├── index.ts                     # MCP server entry point, tool definition & handler
├── handler.ts                   # audit_code_resilience dispatch & option wiring
├── audit/                       # Audit pipeline: scope, run options, suppressions, output
│                                #   apply-suppressions.ts owns mutant matching + tier-3 relocation
├── triage/                      # triage_test_coverage: target discovery + per-file audit
├── engines/
│   ├── base.ts                  # Abstract BaseEngine + RunOptions + MutationResult types
│   ├── registry.ts              # ENGINE_REGISTRY + the authoritative "Adding a language" note
│   ├── dependency-dirs.ts       # DEPENDENCY_DIRS: the one home for per-language dep dirs
│   ├── typescript.ts            # StrykerJS engine (async, concurrency, dryRun, incremental)
│   ├── python.ts                # Cosmic Ray engine
│   ├── rust.ts                  # cargo-mutants engine
│   └── php.ts                   # Infection engine
├── utils/
│   ├── exec.ts                  # Async runShell helper + ExecFailureError class
│   ├── constants.ts             # Shared exec constants (DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
│   ├── logger.ts                # Verbose-mode logging utility
│   ├── sandbox.ts               # Sandbox isolation (os.tmpdir, symlinks, size guard)
│   ├── suppression.ts           # Suppression storage: load/add/remove/verify + the write lock
│   ├── mutant-identity.ts       # A mutant's identity: mutator + the change it makes
│   ├── diff-change.ts           # original→mutated extraction shared by cosmic-ray and Infection
│   ├── execution.ts             # Native/container execution-session boundary
│   ├── config-loader.ts         # Barrel (26 lines) re-exporting config/ — see below
│   ├── config/                  # types.ts, rules.ts (one rule table), parse.ts, validate.ts
│   └── project-detector.ts      # Auto-detect project types & test runners
└── __tests__/
    ├── handler.test.ts           # Tool dispatch + option wiring unit tests
    ├── typescript-engine.test.ts # Stryker engine unit tests
    ├── python-engine.test.ts     # Cosmic Ray engine unit tests
    ├── rust-engine.test.ts       # Rust engine unit tests
    ├── project-detector.test.ts  # Detection logic unit tests
    ├── sandbox.test.ts           # Sandbox utility unit tests
    ├── config-loader.test.ts     # Config loader unit tests
    ├── cosmic-ray-parser.test.ts # Cosmic Ray results parser unit tests
    ├── build-output.test.ts      # Postbuild shebang restoration tests
    └── integration.test.ts       # End-to-end MCP server protocol test
```

## Adding a New Language Engine

1. Create `src/engines/<lang>.ts` extending `BaseEngine`
2. Implement `async run(filePath, options?)` returning `MutationResult`
3. Use `runShell()` from `src/utils/exec.ts` for async subprocess execution
4. Add a `LANGUAGE_DETECTORS` entry in `src/utils/project-detector.ts` — extension
   matcher, extension list, root markers, and test-runner detection. It is a
   `Record<SupportedProjectType, …>`, so `tsc` fails until you do;
   `detectProjectType()` and the tool schema's extension prose are derived from it
   rather than hand-edited
5. Add an `ENGINE_REGISTRY` entry in `src/engines/registry.ts`. Every
   `EngineDescriptor` field is mandatory — `make`, `configKey`,
   `supportsLineScope`, `honorsConcurrency`, `dependencyDirs`, `syntaxFamily`,
   `displayName`, `label` — plus an optional `prebuild`
6. Add the language's dependency directories to `DEPENDENCY_DIRS` in
   `src/engines/dependency-dirs.ts` and point `dependencyDirs` at that entry
7. Add a config section under `src/utils/config/` — the type in `config/types.ts`
   (including the `EngineConfigKey` member `configKey` must name) and its
   validation rules in `config/rules.ts`. `src/utils/config-loader.ts` is only a
   26-line barrel re-exporting that directory; it needs no change
8. Add tests in `src/__tests__/<lang>-engine.test.ts`
9. Run `npm run check` to verify everything passes

> **The authoritative list is the "Adding a language" note at the bottom of
> `src/engines/registry.ts`.** It is kept next to the code, splits the work into
> the steps `tsc` will FAIL on until you handle them and the steps that fail
> silently at runtime, and covers the files this summary omits (container image,
> baseline timing, test-file conventions, enrichment). Read it before starting;
> if the two ever disagree, that note wins.

## Commit Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — new feature
- `fix:` — bug fix
- `refactor:` — code restructure without behavior change
- `test:` — test additions or changes
- `docs:` — documentation updates
- `chore:` — tooling, dependencies, CI

Example: `feat: add Go mutation engine`

## Release Process

Releases are automated by [release-please](https://github.com/googleapis/release-please) via
`.github/workflows/release-please.yml`:

1. Write commits on `main` following the [Conventional Commits](https://www.conventionalcommits.org/)
   convention described above. release-please reads them to determine the next version.
2. release-please keeps an open **Release PR** up to date, bumping `package.json`,
   bumping `APP_VERSION` in `src/index.ts` (via the `x-release-please-version` annotation),
   and updating `CHANGELOG.md` — all automatically, from those commits.
3. Merging the Release PR creates the `vX.Y.Z` tag and GitHub Release, and the same
   workflow then builds and verifies the release.

npm publish is currently dormant (the project is pre-release and not yet published to npm),
so merging a Release PR does not publish a package — don't expect one.

Maintainers should not hand-edit versions or `CHANGELOG.md`, and should not hand-create tags;
these are all managed by release-please. If a release needs additional narrative notes, edit
the Release PR description before merging it.

## CI

The CI pipeline (`.github/workflows/ci.yml`) runs `npm run check` on Node.js
22.x and 24.x for all pushes and pull requests to `main`. It also builds the
TypeScript, Python, Rust, and PHP container images without publishing them.
Both Node jobs and all four image builds must pass.

The reusable `container-images.yml` workflow publishes all four release-tagged
images to GHCR for Linux AMD64 and ARM64 after Release Please creates a GitHub
release. See [`containers/README.md`](containers/README.md) for local builds
and versioning.

## End-to-End Testing

E2E tests are **opt-in** — they're slow and have environmental dependencies (spawn a real MCP server, run actual Stryker mutations), so they don't run on every PR. A separate workflow (`.github/workflows/e2e.yml`) runs them on demand.

### Local invocation

```bash
E2E=1 npx vitest run src/__tests__/e2e-mcp.test.ts        # MCP audit pipeline (spawns server, runs audit_code_resilience against a fixture)
```

The flag must be set explicitly — without it the test compile-loads but noops (the env-var gate is in the test file itself).

### CI invocation (`.github/workflows/e2e.yml`)

Two trigger paths for the same workflow:

1. **Manual dispatch** — GitHub Actions tab → "E2E" workflow → "Run workflow" button.
2. **Label-triggered** — add the `run-e2e` label to any PR. The `if:` condition gates on `github.event.action == 'labeled'` (not just label presence) so re-edits or removal of the label don't cause spurious re-runs.

Both trigger paths run the E2E workflow on Node 22.x with a 15-minute timeout.

### When to trigger an E2E run

- New engine implementation touching subprocess flow
- Sandbox, config-loader, or handler changes
- Stryker / cosmic-ray / cargo-mutants / Infection major version bumps
- Any change that could affect the full happy-path sandboxing + mutation-test cycle

### What gets exercised

- **`e2e-mcp.test.ts`** — full-stdio JSON-RPC conversation with a real MCP server child process. Verifies tool registration, schema validation, and the `audit_code_resilience` happy path against a fixture project (uses `os.tmpdir()` + sandbox isolation). Has a leak detector that snapshots the tmpdir in `beforeAll` and only flags dirs created _by this run_ (snapshot-relative, not absolute).
