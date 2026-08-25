/**
 * Shared fixtures for the room-archive unit tests (issue 76).
 *
 * A FRESH teacher, room and link per case. Two constraints make shared-teacher
 * fixtures collide: `ScheduleRule_teacher_slot_excl` (issue 298) — an
 * `EXCLUDE USING gist` over (teacherId, dayOfWeek, slot) WHERE isArchived =
 * false, spanning BOTH template families and matching on RANGE OVERLAP rather
 * than an exact start time, so it is strictly wider than the two exact-start
 * partial unique indexes it replaced — and `Class_teacher_slot_unique` on
 * (teacherId, date, startTime) WHERE status <> 'cancelled'. A fresh teacher
 * per case sidesteps both — but only ACROSS fixtures, not within one.
 *
 * `addClass` derives `startTime` from `seq`, and `seq` advances only in
 * `makeFixture`, never in `addClass` itself; `date` is fixed at today+14. So
 * two `addClass` calls against the SAME fixture produce the identical
 * (teacherId, date, startTime) triple `Class_teacher_slot_unique` keys on —
 * the index still applies, this file just doesn't vary the columns it keys on
 * per call. The existing `completed` + `cancelled` two-class case
 * (`room-archive.test.ts`) survives only because the index is partial on
 * `status <> 'cancelled'`, not because two classes on one fixture are safe in
 * general. An obvious-looking "two upcoming classes on one fixture" case —
 * `open` + `open`, or `draft` + `open` — hits the live index and raises
 * P2002; if you need that, pass distinct fixtures, not distinct `addClass`
 * calls on the same one.
 *
 * Each test file passes its own `prefix` so its afterAll sweep cannot delete
 * another file's rows.
 */
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import { hhmmToTime } from '@/lib/time-of-day';

export type RoomFixture = { teacherId: string; roomId: string; linkId: string };
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

  /** Always future-dated: a past date trips the STARTS_IN_PAST guard first. */
  async function addClass(db: PrismaClient, f: RoomFixture, status: ClassFixtureStatus) {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() + 14);
    return db.class.create({
      data: {
        teacherId: f.teacherId,
        teacherRoomId: f.linkId,
        classType: 'Vinyasa',
        date,
        startTime: `0${seq % 8}:30`,
        durationMinutes: 60,
        roomCost: new Prisma.Decimal(20),
        minRate: new Prisma.Decimal(15),
        targetRate: new Prisma.Decimal(25),
        minStudents: 2,
        maxStudents: 10,
        status,
      },
    });
  }

  async function addTemplate(
    db: PrismaClient,
    f: RoomFixture,
    opts: { isActive: boolean; isArchived: boolean },
  ) {
    return db.classTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId: f.teacherId,
            kind: 'regular',
            classType: 'Hatha',
            dayOfWeek: 2,
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

  /** Sweeps only rows created by THIS run's prefix. */
  async function cleanup(db: PrismaClient) {
    const mine = { teacher: { pageSlug: { startsWith: suffix } } };
    await db.class.deleteMany({ where: mine });
    // `ClassTemplate`/`StudioClassTemplate` are `onDelete: Cascade` from
    // `ScheduleRule` (issue 298) — deleting the rule removes both families'
    // templates, so this deletes the rule rather than nesting the filter.
    await db.scheduleRule.deleteMany({ where: mine });
    await db.teacherRoom.deleteMany({ where: mine });
    await db.room.deleteMany({ where: { createdBy: { pageSlug: { startsWith: suffix } } } });
    await db.teacher.deleteMany({ where: { pageSlug: { startsWith: suffix } } });
  }

  return { suffix, makeFixture, addClass, addTemplate, cleanup };
}
