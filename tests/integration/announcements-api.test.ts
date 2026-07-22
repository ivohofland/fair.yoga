import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';

function hashToken(token: string): string {
  return encodeHexLowerCase(sha256(new TextEncoder().encode(token)));
}

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();
const rawSessionToken = crypto.randomBytes(32).toString('hex');
const BASE_URL = 'http://localhost:3000';
const sessionCookie = `fair_yoga_session=${rawSessionToken}`;

let teacherId: string;
let otherTeacherId: string;
let roomId: string;
let class1Id: string;
let class2Id: string;
let class3Id: string;
let foreignClassId: string;
let s1Id: string;
let s2Id: string;
let s3Id: string;

async function sendAnnouncement(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE_URL}/api/announcements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify(body),
  });
}

function announcementNotifications(where: Record<string, unknown>) {
  return prisma.notification.findMany({
    where: {
      type: 'announcement',
      recipientId: { in: [s1Id, s2Id, s3Id] },
      ...where,
    },
  });
}

describe('POST /api/announcements', () => {
  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Announce',
        lastName: 'Teacher',
        email: `announce-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `announce-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Announcement fixtures',
        pageSlug: `announce-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;
    const other = await prisma.teacher.create({
      data: {
        firstName: 'Foreign',
        lastName: 'Teacher',
        email: `announce-other-${uniqueSuffix}@test.local`,
        account: { create: { email: `announce-other-${uniqueSuffix}@test.local` } },
        bio: 'Ownership fixture',
        pageSlug: `announce-other-${uniqueSuffix}`,
      },
    });
    otherTeacherId = other.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Announce Studio',
        address: `${uniqueSuffix} Announce St`,
        city: 'Amsterdam',
        postcode: '1111AN',
        maxCapacity: 10,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 10, rentalRate: 30 },
    });
    const otherTeacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: otherTeacherId, roomId: room.id, capacityOverride: 10, rentalRate: 30 },
    });

    async function makeClass(ownerTeacherId: string, ownerRoomId: string, daysAhead: number) {
      const date = new Date();
      date.setDate(date.getDate() + daysAhead);
      date.setUTCHours(0, 0, 0, 0);
      return prisma.class.create({
        data: {
          teacherId: ownerTeacherId,
          teacherRoomId: ownerRoomId,
          classType: 'Vinyasa',
          date,
          startTime: '09:00',
          durationMinutes: 60,
          roomCost: 30,
          minRate: 15,
          targetRate: 25,
          minStudents: 2,
          maxStudents: 10,
          status: 'open',
        },
      });
    }
    class1Id = (await makeClass(teacherId, teacherRoom.id, 7)).id;
    class2Id = (await makeClass(teacherId, teacherRoom.id, 14)).id;
    class3Id = (await makeClass(teacherId, teacherRoom.id, 21)).id;
    foreignClassId = (await makeClass(otherTeacherId, otherTeacherRoom.id, 7)).id;

    async function makeStudent(name: string) {
      const s = await prisma.student.create({
        data: {
          firstName: name,
          lastName: 'Student',
          email: `announce-${name.toLowerCase()}-${uniqueSuffix}@test.local`,
          incomeTier: 3,
        },
      });
      return s.id;
    }
    s1Id = await makeStudent('Dedup');
    s2Id = await makeStudent('Muted');
    s3Id = await makeStudent('Cancelled');

    async function register(classId: string, studentId: string, status: 'registered' | 'cancelled') {
      await prisma.registration.create({
        data: { classId, studentId, status, tierAtBooking: 3 },
      });
    }
    // S1: classes 1 + 2 (the dedup case).
    await register(class1Id, s1Id, 'registered');
    await register(class2Id, s1Id, 'registered');
    // S2: classes 1 + 3, but muted for teacher A.
    await register(class1Id, s2Id, 'registered');
    await register(class3Id, s2Id, 'registered');
    await prisma.studentPrivacy.create({
      data: { studentId: s2Id, teacherId, receiveComms: false },
    });
    // S3: cancelled in class 1 only.
    await register(class1Id, s3Id, 'cancelled');

    await prisma.session.create({
      data: {
        id: hashToken(rawSessionToken),
        accountId: teacher.accountId,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { id: hashToken(rawSessionToken) } });
    const studentIds = [s1Id, s2Id, s3Id].filter(Boolean);
    if (studentIds.length) {
      await prisma.notification.deleteMany({ where: { recipientId: { in: studentIds } } });
      await prisma.studentPrivacy.deleteMany({ where: { studentId: { in: studentIds } } });
    }
    if (teacherId) await prisma.announcement.deleteMany({ where: { teacherId } });
    const classIds = [class1Id, class2Id, class3Id, foreignClassId].filter(Boolean);
    if (classIds.length) await prisma.class.deleteMany({ where: { id: { in: classIds } } });
    if (roomId) {
      await prisma.teacherRoom.deleteMany({ where: { roomId } });
      await prisma.room.delete({ where: { id: roomId } });
    }
    if (studentIds.length) await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
    if (otherTeacherId) await prisma.teacher.delete({ where: { id: otherTeacherId } });
    await prisma.account.deleteMany({
      where: { email: { contains: `-${uniqueSuffix}@test.local` } },
    });
    await prisma.$disconnect();
  });

  it('class-scoped send reaches non-cancelled, unmuted registrants only', async () => {
    const res = await sendAnnouncement({ classId: class1Id, message: 'Bring a blanket.' });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.recipientCount).toBe(1); // S1 only: S2 muted, S3 cancelled

    const rows = await announcementNotifications({ relatedClassId: class1Id });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipientId).toBe(s1Id);
    // The user-visible payload, not just the row count.
    expect(rows[0]!.title).toBe('New announcement');
    expect(rows[0]!.body).toBe('Bring a blanket.');
  });

  it('rejects a send without a message', async () => {
    const res = await sendAnnouncement({ classId: class1Id });
    expect(res.status).toBe(400);
  });

  it('all-students send deduplicates across classes and honors the mute', async () => {
    const before = new Date();
    const res = await sendAnnouncement({ message: 'Studio closed next week.' });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.recipientCount).toBe(1); // S1 deduped; S2 muted; S3 cancelled-only

    const rows = await announcementNotifications({ createdAt: { gt: before } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipientId).toBe(s1Id);
  });

  it("rejects another teacher's class", async () => {
    const before = new Date();
    const res = await sendAnnouncement({ classId: foreignClassId, message: 'Hijack attempt.' });
    expect(res.status).toBe(403);
    expect(await announcementNotifications({ createdAt: { gt: before } })).toHaveLength(0);
  });

  it('400 when every registrant is muted, and no Announcement row is written', async () => {
    const before = new Date();
    const res = await sendAnnouncement({ classId: class3Id, message: 'Nobody hears this.' });
    expect(res.status).toBe(400);
    expect(await announcementNotifications({ createdAt: { gt: before } })).toHaveLength(0);
    const records = await prisma.announcement.findMany({
      where: { teacherId, classId: class3Id },
    });
    expect(records).toHaveLength(0);
  });

  it('404 for an unknown class', async () => {
    const res = await sendAnnouncement({
      classId: '00000000-0000-4000-8000-000000000000',
      message: 'Ghost class.',
    });
    expect(res.status).toBe(404);
  });
});
