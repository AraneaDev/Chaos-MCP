/**
 * Config loading, in three parts under `./config/`:
 *
 * - `config/types.ts`    — the config shapes (`ChaosConfig` and its sections).
 * - `config/rules.ts`    — ONE rule table per field group, shared by both sides.
 * - `config/parse.ts`    — reads a file and silently drops what the rules reject.
 * - `config/validate.ts` — reads the same file and explains what was dropped.
 *
 * This module stays as the public entry point so every importer keeps one path:
 * five of them (`handler.ts`, `triage-handler.ts`, `estimate-handler.ts`,
 * `index.ts`, `utils/execution.ts`) want only the types, `engines/registry.ts`
 * wants `EngineConfigKey`, and only `cli.ts` wants `loadConfig`/`validateConfig`.
 */
export type {
  CargoMutantsConfig,
  ChaosConfig,
  ConfigValidation,
  ContainerConfig,
  CosmicRayConfig,
  EngineConfigKey,
  InfectionConfig,
  StrykerConfig,
} from './config/types.js';

export { loadConfig } from './config/parse.js';
export { validateConfig } from './config/validate.js';
