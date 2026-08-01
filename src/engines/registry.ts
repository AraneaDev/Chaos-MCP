import { existsSync } from 'fs';
import { join } from 'path';
import type { BaseEngine } from './base.js';
import { TypeScriptEngine } from './typescript.js';
import { PythonEngine } from './python.js';
import { RustEngine } from './rust.js';
import { PhpEngine } from './php.js';
import { canonicalizePythonMutator } from './python/canonicalize.js';
import { canonicalizeRustMutator } from './rust/canonicalize.js';
import { canonicalizePhpMutator } from './php/canonicalize.js';
import type {
  EnvironmentInfo,
  ProjectType,
  SupportedProjectType,
} from '../utils/project-detector.js';
import type { EngineConfigKey } from '../utils/config-loader.js';
import { DEPENDENCY_DIRS } from '../utils/dependency-dirs.js';
import type { ToolArgs } from '../tool-args-validation.js';

/**
 * Re-exported from the detection leaf so existing `from './registry.js'`
 * importers keep working. It is *declared* in project-detector.ts so that
 * `utils/` never has to import from `engines/` — see the note there.
 */
export type { SupportedProjectType };

/**
 * The lexical family a language belongs to for *source-text scanning* purposes.
 *
 * Deliberately named after the comment/string SYNTAX rather than the language:
 * it is the only thing the estimate heuristic keys on, and several languages
 * share one family (TypeScript and Rust are both `'c'`). Members:
 *
 * - `'c'`      — `/* … *\/` block comments, `//` line comments, `'`/`"`/backtick strings.
 * - `'python'` — `#` line comments and triple-quoted strings; NO `//` (floor division).
 * - `'php'`    — the C family PLUS `#` line comments, and `<?php`/`?>` tag stripping.
 *
 * A new language MUST pick one; `noisePattern` in estimate-heuristic.ts switches
 * on this exhaustively, so a new *family* is a compile error there.
 */
export type SyntaxFamily = 'c' | 'python' | 'php';

/**
 * Per-language execution metadata. This is the single source of truth for the
 * facts the codebase previously re-encoded as parallel `projectType === '…'`
 * ternaries and hand-maintained parallel lists (engine construction,
 * config-section selection, line-scope capability, auto-prebuild defaults,
 * sandbox dependency-dir symlinking, comment/string syntax, doc-facing names).
 *
 * Because this is a `Record<SupportedProjectType, EngineDescriptor>`, EVERY
 * field here is compile-enforced: adding a member to `ProjectType` fails the
 * build until the new language supplies all of them.
 *
 * See the "Adding a language" note at the bottom of this file for the sites a
 * new language still has to touch by hand.
 */
export interface EngineDescriptor {
  /** Construct the engine instance for this language. */
  make: () => BaseEngine;

  /**
   * The {@link ChaosConfig} section key holding this engine's overrides
   * (`cfg[configKey]`). The union is declared in config-loader.ts — the module
   * that owns the sections it names — so the two cannot silently disagree.
   */
  configKey: EngineConfigKey;

  /**
   * Whether the engine supports line-level scoping — `lineScope`, diff-aware
   * scoping (A2), and baseline verify re-scoping (A3). Only StrykerJS
   * (TypeScript) does today; the other tools always run whole-file. Also gates
   * which StrykerJS-only options are reported as ignored.
   */
  supportsLineScope: boolean;

  /**
   * Whether the engine honours the `concurrency` option (worker/thread count).
   * StrykerJS (`--concurrency`), cargo-mutants (`-j`), and Infection (`--threads`)
   * all do; cosmic-ray has no worker-count flag and silently discards it. Gates
   * whether `concurrency` is reported to the caller as an ignored option (M1).
   */
  honorsConcurrency: boolean;

  /**
   * Auto-prebuild default: when `marker` exists at the workspace root, run
   * `command` inside the sandbox before mutation. Absent when the language has
   * no default prebuild (TypeScript/Python). These run without the
   * `allowPrebuild` gate (audit Med#10) since they are not caller-supplied.
   */
  prebuild?: { marker: string; command: string };

  /**
   * Heavyweight dependency directories this language keeps at the workspace
   * root, which the sandbox SYMLINKS instead of copying (they are large and
   * read-only during a mutation run). Union'd across languages into
   * `SYMLINK_DIRS` in utils/sandbox.ts.
   *
   * Only list a directory that is safe to SHARE with the host workspace. Build
   * *output* directories must NOT go here: Rust declares `[]` even though it has
   * a huge `target/`, because a symlinked `target/` would let a mutation run
   * corrupt the host's build cache (audit finding H1) — that one is bulk-excluded
   * from the copy via `ALWAYS_EXCLUDE` instead.
   *
   * Order is significant only in that the union is built in registry order.
   */
  dependencyDirs: readonly string[];

  /**
   * Comment/string lexical family, used by the estimate heuristic to strip
   * non-code spans before counting mutable constructs. See {@link SyntaxFamily}.
   */
  syntaxFamily: SyntaxFamily;

