/**
 * Abort reason used when the memory watchdog stops a run.
 *
 * Distinct from a user cancel on purpose: a cancel reports "Operation
 * cancelled.", while this reports what to lower. Callers key on
 * {@link isResourceExhausted} before falling back to the cancel wording.
 */
export class ResourceExhaustedError extends Error {
  readonly availableBytes: number;
  readonly criticalBytes: number;

  constructor(availableBytes: number, criticalBytes: number) {
    super(
      `Stopped to avoid exhausting memory: ${Math.round(availableBytes / 1024 ** 2)} MB free, ` +
        `floor is ${Math.round(criticalBytes / 1024 ** 2)} MB. ` +
        'Lower fileConcurrency or concurrency, or raise the machine memory.',
    );
    this.name = 'ResourceExhaustedError';
    this.availableBytes = availableBytes;
    this.criticalBytes = criticalBytes;
  }
}

export function isResourceExhausted(error: unknown): boolean {
  return error instanceof ResourceExhaustedError;
}
