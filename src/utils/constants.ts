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

/**
 * Largest delay `setTimeout` accepts: the 32-bit signed maximum (~24.8 days).
 *
 * Node stores timer delays in a 32-bit int, so anything above this is clamped
 * to **1 ms** with a `TimeoutOverflowWarning` — the opposite of what the caller
 * asked for. A `timeoutMs` of 3_000_000_000 (one stray zero in a config file)
 * therefore killed the mutation tool ~1 ms after spawn and reported
 * "Command timed out after 3000000000ms". Both `execFile`'s internal timer and
 * the process-tree cleanup timer in `utils/exec.ts` are affected.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;
