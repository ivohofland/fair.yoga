/**
 * Shared fixtures for the room services' unit tests.
 *
 * A FRESH teacher, room and link per `makeFixture`. Two constraints make
 * shared-teacher fixtures collide, each an `EXCLUDE USING gist` matching on
 * RANGE OVERLAP rather than an exact start time and spanning both families of
 * its layer: `ScheduleRule_teacher_slot_excl` over (teacherId, dayOfWeek,
 * slot) WHERE isArchived = false, and `CalendarEntry_teacher_slot_excl` over
 * (teacherId, span) WHERE "cancelledAt" IS NULL. A fresh teacher per fixture
 * sidesteps both across fixtures, not within one.
 *
 * Within one fixture, `addClass` derives `startTime` from the run's `seq`,
 * which advances only in `makeFixture`, and `date` defaults to today+14;
 * `addTemplate` always starts at 18:00 and `dayOfWeek` defaults to 2. So give
 * each live row on one fixture its own `daysAhead` (`addClass`) or `dayOfWeek`
 * (`addTemplate`), or the exclusion refuses the second with `23P01`. A
 * cancelled class and an archived template take no part in it.
 *
 * Each test file passes its own `prefix` so its afterAll sweep cannot delete
 * another file's rows.
 */
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from './class-fixtures';

export type RoomFixture = { teacherId: string; roomId: string; linkId: string };
/**
 * `ClassStatus` plus `'cancelled'`. Since #327 cancellation is a column on the
 * entry rather than a status, so a fixture that wants a cancelled class asks
 * for one here and `addClass` decides which of the two rows carries it.
 */
export type ClassFixtureStatus = 'draft' | 'open' | 'in_progress' | 'completed' | 'cancelled';

export function fixtureRun(prefix: string) {
  const suffix = `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let seq = 0;

  async function makeFixture(db: PrismaClient): Promise<RoomFixture> {
    const tag = `${suffix}-${seq++}`;
    const teacher = await db.teacher.create({
      data: {
        firstName: 'Room',
        lastName: 'Fixture',
        email: `${tag}@test.local`,
        account: { create: { email: `${tag}@test.local` } },
        bio: 'room archive fixtures',
        pageSlug: tag,
      },
    });
    const room = await db.room.create({
      data: {
        venueName: `Venue ${tag}`,
        address: `${seq} Fixture Street`,
        city: 'Amsterdam',
        postcode: '1011AB',
        maxCapacity: 20,
        createdById: teacher.id,
      },
    });
    const link = await db.teacherRoom.create({
      data: {
        teacherId: teacher.id,
        roomId: room.id,
        capacityOverride: 15,
        rentalRate: new Prisma.Decimal(30),
      },
    });
    return { teacherId: teacher.id, roomId: room.id, linkId: link.id };
  }

  /** Always future-dated: a past date trips the STARTS_IN_PAST guard first.
   *  `daysAhead` (default 14) moves the date; give each uncancelled class on one
   *  fixture its own, or `CalendarEntry_teacher_slot_excl` refuses the second. */
  async function addClass(
    db: PrismaClient,
    f: RoomFixture,
    status: ClassFixtureStatus,
    opts: { daysAhead?: number } = {},
  ) {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() + (opts.daysAhead ?? 14));
    return createClassFixture(db, {
        teacherId: f.teacherId,
        teacherRoomId: f.linkId,
        classType: 'Vinyasa',
        date,
        startTime: hhmmToTime(`0${seq % 8}:30`),
        durationMinutes: 60,
        roomCost: new Prisma.Decimal(20),
        minRate: new Prisma.Decimal(15),
        targetRate: new Prisma.Decimal(25),
        minStudents: 2,
        maxStudents: 10,
        status: status === 'cancelled' ? 'open' : status,
        cancelledAt: status === 'cancelled' ? new Date() : null,
      });
  }

  async function addTemplate(
    db: PrismaClient,
    f: RoomFixture,
    opts: { isActive: boolean; isArchived: boolean; dayOfWeek?: number },
  ) {
    return db.classTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId: f.teacherId,
            kind: 'regular',
            classType: 'Hatha',
            dayOfWeek: opts.dayOfWeek ?? 2,
            startTime: hhmmToTime('18:00'),
            durationMinutes: 60,
            isActive: opts.isActive,
            isArchived: opts.isArchived,
          },
        },
        teacherRoom: { connect: { id: f.linkId } },
        roomCost: new Prisma.Decimal(20),
        minRate: new Prisma.Decimal(15),
        targetRate: new Prisma.Decimal(25),
        minStudents: 2,
        maxStudents: 10,
      },
    });
  }

  /**
   * A SHARED room with `f`'s identity (issue 259). `f`'s private room is first
   * given a run-unique `roomName`, because two runs' twins would otherwise
   * collide on `Room_public_identity_unique`. The twin's creator is `f`'s
   * teacher, so `cleanup` sweeps it with the rest. `twinCase` varies case and
   * whitespace on the twin's side only; `roomName` gives it a different
   * identity outright.
   */
  async function addSharedTwin(
    db: PrismaClient,
    f: RoomFixture,
    opts: { maxCapacity?: number; twinCase?: boolean; roomName?: string } = {},
  ) {
    const tag = `${suffix}-${crypto.randomBytes(3).toString('hex')}`;
    const priv = await db.room.update({
      where: { id: f.roomId },
      data: { roomName: `Studio ${tag}` },
    });
    return db.room.create({
      data: {
        venueName: `Shared ${tag}`,
        address: opts.twinCase ? `  ${priv.address.toUpperCase()} ` : priv.address,
        floor: priv.floor,
        roomName: opts.roomName ?? (opts.twinCase ? ` STUDIO ${tag.toUpperCase()}` : priv.roomName),
        city: priv.city,
        postcode: priv.postcode,
        maxCapacity: opts.maxCapacity ?? 24,
        isPublic: true,
        createdById: f.teacherId,
      },
    });
  }

  /** Sweeps only rows created by THIS run's prefix. */
  async function cleanup(db: PrismaClient) {
    const mine = { teacher: { pageSlug: { startsWith: suffix } } };
    // The ENTRY, which cascades to both families' children (#327).
    await db.calendarEntry.deleteMany({ where: mine });
    // `ClassTemplate`/`StudioClassTemplate` are `onDelete: Cascade` from
    // `ScheduleRule` (issue 298) — deleting the rule removes both families'
    // templates, so this deletes the rule rather than nesting the filter.
    await db.scheduleRule.deleteMany({ where: mine });
    await db.teacherRoom.deleteMany({ where: mine });
    await db.room.deleteMany({ where: { createdBy: { pageSlug: { startsWith: suffix } } } });
    await db.teacher.deleteMany({ where: { pageSlug: { startsWith: suffix } } });
    // Issue 177: Account must be deleted after Teacher due to FK reference
    await db.account.deleteMany({ where: { email: { startsWith: suffix } } });
  }

  return { suffix, makeFixture, addClass, addTemplate, addSharedTwin, cleanup };
}
