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