  /**
   * Human-facing name of the mutation engine (`'StrykerJS'`, `'cosmic-ray'`, …).
   * Surfaced verbatim in the `chaos://languages` resource and in the MCP tool
   * description.
   */
  displayName: string;

  /**
   * Human-facing name of the LANGUAGE, which is not the `SupportedProjectType`
   * key: `typescript` covers `'TypeScript/JavaScript'`. Paired with
   * {@link EngineDescriptor.displayName} to render the tool description's
   * "Supports X (engine), …" prose.
   */
  label: string;

  /**
   * Translate ONE mutant of this engine's wire vocabulary into a canonical
   * mutator category — a key of `MUTATOR_SEMANTICS` in enrich.ts — or the
   * literal `'unknown'` when nothing matches.
   *
   * Lives here because every such table decodes exactly one tool's output and is
   * versioned against that tool: the PHP map is pinned to Infection 0.27–0.34,
   * the range `php.ts`'s parser declares it reads, and the Rust rules strip
   * cargo-mutants' `->` arrow. Held two layers up in enrich.ts, PHP simply had
   * no branch, so every PHP mutant reported severity `unknown` while the output
   * claimed enrichment had run and a `severityFloor` filtered out 100% of groups
   * (audit: PHP severities all `unknown`). The engine knew; the consumer did not.
   *
   * `rawMutator` is the operator name the engine's parser stored verbatim;
   * `changeText` is the joined change description, which is the ONLY operator
   * evidence for cargo-mutants (it exposes no operator field) and must be the
   * complete set, not a display-capped one.
   *
   * OPTIONAL, and omitting it is the honest default for a new language: the
   * caller falls back to `'unknown'`, i.e. no severity and a why/hint saying so,
   * rather than borrowing another engine's table. That matters because the name
   * spaces collide — `TrueValue` is a real Infection mutator that also matches
   * Python's `/True|False|Boolean/i` rule — and a cross-engine match invents a
   * confident severity out of a coincidence. Returning a name that is NOT in
   * `MUTATOR_SEMANTICS` is also treated as `'unknown'`; the caller re-checks, so
   * this direction never has to import the table upward.
   */
  canonicalizeMutator?: (rawMutator: string, changeText?: string) => string;
}

/**
 * Language → execution metadata.
 *
 * Insertion order IS significant for two derived values: the sandbox's
 * `SYMLINK_DIRS` union (utils/sandbox.ts) and the tool description's
 * "Supports …" prose (tool-schema.ts) are both built by walking this object in
 * declaration order. Reordering it changes those strings; tests pin both.
 */
export const ENGINE_REGISTRY: Record<SupportedProjectType, EngineDescriptor> = {
  typescript: {
    make: () => new TypeScriptEngine(),
    configKey: 'stryker',
    supportsLineScope: true,
    honorsConcurrency: true,
    dependencyDirs: DEPENDENCY_DIRS.typescript,
    syntaxFamily: 'c',
    displayName: 'StrykerJS',
    label: 'TypeScript/JavaScript',
    // StrykerJS's mutator names ARE the canonical vocabulary — the other three
    // engines normalize onto them — so the identity is the whole translation.
    // The caller still rejects a name that is not in `MUTATOR_SEMANTICS`, which
    // is what keeps a custom Stryker plugin's mutator out of the table.
    canonicalizeMutator: (rawMutator) => rawMutator,
  },
  python: {
    make: () => new PythonEngine(),
    configKey: 'cosmicray',
    supportsLineScope: false,
    honorsConcurrency: false,
    dependencyDirs: DEPENDENCY_DIRS.python,
    syntaxFamily: 'python',
    displayName: 'cosmic-ray',
    label: 'Python',
    canonicalizeMutator: canonicalizePythonMutator,
  },
  rust: {
    make: () => new RustEngine(),
    configKey: 'rust',
    supportsLineScope: false,
    honorsConcurrency: true,
    prebuild: { marker: 'Cargo.toml', command: 'cargo check' },
    dependencyDirs: DEPENDENCY_DIRS.rust,
    syntaxFamily: 'c',
    displayName: 'cargo-mutants',
    label: 'Rust',
    canonicalizeMutator: canonicalizeRustMutator,
  },
  php: {
    make: () => new PhpEngine(),
    configKey: 'infection',
    supportsLineScope: false,
    honorsConcurrency: true,
    dependencyDirs: DEPENDENCY_DIRS.php,
    syntaxFamily: 'php',
    displayName: 'Infection',
    label: 'PHP',
    canonicalizeMutator: canonicalizePhpMutator,
  },
};

/**
 * Every heavyweight dependency directory across all languages, deduped, in
 * registry order. The sandbox symlinks these rather than copying them; see
 * `SYMLINK_DIRS` in utils/sandbox.ts, which is exactly this list.
 */
