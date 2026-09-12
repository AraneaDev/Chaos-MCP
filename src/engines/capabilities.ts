/**
 * Cross-engine capability matrix, and the ratchet it feeds.
 *
 * Parity may only go up: no change may lower a cell. The test in
 * `__tests__/capabilities-parity.test.ts` compares this table against the
 * committed baseline in both directions, so a drop fails the build and a gain
 * fails until the baseline is updated on purpose.
 *
 * Seeded 2026-09-11 from a read of all four engines. Cells that a registry flag
 * already decides are derived from it, so the two cannot disagree.
 */
import type { SupportedProjectType } from '../utils/project-detector.js';
import { ENGINE_REGISTRY } from './registry.js';

export type CapabilityLevel = 'none' | 'partial' | 'full';

export const LEVEL_RANK: Record<CapabilityLevel, number> = { none: 0, partial: 1, full: 2 };

export type Capability =
  | 'related-test-selection'
  | 'per-test-coverage'
  | 'incremental-cache'
  | 'run-cache-verify'
  | 'diff-line-scope'
  | 'concurrency'
  | 'inner-pool-cap'
  | 'per-mutant-timeout'
  | 'partial-results-on-timeout'
  | 'baseline-timing'
  | 'cancellation'
  | 'suppressions'
  | 'dead-harness-warning'
  | 'no-coverage-reporting'
  | 'replacement-text'
  | 'column-info'
  | 'mutator-names'
  | 'mutator-filtering'
  | 'dry-run'
  | 'estimate'
  | 'missing-tool-preflight'
  | 'container'
  | 'memory-aware-sizing'
  | 'memory-watchdog';

const derived = (type: SupportedProjectType) => ({
  'diff-line-scope': ENGINE_REGISTRY[type].supportsLineScope
    ? ('full' as CapabilityLevel)
    : ('none' as CapabilityLevel),
  concurrency: ENGINE_REGISTRY[type].honorsConcurrency
    ? ('full' as CapabilityLevel)
    : ('none' as CapabilityLevel),
});

export const CAPABILITIES: Record<SupportedProjectType, Record<Capability, CapabilityLevel>> = {
  typescript: {
    ...derived('typescript'),
    'related-test-selection': 'full',
    'per-test-coverage': 'partial',
    'incremental-cache': 'full',
    'run-cache-verify': 'full',
    'inner-pool-cap': 'full',
    'per-mutant-timeout': 'full',
    'partial-results-on-timeout': 'full',
    'baseline-timing': 'full',
    cancellation: 'full',
    suppressions: 'full',
    'dead-harness-warning': 'full',
    'no-coverage-reporting': 'full',
    'replacement-text': 'full',
    'column-info': 'full',
    'mutator-names': 'full',
    'mutator-filtering': 'partial',
    'dry-run': 'full',
    estimate: 'partial',
    'missing-tool-preflight': 'full',
    container: 'full',
    'memory-aware-sizing': 'full',
    'memory-watchdog': 'full',
  },
  python: {
    ...derived('python'),
    'related-test-selection': 'partial',
    'per-test-coverage': 'none',
    'incremental-cache': 'none',
    'run-cache-verify': 'partial',
    // cosmic-ray runs its mutants serially, so there is no pool to cap.
    // 'partial' rather than 'none': cosmic-ray having no pool is the tool's
    // shape, not a gap to close, and 'none' reads as something to fix later.
    'inner-pool-cap': 'partial',
    'per-mutant-timeout': 'partial',
    'partial-results-on-timeout': 'none',
    'baseline-timing': 'partial',
    cancellation: 'full',
    suppressions: 'full',
    'dead-harness-warning': 'full',
    'no-coverage-reporting': 'none',
    'replacement-text': 'full',
    'column-info': 'none',
    'mutator-names': 'full',
    'mutator-filtering': 'partial',
    'dry-run': 'none',
    estimate: 'partial',
    'missing-tool-preflight': 'full',
    container: 'full',
    'memory-aware-sizing': 'full',
    'memory-watchdog': 'full',
  },
  rust: {
    ...derived('rust'),
    'related-test-selection': 'none',
    'per-test-coverage': 'none',
    'incremental-cache': 'none',
    'run-cache-verify': 'partial',
    'inner-pool-cap': 'full',
    'per-mutant-timeout': 'none',
    'partial-results-on-timeout': 'none',
    'baseline-timing': 'full',
    cancellation: 'full',
    suppressions: 'partial',
    'dead-harness-warning': 'full',
    'no-coverage-reporting': 'none',
    'replacement-text': 'none',
    'column-info': 'none',
    'mutator-names': 'partial',
    'mutator-filtering': 'none',
    'dry-run': 'none',
    estimate: 'full',
    'missing-tool-preflight': 'partial',
    container: 'full',
    'memory-aware-sizing': 'full',
    'memory-watchdog': 'full',
  },
  php: {
    ...derived('php'),
    'related-test-selection': 'full',
    'per-test-coverage': 'full',
    'incremental-cache': 'none',
    'run-cache-verify': 'partial',
    'inner-pool-cap': 'full',
    'per-mutant-timeout': 'none',
    'partial-results-on-timeout': 'none',
    'baseline-timing': 'partial',
    cancellation: 'full',
    suppressions: 'full',
    'dead-harness-warning': 'full',
    'no-coverage-reporting': 'full',
    'replacement-text': 'full',
    'column-info': 'none',
    'mutator-names': 'full',
    'mutator-filtering': 'none',
    'dry-run': 'none',
    estimate: 'partial',
    'missing-tool-preflight': 'partial',
    container: 'full',
    'memory-aware-sizing': 'full',
    'memory-watchdog': 'full',
  },
};
