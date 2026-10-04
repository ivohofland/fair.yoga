import { formatClockInZone } from '@/lib/finish-window';
import { formatInstantInZone, startOfLocalDay } from '@/lib/timezone';
import type { TeacherSession } from '@/lib/types';

export interface OfflineSnapshotStamp {
  ownerId: string;
  renderedAt: number;
  loadedAtClock: string;
  loadedAtDayClock: string;
  loadedOn: string;
  timeZone: string;
}

/** `YYYY-MM-DD` of `instant` in `timeZone`; an unknown zone reads as UTC's date. */
export function localDateKey(instant: Date, timeZone: string): string {
  return startOfLocalDay(instant, timeZone).toISOString().slice(0, 10);
}

export function offlineSnapshotStamp(session: TeacherSession, now: Date): OfflineSnapshotStamp {
  const timeZone = session.defaultTimezone;
  return {
    ownerId: session.accountId,
    renderedAt: now.getTime(),
    loadedAtClock: formatClockInZone(now, timeZone),
    loadedAtDayClock: formatInstantInZone(now, timeZone),
    loadedOn: localDateKey(now, timeZone),
    timeZone,
  };
}

type EntryDated = ReadonlyArray<{ id: string; calendarEntry: { date: Date } }>;

/** The detail pages of today's entries; an `@db.Date` is midnight UTC of the local date. */
export function todaysOfflinePaths(classes: EntryDated, studioClasses: EntryDated, todayKey: string): string[] {
  const onToday = (entry: { calendarEntry: { date: Date } }) => entry.calendarEntry.date.toISOString().slice(0, 10) === todayKey;
  return [
    ...classes.filter(onToday).map((c) => `/class/${c.id}`),
    ...studioClasses.filter(onToday).map((c) => `/studio-class/${c.id}`),
  ];
}
