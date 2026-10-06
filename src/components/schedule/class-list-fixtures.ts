import type { ComponentProps } from 'react';
import type { PaymentStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { hhmmToTime } from '@/lib/time-of-day';
import { ClassList } from './class-list';

/**
 * Shared Prisma-shaped `Class` fixtures for `ClassList`'s cards, so component
 * tests render the same shape rather than each hand-rolling their own.
 *
 * `ClassRow` is typed as `ClassList`'s own prop element (not a hand-written
 * interface) so no assertion is needed and so a schema change breaks this
 * file rather than silently drifting from it. `Decimal` comes from
 * `@prisma/client/runtime/library`, the pure-JS decimal implementation, not
 * from `@prisma/client` itself: no engine, no database, nothing for jsdom to
 * choke on.
 *
 * Named without a `.test.` suffix on purpose — this module has no `describe`/
 * `it` of its own, so a name matching a vitest project's test-file glob
 * (`vitest.config.ts`'s `include`) would have it collected as an empty test
 * file.
 */
export type ClassRow = ComponentProps<typeof ClassList>['classes'][number];

export const AT = new Date('2026-06-01T00:00:00.000Z');

export const room = {
  id: 'room-1',
  venueName: 'Studio Zen',
  address: 'Prinsengracht 1',
  city: 'Amsterdam',
  postcode: '1015 DK',
  floor: '',
  roomName: 'Big Room',
  maxCapacity: 20,
  equipment: [],
  notes: null,
  isPublic: true,
  createdById: 'teacher-1',
  createdAt: AT,
  updatedAt: AT,
};

export const teacherRoom = {
  id: 'tr-1',
  teacherId: 'teacher-1',
  roomId: 'room-1',
  capacityOverride: 12,
  rentalRate: new Decimal(20),
  equipmentNotes: null,
  isArchived: false,
  createdAt: AT,
  updatedAt: AT,
  room,
};

/**
 * `payments` is the charged registrations' payment states, `null` for a
 * registration with no payment row — what a `registrations.payment` select
 * returns. Pass `undefined` for a caller that did not include registrations
 * at all; the prop is optional.
 */
export function classRow(
  id: string,
  status: ClassRow['status'],
  payments: (PaymentStatus | null)[] | undefined,
  overrides?: { date?: Date; startTime?: string; cancelled?: boolean },
): ClassRow {
  return {
    id,
    calendarEntryId: `entry-${id}`,
    kind: 'regular' as const,
    // The calendar identity is a row of its own, and the card reads every
    // one of these fields through it.
    calendarEntry: {
      id: `entry-${id}`,
      teacherId: 'teacher-1',
      kind: 'regular' as const,
      classType: 'Vinyasa',
      date: overrides?.date ?? new Date('2026-06-12T00:00:00.000Z'),
      startTime: hhmmToTime(overrides?.startTime ?? '09:30'),
      durationMinutes: 60,
      cancelledAt: overrides?.cancelled === true ? AT : null,
      // GENERATED in the database as `cancelledAt IS NULL` (issue 339) — a
      // fixture has to state what Postgres would compute.
      live: overrides?.cancelled !== true,
      classCompletedAt: null,
      scheduleRuleId: null,
      createdAt: AT,
      updatedAt: AT,
    },
    teacherRoomId: 'tr-1',
    // MIRRORS (issue 339): `entryLive` copies the entry's generated `live`
    // above, `roomArchived` copies `teacherRoom.isArchived` (always `false`
    // in this fixture).
    entryLive: overrides?.cancelled !== true,
    roomArchived: false,
    description: null,
    currency: 'EUR' as const,
    roomCost: new Decimal(20),
    minRate: new Decimal(40),
    targetRate: new Decimal(80),
    minStudents: 4,
    maxStudents: 12,
    cancelDeadline: 'HOURS_24',
    autoCancelCheck: 'HOURS_2',
    status,
    settingsLocked: true,
    effectiveTeacherRate: null,
    totalStudents: null,
    totalRevenue: null,
    spotBroadcastAt: null,
    teacherReminderSentAt: null,
    createdAt: AT,
    updatedAt: AT,
    _count: { registrations: payments?.length ?? 0 },
    teacherRoom,
    registrations: payments?.map((p) => ({ payment: p === null ? null : { status: p } })),
  };
}
