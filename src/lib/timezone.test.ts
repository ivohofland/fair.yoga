import { describe, it, expect, vi, afterEach } from 'vitest';
import { classStartInstant, startOfLocalDay, startOfLocalWeek } from './timezone';
import { log } from '@/lib/log';

/**
 * The boundary #86's archive rule compares `Class.date` against. These are
 * the deterministic teeth for that fix: the service tests seed a teacher and
 * ask whether today's class survived, but "today" there is whatever the clock
 * says at run time. Here the instants are fixed, so both directions of the
 * bug are pinned at every hour of the day.
 */
describe('startOfLocalDay', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is the UTC calendar date for a UTC teacher', () => {
    expect(startOfLocalDay(new Date('2026-07-26T13:45:00Z'), 'UTC').toISOString()).toBe(
      '2026-07-26T00:00:00.000Z',
    );
  });

  /**
   * West of UTC, late local evening: UTC has already rolled into the next
   * calendar day while the teacher is still on the previous one. Using `now`
   * directly here is what left tomorrow's class bookable under an archived
   * template — the delete's `date > now` read false for it.
   */
  it('stays on the previous day west of UTC after UTC midnight', () => {
    expect(
      startOfLocalDay(new Date('2026-07-26T01:05:00Z'), 'America/Los_Angeles').toISOString(),
    ).toBe('2026-07-25T00:00:00.000Z');
  });

  /**
   * East of UTC, local morning: the teacher is already on the next calendar
   * day while UTC is not. Using `now` directly here is what deleted a class
   * running that same evening — `date > now` read true for it.
   */
  it('advances to the next day east of UTC before UTC midnight', () => {
    expect(startOfLocalDay(new Date('2026-07-25T21:00:00Z'), 'Pacific/Auckland').toISOString()).toBe(
      '2026-07-26T00:00:00.000Z',
    );
  });

  it('returns midnight, not the instant it was given', () => {
    const d = startOfLocalDay(new Date('2026-07-26T13:45:30.500Z'), 'Europe/Amsterdam');
    expect([d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()]).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it('falls back to the UTC calendar date for an unknown timezone', () => {
    expect(startOfLocalDay(new Date('2026-07-26T13:45:00Z'), 'Not/AZone').toISOString()).toBe(
      '2026-07-26T00:00:00.000Z',
    );
  });

  it('warns when falling back so the bad zone is observable', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    startOfLocalDay(new Date('2026-07-26T13:45:00Z'), 'Not/AZone');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ timeZone: 'Not/AZone' }),
      expect.stringContaining('falling back to UTC'),
    );
  });
});

// Class rows store a calendar date (UTC midnight) + HH:mm wall-clock startTime.
// classStartInstant interprets that wall clock in the teacher's timezone.
describe('classStartInstant', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('converts Amsterdam summer time (CEST, +2) to UTC', () => {
    const start = classStartInstant(day('2026-07-20'), '18:00', 'Europe/Amsterdam');
    expect(start.toISOString()).toBe('2026-07-20T16:00:00.000Z');
  });

  it('converts Amsterdam winter time (CET, +1) to UTC', () => {
    const start = classStartInstant(day('2026-01-20'), '18:00', 'Europe/Amsterdam');
    expect(start.toISOString()).toBe('2026-01-20T17:00:00.000Z');
  });

  it('handles zones behind UTC', () => {
    const start = classStartInstant(day('2026-07-20'), '18:00', 'America/New_York');
    expect(start.toISOString()).toBe('2026-07-20T22:00:00.000Z');
  });

  it('an early-morning class can start on the previous UTC day', () => {
    const start = classStartInstant(day('2026-07-20'), '00:30', 'Europe/Amsterdam');
    expect(start.toISOString()).toBe('2026-07-19T22:30:00.000Z');
  });

  it('UTC zone is the identity', () => {
    const start = classStartInstant(day('2026-07-20'), '09:15', 'UTC');
    expect(start.toISOString()).toBe('2026-07-20T09:15:00.000Z');
  });

  it('resolves a time on the EU spring-forward day (02:30 does not exist)', () => {
    // 2026-03-29 02:00 CET jumps to 03:00 CEST. The helper must return a
    // deterministic instant on the right day, not NaN.
    const start = classStartInstant(day('2026-03-29'), '02:30', 'Europe/Amsterdam');
    expect(Number.isNaN(start.getTime())).toBe(false);
    // Either interpretation (+1 → 01:30Z, +2 → 00:30Z) is acceptable.
    const iso = start.toISOString();
    expect(['2026-03-29T00:30:00.000Z', '2026-03-29T01:30:00.000Z']).toContain(iso);
  });

  it('falls back to UTC interpretation for an unknown timezone', () => {
    const start = classStartInstant(day('2026-07-20'), '18:00', 'Not/AZone');
    expect(start.toISOString()).toBe('2026-07-20T18:00:00.000Z');
  });

  it('warns when falling back to UTC so the bad zone is observable', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    classStartInstant(day('2026-07-20'), '18:00', 'Not/AZone');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ timeZone: 'Not/AZone' }),
      expect.stringContaining('falling back to UTC'),
    );
  });
});

/**
 * #101. The teacher's week, not UTC's. Both the Schedule tab's query window and
 * the "This week" labels below it derived their Monday from `new Date()` read
 * with `getUTCDay`, so for a teacher west of UTC in their local evening — when
 * UTC has already rolled into the next day, and on Sundays into the next week —
 * the boundary landed a day or a week off.
 *
 * These fixtures use `America/Los_Angeles` (UTC-7 in June) and are all
 * instants where the UTC calendar day and the LA calendar day disagree.
 */
describe('startOfLocalWeek', () => {
  it('returns the Monday of the local week, not the UTC week', () => {
    // Sunday 20:00 LA = Monday 03:00 UTC. UTC has entered the next week; LA has not.
    const instant = new Date('2026-06-08T03:00:00.000Z');
    expect(startOfLocalWeek(instant, 'America/Los_Angeles').toISOString())
      .toBe('2026-06-01T00:00:00.000Z');
  });

  it('agrees with UTC when the two calendar days agree', () => {
    // Wednesday 12:00 UTC = Wednesday 05:00 LA — same calendar day, same week.
    const instant = new Date('2026-06-10T12:00:00.000Z');
    expect(startOfLocalWeek(instant, 'America/Los_Angeles').toISOString())
      .toBe('2026-06-08T00:00:00.000Z');
  });

  it('treats Monday as the first day of the week', () => {
    // Monday 09:00 LA — the week starts today, not six days ago.
    const instant = new Date('2026-06-08T16:00:00.000Z');
    expect(startOfLocalWeek(instant, 'America/Los_Angeles').toISOString())
      .toBe('2026-06-08T00:00:00.000Z');
  });

  it('rolls Sunday back to the Monday six days earlier', () => {
    // Sunday 09:00 LA. JS getUTCDay() is 0 for Sunday; the schema convention is
    // Monday-first, so this is the case a naive `1 - day` gets wrong by a week.
    const instant = new Date('2026-06-14T16:00:00.000Z');
    expect(startOfLocalWeek(instant, 'America/Los_Angeles').toISOString())
      .toBe('2026-06-08T00:00:00.000Z');
  });

  it('works east of UTC too', () => {
    // Monday 00:30 Amsterdam = Sunday 22:30 UTC. UTC is still last week.
    const instant = new Date('2026-06-07T22:30:00.000Z');
    expect(startOfLocalWeek(instant, 'Europe/Amsterdam').toISOString())
      .toBe('2026-06-08T00:00:00.000Z');
  });
});
