/**
 * Shared execution constants.
 *
 * Single source of truth for defaults that were previously duplicated across the
 * engines and the exec layer (audit I2). The schema docs describe this same value
 * as the enforced default, so keeping one constant keeps documentation and
 * behaviour from drifting apart.
 */

/**
 * Default wall-clock timeout (ms) for a single mutation-tool invocation when the
 * caller does not pass `timeoutMs`. Applied by every engine and by the exec layer.
 */
export const DEFAULT_TIMEOUT_MS = 300_000;
