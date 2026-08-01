import type { SupportedProjectType } from './project-detector.js';

/**
 * Per-language heavyweight dependency directories — the ONE place each
 * language's directories are written down.
 *
 * This lives in its own import-free leaf module rather than inline in
 * `registry.ts` because BOTH layers need it and they sit on opposite sides of
 * the dependency graph:
 *
 *   - `utils/sandbox.ts` derives `SYMLINK_DIRS` from `ALL_DEPENDENCY_DIRS`.
 *   - `utils/execution.ts` derives the container bind-mount list from it.
 *   - `engines/registry.ts` stamps each descriptor's `dependencyDirs` from it.
 *
 * `utils/execution.ts` cannot import `engines/registry.ts` directly: the
 * registry imports every engine class, each engine reaches
 * `utils/exec-classify.ts`, and that imports `utils/execution.ts` — a cycle
 * (9 of them, one per engine/entry-point pair). Hoisting just the DATA into a
 * module that imports nothing at runtime breaks that knot while keeping a single
 * source of truth, so the three consumers cannot drift.
 *
 * It sits under `utils/` rather than `engines/` because two of its three
 * consumers are utils and it depends on nothing in the engine layer — it is
 * data, not engine behaviour. Filing it under `engines/` made the two utils
 * that read it import upward across a layer they otherwise never touch
 * (`utils-is-a-leaf` in knossos.json).
 *
 * Only list a directory that is safe to SHARE with the host workspace. Build
 * *output* directories must NOT go here — see {@link EngineDescriptor.dependencyDirs}
 * in registry.ts for why Rust declares none (audit H1).
 *
 * Declaration order is load-bearing: it fixes the order of
 * {@link ALL_DEPENDENCY_DIRS}, which in turn fixes the order of the generated
 * `--mount` argv. Keep it in step with `ENGINE_REGISTRY`'s declaration order.
 */
export const DEPENDENCY_DIRS: Record<SupportedProjectType, readonly string[]> = {
  typescript: ['node_modules'],
  // Both conventional virtualenv layouts; a project uses one or the other.
  python: ['.venv', 'venv'],
  // Deliberately empty: `target/` is build OUTPUT, not a read-only dependency
  // cache, so it is excluded from the copy rather than shared (audit H1).
  rust: [],
  // Composer's vendor/. Note utils/sandbox.ts drops this from the symlink set
  // for Composer audits specifically and copies it instead — see
  // `isComposerPhpAudit` for why __DIR__ resolution forces that.
  php: ['vendor'],
};

/**
 * Every dependency directory across all languages, deduped, in declaration
 * order. Consumed by the exec layer for container bind-mounts; the registry's
 * `dependencyDirectories()` derives the same list from the engine descriptors,
 * and a test pins the two to be identical in value AND order.
 */
export const ALL_DEPENDENCY_DIRS: readonly string[] = [
  ...new Set(Object.values(DEPENDENCY_DIRS).flat()),
];