export function dependencyDirectories(): string[] {
  return [
    ...new Set(
      (Object.keys(ENGINE_REGISTRY) as SupportedProjectType[]).flatMap(
        (t) => ENGINE_REGISTRY[t].dependencyDirs,
      ),
    ),
  ];
}

/** Construct the engine for a (supported) project type. */
export function makeEngine(projectType: SupportedProjectType): BaseEngine {
  return ENGINE_REGISTRY[projectType].make();
}

/**
 * Resolve the prebuild command: explicit args win, then fall back to smart
 * defaults based on the detected package manager / language. Returns `null`
 * when no prebuild is needed.
 */
export function resolvePrebuildCommand(
  args: ToolArgs,
  env: EnvironmentInfo,
  projectType: ProjectType,
): string | null {
  if (typeof args.prebuildCommand === 'string' && args.prebuildCommand.trim().length > 0) {
    return args.prebuildCommand;
  }
  // Python dependency installers (`uv sync` / `poetry install`) are intentionally
  // NOT auto-run: `.venv` is symlinked into the sandbox from the host, so an
  // install would mutate the user's real virtual environment (High#2). The
  // symlinked environment is already populated; callers who genuinely need a
  // rebuild can pass an explicit prebuildCommand. Rust (`cargo check`) declares
  // its auto-prebuild in the engine registry. (PHP has none — Infection needs no build.)
  const prebuild = ENGINE_REGISTRY[projectType as SupportedProjectType]?.prebuild;
  if (prebuild && existsSync(join(env.workspaceRoot, prebuild.marker))) {
    return prebuild.command;
  }
  return null;
}

/*
 * ─── Adding a language ───────────────────────────────────────────────────────
 *
 * It is NOT "one entry here". A new language touches roughly a dozen files. What
 * this registry buys you is that most of them now fail the BUILD rather than
 * failing silently at runtime — which is what the earlier version of this note
 * (and the claim that the config lived in `config-loader.ts`, now a 26-line
 * barrel over `utils/config/`) got wrong.
 *
 * COMPILE-ENFORCED — `tsc` fails until each is handled. Adding a member to
 * `ProjectType` in utils/project-detector.ts is the trigger:
 *
 *  1. utils/project-detector.ts — `LANGUAGE_DETECTORS`
 *     (`Record<SupportedProjectType, …>`): extension matcher, extension list,
 *     root markers, test-runner detection. Triage discovery and the tool
 *     schema's extension prose are DERIVED from it.
 *  2. utils/dependency-dirs.ts — `DEPENDENCY_DIRS`
 *     (`Record<SupportedProjectType, …>`): the language's heavyweight dependency
 *     directories, and the ONE place they are written down. `dependencyDirs`
 *     below points at it, and BOTH `SYMLINK_DIRS` (utils/sandbox.ts) and
 *     `SHARED_DEPENDENCY_DIRS` (utils/execution.ts, container bind-mounts) are
 *     DERIVED from it. Declare `[]` for a language whose big directory is build
 *     OUTPUT rather than a shareable cache — see Rust and audit H1.
 *  3. engines/registry.ts — this `Record`. Every `EngineDescriptor` field is
 *     mandatory, and four consumers are DERIVED from them, so they cannot go
 *     stale: `SYMLINK_DIRS` in utils/sandbox.ts (`dependencyDirs`), comment /
 *     string stripping in estimate-heuristic.ts (`syntaxFamily`), the
 *     `chaos://languages` resource and the `audit_code_resilience` description
 *     (`displayName` + `label`).
 *  4. utils/config/types.ts — `EngineConfigKey`, because `configKey` above must
 *     name a real config section (a new section also needs its own type there).
 *  5. utils/execution.ts — `DEFAULT_IMAGES` (`Record<SupportedProjectType, …>`):
 *     the container image for the language.
 *  6. baseline-timing.ts — baseline test command (`never` guard).
 *  7. test-file.ts — test-file naming convention (`never` guard).
 *
 * STILL MANUAL — nothing breaks; behaviour is silently wrong or degraded:
 *
 *  8. engines/<lang>.ts — the {@link BaseEngine} implementation itself.
 *  9. utils/config/rules.ts — validation rules for the new config section
 *     (unvalidated keys are accepted and then ignored).
 * 10. utils/execution.ts — the python-only virtualenv env args. The container
 *     bind-mount list is no longer a hand-written copy; it derives from (2).
 * 11. resources.ts (`estimateFidelity`) and estimate.ts — both branch on
 *     `=== 'rust'` to mean "exact mutant count"; a new language silently
 *     reports "approx".
 * 12. engines/<lang>/canonicalize.ts — the mutator-name → canonical-category
 *     translation, wired in via the OPTIONAL `canonicalizeMutator` above.
 *     Without it the language reports severity "unknown" for every survivor —
 *     honest, but useless. (This used to live in enrich.ts, which is exactly how
 *     PHP shipped with no branch at all.) Plus the Docker image, CI matrix, and
 *     README/CONTRIBUTING tables.
 */
