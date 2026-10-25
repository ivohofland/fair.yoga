import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { RegistrationStatus } from '@/lib/prisma-client';
import { createPrismaClient } from '@/lib/prisma-client';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../../tests/class-fixtures';
import { notifyVideoLinkChanged } from './video-link-notice';

const prisma = createPrismaClient();
const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const LINK_A = `https://example.invalid/notice-911-a-${suffix}`;
const LINK_B = `https://example.invalid/notice-911-b-${suffix}`;

describe('notifyVideoLinkChanged (DB)', () => {
  let teacherId = '';
  let accountId = '';
  const studentIds: string[] = [];
  const classIds: string[] = [];
  let n = 0;
  let day = 0;

  async function student(): Promise<string> {
    const s = await prisma.student.create({
      data: { firstName: 'Notice', lastName: 'Student', email: `vnotice-${suffix}-${n++}@test.local` },
    });
    studentIds.push(s.id);
    return s.id;
  }

  /** A fresh online class with two registered students, one cancelled and one waitlisted. */
  async function bookedClass(): Promise<{ classId: string; registered: string[]; others: string[] }> {
    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId: null,
      format: 'online',
      classType: 'Notice Flow',
      date: new Date(Date.UTC(2099, 6, 1 + day++)),
      startTime: hhmmToTime('18:00'),
      durationMinutes: 60,
      roomCost: 0,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 12,
      status: 'open',
    });
    classIds.push(cls.id);
    const reg = async (status: RegistrationStatus): Promise<string> => {
      const id = await student();
      await prisma.registration.create({ data: { classId: cls.id, studentId: id, status, tierAtBooking: 3 } });
      return id;
    };
    const registered = [await reg('registered'), await reg('registered')];
    const cancelled = await reg('cancelled');
    const waiting = await student();
    await prisma.waitlistEntry.create({ data: { classId: cls.id, studentId: waiting, position: 1, status: 'waiting' } });
    return { classId: cls.id, registered, others: [cancelled, waiting] };
  }

  const rowsFor = (classId: string) =>
    prisma.notification.findMany({ where: { relatedClassId: classId, type: 'video_link_updated' } });

  beforeAll(async () => {
    const email = `vnotice-teacher-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Notice',
        lastName: 'Teacher',
        email,
        bio: 'notifyVideoLinkChanged',
        pageSlug: `vnotice-teacher-${suffix}`,
        defaultTimezone: 'UTC',
        account: { create: { email } },
      },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId ?? '';
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { relatedClassId: { in: classIds } } });
    await prisma.waitlistEntry.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.registration.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    if (accountId) await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('notifies the registered students when a link is added, and no one else', async () => {
    const { classId, registered, others } = await bookedClass();
    expect(await notifyVideoLinkChanged(prisma, { classId, previous: null, next: LINK_A })).toBe(2);
    const rows = await rowsFor(classId);
    expect(rows.map((r) => r.recipientId).sort()).toEqual([...registered].sort());
    for (const other of others) expect(rows.some((r) => r.recipientId === other)).toBe(false);
    expect(rows.every((r) => r.recipientType === 'student')).toBe(true);
  });

  it('notifies when one link replaces another', async () => {
    const { classId } = await bookedClass();
    expect(await notifyVideoLinkChanged(prisma, { classId, previous: LINK_A, next: LINK_B })).toBe(2);
  });

  it('sends nothing when the link is unchanged', async () => {
    const { classId } = await bookedClass();
    expect(await notifyVideoLinkChanged(prisma, { classId, previous: LINK_A, next: LINK_A })).toBe(0);
    expect(await rowsFor(classId)).toHaveLength(0);
  });

  it('sends nothing when the link is cleared', async () => {
    const { classId } = await bookedClass();
    expect(await notifyVideoLinkChanged(prisma, { classId, previous: LINK_A, next: null })).toBe(0);
    expect(await rowsFor(classId)).toHaveLength(0);
  });

  it('carries the class type, day and time, and never a link', async () => {
    const { classId } = await bookedClass();
    await notifyVideoLinkChanged(prisma, { classId, previous: null, next: LINK_A });
    const row = await prisma.notification.findFirstOrThrow({ where: { relatedClassId: classId, type: 'video_link_updated' } });
    expect(row.title).toBe('Video link for Notice Flow');
    expect(row.body).toMatch(/^Notice Flow on .+ at 18:00: the video link is on your booking\.$/);
    expect(`${row.title} ${row.body}`).not.toContain('https://');
  });
});
