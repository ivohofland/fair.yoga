import type { Currency, PricingMode, PrismaClient, RegistrationStatus } from '@/lib/prisma-client';
import { publicClassLocation, type PublicClassLocation } from '@/lib/class-location';
import { CHARGED_STATUSES } from '@/lib/registration-status';
import { classStartInstant, startOfLocalDay } from '@/lib/timezone';

export type PublicScheduleMode =
  | { kind: 'bookable'; weeks: number | null }
  | { kind: 'calendar'; weeks: number };

export type PublicScheduleInput = {
  teacherId: string;
  timeZone: string;
  now: Date;
  mode: PublicScheduleMode;
  includeStudio: boolean;
};

export type PublicClassEntry = {
  kind: 'class';
  id: string;
  calendarEntryId: string;
  updatedAt: Date;
  date: Date;
  startTime: Date;
  start: Date;
  durationMinutes: number;
  classType: string;
  location: PublicClassLocation;
  pricingMode: PricingMode;
  availability: 'open' | 'waitlist';
  cancelled: boolean;
  economics: {
    roomCost: number;
    minRate: number;
    targetRate: number;
    minStudents: number;
    maxStudents: number;
    vatPercent: number;
    currency: Currency;
    registrations: { id: string; tierAtBooking: number; status: RegistrationStatus; studentId: string }[];
  };
};

export type PublicStudioEntry = {
  kind: 'studio';
  id: string;
  calendarEntryId: string;
  updatedAt: Date;
  date: Date;
  startTime: Date;
  start: Date;
  durationMinutes: number;
  classType: string;
  location: string;
  bookingUrl: string | null;
  cancelled: boolean;
};

export type PublicScheduleEntry = PublicClassEntry | PublicStudioEntry;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The classes a teacher shows the public, in one shape for every channel.
 * `bookable` is what a visitor can still book; `calendar` is the teacher's
 * whole window, cancelled entries marked rather than dropped.
 */
export async function listPublicSchedule(
  db: PrismaClient,
  input: PublicScheduleInput,
): Promise<PublicScheduleEntry[]> {
  const { teacherId, timeZone, now, mode, includeStudio } = input;
  const today = startOfLocalDay(now, timeZone);
  const end = mode.weeks === null ? null : new Date(today.getTime() + mode.weeks * 7 * DAY_MS);
  const dateWindow = end === null ? { gte: today } : { gte: today, lt: end };
  const bookable = mode.kind === 'bookable';

  const [classes, studioClasses] = await Promise.all([
    db.class.findMany({
      where: {
        isPrivate: false,
        status: bookable ? 'open' : { in: ['open', 'in_progress', 'completed'] },
        calendarEntry: {
          teacherId,
          date: dateWindow,
          ...(bookable ? { cancelledAt: null } : {}),
        },
      },
      omit: { videoUrl: true },
      include: {
        calendarEntry: true,
        teacherRoom: { include: { room: true } },
        registrations: {
          where: { status: { in: [...CHARGED_STATUSES] } },
          select: { id: true, tierAtBooking: true, status: true, studentId: true },
        },
      },
    }),
    includeStudio
      ? db.studioClass.findMany({
          where: { calendarEntry: { teacherId, date: dateWindow, ...(bookable ? { cancelledAt: null } : {}) } },
          include: { calendarEntry: true },
        })
      : Promise.resolve([]),
  ]);

  const entries: PublicScheduleEntry[] = [];

  for (const cls of classes) {
    const e = cls.calendarEntry;
    const start = classStartInstant(e, timeZone);
    if (bookable && start <= now) continue;
    const occupied = cls.registrations.filter((r) => r.status !== 'late_cancel').length;
    entries.push({
      kind: 'class',
      id: cls.id,
      calendarEntryId: e.id,
      updatedAt: cls.updatedAt,
      date: e.date,
      startTime: e.startTime,
      start,
      durationMinutes: e.durationMinutes,
      classType: e.classType,
      location: publicClassLocation(cls),
      pricingMode: cls.pricingMode,
      availability: occupied >= cls.maxStudents ? 'waitlist' : 'open',
      cancelled: e.cancelledAt !== null,
      economics: {
        roomCost: Number(cls.roomCost),
        minRate: Number(cls.minRate),
        targetRate: Number(cls.targetRate),
        minStudents: cls.minStudents,
        maxStudents: cls.maxStudents,
        vatPercent: Number(cls.vatPercent),
        currency: cls.currency,
        registrations: cls.registrations,
      },
    });
  }

  for (const sc of studioClasses) {
    const e = sc.calendarEntry;
    const start = classStartInstant(e, timeZone);
    if (bookable && start <= now) continue;
    entries.push({
      kind: 'studio',
      id: sc.id,
      calendarEntryId: e.id,
      updatedAt: sc.updatedAt,
      date: e.date,
      startTime: e.startTime,
      start,
      durationMinutes: e.durationMinutes,
      classType: e.classType,
      location: sc.location,
      bookingUrl: sc.bookingUrl,
      cancelled: e.cancelledAt !== null,
    });
  }

  return entries.sort((a, b) => a.start.getTime() - b.start.getTime());
}
