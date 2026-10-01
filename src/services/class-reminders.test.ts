import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  PrismaClient,
  type ClassStatus,
  type RegistrationStatus,
  type ReminderChannel,
  type ReminderTiming,
} from '@prisma/client';
import crypto from 'crypto';
import { processClassReminders, reminderCandidateDates } from './class-reminders';
import { hhmmToTime } from '@/lib/time-of-day';
import { log } from '@/lib/log';
import { createClassFixture, createStudioClassFixture } from '../../tests/class-fixtures';
import { scopeSweep } from '../../tests/scoped-sweep';

const sendMock = vi.hoisted(() => vi.fn());
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

vi.mock('@/lib/log', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const prisma = new PrismaClient();
const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let n = 0;

function sendsTo(email: string): number {
  return sendMock.mock.calls.filter(([args]) => args.to === email).length;
}

const START = new Date('2099-06-10T18:00:00Z');
const MORNING = new Date('2099-06-10T07:00:00Z');
const MINUTE = 60 * 1000;

describe('reminderCandidateDates', () => {
  it('spans two UTC days back to three forward, at midnight', () => {
    expect(reminderCandidateDates(new Date('2099-06-10T23:30:00Z'))).toEqual({
      from: new Date('2099-06-08T00:00:00Z'),
      to: new Date('2099-06-13T00:00:00Z'),
    });
  });
});

describe('processClassReminders (DB)', () => {
  const teacherIds: string[] = [];
  const accountIds: string[] = [];
  const roomIds: string[] = [];
  const classIds: string[] = [];
  const studentIds: string[] = [];

  const savedApiKey = process.env.RESEND_API_KEY;
  const savedDryRun = process.env.EMAIL_DRY_RUN;

  interface Fixture {
    teacherId: string;
    teacherEmail: string;
    classId: string;
    calendarEntryId: string;
  }

  /**
   * `base` with a hook that runs `between` once, after the sweep's candidate
   * `Class` read returns and before any claim — the read is a tick's worth of
   * sends old by the time a later class is claimed. Attached under the scope,
   * so it sees the sweep's own args.
   */
  function interposeAfterClassRead(f: Fixture, between: () => Promise<void>) {
    const state = { interposed: 0, sawFixture: false };
    const client = prisma.$extends({
      query: {
        class: {
          async findMany({ args, query }) {
            const rows = await query(args);
            if (state.interposed > 0) return rows;
            state.interposed += 1;
            state.sawFixture = rows.some((r) => r.id === f.classId);
            await between();
            return rows;
          },
        },
      },
      // `$extends` returns a client missing `$on`; every method used is the real one.
    }) as unknown as PrismaClient;
    return {
      state,
      sweep: (now: Date) =>
        processClassReminders(scopeSweep(client, { Class: { calendarEntry: { teacherId: f.teacherId } } }).db, now),
    };
  }

  /** A teacher of the test's own (UTC unless overridden), with one class on 2099-06-10 at 18:00. */
  async function seed(
    teacherOverrides: Partial<{
      classReminder: ReminderTiming;
      classReminderChannel: ReminderChannel;
      defaultTimezone: string;
    }> = {},
    classOverrides: Partial<{ status: ClassStatus; cancelledAt: Date }> = {},
  ): Promise<Fixture> {
    const k = n++;
    const teacherEmail = `classrem-teacher-${uniqueSuffix}-${k}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Remy',
        lastName: 'Teacher',
        email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: 'Class reminder tests',
        pageSlug: `classrem-teacher-${uniqueSuffix}-${k}`,
        defaultTimezone: 'UTC',
        ...teacherOverrides,
      },
    });
    teacherIds.push(teacher.id);
    if (teacher.accountId !== null) accountIds.push(teacher.accountId);

    const room = await prisma.room.create({
      data: {
        venueName: 'ClassRem Studio',
        address: `${uniqueSuffix}-${k} ClassRem St`,
        city: 'Amsterdam',
        postcode: '1234CR',
        maxCapacity: 20,
        createdById: teacher.id,
      },
    });
    roomIds.push(room.id);
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 15, rentalRate: 30 },
    });

    const cls = await createClassFixture(prisma, {
      teacherId: teacher.id,
      teacherRoomId: teacherRoom.id,
      classType: 'Flow',
      date: new Date('2099-06-10'),
      startTime: hhmmToTime('18:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 12,
      status: classOverrides.status ?? 'open',
      cancelledAt: classOverrides.cancelledAt ?? null,
    });
    classIds.push(cls.id);
    return { teacherId: teacher.id, teacherEmail, classId: cls.id, calendarEntryId: cls.calendarEntryId };
  }

  async function book(
    f: Fixture,
    studentOverrides: Partial<{ classReminder: ReminderTiming; classReminderChannel: ReminderChannel }> = {},
    regOverrides: Partial<{ registeredAt: Date; status: RegistrationStatus }> = {},
  ) {
    const student = await prisma.student.create({
      data: {
        firstName: 'Rem',
        lastName: 'Inder',
        email: `rem-${uniqueSuffix}-${n++}@test.local`,
        incomeTier: 3,
        ...studentOverrides,
      },
    });
    studentIds.push(student.id);
    const registration = await prisma.registration.create({
      data: {
        classId: f.classId,
        studentId: student.id,
        status: 'registered',
        tierAtBooking: 3,
        registeredAt: new Date('2099-06-01T00:00:00Z'),
        ...regOverrides,
      },
    });
    return { student, registration };
  }

  /** The sweep, narrowed to this fixture teacher's `Class` rows. */
  function run(f: Fixture, now: Date) {
    return processClassReminders(
      scopeSweep(prisma, { Class: { calendarEntry: { teacherId: f.teacherId } } }).db,
      now,
    );
  }

  const studentRows = (studentId: string) =>
    prisma.notification.findMany({
      where: { recipientType: 'student', recipientId: studentId, type: 'class_reminder' },
    });
  const teacherRows = (teacherId: string) =>
    prisma.notification.findMany({
      where: { recipientType: 'teacher', recipientId: teacherId, type: 'class_reminder' },
    });
  const stampOf = async (registrationId: string) =>
    (await prisma.registration.findUniqueOrThrow({ where: { id: registrationId } })).classReminderSentAt;

  beforeAll(() => {
    // Force the real-send path: a key is configured and dry-run is off.
    process.env.RESEND_API_KEY = 're_test_dummy';
    delete process.env.EMAIL_DRY_RUN;
  });

  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ error: null });
    vi.mocked(log.error).mockClear();
  });

  afterAll(async () => {
    if (savedApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = savedApiKey;
    if (savedDryRun === undefined) delete process.env.EMAIL_DRY_RUN;
    else process.env.EMAIL_DRY_RUN = savedDryRun;

    // Every filter below reads an array declared non-empty-safe at the top: an
    // empty `in` matches nothing, so a failed seed cannot widen a delete.
    await prisma.notification.deleteMany({ where: { recipientId: { in: [...studentIds, ...teacherIds] } } });
    await prisma.registration.deleteMany({ where: { classId: { in: classIds } } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
    await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.$disconnect();
  });

  // 1
  it('reminds a morning_of / inbox_and_email student once, in the inbox and by email', async () => {
    const f = await seed({ classReminder: 'off' });
    const { student, registration } = await book(f, { classReminder: 'morning_of', classReminderChannel: 'inbox_and_email' });

    const result = await run(f, MORNING);

    expect(result.studentReminders).toBe(1);
    const rows = await studentRows(student.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.emailSent).toBe(true);
    expect(rows[0]!.relatedClassId).toBe(f.classId);
    expect(rows[0]!.title).toBe('Class reminder');
    expect(sendsTo(student.email)).toBe(1);
    expect(await stampOf(registration.id)).toEqual(MORNING);
  });

  // 2
  it('sends once across two runs', async () => {
    const f = await seed({ classReminder: 'off' });
    const { student } = await book(f, { classReminder: 'morning_of', classReminderChannel: 'inbox_and_email' });

    const first = await run(f, MORNING);
    const second = await run(f, new Date(MORNING.getTime() + 5 * MINUTE));

    expect(first.studentReminders).toBe(1);
    expect(second.studentReminders).toBe(0);
    expect(await studentRows(student.id)).toHaveLength(1);
    expect(sendsTo(student.email)).toBe(1);
  });

  // 2b
  it('sends once when two sweeps overlap on the same registration', async () => {
    const f = await seed({ classReminder: 'off' });
    const { student } = await book(f, { classReminder: 'morning_of', classReminderChannel: 'inbox_and_email' });

    let interposed = 0;
    const overlapping = prisma.$extends({
      query: {
        registration: {
          async findMany({ args, query }) {
            const rows = await query(args);
            // Keyed on the candidate read's shape: the only registration read
            // asking for unstamped rows.
            const where = args.where as { classReminderSentAt?: unknown } | undefined;
            if (where?.classReminderSentAt !== null || interposed > 0) return rows;
            interposed += 1;
            // A whole second sweep, on a client built from the plain one so it
            // never re-enters this hook, landing between this sweep's read and
            // its claim — the scheduler tick and a cron request overlapping.
            await run(f, MORNING);
            return rows;
          },
        },
      },
      // `$extends` returns a client missing `$on`; every method used is the real one.
    }) as unknown as PrismaClient;

    const outer = await processClassReminders(
      scopeSweep(overlapping, { Class: { calendarEntry: { teacherId: f.teacherId } } }).db,
      MORNING,
    );

    expect(interposed).toBe(1);
    expect(sendsTo(student.email)).toBe(1);
    expect(await studentRows(student.id)).toHaveLength(1);
    // The interposed sweep won the claim; this one found it taken and skipped.
    expect(outer.studentReminders).toBe(0);
  });

  // 3
  it('inbox-only writes a row and sends no email', async () => {
    const f = await seed({ classReminder: 'off' });
    const { student } = await book(f, { classReminder: 'morning_of', classReminderChannel: 'inbox' });

    const result = await run(f, MORNING);

    expect(result.studentReminders).toBe(1);
    expect(await studentRows(student.id)).toHaveLength(1);
    expect(sendsTo(student.email)).toBe(0);
  });

  // 4
  it('email-only sends and writes no row, and stamps the registration', async () => {
    const f = await seed({ classReminder: 'off' });
    const { student, registration } = await book(f, { classReminder: 'morning_of', classReminderChannel: 'email' });

    const result = await run(f, MORNING);

    expect(result.studentReminders).toBe(1);
    expect(sendsTo(student.email)).toBe(1);
    expect(await studentRows(student.id)).toHaveLength(0);
    expect(await stampOf(registration.id)).toEqual(MORNING);
  });

  // 5
  it('timing off: nothing, and no stamp', async () => {
    const f = await seed({ classReminder: 'off' });
    const { student, registration } = await book(f, { classReminder: 'off' });
    expect(await prisma.registration.count({ where: { id: registration.id, status: 'registered' } })).toBe(1);

    const result = await run(f, MORNING);

    expect(result.studentReminders).toBe(0);
    expect(await studentRows(student.id)).toHaveLength(0);
    expect(sendsTo(student.email)).toBe(0);
    expect(await stampOf(registration.id)).toBeNull();
  });

  // 6
  it('skips a registration made after its reminder moment', async () => {
    const f = await seed({ classReminder: 'off' });
    const { student, registration } = await book(
      f,
      { classReminder: 'morning_of' },
      { registeredAt: new Date(MORNING.getTime() + MINUTE) },
    );
    expect(await prisma.registration.count({ where: { id: registration.id, status: 'registered' } })).toBe(1);

    const result = await run(f, new Date(MORNING.getTime() + 10 * MINUTE));

    expect(result.studentReminders).toBe(0);
    expect(await studentRows(student.id)).toHaveLength(0);
    expect(sendsTo(student.email)).toBe(0);
    expect(await stampOf(registration.id)).toBeNull();
  });

  // 7
  it('skips a cancelled registration', async () => {
    const f = await seed({ classReminder: 'off' });
    const { student, registration } = await book(f, {}, { status: 'cancelled' });
    expect(await prisma.registration.count({ where: { id: registration.id } })).toBe(1);

    const result = await run(f, MORNING);

    expect(result.studentReminders).toBe(0);
    expect(await studentRows(student.id)).toHaveLength(0);
    expect(sendsTo(student.email)).toBe(0);
    expect(await stampOf(registration.id)).toBeNull();
  });

  // 8
  it('sends nothing before the moment', async () => {
    const f = await seed();
    const { student, registration } = await book(f);
    expect(await prisma.registration.count({ where: { id: registration.id, status: 'registered' } })).toBe(1);

    const result = await run(f, new Date(MORNING.getTime() - MINUTE));

    expect(result).toEqual({ studentReminders: 0, teacherReminders: 0, emailFailures: 0 });
    expect(await studentRows(student.id)).toHaveLength(0);
    expect(await teacherRows(f.teacherId)).toHaveLength(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  // 9
  it('sends nothing at start', async () => {
    const f = await seed();
    const { student, registration } = await book(f);
    expect(await prisma.registration.count({ where: { id: registration.id, status: 'registered' } })).toBe(1);

    const result = await run(f, START);

    expect(result).toEqual({ studentReminders: 0, teacherReminders: 0, emailFailures: 0 });
    expect(await studentRows(student.id)).toHaveLength(0);
    expect(await teacherRows(f.teacherId)).toHaveLength(0);
    expect(sendMock).not.toHaveBeenCalled();
    expect(await stampOf(registration.id)).toBeNull();
  });

  // 10
  it('skips a class whose entry is cancelled', async () => {
    const f = await seed({}, { cancelledAt: new Date('2099-06-01T00:00:00Z') });
    const { student, registration } = await book(f);
    expect(await prisma.registration.count({ where: { id: registration.id, status: 'registered' } })).toBe(1);

    const result = await run(f, MORNING);

    expect(result).toEqual({ studentReminders: 0, teacherReminders: 0, emailFailures: 0 });
    expect(await studentRows(student.id)).toHaveLength(0);
    expect(await teacherRows(f.teacherId)).toHaveLength(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  // 11
  it('skips a draft class', async () => {
    const f = await seed({}, { status: 'draft' });
    const { student, registration } = await book(f);
    expect(await prisma.registration.count({ where: { id: registration.id, status: 'registered' } })).toBe(1);

    const result = await run(f, MORNING);

    expect(result).toEqual({ studentReminders: 0, teacherReminders: 0, emailFailures: 0 });
    expect(await studentRows(student.id)).toHaveLength(0);
    expect(await teacherRows(f.teacherId)).toHaveLength(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  // 12
  it('skips an erased student', async () => {
    const f = await seed({ classReminder: 'off' });
    const { student, registration } = await book(f);
    await prisma.student.update({ where: { id: student.id }, data: { deletedAt: new Date('2099-06-02T00:00:00Z') } });
    expect(await prisma.registration.count({ where: { id: registration.id, status: 'registered' } })).toBe(1);

    const result = await run(f, MORNING);

    expect(result.studentReminders).toBe(0);
    expect(await studentRows(student.id)).toHaveLength(0);
    expect(sendsTo(student.email)).toBe(0);
    expect(await stampOf(registration.id)).toBeNull();
  });

  // 13
  it('reminds the teacher once, with the registration count', async () => {
    const f = await seed({ classReminder: 'morning_of', classReminderChannel: 'inbox_and_email' });
    await book(f, { classReminder: 'off' });
    await book(f, { classReminder: 'off' });

    const first = await run(f, MORNING);

    expect(first.teacherReminders).toBe(1);
    const rows = await teacherRows(f.teacherId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toContain('2 registered');
    expect(rows[0]!.emailSent).toBe(true);
    expect(rows[0]!.relatedClassId).toBe(f.classId);
    expect(sendsTo(f.teacherEmail)).toBe(1);
    const cls = await prisma.class.findUniqueOrThrow({ where: { id: f.classId } });
    expect(cls.teacherReminderSentAt).toEqual(MORNING);

    const second = await run(f, new Date(MORNING.getTime() + 5 * MINUTE));
    expect(second.teacherReminders).toBe(0);
    expect(await teacherRows(f.teacherId)).toHaveLength(1);
    expect(sendsTo(f.teacherEmail)).toBe(1);
  });

  // 13b
  it('reminds the teacher once when two sweeps overlap on the same class', async () => {
    const f = await seed({ classReminder: 'morning_of', classReminderChannel: 'inbox_and_email' });

    let interposed = 0;
    const overlapping = prisma.$extends({
      query: {
        class: {
          async findMany({ args, query }) {
            const rows = await query(args);
            if (interposed > 0) return rows;
            interposed += 1;
            // Same interleaving as the student case, on the candidate read.
            await run(f, MORNING);
            return rows;
          },
        },
      },
      // `$extends` returns a client missing `$on`; every method used is the real one.
    }) as unknown as PrismaClient;

    const outer = await processClassReminders(
      scopeSweep(overlapping, { Class: { calendarEntry: { teacherId: f.teacherId } } }).db,
      MORNING,
    );

    expect(interposed).toBe(1);
    expect(sendsTo(f.teacherEmail)).toBe(1);
    expect(await teacherRows(f.teacherId)).toHaveLength(1);
    expect(outer.teacherReminders).toBe(0);
  });

  // 14
  it('teacher timing off: no teacher reminder, no stamp', async () => {
    const f = await seed({ classReminder: 'off' });
    await book(f, { classReminder: 'off' });
    expect(await prisma.class.count({ where: { id: f.classId, status: 'open' } })).toBe(1);

    const result = await run(f, MORNING);

    expect(result.teacherReminders).toBe(0);
    expect(await teacherRows(f.teacherId)).toHaveLength(0);
    expect(sendsTo(f.teacherEmail)).toBe(0);
    const cls = await prisma.class.findUniqueOrThrow({ where: { id: f.classId } });
    expect(cls.teacherReminderSentAt).toBeNull();
  });

  // 15
  it('skips an erased teacher', async () => {
    const f = await seed({ classReminder: 'morning_of' });
    await prisma.teacher.update({ where: { id: f.teacherId }, data: { deletedAt: new Date('2099-06-02T00:00:00Z') } });
    expect(await prisma.class.count({ where: { id: f.classId, status: 'open' } })).toBe(1);

    const result = await run(f, MORNING);

    expect(result.teacherReminders).toBe(0);
    expect(await teacherRows(f.teacherId)).toHaveLength(0);
    expect(sendsTo(f.teacherEmail)).toBe(0);
  });

  // 16
  it('never reminds about a studio class', async () => {
    const f = await seed({ classReminder: 'morning_of', classReminderChannel: 'inbox' });
    await createStudioClassFixture(prisma, {
      teacherId: f.teacherId,
      classType: 'Studio Flow',
      date: new Date('2099-06-10'),
      startTime: hhmmToTime('12:00'),
      durationMinutes: 60,
      location: 'Studio Loft',
      hourlyRate: 45,
    });
    expect(await prisma.calendarEntry.count({ where: { teacherId: f.teacherId, kind: 'studio' } })).toBe(1);

    const result = await run(f, MORNING);

    // The regular class alone accounts for every row the teacher received.
    expect(result.teacherReminders).toBe(1);
    const rows = await teacherRows(f.teacherId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.relatedClassId).toBe(f.classId);
  });

  // 17
  it('counts a failed send, keeps the stamp, and does not retry', async () => {
    const f = await seed({ classReminder: 'off' });
    const { student, registration } = await book(f, { classReminderChannel: 'email' });
    sendMock.mockResolvedValueOnce({ error: { message: 'boom' } });

    const first = await run(f, MORNING);

    expect(first.emailFailures).toBe(1);
    expect(first.studentReminders).toBe(1);
    expect(sendsTo(student.email)).toBe(1);
    expect(await stampOf(registration.id)).toEqual(MORNING);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ reason: 'boom' }), expect.any(String));

    const second = await run(f, new Date(MORNING.getTime() + 5 * MINUTE));
    expect(second.studentReminders).toBe(0);
    expect(sendsTo(student.email)).toBe(1);
  });

  // 18
  it('a send that throws is a failed send; the sweep carries on to the next student', async () => {
    const f = await seed({ classReminder: 'off' });
    const a = await book(f, { classReminderChannel: 'email' });
    const b = await book(f, { classReminderChannel: 'email' });
    sendMock.mockRejectedValueOnce(new Error('socket hang up'));

    const result = await run(f, MORNING);

    expect(result).toEqual({ studentReminders: 2, teacherReminders: 0, emailFailures: 1 });
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendsTo(a.student.email)).toBe(1);
    expect(sendsTo(b.student.email)).toBe(1);
    expect(await stampOf(a.registration.id)).toEqual(MORNING);
    expect(await stampOf(b.registration.id)).toEqual(MORNING);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'socket hang up' }),
      expect.any(String),
    );
  });

  // 19
  it('reminds no one when the entry is cancelled between the candidate read and the claims', async () => {
    const f = await seed({ classReminder: 'morning_of', classReminderChannel: 'inbox_and_email' });
    const { student, registration } = await book(f, { classReminder: 'morning_of', classReminderChannel: 'inbox_and_email' });
    const { state, sweep } = interposeAfterClassRead(f, async () => {
      await prisma.calendarEntry.update({ where: { id: f.calendarEntryId }, data: { cancelledAt: MORNING } });
    });

    const result = await sweep(MORNING);

    expect(state).toEqual({ interposed: 1, sawFixture: true });
    expect(result).toEqual({ studentReminders: 0, teacherReminders: 0, emailFailures: 0 });
    expect(sendMock).not.toHaveBeenCalled();
    expect(await studentRows(student.id)).toHaveLength(0);
    expect(await teacherRows(f.teacherId)).toHaveLength(0);
    expect(await stampOf(registration.id)).toBeNull();
    expect((await prisma.class.findUniqueOrThrow({ where: { id: f.classId } })).teacherReminderSentAt).toBeNull();
  });

  // 20
  it('reminds no one when the class leaves open between the candidate read and the claims', async () => {
    const f = await seed({ classReminder: 'morning_of', classReminderChannel: 'inbox_and_email' });
    const { student, registration } = await book(f, { classReminder: 'morning_of', classReminderChannel: 'inbox_and_email' });
    const { state, sweep } = interposeAfterClassRead(f, async () => {
      await prisma.class.update({ where: { id: f.classId }, data: { status: 'in_progress' } });
    });

    const result = await sweep(MORNING);

    expect(state).toEqual({ interposed: 1, sawFixture: true });
    expect(result).toEqual({ studentReminders: 0, teacherReminders: 0, emailFailures: 0 });
    expect(sendMock).not.toHaveBeenCalled();
    expect(await studentRows(student.id)).toHaveLength(0);
    expect(await teacherRows(f.teacherId)).toHaveLength(0);
    expect(await stampOf(registration.id)).toBeNull();
    expect((await prisma.class.findUniqueOrThrow({ where: { id: f.classId } })).teacherReminderSentAt).toBeNull();
  });

  // 21
  it('skips a registration cancelled and rebooked after its moment between the read and the claim', async () => {
    const f = await seed({ classReminder: 'off' });
    const { student, registration } = await book(f, { classReminder: 'morning_of', classReminderChannel: 'inbox_and_email' });
    const rebookedAt = new Date(MORNING.getTime() + 5 * MINUTE);
    const { state, sweep } = interposeAfterClassRead(f, async () => {
      await prisma.registration.update({
        where: { id: registration.id },
        data: { status: 'cancelled', cancelledAt: rebookedAt },
      });
      // What `activateRegistration` writes when it reuses the row.
      await prisma.registration.update({
        where: { id: registration.id },
        data: { status: 'registered', cancelledAt: null, registeredAt: rebookedAt, classReminderSentAt: null },
      });
    });

    const result = await sweep(new Date(MORNING.getTime() + 10 * MINUTE));

    expect(state).toEqual({ interposed: 1, sawFixture: true });
    expect(result.studentReminders).toBe(0);
    expect(sendsTo(student.email)).toBe(0);
    expect(await studentRows(student.id)).toHaveLength(0);
    expect(await stampOf(registration.id)).toBeNull();
  });

  // 22
  it("times reminders on the teacher's zone (Europe/Amsterdam, summer time)", async () => {
    // 18:00 CEST is 16:00Z: the student's one-hour-before moment is 15:00Z,
    // and the teacher's evening-before moment is 19:00 CEST the day before,
    // 17:00Z on 2099-06-09. Read in UTC, both would be two hours later.
    const f = await seed({
      defaultTimezone: 'Europe/Amsterdam',
      classReminder: 'evening_before',
      classReminderChannel: 'inbox',
    });
    const { student } = await book(f, { classReminder: 'one_hour_before', classReminderChannel: 'inbox' });

    const teacherBefore = await run(f, new Date('2099-06-09T16:59:00Z'));
    const teacherAt = await run(f, new Date('2099-06-09T17:00:00Z'));
    const studentBefore = await run(f, new Date('2099-06-10T14:59:00Z'));
    const studentAt = await run(f, new Date('2099-06-10T15:00:00Z'));

    expect(teacherBefore).toEqual({ studentReminders: 0, teacherReminders: 0, emailFailures: 0 });
    expect(teacherAt).toEqual({ studentReminders: 0, teacherReminders: 1, emailFailures: 0 });
    expect(studentBefore).toEqual({ studentReminders: 0, teacherReminders: 0, emailFailures: 0 });
    expect(studentAt).toEqual({ studentReminders: 1, teacherReminders: 0, emailFailures: 0 });
    expect(await teacherRows(f.teacherId)).toHaveLength(1);
    expect(await studentRows(student.id)).toHaveLength(1);
  });

  // 23
  it("counts a failed teacher send and keeps the class's stamp", async () => {
    const f = await seed({ classReminder: 'morning_of', classReminderChannel: 'email' });
    sendMock.mockResolvedValueOnce({ error: { message: 'boom' } });

    const result = await run(f, MORNING);

    expect(result).toEqual({ studentReminders: 0, teacherReminders: 1, emailFailures: 1 });
    expect(sendsTo(f.teacherEmail)).toBe(1);
    expect((await prisma.class.findUniqueOrThrow({ where: { id: f.classId } })).teacherReminderSentAt).toEqual(MORNING);
  });
});
