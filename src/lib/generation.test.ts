import { describe, it, expect } from 'vitest';
import { countSkipReasons, type SkippedSlot } from './generation';

const at = (iso: string, reason: SkippedSlot['reason']): SkippedSlot => ({
  date: new Date(iso),
  reason,
});

describe('countSkipReasons', () => {
  it('counts the three reasons a teacher is shown, and ignores the two they are not', () => {
    const counts = countSkipReasons([
      at('2026-09-21T00:00:00.000Z', 'blocked_by_cancelled'),
      at('2026-09-28T00:00:00.000Z', 'slot_taken'),
      at('2026-10-05T00:00:00.000Z', 'already_this_week'),
      at('2026-10-12T00:00:00.000Z', 'already_this_week'),
      // Deliberately excluded — see SkipCounts' docblock.
      at('2026-10-19T00:00:00.000Z', 'already_generated'),
      at('2026-10-26T00:00:00.000Z', 'raced'),
    ]);

    expect(counts).toEqual({ blockedByCancelled: 1, slotTaken: 1, alreadyThisWeek: 2 });
  });

  it('returns zeroes for an empty skip list', () => {
    expect(countSkipReasons([])).toEqual({
      blockedByCancelled: 0,
      slotTaken: 0,
      alreadyThisWeek: 0,
    });
  });
});
