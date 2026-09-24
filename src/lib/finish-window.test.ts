import { describe, it, expect, vi, afterEach } from 'vitest';
import { hhmmToTime } from '@/lib/time-of-day';
import { log } from '@/lib/log';
import {
  FINISH_GRACE_MINUTES,
  CHECKIN_OPENS_MINUTES,
  classEndInstant,
  finishOpensAt,
  autoFinishAt,
  formatClockInZone,
  classPageClock,
} from './finish-window';

const MINUTE = 60_000;

describe('finish window', () => {
  it('ends a class durationMinutes after its start, in the teacher timezone', () => {
    // 2026-06-01 is CEST (UTC+2): 18:00 local is 16:00Z.
    const end = classEndInstant(
      { date: new Date('2026-06-01'), startTime: hhmmToTime('18:00'), durationMinutes: 75 },
      'Europe/Amsterdam',
    );
    expect(end.toISOString()).toBe('2026-06-01T17:15:00.000Z');
  });

  /**
   * Review Focus 5. 2026-03-29 springs forward at 02:00 local. A class at
   * 01:30 CET (00:30Z) for 60 minutes ends at 01:30Z: 60 real minutes, even
   * though the wall clock then reads 03:30. Wall-clock arithmetic would say
   * 02:30 local, a moment that does not exist that day.
   */
  it('measures duration in real minutes across a DST change', () => {
    const end = classEndInstant(
      { date: new Date('2026-03-29'), startTime: hhmmToTime('01:30'), durationMinutes: 60 },
      'Europe/Amsterdam',
    );
    expect(end.toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('opens the finish window FINISH_GRACE_MINUTES before the end and auto-finishes as long after', () => {
    const start = new Date('2026-06-01T16:00:00Z');
    const end = new Date('2026-06-01T17:15:00Z');
    expect(finishOpensAt({ start, end }).getTime()).toBe(end.getTime() - FINISH_GRACE_MINUTES * MINUTE);
    expect(autoFinishAt(end).getTime()).toBe(end.getTime() + FINISH_GRACE_MINUTES * MINUTE);
  });

  /**
   * A class no longer than the grace would otherwise open its finish window
   * at or before its start, which is billing a class that has not begun.
   */
  it('never opens the finish window before the class starts', () => {
    const start = new Date('2026-06-01T16:00:00Z');
    const end = new Date(start.getTime() + 10 * MINUTE);
    expect(finishOpensAt({ start, end }).toISOString()).toBe(start.toISOString());
  });

  it('pins the grace at 15 minutes', () => {
    // The product decision (spec D1/D2). Changing it is a product change,
    // and this line is where that change has to be made on purpose.
    expect(FINISH_GRACE_MINUTES).toBe(15);
  });

  it('formats an instant as a 24h wall-clock time in the zone', () => {
    expect(formatClockInZone(new Date('2026-06-01T17:30:00Z'), 'Europe/Amsterdam')).toBe('19:30');
  });

  describe('on input it cannot read', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('falls back to UTC, says so, and logs the zone at error', () => {
      const error = vi.spyOn(log, 'error').mockImplementation(() => undefined as unknown as void);
      expect(formatClockInZone(new Date('2026-06-01T17:30:00Z'), 'Not/AZone')).toBe('17:30 (UTC)');
      expect(error).toHaveBeenCalledWith({ timeZone: 'Not/AZone' }, expect.any(String));
    });

    /**
     * An Invalid Date throws from `Intl.DateTimeFormat.format` in every zone,
     * UTC included, so without its own check it escapes the fallback and the
     * class page answers 500.
     */
    it('answers a placeholder for an unreadable instant rather than throwing, and logs it', () => {
      const error = vi.spyOn(log, 'error').mockImplementation(() => undefined as unknown as void);
      expect(formatClockInZone(new Date('nonsense'), 'Europe/Amsterdam')).toBe('Invalid Date');
      expect(error).toHaveBeenCalledWith({ timeZone: 'Europe/Amsterdam' }, expect.any(String));
    });
  });
});

describe('classPageClock', () => {
  // A 75-minute class, 18:00–19:15Z: the finish window opens at 19:00 and
  // the sweep is due at 19:30.
  const start = new Date('2026-06-01T18:00:00.000Z');
  const end = new Date('2026-06-01T19:15:00.000Z');
  const checkinAt = new Date('2026-06-01T17:45:00.000Z');
  const opensAt = new Date('2026-06-01T19:00:00.000Z');
  const autoAt = new Date('2026-06-01T19:30:00.000Z');
  const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);
  const clock = (now: Date, status: 'draft' | 'open' | 'in_progress' | 'completed', cancelled = false) =>
    classPageClock({ now, start, end, status, cancelled });
  const iso = (ds: readonly Date[]) => ds.map((d) => d.toISOString());

  it('names the check-in lead as its own 15 minutes', () => {
    expect(CHECKIN_OPENS_MINUTES).toBe(15);
  });

  it('shows check-in on an open class from CHECKIN_OPENS_MINUTES before the start, and not a millisecond before', () => {
    expect(clock(ms(checkinAt, -1), 'open').showCheckin).toBe(false);
    expect(clock(checkinAt, 'open').showCheckin).toBe(true);
  });

  it('shows check-in on an in_progress class whatever the time', () => {
    expect(clock(ms(start, 5 * MINUTE), 'in_progress').showCheckin).toBe(true);
  });

  it('offers the finish from finishOpensAt, and not a millisecond before', () => {
    expect(clock(ms(opensAt, -1), 'in_progress').canFinish).toBe(false);
    expect(clock(opensAt, 'in_progress').canFinish).toBe(true);
    // An `open` class the start sweep has not reached yet is finishable too.
    expect(clock(opensAt, 'open').canFinish).toBe(true);
  });

  it('never offers the finish before the start of a class no longer than the grace', () => {
    const shortEnd = ms(start, 10 * MINUTE);
    const short = (now: Date) => classPageClock({ now, start, end: shortEnd, status: 'open', cancelled: false });
    expect(short(ms(start, -1)).canFinish).toBe(false);
    expect(short(start).canFinish).toBe(true);
    expect(iso(short(ms(start, -1)).refreshInstants)).toContain(start.toISOString());
  });

  it('re-renders an open class at the check-in edge, the finish edge and the sweep edge', () => {
    const c = clock(ms(checkinAt, -60 * MINUTE), 'open');
    expect(c.live).toBe(true);
    expect(iso(c.refreshInstants)).toEqual(iso([checkinAt, opensAt, autoAt]));
  });

  it('does not re-render an in_progress class for a check-in it already shows', () => {
    const c = clock(ms(start, 5 * MINUTE), 'in_progress');
    expect(iso(c.refreshInstants)).toEqual(iso([opensAt, autoAt]));
  });

  it('is not yet auto-finishing a millisecond before autoFinishAt, and asks for no retry', () => {
    const c = clock(ms(autoAt, -1), 'in_progress');
    expect(c.autoFinishing).toBe(false);
    expect(iso(c.refreshInstants)).toEqual(iso([opensAt, autoAt]));
  });

  /**
   * The sweep lands at its first run at or after `autoFinishAt`, so a render
   * that still finds the class live then asks again a minute later.
   */
  it('is auto-finishing from autoFinishAt, and asks again a minute after each render', () => {
    const atEdge = clock(autoAt, 'in_progress');
    expect(atEdge.autoFinishing).toBe(true);
    expect(iso(atEdge.refreshInstants)).toContain(ms(autoAt, MINUTE).toISOString());

    const now = ms(autoAt, 7 * MINUTE + 123);
    const late = clock(now, 'in_progress');
    expect(late.autoFinishing).toBe(true);
    expect(late.canFinish).toBe(true);
    expect(iso(late.refreshInstants)).toContain(ms(now, MINUTE).toISOString());
  });

  it('returns the auto-finish instant it computed', () => {
    expect(clock(start, 'in_progress').autoAt.toISOString()).toBe(autoAt.toISOString());
  });

  it.each(['completed', 'draft'] as const)('is inert on a %s class: not live, nothing to show, nothing to wait for', (status) => {
    const c = clock(ms(autoAt, 5 * MINUTE), status);
    expect(c).toMatchObject({ live: false, showCheckin: false, canFinish: false, autoFinishing: false });
    expect(c.refreshInstants).toEqual([]);
  });

  /**
   * An unreadable schedule makes every edge an Invalid Date, whose
   * `toISOString()` throws: handed on, it would fail the page's render.
   */
  it('offers nothing and waits for nothing when the schedule is unreadable', () => {
    const c = classPageClock({
      now: start,
      start: new Date(NaN),
      end: new Date(NaN),
      status: 'open',
      cancelled: false,
    });
    expect(c).toMatchObject({ showCheckin: false, canFinish: false, autoFinishing: false });
    expect(c.refreshInstants).toEqual([]);
  });

  it.each(['open', 'in_progress'] as const)('is inert on a cancelled %s class', (status) => {
    const c = clock(ms(autoAt, 5 * MINUTE), status, true);
    expect(c).toMatchObject({ live: false, showCheckin: false, canFinish: false, autoFinishing: false });
    expect(c.refreshInstants).toEqual([]);
  });
});
