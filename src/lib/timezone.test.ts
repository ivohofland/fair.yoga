import { describe, it, expect, vi, afterEach } from 'vitest';
import { classStartInstant, startsInPast, startOfLocalDay, startOfLocalWeek, mondayOf } from './timezone';
import { hhmmToTime } from '@/lib/time-of-day';
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

// Class rows store a calendar date (UTC midnight) + a wall-clock startTime
// (`@db.Time`). classStartInstant interprets that wall clock in the teacher's
// timezone.
describe('classStartInstant', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('converts Amsterdam summer time (CEST, +2) to UTC', () => {
    const start = classStartInstant(day('2026-07-20'), hhmmToTime('18:00'), 'Europe/Amsterdam');
    expect(start.toISOString()).toBe('2026-07-20T16:00:00.000Z');
  });

  it('converts Amsterdam winter time (CET, +1) to UTC', () => {
    const start = classStartInstant(day('2026-01-20'), hhmmToTime('18:00'), 'Europe/Amsterdam');
    expect(start.toISOString()).toBe('2026-01-20T17:00:00.000Z');
  });

  it('handles zones behind UTC', () => {
    const start = classStartInstant(day('2026-07-20'), hhmmToTime('18:00'), 'America/New_York');
    expect(start.toISOString()).toBe('2026-07-20T22:00:00.000Z');
  });

  it('an early-morning class can start on the previous UTC day', () => {
    const start = classStartInstant(day('2026-07-20'), hhmmToTime('00:30'), 'Europe/Amsterdam');
    expect(start.toISOString()).toBe('2026-07-19T22:30:00.000Z');
  });

  it('UTC zone is the identity', () => {
    const start = classStartInstant(day('2026-07-20'), hhmmToTime('09:15'), 'UTC');
    expect(start.toISOString()).toBe('2026-07-20T09:15:00.000Z');
  });

  it('resolves a time on the EU spring-forward day (02:30 does not exist)', () => {
    // 2026-03-29 02:00 CET jumps to 03:00 CEST. The helper must return a
    // deterministic instant on the right day, not NaN.
    const start = classStartInstant(day('2026-03-29'), hhmmToTime('02:30'), 'Europe/Amsterdam');
    expect(Number.isNaN(start.getTime())).toBe(false);
    // Either interpretation (+1 → 01:30Z, +2 → 00:30Z) is acceptable.
    const iso = start.toISOString();
    expect(['2026-03-29T00:30:00.000Z', '2026-03-29T01:30:00.000Z']).toContain(iso);
  });

  it('falls back to UTC interpretation for an unknown timezone', () => {
    const start = classStartInstant(day('2026-07-20'), hhmmToTime('18:00'), 'Not/AZone');
    expect(start.toISOString()).toBe('2026-07-20T18:00:00.000Z');
  });

  it('warns when falling back to UTC so the bad zone is observable', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    classStartInstant(day('2026-07-20'), hhmmToTime('18:00'), 'Not/AZone');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ timeZone: 'Not/AZone' }),
      expect.stringContaining('falling back to UTC'),
    );
  });

  /**
   * THREE WAYS TO FAIL, THREE MESSAGES — and this is the second time that has
   * had to be said here.
   *
   * `Date.UTC` returns NaN if the hour is NaN OR if the year is, and an Invalid
   * `classDate` makes `getUTCFullYear()` NaN just as an Invalid `startTime`
   * makes `getUTCHours()` NaN. The first version of the NaN guard tested only
   * the combined `wallUtc` and blamed `startTime` unconditionally — so
   * `classStartInstant(new Date('nonsense'), hhmmToTime('09:00'),
   * 'Europe/Amsterdam')` logged the valid `startTime` against a message saying
   * it was unparseable. Measured. That is the same misattribution the guard
   * was added to remove, moved one level rather than fixed: before it, a bad
   * `startTime` was blamed on the timezone; after it, a bad date was blamed on
   * the `startTime`.
   *
   * On a VPS whose observability is grep over pino, each wrong name sends
   * whoever is on call to the wrong column.
   */
  it('names the date when the date is what broke, not the startTime', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    classStartInstant(new Date('nonsense'), hhmmToTime('09:00'), 'Europe/Amsterdam');

    expect(warn).toHaveBeenCalledTimes(1);
    const [payload, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toMatch(/date/i);
    expect(message).not.toMatch(/startTime/i);
    expect(message).not.toMatch(/timezone/i);
    expect(payload).toMatchObject({ classDate: null });
  });

  // `startTime` is a `Date` now, not a raw string — so the only way for it to
  // be the thing that broke is an Invalid Date, rather than a wrongly-shaped
  // "HH:mm" string. `timeHHmm` (`@/lib/schemas`) is what keeps a bad string
  // from ever reaching `hhmmToTime` in the first place.
  it('names the startTime when the startTime is what broke, not the date', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    classStartInstant(day('2026-07-20'), new Date('garbage'), 'Europe/Amsterdam');

    expect(warn).toHaveBeenCalledTimes(1);
    const [payload, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toMatch(/startTime/i);
    expect(message).not.toMatch(/timezone/i);
    expect(payload).toMatchObject({ startTime: null });
  });
});

