import { describe, expect, it } from 'vitest';
import { AuditDeadline } from '../utils/deadline.js';

describe('AuditDeadline', () => {
  it('tracks one absolute budget across phases', () => {
    let now = 1_000;
    const deadline = new AuditDeadline(10_000, () => now);

    expect(deadline.remainingMs()).toBe(10_000);
    now += 2_500;
    expect(deadline.elapsedMs()).toBe(2_500);
    expect(deadline.remainingMs()).toBe(7_500);
    expect(deadline.expired()).toBe(false);
  });

  it('reserves cleanup time without moving the absolute deadline', () => {
    let now = 0;
    const deadline = new AuditDeadline(5_000, () => now);
    expect(deadline.remainingMs(2_000)).toBe(3_000);
    now = 4_000;
    expect(deadline.remainingMs(2_000)).toBe(0);
    expect(deadline.remainingMs()).toBe(1_000);
  });

  it('clamps expired and invalid budgets safely', () => {
    let now = 10;
    const deadline = new AuditDeadline(0, () => now);
    expect(deadline.remainingMs()).toBe(1);
    now = 11;
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.expired()).toBe(true);
  });
});
