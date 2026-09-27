import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  PrismaClient,
  type ClassStatus,
  type PaymentStatus,
  type RegistrationStatus,
} from '@prisma/client';
import { archiveStudent, type ArchiveOutcome } from './student-archive';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture, slotDate } from '../../tests/class-fixtures';

const prisma = new PrismaClient();
const suffix = Date.now();

/** The code a refused outcome carries; throws, naming the outcome, otherwise. */
function refusalCode(outcome: ArchiveOutcome): string {
  if (outcome.kind !== 'refused') {
    throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
  }
  return outcome.refusal.code;
}

describe('archiveStudent (DB)', () => {
  let teacherId: string | undefined;
  let otherTeacherId: string | undefined;
  let roomId: string | undefined;
  let teacherRoomId: string;
  let otherTeacherRoomId: string;
  // Every row below is collected as it is made, so teardown deletes by
  // `in: [...]` — an empty list matches nothing, where an unassigned id
  // would match everything.
  const studentIds: string[] = [];
  const entryIds: string[] = [];
  let slot = 0;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Archive',
        lastName: 'Teacher',
        email: `archive-teacher-${suffix}@test.local`,
        account: { create: { email: `archive-teacher-${suffix}@test.local` } },
        bio: 'Test teacher for archiveStudent',
        pageSlug: `archive-teacher-${suffix}`,
      },
    });
    teacherId = teacher.id;

    const other = await prisma.teacher.create({
      data: {
        firstName: 'Archive',
        lastName: 'Other',
        email: `archive-other-${suffix}@test.local`,
        account: { create: { email: `archive-other-${suffix}@test.local` } },
        bio: 'Scoping fixture: a second teacher of the same student',
        pageSlug: `archive-other-${suffix}`,
      },
    });
    otherTeacherId = other.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Archive Studio',
        address: `${suffix} Archive St`,
        city: 'Amsterdam',
        postcode: '1234AR',
        maxCapacity: 20,
        createdById: teacher.id,
      },
    });
    roomId = room.id;
    teacherRoomId = (
      await prisma.teacherRoom.create({
        data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 15, rentalRate: 30 },
      })
    ).id;
    otherTeacherRoomId = (
      await prisma.teacherRoom.create({
        data: { teacherId: other.id, roomId: room.id, capacityOverride: 15, rentalRate: 30 },
      })
    ).id;
  });

  afterAll(async () => {
    // Registrations and payments cascade off the entry's class and the student.
    await prisma.calendarEntry.deleteMany({ where: { id: { in: entryIds } } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    if (roomId) {
      await prisma.teacherRoom.deleteMany({ where: { roomId } });
      await prisma.room.delete({ where: { id: roomId } });
    }
    if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
    if (otherTeacherId) await prisma.teacher.delete({ where: { id: otherTeacherId } });
    await prisma.account.deleteMany({
      where: {
        email: { in: [`archive-teacher-${suffix}@test.local`, `archive-other-${suffix}@test.local`] },
      },
    });
    await prisma.$disconnect();
  });

  function owner(which: 'this' | 'other'): { teacherId: string; teacherRoomId: string } {
    const id = which === 'this' ? teacherId : otherTeacherId;
    if (!id) throw new Error('fixture teacher missing: beforeAll failed');
    return { teacherId: id, teacherRoomId: which === 'this' ? teacherRoomId : otherTeacherRoomId };
  }

  /** A fresh student, linked to this suite's teacher unless `linked` is false. */
  async function newStudent(linked = true): Promise<string> {
    const n = studentIds.length;
    const student = await prisma.student.create({
      data: { firstName: `Archive${n}`, lastName: 'Student', email: `archive-student-${suffix}-${n}@test.local` },
    });
    studentIds.push(student.id);
    if (linked) {
      await prisma.teacherStudent.create({ data: { teacherId: owner('this').teacherId, studentId: student.id } });
    }
    return student.id;
  }

  /** One class, on a slot of its own so no two fixtures of a teacher overlap. */
  async function makeClass(
    status: ClassStatus,
    opts: { who?: 'this' | 'other'; cancelled?: boolean } = {},
  ): Promise<string> {
    const n = slot++;
    const cls = await createClassFixture(prisma, {
      ...owner(opts.who ?? 'this'),
      classType: 'Hatha',
      // Completed classes in the past, live ones in the future.
      date: slotDate(status === 'completed' ? '2025-01-01' : '2030-01-01', n),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 30,
      minRate: 15,
      targetRate: 25,
      minStudents: 2,
      maxStudents: 10,
      status,
      settingsLocked: true,
      cancelledAt: opts.cancelled ? new Date() : null,
    });
    entryIds.push(cls.calendarEntry.id);
    return cls.id;
  }

  async function register(classId: string, studentId: string, status: RegistrationStatus): Promise<string> {
    const reg = await prisma.registration.create({
      data: { classId, studentId, status, tierAtBooking: 3, price: 12.1, tierRatio: 1.0 },
    });
    return reg.id;
  }

  /** A class of `status`, not completed, with `studentId` registered as `regStatus`. */
  async function liveClass(
    studentId: string,
    status: ClassStatus,
    regStatus: RegistrationStatus = 'registered',
    opts: { cancelled?: boolean } = {},
  ): Promise<void> {
    await register(await makeClass(status, opts), studentId, regStatus);
  }

  /** A completed class the student attended, and its payment in `paymentStatus`. Returns the payment id. */
  async function completedClassWithPayment(
    studentId: string,
    paymentStatus: PaymentStatus,
    who: 'this' | 'other' = 'this',
  ): Promise<string> {
    const registrationId = await register(await makeClass('completed', { who }), studentId, 'attended');
    const payment = await prisma.payment.create({
      data: { registrationId, amount: 12.1, status: paymentStatus },
    });
    return payment.id;
  }

  async function isArchived(studentId: string): Promise<boolean> {
    const link = await prisma.teacherStudent.findUniqueOrThrow({
      where: { teacherId_studentId: { teacherId: owner('this').teacherId, studentId } },
    });
    return link.isArchived;
  }

  async function paymentStatuses(ids: string[]): Promise<PaymentStatus[]> {
    const rows = await prisma.payment.findMany({ where: { id: { in: ids } } });
    return ids.map((id) => {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error(`payment ${id} missing`);
      return row.status;
    });
  }

  const archive = (studentId: string, waivePaymentIds?: readonly string[]) =>
    archiveStudent(prisma, { teacherId: owner('this').teacherId, studentId, waivePaymentIds });

  it('archives a student with nothing live', async () => {
    const studentId = await newStudent();

    expect(await archive(studentId)).toEqual({ kind: 'archived', waivedCount: 0 });
    expect(await isArchived(studentId)).toBe(true);
  });

  it('refuses while the student is registered on an open class', async () => {
    const studentId = await newStudent();
    await liveClass(studentId, 'open');

    expect(refusalCode(await archive(studentId))).toBe('STUDENT_HAS_UNBILLED_CLASSES');
    expect(await isArchived(studentId)).toBe(false);
  });

  it('refuses on a late cancellation too, since completion still bills it', async () => {
    const studentId = await newStudent();
    await liveClass(studentId, 'open', 'late_cancel');

    expect(refusalCode(await archive(studentId))).toBe('STUDENT_HAS_UNBILLED_CLASSES');
    expect(await isArchived(studentId)).toBe(false);
  });

  it('archives past a registration on a cancelled class', async () => {
    const studentId = await newStudent();
    await liveClass(studentId, 'open', 'registered', { cancelled: true });

    expect(await archive(studentId)).toEqual({ kind: 'archived', waivedCount: 0 });
    expect(await isArchived(studentId)).toBe(true);
  });

  it('archives past a completed class whose payment is paid', async () => {
    const studentId = await newStudent();
    const paid = await completedClassWithPayment(studentId, 'paid');

    expect(await archive(studentId)).toEqual({ kind: 'archived', waivedCount: 0 });
    expect(await isArchived(studentId)).toBe(true);
    expect(await paymentStatuses([paid])).toEqual(['paid']);
  });

  it.each(['pending', 'overdue'] as const)('refuses while a payment is %s', async (status) => {
    const studentId = await newStudent();
    const open = await completedClassWithPayment(studentId, status);

    expect(refusalCode(await archive(studentId))).toBe('STUDENT_HAS_OUTSTANDING_PAYMENTS');
    expect(await isArchived(studentId)).toBe(false);
    expect(await paymentStatuses([open])).toEqual([status]);
  });

  it('names the unbilled classes first when there is also a payment open', async () => {
    const studentId = await newStudent();
    await liveClass(studentId, 'open');
    const open = await completedClassWithPayment(studentId, 'pending');

    expect(refusalCode(await archive(studentId, [open]))).toBe('STUDENT_HAS_UNBILLED_CLASSES');
    expect(await isArchived(studentId)).toBe(false);
    expect(await paymentStatuses([open])).toEqual(['pending']);
  });

  it('waives exactly the open set it is shown, and archives', async () => {
    const studentId = await newStudent();
    const a = await completedClassWithPayment(studentId, 'pending');
    const b = await completedClassWithPayment(studentId, 'overdue');

    expect(await archive(studentId, [b, a])).toEqual({ kind: 'archived', waivedCount: 2 });
    expect(await isArchived(studentId)).toBe(true);
    const rows = await prisma.payment.findMany({ where: { id: { in: [a, b] } } });
    expect(rows.map((r) => [r.status, r.notChargedAt !== null])).toEqual([
      ['not_charged', true],
      ['not_charged', true],
    ]);
  });

  it('refuses a waive naming only part of the open set, writing nothing', async () => {
    const studentId = await newStudent();
    const a = await completedClassWithPayment(studentId, 'pending');
    const b = await completedClassWithPayment(studentId, 'pending');

    expect(refusalCode(await archive(studentId, [a]))).toBe('STUDENT_HAS_OUTSTANDING_PAYMENTS');
    expect(await isArchived(studentId)).toBe(false);
    expect(await paymentStatuses([a, b])).toEqual(['pending', 'pending']);
  });

  it("refuses a waive that names another teacher's payment, leaving it untouched", async () => {
    const studentId = await newStudent();
    const a = await completedClassWithPayment(studentId, 'pending');
    const b = await completedClassWithPayment(studentId, 'pending');
    const foreign = await completedClassWithPayment(studentId, 'pending', 'other');

    expect(refusalCode(await archive(studentId, [a, b, foreign]))).toBe('STUDENT_HAS_OUTSTANDING_PAYMENTS');
    expect(await isArchived(studentId)).toBe(false);
    expect(await paymentStatuses([a, b, foreign])).toEqual(['pending', 'pending', 'pending']);
  });

  it('refuses a waive that also names a paid payment of the pair', async () => {
    const studentId = await newStudent();
    const a = await completedClassWithPayment(studentId, 'pending');
    const b = await completedClassWithPayment(studentId, 'pending');
    const paid = await completedClassWithPayment(studentId, 'paid');

    expect(refusalCode(await archive(studentId, [a, b, paid]))).toBe('STUDENT_HAS_OUTSTANDING_PAYMENTS');
    expect(await isArchived(studentId)).toBe(false);
    expect(await paymentStatuses([a, b, paid])).toEqual(['pending', 'pending', 'paid']);
  });

  it('refuses a waive whose set shrank because one payment was paid before the call', async () => {
    const studentId = await newStudent();
    const a = await completedClassWithPayment(studentId, 'pending');
    const b = await completedClassWithPayment(studentId, 'pending');
    // What the teacher saw was {a, b}; b is paid before the confirm lands.
    await prisma.payment.update({ where: { id: b }, data: { status: 'paid', paidAt: new Date() } });

    expect(refusalCode(await archive(studentId, [a, b]))).toBe('STUDENT_HAS_OUTSTANDING_PAYMENTS');
    expect(await isArchived(studentId)).toBe(false);
    expect(await paymentStatuses([a, b])).toEqual(['pending', 'paid']);
  });

  it('archives when a waive names payments that have all been paid since, waiving nothing', async () => {
    const studentId = await newStudent();
    const a = await completedClassWithPayment(studentId, 'pending');
    await prisma.payment.update({ where: { id: a }, data: { status: 'paid', paidAt: new Date() } });

    expect(await archive(studentId, [a])).toEqual({ kind: 'archived', waivedCount: 0 });
    expect(await isArchived(studentId)).toBe(true);
    expect(await paymentStatuses([a])).toEqual(['paid']);
  });

  it('answers unchanged for an archived link, ignoring any waive it carries', async () => {
    const studentId = await newStudent();
    await prisma.teacherStudent.update({
      where: { teacherId_studentId: { teacherId: owner('this').teacherId, studentId } },
      data: { isArchived: true },
    });
    const open = await completedClassWithPayment(studentId, 'pending');

    expect(await archive(studentId, [open])).toEqual({ kind: 'unchanged' });
    expect(await isArchived(studentId)).toBe(true);
    expect(await paymentStatuses([open])).toEqual(['pending']);
  });

  it('answers not-linked for a student with no link to this teacher', async () => {
    const studentId = await newStudent(false);

    expect(await archive(studentId)).toEqual({ kind: 'not-linked' });
    expect(
      await prisma.teacherStudent.count({ where: { teacherId: owner('this').teacherId, studentId } }),
    ).toBe(0);
  });

  it("archives past an open payment owed to another teacher: the pair is the scope", async () => {
    const studentId = await newStudent();
    const foreign = await completedClassWithPayment(studentId, 'pending', 'other');

    expect(await archive(studentId)).toEqual({ kind: 'archived', waivedCount: 0 });
    expect(await isArchived(studentId)).toBe(true);
    expect(await paymentStatuses([foreign])).toEqual(['pending']);
  });
});
