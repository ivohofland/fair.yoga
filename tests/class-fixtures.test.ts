import { describe, expect, it } from 'vitest';
import { timeToHHmm } from '@/lib/time-of-day';
import { wallSlotAt } from './class-fixtures';

describe('wallSlotAt', () => {
  it('refuses the earlier of a repeated wall-clock hour, which no slot can name', () => {
    expect(() => wallSlotAt(new Date('2026-10-25T00:05:00Z'), 'Europe/Amsterdam')).toThrow(
      /2026-10-25T00:05:00\.000Z.*Europe\/Amsterdam.*02:05.*2026-10-25T01:05:00\.000Z/,
    );
  });

  it('accepts the later of a repeated hour, which a slot reads back as', () => {
    const { date, startTime } = wallSlotAt(new Date('2026-10-25T01:05:00Z'), 'Europe/Amsterdam');
    expect(date.toISOString()).toBe('2026-10-25T00:00:00.000Z');
    expect(timeToHHmm(startTime)).toBe('02:05');
  });

  it('truncates to the minute, so an instant with seconds still round-trips', () => {
    expect(() => wallSlotAt(new Date('2026-10-25T10:00:42Z'), 'UTC')).not.toThrow();
  });
});
