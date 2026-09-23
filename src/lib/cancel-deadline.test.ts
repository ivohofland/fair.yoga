import { describe, it, expect } from 'vitest';
import { isPastCancelDeadline } from './cancel-deadline';

describe('isPastCancelDeadline', () => {
  const deadline = new Date('2026-04-09T09:00:00Z');

  it('is false before the deadline', () => {
    expect(isPastCancelDeadline(deadline, new Date('2026-04-09T08:59:59.999Z'))).toBe(false);
  });

  it('is false exactly at the deadline', () => {
    expect(isPastCancelDeadline(deadline, new Date(deadline.getTime()))).toBe(false);
  });

  it('is true one millisecond after the deadline', () => {
    expect(isPastCancelDeadline(deadline, new Date(deadline.getTime() + 1))).toBe(true);
  });
});
