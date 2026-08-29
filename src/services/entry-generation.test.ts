import { describe, it, expect } from 'vitest';
import { mondayOf } from '@/lib/timezone';
import { getNextOccurrences, firstFreeWeek } from './entry-generation';

// ===========================================================================
// Pure logic tests — getNextOccurrences
// ===========================================================================

describe('getNextOccurrences', () => {
  it('returns 4 dates for dayOfWeek=1 (Tuesday) starting from Monday 2026-04-06', () => {
    // Monday 2026-04-06, looking for Tuesdays (dayOfWeek=1 in schema)
    const from = new Date('2026-04-06T00:00:00.000Z');
    const dates = getNextOccurrences(1, from, 4);

    expect(dates).toHaveLength(4);
    expect(dates[0]!.toISOString()).toBe('2026-04-07T00:00:00.000Z');
    expect(dates[1]!.toISOString()).toBe('2026-04-14T00:00:00.000Z');
    expect(dates[2]!.toISOString()).toBe('2026-04-21T00:00:00.000Z');
    expect(dates[3]!.toISOString()).toBe('2026-04-28T00:00:00.000Z');
  });

  it('includes today if today matches the day (Tuesday 2026-04-07, dayOfWeek=1)', () => {
    // Tuesday 2026-04-07, looking for Tuesdays (dayOfWeek=1 in schema)
    const from = new Date('2026-04-07T00:00:00.000Z');
    const dates = getNextOccurrences(1, from, 4);

    expect(dates).toHaveLength(4);
    expect(dates[0]!.toISOString()).toBe('2026-04-07T00:00:00.000Z');
    expect(dates[1]!.toISOString()).toBe('2026-04-14T00:00:00.000Z');
    expect(dates[2]!.toISOString()).toBe('2026-04-21T00:00:00.000Z');
    expect(dates[3]!.toISOString()).toBe('2026-04-28T00:00:00.000Z');
  });
});

describe('firstFreeWeek', () => {
  const d = (iso: string) => new Date(iso);
  // Four consecutive Thursdays.
  const thursdays = [
    d('2026-09-24T00:00:00.000Z'),
    d('2026-10-01T00:00:00.000Z'),
    d('2026-10-08T00:00:00.000Z'),
    d('2026-10-15T00:00:00.000Z'),
  ];

  it('returns the first candidate when nothing is held', () => {
    expect(firstFreeWeek(thursdays, new Set())?.toISOString()).toBe('2026-09-24T00:00:00.000Z');
  });

  it('skips candidates whose week is held and returns the first free one', () => {
    // Hold the weeks of the first two Thursdays, via the MONDAY of each —
    // which is what a Tuesday class from the same template would produce.
    const held = new Set([
      mondayOf(d('2026-09-22T00:00:00.000Z')), // Tue, week of Sep 21
      mondayOf(d('2026-09-29T00:00:00.000Z')), // Tue, week of Sep 28
    ]);
    expect(firstFreeWeek(thursdays, held)?.toISOString()).toBe('2026-10-08T00:00:00.000Z');
  });

  it('returns null when every candidate week is held', () => {
    const held = new Set(thursdays.map((t) => mondayOf(t)));
    expect(firstFreeWeek(thursdays, held)).toBeNull();
  });

  it('returns null for an empty candidate list', () => {
    expect(firstFreeWeek([], new Set())).toBeNull();
  });
});
