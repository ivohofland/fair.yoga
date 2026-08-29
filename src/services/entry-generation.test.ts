import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { mondayOf } from '@/lib/timezone';
import { log } from '@/lib/log';
import { getNextOccurrences, firstFreeWeek, probeFirstEffectiveWeek } from './entry-generation';

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

// ===========================================================================
// probeFirstEffectiveWeek — the two failure modes, and that neither escapes
// ===========================================================================

/**
 * The probe runs AFTER its caller's transaction has committed, so its contract
 * is `null` on failure rather than a throw: a template the teacher already
 * saved must not come back as a 500 because the sentence naming its first
 * effective week could not be composed. Two guards carry that, and these two
 * cases are one each — read fault and arithmetic fault — asserted through the
 * warn line, because `null` alone cannot tell them apart and the whole reason
 * there are two guards is that an operator has to.
 *
 * Stubbed rather than seeded: what is under test is the shape of the failure
 * path, and both branches need a read that misbehaves in a way no real query
 * against a healthy schema produces.
 */
describe('probeFirstEffectiveWeek failure handling', () => {
  const THURSDAYS = [
    new Date('2026-09-24T00:00:00.000Z'),
    new Date('2026-10-01T00:00:00.000Z'),
    new Date('2026-10-08T00:00:00.000Z'),
    new Date('2026-10-15T00:00:00.000Z'),
  ];

  const TEMPLATE = {
    id: 'tpl-probe',
    scheduleRuleId: 'rule-probe',
    teacherId: 'teacher-probe',
    startTime: '09:00',
    durationMinutes: 60,
  };

  /** One stub for both cases; `findMany` decides by call order. */
  const clientOf = (findMany: (call: number) => Promise<unknown>) => {
    let call = 0;
    return { calendarEntry: { findMany: () => findMany(call++) } } as unknown as PrismaClient;
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers null and logs a READ fault when a read rejects', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const db = clientOf(() => Promise.reject(new Error('connection reset')));

    await expect(probeFirstEffectiveWeek(db, TEMPLATE, THURSDAYS, 'studio template')).resolves.toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[1])).toContain('the first-effective-week probe failed');
  });

  it('answers null and logs an ARITHMETIC fault when the week maths throws', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    // Both reads RESOLVE — the `.catch()` on them never fires. The second one
    // hands back a slot holder with no `startTime`, which `spansOverlap`
    // dereferences, so the throw lands in the arithmetic the second guard
    // covers. A malformed `startTime` on the TEMPLATE is not an injection:
    // `hhmmToTime` answers an invalid `Date` and every comparison after it is
    // `false`, so the probe returns a week rather than failing.
    const db = clientOf((call) =>
      Promise.resolve(
        call === 0 ? [] : [{ date: THURSDAYS[0], startTime: null, durationMinutes: 60 }],
      ),
    );

    await expect(probeFirstEffectiveWeek(db, TEMPLATE, THURSDAYS, 'recurring class')).resolves.toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[1]);
    // The two lines must stay distinguishable — that is the whole point of the
    // second guard, and a shared sentence would pass a `null` assertion alone.
    expect(message).toContain("probe's own week arithmetic threw");
    expect(message).not.toContain('the first-effective-week probe failed');
  });
});
