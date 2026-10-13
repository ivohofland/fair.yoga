import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { mondayOf } from '@/lib/timezone';
import { log } from '@/lib/log';
import {
  getNextOccurrences,
  isWeekHeld,
  firstFreeWeek,
  probeFirstEffectiveWeek,
  probeHorizon,
  DEFAULT_WEEKS,
} from './entry-generation';
import { hhmmToTime } from '@/lib/time-of-day';

/**
 * Compile-time assertion that `isWeekHeld` and `firstFreeWeek` require branded
 * `WeekKey`s rather than plain `number`s (epoch timestamps).
 *
 * `tsconfig.json` includes every `.ts` file in the repo, so loosening `WeekKey`
 * back to `number` makes `tsc --noEmit` fail on the unused `@ts-expect-error`
 * directives below (issue #286). Mirrors `src/lib/db-locks.test.ts`.
 *
 * These checks are verified by `npm run typecheck` only (`tsc --noEmit`) and
 * are invisible to Vitest runtime test execution (tests do not typecheck or transpile types).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _theBrandRejectsUnbrandedEpochMs(
  epochTimestamps: ReadonlySet<number>,
  date: Date,
): void {
  // @ts-expect-error Set<number> of epoch timestamps must not satisfy ReadonlySet<WeekKey>
  isWeekHeld(date, epochTimestamps);
  // @ts-expect-error Set<number> of epoch timestamps must not satisfy ReadonlySet<WeekKey>
  firstFreeWeek([date], epochTimestamps);
}

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

describe('probeHorizon', () => {
  // Tuesday 2026-10-20 at 10:00; schema dayOfWeek 1 is Tuesday.
  const rule = { dayOfWeek: 1, startTime: hhmmToTime('10:00') };
  const horizonAt = (zone: string, at: Date, now: Date = new Date(at.getTime() - 60 * 60_000)) =>
    probeHorizon(rule, zone, now, at).map((d) => d.toISOString().slice(0, 10));
  const S = new Date('2026-10-20T10:00:00.000Z');

  it('keeps a candidate starting 1 ms after the sweep instant', () => {
    expect(horizonAt('UTC', new Date(S.getTime() - 1))[0]).toBe('2026-10-20');
  });

  it('drops a candidate starting exactly at the sweep instant', () => {
    expect(horizonAt('UTC', S)[0]).toBe('2026-10-27');
  });

  it('drops a candidate that started before the sweep instant', () => {
    expect(horizonAt('UTC', new Date(S.getTime() + 1))[0]).toBe('2026-10-27');
  });

  it('judges the start instant in the teacher zone', () => {
    const start = new Date('2026-10-20T08:00:00.000Z');
    expect(horizonAt('Europe/Amsterdam', new Date(start.getTime() - 1))[0]).toBe('2026-10-20');
    expect(horizonAt('Europe/Amsterdam', start)[0]).toBe('2026-10-27');
  });

  it("enumerates from now so a candidate on now's date survives when at is the next UTC date", () => {
    const now = new Date('2026-10-19T23:30:00.000Z');
    const at = new Date(now.getTime() + 60 * 60_000);
    expect(horizonAt('UTC', at, now)[0]).toBe('2026-10-20');
  });

  it('returns DEFAULT_WEEKS * 2 ascending Tuesdays when nothing is cut', () => {
    const now = new Date('2026-10-13T00:00:00.000Z');
    const dates = probeHorizon(rule, 'UTC', now, new Date(now.getTime() + 60 * 60_000));
    expect(dates).toHaveLength(DEFAULT_WEEKS * 2);
    expect(dates.every((d) => d.getUTCDay() === 2)).toBe(true);
    const times = dates.map((d) => d.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
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
// probeFirstEffectiveWeek — its answer, and the two failure modes that never escape
// ===========================================================================

/**
 * The probe runs AFTER its caller's transaction has committed, so its contract
 * is `null` on failure rather than a throw: a template the teacher already
 * saved must not come back as a 500 because the sentence naming its first
 * effective week could not be composed. The block holds the probe's answer
 * (the week and the candidate date it names) and a case per guard that keeps
 * the failure from escaping — read fault and arithmetic fault — asserted
 * through the warn line, because `null` alone cannot tell them apart and an
 * operator has to.
 *
 * Stubbed rather than seeded: what is under test is the shape of the failure
 * path, and both branches need a read that misbehaves in a way no real query
 * against a healthy schema produces.
 */
describe('probeFirstEffectiveWeek', () => {
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

    await expect(probeFirstEffectiveWeek(db, TEMPLATE, THURSDAYS, null, 'studio template')).resolves.toBeNull();

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

    await expect(probeFirstEffectiveWeek(db, TEMPLATE, THURSDAYS, null, 'recurring class')).resolves.toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[1]);
    // The two lines must stay distinguishable — that is the whole point of the
    // second guard, and a shared sentence would pass a `null` assertion alone.
    expect(message).toContain("probe's own week arithmetic threw");
    expect(message).not.toContain('the first-effective-week probe failed');
  });

  it('answers null without querying the database when candidate horizon is empty', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const findMany = vi.fn();
    const db = { calendarEntry: { findMany } } as unknown as PrismaClient;

    await expect(probeFirstEffectiveWeek(db, TEMPLATE, [], null, 'recurring class')).resolves.toBeNull();

    expect(findMany).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers the week and the candidate date that opens it when a week is free', async () => {
    const db = clientOf(() => Promise.resolve([]));

    await expect(probeFirstEffectiveWeek(db, TEMPLATE, THURSDAYS, null, 'recurring class')).resolves.toEqual({
      week: new Date('2026-09-21T00:00:00.000Z'),
      candidate: new Date('2026-09-24T00:00:00.000Z'),
    });
  });
});