/**
 * #249. The predicate both past-start guards share.
 *
 * The Auckland case is the one that matters and the one that can be written so
 * it cannot fail. `Class.date` is stored at UTC midnight, so a guard that
 * compared the stored column against `now` — the obvious wrong implementation —
 * agrees with the correct answer at most hours of most days. These numbers are
 * chosen so the two disagree: 2026-06-15 23:00 NZST is 2026-06-15T11:00Z, which
 * is AFTER the `now` below, while the stored column reads 2026-06-15T00:00Z,
 * which is BEFORE it. Re-derive them if the fixture changes; do not adjust them
 * until a test passes.
 */
describe('startsInPast', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  // Matching both sibling describes in this file, and it was missing here.
  // `vi.spyOn` on an already-spied method returns THE SAME mock with its calls
  // still accumulated — measured: a second test's spy reported
  // `[{tag:'from-a'},{tag:'from-b'}]`. Four tests below spy on `log.warn`, so
  // without this the `for (const [, msg] of warn.mock.calls)` sweep in the
  // attribution test walks a previous test's calls as well as its own, and
  // `toHaveBeenCalledWith` can be satisfied by a sibling's invocation rather
  // than the one under test. Neither is masking a real failure today — silencing
  // both warns still reddens that test — but the assertions are order-coupled
  // until this line exists. The mock also survives the describe: `log.warn` was
  // measurably still mocked in a later block that never spied.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is false for a class still to come in a zone far ahead of UTC', () => {
    expect(
      startsInPast(
        { date: day('2026-06-15'), startTime: hhmmToTime('23:00'), timeZone: 'Pacific/Auckland' },
        new Date('2026-06-15T06:00:00.000Z'),
      ),
    ).toBe(false);
  });

  it('is true once the start instant has passed', () => {
    // 09:00 CEST = 07:00Z, and `now` is five hours later.
    expect(
      startsInPast(
        { date: day('2026-06-15'), startTime: hhmmToTime('09:00'), timeZone: 'Europe/Amsterdam' },
        new Date('2026-06-15T12:00:00.000Z'),
      ),
    ).toBe(true);
  });

  it('is false at exactly the start instant', () => {
    // Strictly `<`: a class starting this instant has not started in the past.
    expect(
      startsInPast(
        { date: day('2026-06-15'), startTime: hhmmToTime('09:00'), timeZone: 'Europe/Amsterdam' },
        new Date('2026-06-15T07:00:00.000Z'),
      ),
    ).toBe(false);
  });

  /**
   * THE CASE THAT KILLS "READ THE WALL CLOCK AS UTC", which none of the three
   * above do — checked, not assumed. Replace `classStartInstant`'s body with a
   * bare `new Date(wallUtc)` and every one of them stays green: Auckland 23:00
   * reads as `11:00Z` correctly and `23:00Z` mutated, and both are after that
   * test's `06:00Z` `now`, so both answer `false`. Same for the two Amsterdam
   * cases. A whole describe block that agrees with the bug it was written
   * against.
   *
   * Killing it needs the two readings to STRADDLE `now`, which needs a zone
   * WEST of UTC: a negative offset puts the true instant LATER than the naive
   * one, where Auckland's positive offset puts it earlier and merely widens an
   * answer both readings already agree on.
   *
   * 02:00 on 15 June in Los Angeles is PDT, UTC-7, so `2026-06-15T09:00Z`.
   * `now` sits between the two readings: after `02:00Z` (what the mutation
   * sees) and before `09:00Z` (the truth). Correct answer `false`, mutated
   * answer `true` — a guard that would refuse a Los Angeles teacher's edit at
   * a quarter to seven in the morning for a class they have not taught yet.
   * Re-derive the trio if the fixture changes; do not adjust it until a test
   * passes.
   */
  it('reads the wall clock in the zone, not as UTC — the west-of-UTC case', () => {
    expect(
      startsInPast(
        { date: day('2026-06-15'), startTime: hhmmToTime('02:00'), timeZone: 'America/Los_Angeles' },
        new Date('2026-06-15T05:00:00.000Z'),
      ),
    ).toBe(false);

    // The other side of the same instant, so the case cannot pass by always
    // answering `false`: one hour past the true start, it is `true`.
    expect(
      startsInPast(
        { date: day('2026-06-15'), startTime: hhmmToTime('02:00'), timeZone: 'America/Los_Angeles' },
        new Date('2026-06-15T10:00:00.000Z'),
      ),
    ).toBe(true);
  });

  /**
   * FAILING CLOSED, and the direction is the entire point.
   *
   * An Invalid `startTime` makes `classStartInstant` return an Invalid Date,
   * and every comparison against one is `false` — so the obvious
   * implementation (`classStartInstant(...) < now`) answered "no, it has not
   * started" for a value it could not read at all, in a predicate whose only
   * two callers use a `true` to REFUSE a write. Measured before this test
   * existed: `startsInPast(2020-01-01, new Date('garbage'), 'Europe/Amsterdam',
   * now)` returned `false`, letting a 2020 date through both guards.
   *
   * `completeClass` (`class-lifecycle.ts`) already `Number.isNaN`-guards this
   * exact shape on `requireEndedBy`; this is the same defence one file over.
   *
   * A stored `startTime` can only be a valid `@db.Time` value — Postgres
   * enforces the column type, and `timeHHmm` validates the wire format before
   * `hhmmToTime` ever produces one — so reaching this branch means the value
   * was constructed outside that path entirely. Refusing the edit and logging
   * is the right answer to that; silently permitting it is not.
   */
  it('fails closed on an unparseable startTime rather than permitting the write', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    expect(
      startsInPast(
        { date: day('2026-06-15'), startTime: new Date('garbage'), timeZone: 'Europe/Amsterdam' },
        new Date(),
      ),
    ).toBe(true);
  });

  it('does not throw while logging a class whose date is also unreadable', () => {
    // The refusal branch serialises `classDate`, and `toISOString` throws a
    // RangeError on an Invalid Date — which is reachable exactly here, since
    // this branch is the one for inputs already known to be broken. Unguarded
    // it would convert the 409 this guard exists to produce into a 500 raised
    // by the log line. Both halves corrupt at once is the shape that finds it.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    expect(
      startsInPast(
        { date: new Date(NaN), startTime: new Date('garbage'), timeZone: 'Europe/Amsterdam' },
        new Date(),
      ),
    ).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ classDate: null }),
      expect.any(String),
    );
  });

  it('names the startTime, not the timezone, when the startTime is what broke', () => {
    // The log line this replaces said "invalid timezone" for a perfectly valid
    // `Europe/Amsterdam`, because the NaN from the unparseable time reached
    // `Intl` and threw there. On a VPS whose observability is grep over pino,
    // that sends whoever is on call to the wrong column.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    startsInPast(
        { date: day('2026-06-15'), startTime: new Date('garbage'), timeZone: 'Europe/Amsterdam' },
        new Date(),
      );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ startTime: null }),
      expect.stringContaining('startTime'),
    );
    for (const [, msg] of warn.mock.calls) {
      expect(msg).not.toContain('invalid timezone');
    }
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

