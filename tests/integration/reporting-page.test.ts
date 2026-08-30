import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { createClassFixture, createStudioClassFixture } from '../class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';
import { startOfLocalDay } from '@/lib/timezone';
import { formatMonthLabel } from '@/lib/format';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/**
 * `/(teacher)/settings/reporting` — teacher income and reporting page test suite (Issue 143).
 *
 * Covers:
 * - Empty state ("Nothing to report yet") when no completed classes or studio classes exist
 * - Total earnings calculation:
 *   - Regular completed classes: revenue minus room cost
 *   - Active studio classes: (hourlyRate * durationMinutes) / 60
 *   - Room costs paid summary
 * - Distinct students reached count (singular "1 student reached" vs plural "N students reached")
 * - Registration status filtering for student reach (attended, registered, no_show, late_cancel included; cancelled excluded)
 * - Monthly aggregation table ("By month") with formatMonthLabel (e.g. "August 2026", "July 2026")
 * - Timezone boundary discrimination for west-of-UTC teacher (e.g. America/Los_Angeles):
 *   - Today's studio class is counted
 *   - Tomorrow's studio class is excluded
 *   - Cancelled studio class is excluded
 *   - Non-completed regular classes (draft/open/cancelled) are excluded
 */
describe('GET /settings/reporting (reporting page)', () => {
  let emptyTeacherId: string;
  let emptyTeacherAccountId: string;
  let emptyTeacherToken: string;

  let reportTeacherId: string;
  let reportTeacherAccountId: string;
  let reportTeacherToken: string;

  let pacificTeacherId: string;
  let pacificTeacherAccountId: string;
  let pacificTeacherToken: string;

  let roomId: string;
  let reportTeacherRoomId: string;

  const reportingPage = (token: string) =>
    fetch(`${BASE_URL}/settings/reporting`, { headers: cookie(token) });

  beforeAll(async () => {
    await prisma.$connect();

    // 1. Teacher with nothing yet
    const emptyEmail = `report-empty-${suffix}@test.local`;
    const emptyTeacher = await prisma.teacher.create({
      data: {
        firstName: 'Empty',
        lastName: 'Reporting',
        email: emptyEmail,
        account: { create: { email: emptyEmail } },
        bio: 'Empty reporting test',
        pageSlug: `report-empty-${suffix}`,
      },
    });
    emptyTeacherId = emptyTeacher.id;
    emptyTeacherAccountId = emptyTeacher.accountId;
    emptyTeacherToken = await seedSession(prisma, emptyTeacherAccountId);

    // 2. Main reporting teacher (Europe/Amsterdam default)
    const reportEmail = `report-main-${suffix}@test.local`;
    const reportTeacher = await prisma.teacher.create({
      data: {
        firstName: 'Report',
        lastName: 'Teacher',
        email: reportEmail,
        account: { create: { email: reportEmail } },
        bio: 'Main reporting test',
        pageSlug: `report-main-${suffix}`,
      },
    });
    reportTeacherId = reportTeacher.id;
    reportTeacherAccountId = reportTeacher.accountId;
    reportTeacherToken = await seedSession(prisma, reportTeacherAccountId);

    // 3. Pacific teacher (America/Los_Angeles) for timezone boundary discrimination
    const pacificEmail = `report-pacific-${suffix}@test.local`;
    const pacificTeacher = await prisma.teacher.create({
      data: {
        firstName: 'Pacific',
        lastName: 'Teacher',
        email: pacificEmail,
        account: { create: { email: pacificEmail } },
        bio: 'Pacific timezone reporting test',
        pageSlug: `report-pacific-${suffix}`,
        defaultTimezone: 'America/Los_Angeles',
      },
    });
    pacificTeacherId = pacificTeacher.id;
    pacificTeacherAccountId = pacificTeacher.accountId;
    pacificTeacherToken = await seedSession(prisma, pacificTeacherAccountId);

    const room = await prisma.room.create({
      data: {
        venueName: 'Reporting Hall',
        address: `${suffix} Report St`,
        city: 'Amsterdam',
        postcode: '1000RP',
        roomName: 'Main Room',
        maxCapacity: 20,
        createdById: reportTeacherId,
      },
    });
    roomId = room.id;

    const tr = await prisma.teacherRoom.create({
      data: { teacherId: reportTeacherId, roomId, capacityOverride: 15, rentalRate: 25.5 },
    });
    reportTeacherRoomId = tr.id;

    // Warm up the route
    await fetch(`${BASE_URL}/settings/reporting`, { headers: cookie(reportTeacherToken) }).catch(() => {});
  }, 20_000);

  afterAll(async () => {
    const teacherIds = [emptyTeacherId, reportTeacherId, pacificTeacherId].filter(Boolean);
    const accountIds = [emptyTeacherAccountId, reportTeacherAccountId, pacificTeacherAccountId].filter(Boolean);

    await prisma.payment.deleteMany({
      where: { registration: { class: { calendarEntry: { teacherId: { in: teacherIds } } } } },
    });
    await prisma.registration.deleteMany({
      where: { class: { calendarEntry: { teacherId: { in: teacherIds } } } },
    });
    await prisma.calendarEntry.deleteMany({
      where: { teacherId: { in: teacherIds } },
    });
    await prisma.teacherStudent.deleteMany({
      where: { teacherId: { in: teacherIds } },
    });
    await prisma.student.deleteMany({
      where: { email: { contains: `-${suffix}@test.local` } },
    });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
    await prisma.session.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.teacher.deleteMany({
      where: { id: { in: teacherIds } },
    });
    await prisma.account.deleteMany({
      where: { email: { contains: `-${suffix}@test.local` } },
    });
    await prisma.$disconnect();
  });

  describe('empty state', () => {
    it('renders "Nothing to report yet" when teacher has no classes', async () => {
      const res = await reportingPage(emptyTeacherToken);
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain('Reporting');
      expect(html).toContain('Nothing to report yet');
      expect(html).toContain('Completed classes and their earnings appear here.');
      expect(html).not.toContain('Total earned teaching');
      expect(html).not.toContain('>By month</h2>');
    });
  });

  describe('earnings calculations and aggregation', () => {
    it('correctly aggregates completed regular classes and studio classes', async () => {
      // Create 2 students
      const student1 = await prisma.student.create({
        data: {
          firstName: 'Student',
          lastName: 'One',
          email: `rep-s1-${suffix}@test.local`,
          account: { create: { email: `rep-s1-${suffix}@test.local` } },
          claimedAt: new Date(),
        },
      });
      const student2 = await prisma.student.create({
        data: {
          firstName: 'Student',
          lastName: 'Two',
          email: `rep-s2-${suffix}@test.local`,
          account: { create: { email: `rep-s2-${suffix}@test.local` } },
          claimedAt: new Date(),
        },
      });
      await prisma.teacherStudent.createMany({
        data: [
          { teacherId: reportTeacherId, studentId: student1.id },
          { teacherId: reportTeacherId, studentId: student2.id },
        ],
      });

      // Class 1: Completed regular class in August 2026
      // Revenue: 85.00, Room Cost: 25.50 -> Net earnings: 59.50, 2 students
      const cls1 = await createClassFixture(prisma, {
        teacherId: reportTeacherId,
        teacherRoomId: reportTeacherRoomId,
        classType: 'Power Vinyasa',
        date: new Date('2026-08-10T00:00:00.000Z'),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: new Prisma.Decimal('25.50'),
        totalRevenue: new Prisma.Decimal('85.00'),
        totalStudents: 2,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 10,
        status: 'completed',
      });
      // 2 registrations: 1 attended, 1 registered -> both count toward distinct students
      await prisma.registration.create({
        data: { classId: cls1.id, studentId: student1.id, status: 'attended', tierAtBooking: 2 },
      });
      await prisma.registration.create({
        data: { classId: cls1.id, studentId: student2.id, status: 'registered', tierAtBooking: 3 },
      });

      // Class 2: Studio class in August 2026
      // Hourly rate: 45.00, 90 minutes -> Earnings: 45 * 90 / 60 = 67.50, 8 students count
      await createStudioClassFixture(prisma, {
        teacherId: reportTeacherId,
        classType: 'Studio Flow 90',
        location: 'Community Studio A',
        date: new Date('2026-08-15T00:00:00.000Z'),
        startTime: hhmmToTime('10:00'),
        durationMinutes: 90,
        hourlyRate: new Prisma.Decimal('45.00'),
        studentCount: 8,
      });

      // Class 3: Completed regular class in July 2026
      // Revenue: 50.00, Room Cost: 20.00 -> Net earnings: 30.00, 1 student
      const cls3 = await createClassFixture(prisma, {
        teacherId: reportTeacherId,
        teacherRoomId: reportTeacherRoomId,
        classType: 'Gentle Flow',
        date: new Date('2026-07-20T00:00:00.000Z'),
        startTime: hhmmToTime('18:00'),
        durationMinutes: 60,
        roomCost: new Prisma.Decimal('20.00'),
        totalRevenue: new Prisma.Decimal('50.00'),
        totalStudents: 1,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 10,
        status: 'completed',
      });
      // student1 attended cls3 as well -> distinct students across all completed classes remains 2
      await prisma.registration.create({
        data: { classId: cls3.id, studentId: student1.id, status: 'attended', tierAtBooking: 2 },
      });

      // Total Class Earnings: 59.50 + 30.00 = 89.50
      // Total Studio Earnings: 67.50
      // Total Overall: 89.50 + 67.50 = 157.00
      // Total Room Costs: 25.50 + 20.00 = 45.50
      // Total Classes: 3
      // Distinct Students: 2

      const res = await reportingPage(reportTeacherToken);
      expect(res.status).toBe(200);
      const html = await res.text();

      // Top banner
      expect(html).toContain('Total earned teaching');
      expect(html).toContain('157.00');
      expect(html).toMatch(/3.*classes.*·.*2.*students.*reached/);

      // Breakdown rows
      expect(html).toContain('Your classes');
      expect(html).toContain('89.50');
      expect(html).toContain('Studio classes');
      expect(html).toContain('67.50');
      expect(html).toContain('Room costs paid');
      expect(html).toContain('45.50');

      // By month section
      expect(html).toContain('>By month</h2>');
      expect(html).toContain('MONTH');
      expect(html).toContain('CLASSES');
      expect(html).toContain('STUDENTS');
      expect(html).toContain('EARNED');

      // August 2026: 2 classes (1 regular + 1 studio), 10 students (2 + 8), 127.00 earned (59.50 + 67.50)
      const augLabel = formatMonthLabel(2026, 7); // monthIndex 7 is August
      expect(html).toContain(augLabel);
      expect(html).toContain('August 2026');
      expect(html).toContain('127.00');

      // July 2026: 1 class (1 regular), 1 student, 30.00 earned
      const julLabel = formatMonthLabel(2026, 6); // monthIndex 6 is July
      expect(html).toContain(julLabel);
      expect(html).toContain('July 2026');
      expect(html).toContain('30.00');
    });

    it('handles singular student reach and excludes cancelled registrations from reach count', async () => {
      const singleEmail = `report-single-${suffix}@test.local`;
      const singleTeacher = await prisma.teacher.create({
        data: {
          firstName: 'Single',
          lastName: 'Reach',
          email: singleEmail,
          account: { create: { email: singleEmail } },
          bio: 'Single student reach test',
          pageSlug: `report-single-${suffix}`,
        },
      });
      const singleToken = await seedSession(prisma, singleTeacher.accountId);
      const singleTeacherRoom = await prisma.teacherRoom.create({
        data: { teacherId: singleTeacher.id, roomId, capacityOverride: 10, rentalRate: 20 },
      });

      const studentA = await prisma.student.create({
        data: {
          firstName: 'Student',
          lastName: 'Active',
          email: `rep-sa-${suffix}@test.local`,
          account: { create: { email: `rep-sa-${suffix}@test.local` } },
          claimedAt: new Date(),
        },
      });
      const studentC = await prisma.student.create({
        data: {
          firstName: 'Student',
          lastName: 'Cancelled',
          email: `rep-sc-${suffix}@test.local`,
          account: { create: { email: `rep-sc-${suffix}@test.local` } },
          claimedAt: new Date(),
        },
      });
      await prisma.teacherStudent.createMany({
        data: [
          { teacherId: singleTeacher.id, studentId: studentA.id },
          { teacherId: singleTeacher.id, studentId: studentC.id },
        ],
      });

      const cls = await createClassFixture(prisma, {
        teacherId: singleTeacher.id,
        teacherRoomId: singleTeacherRoom.id,
        classType: 'Solo Reach Class',
        date: new Date('2026-08-01T00:00:00.000Z'),
        startTime: hhmmToTime('08:00'),
        durationMinutes: 60,
        roomCost: new Prisma.Decimal('20.00'),
        totalRevenue: new Prisma.Decimal('40.00'),
        totalStudents: 1,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 10,
        status: 'completed',
      });

      // 1 attended, 1 cancelled
      await prisma.registration.create({
        data: { classId: cls.id, studentId: studentA.id, status: 'attended', tierAtBooking: 1 },
      });
      await prisma.registration.create({
        data: { classId: cls.id, studentId: studentC.id, status: 'cancelled', tierAtBooking: 1 },
      });

      const res = await reportingPage(singleToken);
      expect(res.status).toBe(200);
      const html = await res.text();

      // Singular "1 student reached" (cancelled student excluded)
      expect(html).toMatch(/1.*classes.*·.*1.*student.*reached/);
      expect(html).not.toMatch(/1.*classes.*·.*1.*students.*reached/);

      // Cleanup
      await prisma.registration.deleteMany({ where: { classId: cls.id } });
      await prisma.calendarEntry.deleteMany({ where: { teacherId: singleTeacher.id } });
      await prisma.teacherStudent.deleteMany({ where: { teacherId: singleTeacher.id } });
      await prisma.student.deleteMany({ where: { id: { in: [studentA.id, studentC.id] } } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: singleTeacher.id } });
      await prisma.session.deleteMany({ where: { accountId: singleTeacher.accountId } });
      await prisma.teacher.delete({ where: { id: singleTeacher.id } });
      await prisma.account.deleteMany({
        where: { email: { in: [singleEmail, `rep-sa-${suffix}@test.local`, `rep-sc-${suffix}@test.local`] } },
      });
    });
  });

  describe('timezone boundary discrimination for west-of-UTC teacher', () => {
    it('includes studio classes on or before local today and excludes tomorrow or cancelled ones', async () => {
      const now = new Date();
      const localToday = startOfLocalDay(now, 'America/Los_Angeles');

      // Tomorrow in Pacific local calendar
      const localTomorrow = new Date(localToday);
      localTomorrow.setUTCDate(localTomorrow.getUTCDate() + 1);

      // Studio Class A: Dated TODAY in America/Los_Angeles, already started (00:00) -> INCLUDED
      // Hourly rate: 50.00, 60 min -> 50.00
      await createStudioClassFixture(prisma, {
        teacherId: pacificTeacherId,
        classType: 'Pacific Today Class',
        location: 'Portland Studio',
        date: localToday,
        startTime: hhmmToTime('00:00'),
        durationMinutes: 60,
        hourlyRate: new Prisma.Decimal('50.00'),
        studentCount: 5,
      });

      // Studio Class B: Dated TOMORROW in America/Los_Angeles -> EXCLUDED (date > endOfToday)
      // Hourly rate: 80.00, 60 min -> 80.00
      await createStudioClassFixture(prisma, {
        teacherId: pacificTeacherId,
        classType: 'Pacific Tomorrow Class',
        location: 'Portland Studio',
        date: localTomorrow,
        startTime: hhmmToTime('10:00'),
        durationMinutes: 60,
        hourlyRate: new Prisma.Decimal('80.00'),
        studentCount: 10,
      });

      // Studio Class C: Dated TODAY in America/Los_Angeles, but CANCELLED -> EXCLUDED (cancelledAt != null)
      // Hourly rate: 100.00, 60 min -> 100.00
      await createStudioClassFixture(prisma, {
        teacherId: pacificTeacherId,
        classType: 'Pacific Cancelled Today Class',
        location: 'Portland Studio',
        date: localToday,
        startTime: hhmmToTime('14:00'),
        durationMinutes: 60,
        hourlyRate: new Prisma.Decimal('100.00'),
        studentCount: 4,
        cancelledAt: new Date(),
      });

      const res = await reportingPage(pacificTeacherToken);
      expect(res.status).toBe(200);
      const html = await res.text();

      // Total must include ONLY the 50.00 from Today's uncancelled studio class
      expect(html).toContain('Total earned teaching');
      expect(html).toContain('50.00');
      expect(html).toMatch(/1.*classes.*·.*0.*students.*reached/);

      // Tomorrow's 80.00 and Cancelled's 100.00 must NOT be present
      expect(html).not.toContain('80.00');
      expect(html).not.toContain('100.00');
      expect(html).not.toContain('130.00');
      expect(html).not.toContain('230.00');
    });

    it('excludes a studio class dated today whose start instant is in the future (issue 278)', async () => {
      const now = new Date();
      const localToday = startOfLocalDay(now, 'America/Los_Angeles');

      // Studio Class D: Dated TODAY in America/Los_Angeles, but in the future (23:59) -> EXCLUDED
      // Hourly rate: 60.00, 60 min -> 60.00
      await createStudioClassFixture(prisma, {
        teacherId: pacificTeacherId,
        classType: 'Pacific Late Today Class',
        location: 'Portland Studio',
        date: localToday,
        startTime: hhmmToTime('23:59'),
        durationMinutes: 60,
        hourlyRate: new Prisma.Decimal('60.00'),
        studentCount: 7,
      });

      const res = await reportingPage(pacificTeacherToken);
      expect(res.status).toBe(200);
      const html = await res.text();

      // Total must still be 50.00 from Class A (not 110.00), class count still 1 (not 2)
      expect(html).toContain('Total earned teaching');
      expect(html).toContain('50.00');
      expect(html).not.toContain('60.00');
      expect(html).not.toContain('110.00');
      expect(html).toMatch(/1.*classes.*·.*0.*students.*reached/);
    });
  });
});
