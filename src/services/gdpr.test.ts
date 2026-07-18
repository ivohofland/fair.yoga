import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import {
  exportStudentData,
  deleteStudentAccount,
  deleteTeacherAccount,
} from './gdpr';

const prisma = new PrismaClient();
const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

describe('GDPR (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  let studentId: string;
  let completedClassId: string;
  let openClassId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Gdpr',
        lastName: 'Teacher',
        email: `gdpr-teacher-${uniqueSuffix}@test.local`,
        bio: 'GDPR tests',
        pageSlug: `gdpr-teacher-${uniqueSuffix}`,
        bankIban: 'NL00TEST0123456789',
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'GDPR Studio',
        address: `${uniqueSuffix} GDPR St`,
        city: 'Amsterdam',
        postcode: '1234GD',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const tr = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 15, rentalRate: 30 },
    });
    teacherRoomId = tr.id;

    const student = await prisma.student.create({
      data: {
        firstName: 'Gdpr',
        lastName: 'Student',
        email: `gdpr-student-${uniqueSuffix}@test.local`,
        incomeTier: 2,
        phone: '+31600000000',
        claimedAt: new Date(),
      },
    });
    studentId = student.id;

    await prisma.teacherStudent.create({ data: { teacherId, studentId } });
    await prisma.studentPrivacy.create({
      data: { studentId, teacherId, shareFullName: true },
    });

    const mkClass = (status: 'completed' | 'open', date: string) =>
      prisma.class.create({
        data: {
          teacherId,
          teacherRoomId,
          classType: `GDPR ${status}`,
          date: new Date(date),
          startTime: '09:00',
          durationMinutes: 60,
          roomCost: 20,
          minRate: 15,
          targetRate: 25,
          minStudents: 1,
          maxStudents: 10,
          status,
        },
      });

    const completed = await mkClass('completed', '2026-06-01');
    completedClassId = completed.id;
    const open = await mkClass('open', '2099-06-01');
    openClassId = open.id;

    const completedReg = await prisma.registration.create({
      data: { classId: completedClassId, studentId, status: 'attended', tierAtBooking: 2, price: 11.5 },
    });
    await prisma.payment.create({
      data: { registrationId: completedReg.id, amount: 11.5, status: 'pending' },
    });
    await prisma.registration.create({
      data: { classId: openClassId, studentId, status: 'registered', tierAtBooking: 2 },
    });
    await prisma.notification.create({
      data: {
        recipientType: 'student',
        recipientId: studentId,
        type: 'booking_confirmed',
        title: 'Booking confirmed',
        body: 'test',
        relatedClassId: openClassId,
      },
    });
    // The teacher's copy carries the student's first name — must be scrubbed.
    await prisma.notification.create({
      data: {
        recipientType: 'teacher',
        recipientId: teacherId,
        type: 'booking_confirmed',
        title: 'New booking',
        body: 'Gdpr booked GDPR open.',
        relatedClassId: openClassId,
      },
    });
    await prisma.session.create({
      data: {
        id: crypto.randomBytes(32).toString('hex'),
        userId: studentId,
        userType: 'student',
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({
      where: { relatedClassId: { in: [completedClassId, openClassId] } },
    });
    await prisma.payment.deleteMany({ where: { registration: { classId: completedClassId } } });
    await prisma.registration.deleteMany({ where: { classId: { in: [completedClassId, openClassId] } } });
    await prisma.class.deleteMany({ where: { id: { in: [completedClassId, openClassId] } } });
    await prisma.teacherRoom.deleteMany({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.student.delete({ where: { id: studentId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('export contains profile, bookings, and payment state', async () => {
    const data = await exportStudentData(prisma, studentId);
    expect(data.profile.email).toContain('gdpr-student');
    expect(data.profile.phone).toBe('+31600000000');
    expect(data.bookings.length).toBeGreaterThanOrEqual(2);
    const paidBooking = data.bookings.find((b) => b.payment);
    expect(paidBooking?.payment?.status).toBe('pending');
    expect(data.privacySettings).toHaveLength(1);
  });

  it('student deletion anonymizes, cancels upcoming, and keeps financial rows', async () => {
    await deleteStudentAccount(prisma, studentId);

    const student = await prisma.student.findUniqueOrThrow({ where: { id: studentId } });
    expect(student.firstName).toBe('Deleted');
    expect(student.email).toBe(`deleted-${studentId}@deleted.invalid`);
    expect(student.phone).toBeNull();
    expect(student.deletedAt).not.toBeNull();

    // Pure personal data gone
    expect(await prisma.studentPrivacy.count({ where: { studentId } })).toBe(0);
    expect(await prisma.teacherStudent.count({ where: { studentId } })).toBe(0);
    expect(
      await prisma.notification.count({ where: { recipientType: 'student', recipientId: studentId } }),
    ).toBe(0);
    expect(
      await prisma.session.count({ where: { userId: studentId, userType: 'student' } }),
    ).toBe(0);

    // Upcoming booking cancelled; charged history intact
    const upcoming = await prisma.registration.findFirst({
      where: { classId: openClassId, studentId },
    });
    expect(upcoming?.status).toBe('cancelled');

    const charged = await prisma.registration.findFirst({
      where: { classId: completedClassId, studentId },
      include: { payment: true },
    });
    expect(charged?.status).toBe('attended');
    expect(charged?.payment?.status).toBe('pending');
    expect(Number(charged?.payment?.amount)).toBe(11.5);

    // The teacher's "X booked" notification no longer names the student
    const teacherCopy = await prisma.notification.findFirst({
      where: { recipientType: 'teacher', recipientId: teacherId, relatedClassId: openClassId },
    });
    expect(teacherCopy?.body).not.toContain('Gdpr');
    expect(teacherCopy?.body).toContain('deleted');
  });

  it('teacher deletion cancels upcoming classes, notifies, and anonymizes', async () => {
    // Fresh student registered on the teacher's open class (recreate an
    // open class since the previous one now has a cancelled registration).
    const other = await prisma.student.create({
      data: {
        firstName: 'Other',
        lastName: 'Student',
        email: `gdpr-other-${uniqueSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    await prisma.registration.create({
      data: { classId: openClassId, studentId: other.id, status: 'registered', tierAtBooking: 3 },
    });

    await deleteTeacherAccount(prisma, teacherId);

    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(teacher.firstName).toBe('Deleted');
    expect(teacher.bankIban).toBeNull();
    expect(teacher.pageSlug).toBe(`deleted-${teacherId}`);
    expect(teacher.deletedAt).not.toBeNull();

    const openClass = await prisma.class.findUniqueOrThrow({ where: { id: openClassId } });
    expect(openClass.status).toBe('cancelled');

    // Registered student was told
    const note = await prisma.notification.findFirst({
      where: { recipientType: 'student', recipientId: other.id, type: 'class_cancelled' },
    });
    expect(note).not.toBeNull();

    // Completed class (the students' payment history) survives
    const completed = await prisma.class.findUniqueOrThrow({ where: { id: completedClassId } });
    expect(completed.status).toBe('completed');

    await prisma.notification.deleteMany({ where: { recipientId: other.id } });
    await prisma.registration.deleteMany({ where: { studentId: other.id } });
    await prisma.student.delete({ where: { id: other.id } });
  });
});
