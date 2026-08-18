/**
 * Shared fixtures for the room-archive unit tests (issue 76).
 *
 * A FRESH teacher, room and link per case. Two partial unique indexes make
 * shared-teacher fixtures collide: `ClassTemplate_teacher_slot_unique` on
 * (teacherId, dayOfWeek, startTime) WHERE isArchived = false, and
 * `Class_teacher_slot_unique` on (teacherId, date, startTime) WHERE
 * status <> 'cancelled'. A fresh teacher per case sidesteps both.
 *
 * Each test file passes its own `prefix` so its afterAll sweep cannot delete
 * another file's rows.
 */
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';

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
        teacherId: f.teacherId,
        teacherRoomId: f.linkId,
        classType: 'Hatha',
        dayOfWeek: 2,
        startTime: '18:00',
        durationMinutes: 60,
        roomCost: new Prisma.Decimal(20),
        minRate: new Prisma.Decimal(15),
        targetRate: new Prisma.Decimal(25),
        minStudents: 2,
        maxStudents: 10,
        isActive: opts.isActive,
        isArchived: opts.isArchived,
      },
    });
  }

  /** Sweeps only rows created by THIS run's prefix. */
  async function cleanup(db: PrismaClient) {
    const mine = { teacher: { pageSlug: { startsWith: suffix } } };
    await db.class.deleteMany({ where: mine });
    await db.classTemplate.deleteMany({ where: mine });
    await db.teacherRoom.deleteMany({ where: mine });
    await db.room.deleteMany({ where: { createdBy: { pageSlug: { startsWith: suffix } } } });
    await db.teacher.deleteMany({ where: { pageSlug: { startsWith: suffix } } });
  }

  return { suffix, makeFixture, addClass, addTemplate, cleanup };
}
