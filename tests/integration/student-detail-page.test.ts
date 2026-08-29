import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { createClassFixture } from '../class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';
import { formatDateShort, formatDateWithYear } from '@/lib/format';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/**
 * `/(teacher)/students/[id]` — teacher student detail page test suite (Issue 143).
 *
 * Covers:
 * - Access control & ownership redirects (non-owner / non-existent student)
 * - Privacy projection (`projectStudentForTeacher`) for claimed students:
 *   - Full name vs truncated name (`shareFullName: false` -> `First l.`)
 *   - Contact field gating & `formatDateShort` birthday (`15 Jun`, no year)
 *   - "No contact information to show" empty state
 * - Unlinked students: caption notice, bypasses privacy on contact, no attendance/payments/archive
 * - Attendance & payment history: date/time formats (`formatDateWithYear · timeToHHmm`), humanized status
 * - Multi-teacher isolation: Teacher 1 never sees registrations or payments from Teacher 2
 * - Archive state: back link and button text for active vs archived students
 */
describe('GET /students/[id] (student detail page)', () => {
  let teacherId: string;
  let teacherAccountId: string;
  let teacherToken: string;
  let otherTeacherId: string;
  let otherTeacherAccountId: string;
  let otherTeacherToken: string;
  let roomId: string;
  let teacherRoomId: string;
  let otherTeacherRoomId: string;

  const studentPage = (id: string, token = teacherToken) =>
    fetch(`${BASE_URL}/students/${id}`, { headers: cookie(token) });

  beforeAll(async () => {
    await prisma.$connect();

    const teacherEmail = `studentdetail-teacher-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Detail',
        lastName: 'Teacher',
        email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: 'Student detail page tests',
        pageSlug: `detail-teacher-${suffix}`,
      },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;
    teacherToken = await seedSession(prisma, teacherAccountId);

    const otherEmail = `studentdetail-other-${suffix}@test.local`;
    const otherTeacher = await prisma.teacher.create({
      data: {
        firstName: 'Other',
        lastName: 'Teacher',
        email: otherEmail,
        account: { create: { email: otherEmail } },
        bio: 'Other teacher for isolation tests',
        pageSlug: `detail-other-${suffix}`,
      },
    });
    otherTeacherId = otherTeacher.id;
    otherTeacherAccountId = otherTeacher.accountId;
    otherTeacherToken = await seedSession(prisma, otherTeacherAccountId);

    const room = await prisma.room.create({
      data: {
        venueName: 'Detail Studio',
        address: `${suffix} Detail St`,
        city: 'Amsterdam',
        postcode: '1000AA',
        roomName: 'Hall',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;

    const tr = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 15, rentalRate: 25 },
    });
    teacherRoomId = tr.id;

    const otherTr = await prisma.teacherRoom.create({
      data: { teacherId: otherTeacherId, roomId, capacityOverride: 10, rentalRate: 20 },
    });
    otherTeacherRoomId = otherTr.id;

    // Warm up the route to avoid paying lazy Next.js route compilation against vitest timeout
    await fetch(`${BASE_URL}/students/warmup`, { headers: cookie(teacherToken) }).catch(() => {});
  }, 20_000);

  afterAll(async () => {
    await prisma.payment.deleteMany({
      where: { registration: { class: { calendarEntry: { teacherId: { in: [teacherId, otherTeacherId] } } } } },
    });
    await prisma.registration.deleteMany({
      where: { class: { calendarEntry: { teacherId: { in: [teacherId, otherTeacherId] } } } },
    });
    await prisma.calendarEntry.deleteMany({
      where: { teacherId: { in: [teacherId, otherTeacherId] } },
    });
    await prisma.studentPrivacy.deleteMany({
      where: { teacherId: { in: [teacherId, otherTeacherId] } },
    });
    await prisma.teacherStudent.deleteMany({
      where: { teacherId: { in: [teacherId, otherTeacherId] } },
    });
    await prisma.student.deleteMany({
      where: { email: { contains: `-${suffix}@test.local` } },
    });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: [teacherId, otherTeacherId] } } });
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
    await prisma.session.deleteMany({
      where: { accountId: { in: [teacherAccountId, otherTeacherAccountId] } },
    });
    await prisma.teacher.deleteMany({
      where: { id: { in: [teacherId, otherTeacherId] } },
    });
    await prisma.account.deleteMany({
      where: { email: { contains: `-${suffix}@test.local` } },
    });
    await prisma.$disconnect();
  });

  describe('access control and ownership redirects', () => {
    it('redirects away when the student ID does not exist', async () => {
      const res = await studentPage('00000000-0000-0000-0000-000000000000');
      // Next.js App Router streaming redirects: returns 200 with none of the detail page sections
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain('>Contact</h2>');
      expect(html).not.toContain('>Attendance</h2>');
    });

    it('redirects away when the teacher has no TeacherStudent link to the student', async () => {
      const studentEmail = `stranger-${suffix}@test.local`;
      const stranger = await prisma.student.create({
        data: {
          firstName: 'Stranger',
          lastName: 'Student',
          email: studentEmail,
          account: { create: { email: studentEmail } },
          claimedAt: new Date(),
        },
      });
      await prisma.teacherStudent.create({
        data: { teacherId: otherTeacherId, studentId: stranger.id },
      });

      // teacherId has no link to stranger -> redirected away
      const res = await studentPage(stranger.id, teacherToken);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain('Stranger');
      expect(html).not.toContain('>Contact</h2>');

      // otherTeacherId has a link -> 200 with student detail
      const okRes = await studentPage(stranger.id, otherTeacherToken);
      expect(okRes.status).toBe(200);
      const okHtml = await okRes.text();
      expect(okHtml).toContain('Stranger');
      expect(okHtml).toContain('>Contact</h2>');
    });
  });

  describe('claimed student with privacy projection', () => {
    it('renders truncated name and formatted birthday when privacy flags are default / selective', async () => {
      const email = `claimed-selective-${suffix}@test.local`;
      const birthday = new Date('1992-06-15T00:00:00.000Z');
      const student = await prisma.student.create({
        data: {
          firstName: 'Anna',
          lastName: 'de Vries',
          email,
          phone: '+31612345678',
          birthday,
          address: 'Keizersgracht 100, Amsterdam',
          account: { create: { email } },
          claimedAt: new Date(),
          incomeTier: 2,
        },
      });
      await prisma.teacherStudent.create({
        data: { teacherId, studentId: student.id },
      });
      // Share birthday & phone, hide full name, email, and address
      await prisma.studentPrivacy.create({
        data: {
          studentId: student.id,
          teacherId,
          shareFullName: false,
          shareEmail: false,
          sharePhone: true,
          shareBirthday: true,
          shareAddress: false,
        },
      });

      const res = await studentPage(student.id);
      expect(res.status).toBe(200);
      const html = await res.text();

      // Name truncated to "Anna d." (lowercase initial per formatStudentName)
      expect(html).toContain('Anna d.');
      expect(html).not.toContain('Anna de Vries');

      // Shared contact fields
      expect(html).toContain('+31612345678');
      expect(html).toContain('>Birthday</span>');
      // formatDateShort: "15 Jun" (day first, abbreviated month, no year)
      expect(html).toContain(formatDateShort(birthday));
      expect(html).toContain('15 Jun');
      expect(html).not.toContain('1992');

      // Withheld contact fields
      expect(html).not.toContain(email);
      expect(html).not.toContain('Keizersgracht 100');
    });

    it('renders full name and all contact fields when everything is shared', async () => {
      const email = `claimed-full-${suffix}@test.local`;
      const birthday = new Date('1988-11-23T00:00:00.000Z');
      const student = await prisma.student.create({
        data: {
          firstName: 'Bram',
          lastName: 'Bakker',
          email,
          phone: '+31698765432',
          birthday,
          address: 'Prinsengracht 200, Amsterdam',
          account: { create: { email } },
          claimedAt: new Date(),
        },
      });
      await prisma.teacherStudent.create({
        data: { teacherId, studentId: student.id },
      });
      await prisma.studentPrivacy.create({
        data: {
          studentId: student.id,
          teacherId,
          shareFullName: true,
          shareEmail: true,
          sharePhone: true,
          shareBirthday: true,
          shareAddress: true,
        },
      });

      const res = await studentPage(student.id);
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain('Bram Bakker');
      expect(html).toContain(email);
      expect(html).toContain('+31698765432');
      expect(html).toContain('23 Nov');
      expect(html).toContain('Prinsengracht 200, Amsterdam');
    });

    it('renders "No contact information to show" empty state when all contact fields are withheld', async () => {
      const email = `claimed-hidden-${suffix}@test.local`;
      const student = await prisma.student.create({
        data: {
          firstName: 'Clara',
          lastName: 'Cornelissen',
          email,
          phone: '+31611112222',
          account: { create: { email } },
          claimedAt: new Date(),
        },
      });
      await prisma.teacherStudent.create({
        data: { teacherId, studentId: student.id },
      });
      await prisma.studentPrivacy.create({
        data: {
          studentId: student.id,
          teacherId,
          shareFullName: false,
          shareEmail: false,
          sharePhone: false,
          shareBirthday: false,
          shareAddress: false,
        },
      });

      const res = await studentPage(student.id);
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain('Clara c.');
      expect(html).toContain('No contact information to show.');
      expect(html).not.toContain(email);
      expect(html).not.toContain('+31611112222');
    });
  });

  describe('unlinked / unclaimed student', () => {
    it('displays unlinked caption notice, read-only contact, and no attendance, payment, or archive sections', async () => {
      const email = `unlinked-${suffix}@test.local`;
      const birthday = new Date('1995-04-10T00:00:00.000Z');
      const student = await prisma.student.create({
        data: {
          firstName: 'Daan',
          lastName: 'Dijkstra',
          email,
          phone: '+31633334444',
          birthday,
          address: 'Singel 50, Amsterdam',
          // Unclaimed: no account, claimedAt is null
          claimedAt: null,
        },
      });
      await prisma.teacherStudent.create({
        data: { teacherId, studentId: student.id },
      });

      const res = await studentPage(student.id);
      expect(res.status).toBe(200);
      const html = await res.text();

      // Unlinked caption
      expect(html).toContain("This student hasn't created an account yet.");

      // Full name and contact info are shown (privacy is not enabled for unclaimed rows)
      expect(html).toContain('Daan Dijkstra');
      expect(html).toContain(email);
      expect(html).toContain('+31633334444');
      expect(html).toContain('10 Apr');
      expect(html).toContain('Singel 50, Amsterdam');

      // Negative assertions: Attendance, Payments, and Archive sections do NOT render
      expect(html).not.toContain('>Attendance</h2>');
      expect(html).not.toContain('>Payments</h2>');
      expect(html).not.toContain('Archive student');
      expect(html).not.toContain('Unarchive student');
    });
  });

  describe('attendance and payment history', () => {
    it('renders empty history messages when student has no registrations or payments', async () => {
      const email = `empty-history-${suffix}@test.local`;
      const student = await prisma.student.create({
        data: {
          firstName: 'Eva',
          lastName: 'Evers',
          email,
          account: { create: { email } },
          claimedAt: new Date(),
        },
      });
      await prisma.teacherStudent.create({
        data: { teacherId, studentId: student.id },
      });

      const res = await studentPage(student.id);
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain('>Attendance</h2>');
      expect(html).toContain('No class history.');
      expect(html).toContain('>Payments</h2>');
      expect(html).toContain('No payment history.');
    });

    it('renders populated class history with date, time, and humanized status', async () => {
      const email = `populated-history-${suffix}@test.local`;
      const student = await prisma.student.create({
        data: {
          firstName: 'Finn',
          lastName: 'Faber',
          email,
          account: { create: { email } },
          claimedAt: new Date(),
        },
      });
      await prisma.teacherStudent.create({
        data: { teacherId, studentId: student.id },
      });

      const classDate = new Date('2026-06-12T00:00:00.000Z');
      const cls = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        classType: 'Morning Vinyasa Flow',
        date: classDate,
        startTime: hhmmToTime('09:15'),
        durationMinutes: 75,
        roomCost: 20,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 10,
        status: 'completed',
      });

      const registration = await prisma.registration.create({
        data: {
          classId: cls.id,
          studentId: student.id,
          status: 'attended',
          tierAtBooking: 2,
        },
      });

      await prisma.payment.create({
        data: {
          registrationId: registration.id,
          amount: 18.5,
          status: 'paid',
          paidAt: new Date(),
        },
      });

      const res = await studentPage(student.id);
      expect(res.status).toBe(200);
      const html = await res.text();

      // Attendance history assertion: classType, formatted date & time, status
      expect(html).toContain('Morning Vinyasa Flow');
      // formatDateWithYear: "12 Jun 2026"
      expect(html).toContain(formatDateWithYear(classDate));
      expect(html).toContain('12 Jun 2026');
      expect(html).toContain('09:15');
      expect(html).toMatch(/12 Jun 2026.*·.*09:15/);
      expect(html).toContain('attended');

      // Payment history assertion
      expect(html).toContain('18.50');
      expect(html).toContain('Paid');
    });
  });

  describe('multi-teacher registration & payment isolation', () => {
    it('isolates registrations and payments so Teacher 1 never sees Teacher 2 data', async () => {
      const email = `shared-student-${suffix}@test.local`;
      const student = await prisma.student.create({
        data: {
          firstName: 'Gijs',
          lastName: 'Groot',
          email,
          account: { create: { email } },
          claimedAt: new Date(),
        },
      });
      // Link student to both teachers
      await prisma.teacherStudent.createMany({
        data: [
          { teacherId, studentId: student.id },
          { teacherId: otherTeacherId, studentId: student.id },
        ],
      });

      // Teacher 1's class
      const cls1 = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        classType: 'Teacher One Exclusive Class',
        date: new Date('2026-07-01T00:00:00.000Z'),
        startTime: hhmmToTime('10:00'),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 12,
        targetRate: 22,
        minStudents: 1,
        maxStudents: 8,
        status: 'completed',
      });
      const reg1 = await prisma.registration.create({
        data: { classId: cls1.id, studentId: student.id, status: 'attended', tierAtBooking: 2 },
      });
      await prisma.payment.create({
        data: { registrationId: reg1.id, amount: 22.0, status: 'paid' },
      });

      // Teacher 2's class
      const cls2 = await createClassFixture(prisma, {
        teacherId: otherTeacherId,
        teacherRoomId: otherTeacherRoomId,
        classType: 'Teacher Two Secret Class',
        date: new Date('2026-07-02T00:00:00.000Z'),
        startTime: hhmmToTime('11:00'),
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 6,
        status: 'completed',
      });
      const reg2 = await prisma.registration.create({
        data: { classId: cls2.id, studentId: student.id, status: 'attended', tierAtBooking: 3 },
      });
      await prisma.payment.create({
        data: { registrationId: reg2.id, amount: 99.99, status: 'paid' },
      });

      // When Teacher 1 views the student detail page:
      const res1 = await studentPage(student.id, teacherToken);
      expect(res1.status).toBe(200);
      const html1 = await res1.text();

      // Teacher 1 sees their own class and payment
      expect(html1).toContain('Teacher One Exclusive Class');
      expect(html1).toContain('22.00');

      // Teacher 1 does NOT see Teacher 2's class or payment
      expect(html1).not.toContain('Teacher Two Secret Class');
      expect(html1).not.toContain('99.99');

      // When Teacher 2 views the student detail page:
      const res2 = await studentPage(student.id, otherTeacherToken);
      expect(res2.status).toBe(200);
      const html2 = await res2.text();

      expect(html2).toContain('Teacher Two Secret Class');
      expect(html2).toContain('99.99');
      expect(html2).not.toContain('Teacher One Exclusive Class');
      expect(html2).not.toContain('22.00');
    });
  });

  describe('archival state', () => {
    it('renders "All students" back link and "Archive student" button for active student', async () => {
      const email = `active-student-${suffix}@test.local`;
      const student = await prisma.student.create({
        data: {
          firstName: 'Hugo',
          lastName: 'Hendriks',
          email,
          account: { create: { email } },
          claimedAt: new Date(),
        },
      });
      await prisma.teacherStudent.create({
        data: { teacherId, studentId: student.id, isArchived: false },
      });

      const res = await studentPage(student.id);
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain('href="/students"');
      expect(html).toContain('All students');
      expect(html).toContain('Archive student');
    });

    it('renders "Archived students" back link and "Unarchive student" button for archived student', async () => {
      const email = `archived-student-${suffix}@test.local`;
      const student = await prisma.student.create({
        data: {
          firstName: 'Iris',
          lastName: 'Ivens',
          email,
          account: { create: { email } },
          claimedAt: new Date(),
        },
      });
      await prisma.teacherStudent.create({
        data: { teacherId, studentId: student.id, isArchived: true },
      });

      const res = await studentPage(student.id);
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain('href="/students/archived"');
      expect(html).toContain('Archived students');
      expect(html).toContain('Unarchive student');
    });
  });
});