describe('mondayOf', () => {
  const iso = (ms: number) => new Date(ms).toISOString();

  it('returns the Monday of the week containing a midweek date', () => {
    // 2026-09-24 is a Thursday; its Monday is 2026-09-21.
    expect(iso(mondayOf(new Date('2026-09-24T00:00:00.000Z')))).toBe('2026-09-21T00:00:00.000Z');
  });

  it('returns the date itself when it is already a Monday', () => {
    expect(iso(mondayOf(new Date('2026-09-21T00:00:00.000Z')))).toBe('2026-09-21T00:00:00.000Z');
  });

  it('rolls a Sunday BACK six days, not forward one', () => {
    // 2026-09-27 is a Sunday. Monday-first weeks put it at the END of the
    // week beginning 2026-09-21 — not the start of the one beginning
    // 2026-09-28. This is the off-by-one the whole week rule turns on.
    expect(iso(mondayOf(new Date('2026-09-27T00:00:00.000Z')))).toBe('2026-09-21T00:00:00.000Z');
  });

  it('puts a Sunday and the following Monday in DIFFERENT weeks', () => {
    // The consequence of the rule above, stated as the behaviour that matters:
    // a template moved from Sunday to Monday crosses a week boundary.
    const sunday = mondayOf(new Date('2026-09-27T00:00:00.000Z'));
    const monday = mondayOf(new Date('2026-09-28T00:00:00.000Z'));
    expect(sunday).not.toBe(monday);
  });

  it('reads the date with UTC accessors, not local ones', () => {
    // `mondayOf` takes no timezone argument, so it cannot "ignore" one — what
    // this actually pins is that its internals use `getUTCDate`/`getUTCDay`
    // rather than their local-time twins. `vitest.config.ts:60` pins
    // `TZ: 'America/New_York'` process-wide for exactly this reason: under
    // that pin, midnight-UTC Monday 2026-09-21 reads as roughly 20:00 EDT the
    // PREVIOUS evening, Sunday the 20th. A `mondayOf` written with
    // `getDate()`/`getDay()` instead of the UTC pair would read that local
    // Sunday, roll it back six days, and answer a Monday a week early —
    // exactly the class of bug the `TZ` pin exists to make observable, per
    // `vitest.config.ts`'s own comment on `format.ts`.
    const monday = new Date('2026-09-21T00:00:00.000Z');
    expect(iso(mondayOf(monday))).toBe('2026-09-21T00:00:00.000Z');
    // And the Monday of the previous week is genuinely seven days earlier,
    // proving the function is not silently shifting by an offset.
    expect(iso(mondayOf(new Date('2026-09-14T00:00:00.000Z')))).toBe('2026-09-14T00:00:00.000Z');
  });
});
