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
const BASE_URL = 'http://localhost:3000';

// One dedicated student per case keeps every test order-independent.
type Fixture = { id: string; token: string };
let sNoStamp: Fixture;
let sChooser: Fixture;
let sBooker: Fixture;
let sWaitlister: Fixture;
let sFiller: Fixture;
const teacherToken = crypto.randomBytes(32).toString('hex');

let teacherId: string;
let crmStudentId: string;
let roomId: string;
let openClassId: string;
let fullClassId: string;

async function api(
  path: string,
  method: string,
  body: Record<string, unknown>,
  token: string,
): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `fair_yoga_session=${token}`,
    },
    body: JSON.stringify(body),
  });
}

async function tierSelectedAt(studentId: string): Promise<Date | null> {
  const row = await prisma.student.findUniqueOrThrow({
    where: { id: studentId },
    select: { tierSelectedAt: true },
  });
  return row.tierSelectedAt;
}

describe('tierSelectedAt stamping', () => {
  beforeAll(async () => {
    async function mkStudent(name: string): Promise<Fixture> {
      const email = `tiersel-${name}-${uniqueSuffix}@test.local`;
      const student = await prisma.student.create({
        data: {
          firstName: name,
          lastName: 'Student',
          email,
          account: { create: { email } },
          claimedAt: new Date(),
          // Claimed but deliberately unstamped: the backfill only covers
          // pre-migration students; these simulate claimed-but-not-chosen.
          tierSelectedAt: null,
        },
      });
      const token = crypto.randomBytes(32).toString('hex');
      await prisma.session.create({
        data: {
          id: hashToken(token),
          accountId: student.accountId!,
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
      return { id: student.id, token };
    }

    sNoStamp = await mkStudent('nostamp');
    sChooser = await mkStudent('chooser');
    sBooker = await mkStudent('booker');
    sWaitlister = await mkStudent('waitlister');
    sFiller = await mkStudent('filler');

    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Tiersel',
        lastName: 'Teacher',
        email: `tiersel-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `tiersel-teacher-${uniqueSuffix}@test.local` } },
        bio: 'tierSelectedAt fixtures',
        pageSlug: `tiersel-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;
    await prisma.session.create({
      data: {
        id: hashToken(teacherToken),
        accountId: teacher.accountId,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    const crm = await prisma.student.create({
      data: {
        firstName: 'Roster',
        lastName: 'Student',
        email: `tiersel-crm-${uniqueSuffix}@test.local`,
      },
    });
    crmStudentId = crm.id;
    await prisma.teacherStudent.create({ data: { teacherId, studentId: crmStudentId } });

    const room = await prisma.room.create({
      data: {
        venueName: 'Tiersel Studio',
        address: `${uniqueSuffix} Tiersel St`,
        city: 'Amsterdam',
        postcode: '1111TS',
        maxCapacity: 10,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 10, rentalRate: 30 },
    });

    async function mkClass(daysAhead: number, maxStudents: number) {
      const date = new Date();
      date.setDate(date.getDate() + daysAhead);
      date.setUTCHours(0, 0, 0, 0);
      return prisma.class.create({
        data: {
          teacherId,
          teacherRoomId: teacherRoom.id,
          classType: 'Vinyasa',
          date,
          startTime: '09:00',
          durationMinutes: 60,
          roomCost: 30,
          minRate: 15,
          targetRate: 25,
          minStudents: 1,
          maxStudents,
          status: 'open',
        },
      });
    }
    openClassId = (await mkClass(7, 10)).id;
    fullClassId = (await mkClass(14, 1)).id;
    await prisma.registration.create({
      data: {
        classId: fullClassId,
        studentId: sFiller.id,
        status: 'registered',
        tierAtBooking: 3,
      },
    });
  });

  afterAll(async () => {
    const students = [sNoStamp, sChooser, sBooker, sWaitlister, sFiller].filter(Boolean);
    await prisma.session.deleteMany({
      where: {
        id: { in: [...students.map((s) => hashToken(s.token)), hashToken(teacherToken)] },
      },
    });
    const classIds = [openClassId, fullClassId].filter(Boolean);
    const studentIds = [...students.map((s) => s.id), crmStudentId].filter(Boolean);
    if (studentIds.length) {
      await prisma.notification.deleteMany({ where: { recipientId: { in: studentIds } } });
    }
    if (teacherId) {
      await prisma.notification.deleteMany({ where: { recipientId: teacherId } });
      await prisma.teacherStudent.deleteMany({ where: { teacherId } });
    }
    if (classIds.length) await prisma.class.deleteMany({ where: { id: { in: classIds } } });
    if (roomId) {
      await prisma.teacherRoom.deleteMany({ where: { roomId } });
      await prisma.room.delete({ where: { id: roomId } });
    }
    if (studentIds.length) await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.deleteMany({
      where: { email: { contains: `-${uniqueSuffix}@test.local` } },
    });
    await prisma.$disconnect();
  });

  it('a self-edit without incomeTier does not stamp', async () => {
    const res = await api(`/api/students/${sNoStamp.id}`, 'PUT', { reminderPref: 'morning' }, sNoStamp.token);
    expect(res.status).toBe(200);
    expect(await tierSelectedAt(sNoStamp.id)).toBeNull();
  });

  it('a self-selected tier stamps', async () => {
    const res = await api(`/api/students/${sChooser.id}`, 'PUT', { incomeTier: 4 }, sChooser.token);
    expect(res.status).toBe(200);
    expect(await tierSelectedAt(sChooser.id)).not.toBeNull();
  });

  it('a teacher edit of an unclaimed CRM student can neither set the tier nor stamp', async () => {
    const res = await api(
      `/api/students/${crmStudentId}`,
      'PUT',
      {
        firstName: 'Renamed',
        lastName: 'Student',
        email: `tiersel-crm-${uniqueSuffix}@test.local`,
        incomeTier: 5,
      },
      teacherToken,
    );
    expect(res.status).toBe(200);
    const row = await prisma.student.findUniqueOrThrow({ where: { id: crmStudentId } });
    expect(row.incomeTier).toBe(3); // teacher branch strips incomeTier
    expect(row.tierSelectedAt).toBeNull();
  });

  it('a self-booking stamps — booking past the picker is the choice', async () => {
    const res = await api('/api/registrations', 'POST', { classId: openClassId }, sBooker.token);
    expect(res.status).toBe(201);
    expect(await tierSelectedAt(sBooker.id)).not.toBeNull();
  });

  it('a teacher roster-add does not stamp the student', async () => {
    const res = await api(
      '/api/registrations',
      'POST',
      { classId: openClassId, studentId: crmStudentId },
      teacherToken,
    );
    expect(res.status).toBe(201);
    expect(await tierSelectedAt(crmStudentId)).toBeNull();
  });

  it('joining a waitlist stamps — the choice happens at join, not promotion', async () => {
    const res = await api('/api/waitlist', 'POST', { classId: fullClassId }, sWaitlister.token);
    expect(res.status).toBe(201);
    expect(await tierSelectedAt(sWaitlister.id)).not.toBeNull();
  });
});
