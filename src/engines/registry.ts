import type { BaseEngine } from './base.js';
import { TypeScriptEngine } from './typescript.js';
import { PythonEngine } from './python.js';
import { RustEngine } from './rust.js';
import { PhpEngine } from './php.js';
import type { ProjectType } from '../utils/project-detector.js';

/** The project types that map to a real mutation engine (everything but 'unsupported'). */
export type SupportedProjectType = Exclude<ProjectType, 'unsupported'>;

/**
 * Per-language execution metadata. This is the single source of truth for the
 * facts the handler previously re-encoded as parallel `projectType === '…'`
 * ternaries scattered across handler.ts (engine construction, config-section
 * selection, line-scope capability, auto-prebuild defaults). Adding a language
 * is now: implement a {@link BaseEngine} and add one entry here (plus the
 * detection entry in project-detector.ts and the config section in
 * config-loader.ts).
 */
export interface EngineDescriptor {
  /** Construct the engine instance for this language. */
  make: () => BaseEngine;

  /**
   * The {@link ChaosConfig} section key holding this engine's overrides
   * (`cfg[configKey]`). Mirrors the section keys parsed in config-loader.ts.
   */
  configKey: 'stryker' | 'cosmicray' | 'rust' | 'infection';

  /**
   * Whether the engine supports line-level scoping — `lineScope`, diff-aware
   * scoping (A2), and baseline verify re-scoping (A3). Only StrykerJS
   * (TypeScript) does today; the other tools always run whole-file. Also gates
   * which StrykerJS-only options are reported as ignored.
   */
  supportsLineScope: boolean;

  /**
   * Auto-prebuild default: when `marker` exists at the workspace root, run
   * `command` inside the sandbox before mutation. Absent when the language has
   * no default prebuild (TypeScript/Python). These run without the
   * `allowPrebuild` gate (audit Med#10) since they are not caller-supplied.
   */
  prebuild?: { marker: string; command: string };
}

/** Language → execution metadata. Insertion order is not significant. */
export const ENGINE_REGISTRY: Record<SupportedProjectType, EngineDescriptor> = {
  typescript: {
    make: () => new TypeScriptEngine(),
    configKey: 'stryker',
    supportsLineScope: true,
  },
  python: {
    make: () => new PythonEngine(),
    configKey: 'cosmicray',
    supportsLineScope: false,
  },
  rust: {
    make: () => new RustEngine(),
    configKey: 'rust',
    supportsLineScope: false,
    prebuild: { marker: 'Cargo.toml', command: 'cargo check' },
  },
  php: {
    make: () => new PhpEngine(),
    configKey: 'infection',
    supportsLineScope: false,
  },
};
