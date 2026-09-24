import { describe, it, expect } from 'vitest';
import { hhmmToTime } from '@/lib/time-of-day';
import {
  FINISH_GRACE_MINUTES,
  classEndInstant,
  finishOpensAt,
  autoFinishAt,
  formatClockInZone,
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

  it('falls back to UTC, and says so, on an unreadable zone', () => {
    expect(formatClockInZone(new Date('2026-06-01T17:30:00Z'), 'Not/AZone')).toBe('17:30 (UTC)');
  });
});
