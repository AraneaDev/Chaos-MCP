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

  /**
   * Whether `estimate_audit` can report an EXACT mutant count for this language,
   * or only a source-parse approximation.
   *
   * `'exact'` means one thing very specifically: the estimate path shells the
   * engine's own mutant-ENUMERATION command (today only `cargo mutants --list`)
   * instead of counting constructs in the source text. Three consumers derive
   * from that single fact and must not re-decide it by naming a language:
   *
   *  - `computeCount` (estimate.ts) dispatches the exact path on it, and stamps
   *    the resulting `EstimateResult.fidelity`.
   *  - `estimateNeedsSandbox` (estimate.ts) provisions a sandbox for it —
   *    enumerating requires a subprocess with a workspace, and `computeCount`
   *    silently degrades to the heuristic when `workDir` is absent. The two are
   *    the same condition BY CONSTRUCTION, not by coincidence: the exact path IS
   *    the subprocess path. A future language that reached `'exact'` by parsing
   *    source in-process would need its own branch in `computeCount` AND would
   *    break that equivalence — split the two functions again if that happens.
   *  - the `chaos://languages` resource reports it verbatim to clients.
   *
   * Declaring `'exact'` without adding an exact-count branch to `computeCount`
   * runs cargo-mutants against a non-Rust file; `'approx'` is the correct and
   * honest default for a new language.
   */
  estimateFidelity: 'exact' | 'approx';

  /**
   * Qualifier published alongside an `'exact'` claim in `chaos://languages`,
   * saying exact AT WHAT. Only meaningful with `estimateFidelity: 'exact'`;
   * `'approx'` is already a caveat and needs none.
   *
   * Per-language prose, not derivable: a bare `'exact'` reads as "this is the
   * audit's denominator", and for cargo-mutants it is not — `--list` enumerates
   * mutants that will not compile, which engines/rust.ts excludes from
   * `totalMutants` and reports as `incompetent`. Another engine's `--list` could
   * be exact in a different way, so the sentence belongs to the engine.
   */
  estimateFidelityNote?: string;

  /**
   * Why THIS engine's mutants can come back with severity `'unknown'`, when the
   * reason is a limitation of the engine's own output rather than a gap in this
   * server's tables. Rendered by `unclassifiedNote` in format.ts; when absent
   * the caller emits the generic "this operator name is not one we map" wording,
   * which is the correct explanation for every engine that names its operators.
   *
   * Deliberately NOT derived from {@link EngineDescriptor.estimateFidelity},
   * even though Rust is today the only language with either. The two facts are
   * independent: `estimateFidelity` is about cargo-mutants having a `--list`
   * subcommand, this is about cargo-mutants having no per-mutant operator field.
   * An engine could easily have one and not the other, and deriving it would
   * tell that engine's users their tool hides information it in fact reports —
   * the exact factually-false note this replaced (see `unclassifiedNote`).
   */
  unclassifiedMutatorNote?: string;
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
    estimateFidelity: 'approx',
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
    estimateFidelity: 'approx',
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
    // The one engine with a mutant-enumeration subcommand (`cargo mutants
    // --list`), hence the only 'exact' — and hence the only language whose
    // estimate has to provision a sandbox without being asked for timing.
    estimateFidelity: 'exact',
    estimateFidelityNote:
      'Exact for the mutants cargo-mutants --list GENERATES; the audit scores fewer, ' +
      'excluding unviable ones from its denominator as `incompetent`.',
    // cargo-mutants reports a free-text change description and no operator
    // field, so an unclassified Rust mutant is the TOOL's limit, not this
    // server's missing table entry. Unrelated to `estimateFidelity` above.
    unclassifiedMutatorNote:
      'some mutants could not be classified — cargo-mutants reports a free-text description rather than a per-mutant operator, and this one carried no recognizable operator (severity reported as "unknown").',
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
    estimateFidelity: 'approx',
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
 * Resolve the prebuild command: an explicit one wins, then fall back to smart
 * defaults based on the detected package manager / language. Returns `null`
 * when no prebuild is needed.
 *
 * `explicit` is the caller-supplied command, ALREADY extracted and validated
 * (non-blank string or `undefined`) by whoever owns the tool arguments. This
 * used to take the whole `ToolArgs` bag and read `args.prebuildCommand` by
 * string key — the engine layer's only upward import, and one that bought no
 * type safety at all, since `ToolArgs` is `Record<string, unknown>`: renaming
 * the schema property would have silently stopped honouring it with no compile
 * error. The handler layer now names that property, and the string appears in
 * exactly the layer that defines it.
 */
export function resolvePrebuildCommand(
  explicit: string | undefined,
  env: EnvironmentInfo,
  projectType: ProjectType,
): string | null {
  if (explicit !== undefined) return explicit;
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
 *  3. engines/registry.ts — this `Record`. Every non-optional `EngineDescriptor`
 *     field is mandatory, and six consumers are DERIVED from them, so they
 *     cannot go stale: `SYMLINK_DIRS` in utils/sandbox.ts (`dependencyDirs`),
 *     comment / string stripping in estimate-heuristic.ts (`syntaxFamily`), the
 *     `chaos://languages` resource and the `audit_code_resilience` description
 *     (`displayName` + `label`), and BOTH the exact-count dispatch and the
 *     sandbox precondition in estimate.ts (`estimateFidelity`).
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
 * 11. estimate.ts — `computeCount`, and ONLY if you set `estimateFidelity:
 *     'exact'` above. The field itself is now the single source of truth for
 *     "the mutant count is exact": `estimateNeedsSandbox`, the `fidelity` on
 *     `EstimateResult`, and the `chaos://languages` resource all read it, and
 *     none of them names a language any more. What is still hand-written is the
 *     exact-count IMPLEMENTATION — `computeCount` has one branch, and it shells
 *     `cargo mutants --list`. Leave `estimateFidelity: 'approx'` (the honest
 *     default) and there is nothing to do here. Likewise `estimateFidelityNote`
 *     and `unclassifiedMutatorNote`: both are optional per-engine prose, and
 *     omitting them yields the correct generic wording rather than a wrong
 *     borrowed one.
 * 12. engines/<lang>/canonicalize.ts — the mutator-name → canonical-category
 *     translation, wired in via the OPTIONAL `canonicalizeMutator` above.
 *     Without it the language reports severity "unknown" for every survivor —
 *     honest, but useless. (This used to live in enrich.ts, which is exactly how
 *     PHP shipped with no branch at all.) Plus the Docker image, CI matrix, and
 *     README/CONTRIBUTING tables.
 */
