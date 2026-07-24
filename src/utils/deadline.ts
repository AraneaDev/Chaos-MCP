/**
 * Absolute wall-clock budget shared by all phases of one audit.
 *
 * Mutation engines still receive their own timeout, but it is derived from the
 * remaining absolute budget so discovery, sandboxing, and prebuild work cannot
 * each consume a fresh full timeout.
 */
export class AuditDeadline {
  readonly startedAt: number;
  readonly expiresAt: number;

  constructor(
    readonly budgetMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
    this.expiresAt = this.startedAt + Math.max(1, budgetMs);
  }

  elapsedMs(): number {
    return Math.max(0, this.now() - this.startedAt);
  }

  remainingMs(reserveMs = 0): number {
    return Math.max(0, this.expiresAt - this.now() - Math.max(0, reserveMs));
  }

  expired(): boolean {
    return this.remainingMs() <= 0;
  }
}
