import { describe, it, expect, vi, afterEach } from 'vitest';
import type { TeacherSession } from './types';
import { localDateKey, offlineSnapshotStamp, todaysOfflinePaths } from './offline-snapshot-props';

afterEach(() => {
  vi.useRealTimers();
});

const entry = (id: string, date: string) => ({ id, calendarEntry: { date: new Date(`${date}T00:00:00.000Z`) } });

describe('localDateKey', () => {
  it('is the date in the teacher zone, not the instant\'s UTC date', () => {
    expect(localDateKey(new Date('2026-10-04T11:30:00Z'), 'Pacific/Auckland')).toBe('2026-10-05');
  });

  it('is the earlier local date for an evening in a zone behind UTC', () => {
    expect(localDateKey(new Date('2026-10-05T03:30:00Z'), 'America/Los_Angeles')).toBe('2026-10-04');
  });

  it('degrades to the UTC date for an unknown zone, without throwing', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(localDateKey(new Date('2026-10-04T23:30:00Z'), 'Not/AZone')).toBe('2026-10-04');
    consoleError.mockRestore();
  });
});

describe('todaysOfflinePaths', () => {
  it('keeps only entries on the day and emits both families', () => {
    expect(
      todaysOfflinePaths(
        [entry('c1', '2026-10-04'), entry('c2', '2026-10-05')],
        [entry('s1', '2026-10-04'), entry('s2', '2026-10-06')],
        '2026-10-04',
      ),
    ).toEqual(['/class/c1', '/studio-class/s1']);
  });

  it('follows the key it is given, not the clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T11:30:00Z'));
    expect(
      todaysOfflinePaths([entry('c1', '2026-10-04'), entry('c2', '2026-10-05')], [entry('s1', '2026-10-04'), entry('s2', '2026-10-05')], '2026-10-05'),
    ).toEqual(['/class/c2', '/studio-class/s2']);
  });
});

describe('offlineSnapshotStamp', () => {
  it('stamps the account and reads the clock in the session zone', () => {
    const session: TeacherSession = {
      sessionId: 's',
      accountId: 'account-1',
      teacherId: 't',
      defaultTimezone: 'Pacific/Auckland',
      studentId: null,
    };
    const now = new Date('2026-10-04T11:30:00Z');
    expect(offlineSnapshotStamp(session, now)).toEqual({
      ownerId: 'account-1',
      renderedAt: now.getTime(),
      loadedAtClock: '00:30',
      loadedAtDayClock: expect.stringContaining('Mon 5 Oct'),
      loadedOn: '2026-10-05',
      timeZone: 'Pacific/Auckland',
    });
  });
});
