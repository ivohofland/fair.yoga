import { describe, it, expect } from 'vitest';
import { placeNow, describeNextStart, type TimelineItem } from './now-line';

const TZ = 'Europe/Amsterdam';

/** An item whose start and end are given as Amsterdam wall-clock ISO strings (CET, +01:00). */
function item(id: string, start: string, end: string, extra: Partial<TimelineItem> = {}): TimelineItem {
  return {
    id,
    start: new Date(`${start}+01:00`).getTime(),
    end: new Date(`${end}+01:00`).getTime(),
    cancelled: false,
    completed: false,
    ...extra,
  };
}

const at = (local: string): number => new Date(`${local}+01:00`).getTime();

// The screenshot's week: Tue + two Thursday classes done, Saturday ahead.
const week: TimelineItem[] = [
  item('tue', '2026-11-03T19:30', '2026-11-03T20:45'),
  item('thu1', '2026-11-05T18:30', '2026-11-05T19:30'),
  item('thu2', '2026-11-05T19:45', '2026-11-05T20:45'),
  item('sat', '2026-11-07T17:00', '2026-11-07T18:15'),
  item('tue2', '2026-11-10T19:30', '2026-11-10T20:45'),
];

describe('placeNow', () => {
  it('puts the line after the last class that has ended and marks the first upcoming one next', () => {
    expect(placeNow(week, at('2026-11-06T10:52'))).toEqual({
      lineBeforeId: null,
      lineAfterId: 'thu2',
      runningId: null,
      nextId: 'sat',
    });
  });

  it('puts the line before the first class when none has ended', () => {
    expect(placeNow(week, at('2026-11-02T09:00'))).toMatchObject({
      lineBeforeId: 'tue',
      lineAfterId: null,
      nextId: 'tue',
    });
  });

  it('puts the line after the last class when every class has ended, with nothing next', () => {
    expect(placeNow(week, at('2026-11-11T09:00'))).toEqual({
      lineBeforeId: null,
      lineAfterId: 'tue2',
      runningId: null,
      nextId: null,
    });
  });

  it('marks a class in progress as running, above the line, and the one after it as next', () => {
    expect(placeNow(week, at('2026-11-05T20:00'))).toEqual({
      lineBeforeId: null,
      lineAfterId: 'thu1',
      runningId: 'thu2',
      nextId: 'sat',
    });
  });

  it('treats a class the teacher finished early as ended', () => {
    const finished = week.map((i) => (i.id === 'thu2' ? { ...i, completed: true } : i));
    expect(placeNow(finished, at('2026-11-05T20:35'))).toMatchObject({
      lineAfterId: 'thu2',
      runningId: null,
      nextId: 'sat',
    });
  });

  it('never names a cancelled class next or running', () => {
    const cancelled = week.map((i) => (i.id === 'sat' ? { ...i, cancelled: true } : i));
    expect(placeNow(cancelled, at('2026-11-06T10:52'))).toMatchObject({ nextId: 'tue2' });
    const cancelledRunning = week.map((i) => (i.id === 'thu2' ? { ...i, cancelled: true } : i));
    expect(placeNow(cancelledRunning, at('2026-11-05T20:00'))).toMatchObject({ runningId: null, nextId: 'sat' });
  });

  it('places no line in an empty list', () => {
    expect(placeNow([], at('2026-11-06T10:52'))).toEqual({
      lineBeforeId: null,
      lineAfterId: null,
      runningId: null,
      nextId: null,
    });
  });
});

describe('describeNextStart', () => {
  const now = at('2026-11-06T10:52'); // Friday

  it('says today for a class later the same day', () => {
    expect(describeNextStart(at('2026-11-06T19:30'), now, TZ)).toBe('today at 19:30');
  });

  it('says tomorrow for the next calendar day, however few hours away', () => {
    expect(describeNextStart(at('2026-11-07T17:00'), now, TZ)).toBe('tomorrow at 17:00');
    expect(describeNextStart(at('2026-11-07T00:30'), at('2026-11-06T23:50'), TZ)).toBe('tomorrow at 00:30');
  });

  it('names the weekday within the coming week', () => {
    expect(describeNextStart(at('2026-11-10T19:30'), now, TZ)).toBe('Tuesday at 19:30');
    expect(describeNextStart(at('2026-11-12T19:30'), now, TZ)).toBe('Thursday at 19:30');
  });

  it('gives the date from a week out, so the weekday cannot be read as this week’s', () => {
    expect(describeNextStart(at('2026-11-13T19:30'), now, TZ)).toBe('Fri 13 Nov at 19:30');
  });

  it('counts calendar days in the teacher’s zone, not the device’s or UTC', () => {
    // 23:30 Amsterdam on Friday is 22:30 UTC Friday; Saturday 00:30 Amsterdam is
    // still Friday in UTC — "tomorrow" only in the teacher's zone.
    expect(describeNextStart(at('2026-11-07T00:30'), at('2026-11-06T23:30'), TZ)).toBe('tomorrow at 00:30');
  });

  it('reads an unreadable zone as UTC rather than throwing in the browser', () => {
    // 17:00 Amsterdam is 16:00 UTC.
    expect(describeNextStart(at('2026-11-07T17:00'), now, 'Not/AZone')).toBe('tomorrow at 16:00');
  });
});
