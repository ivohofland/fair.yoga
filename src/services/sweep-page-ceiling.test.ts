/**
 * Calibrates the ceiling harness — a lowered `max_stack_depth` must split a
 * `SWEEP_PAGE_SIZE` parent set from a `CEILING_ROWS` one, on the raw SQL path
 * and on Prisma's relation-load path, and must not leak past its own client —
 * then runs one ceiling test per paged read: each seeds a `CEILING_ROWS`
 * parent set and asserts the read completes on the lowered stack. The design
 * is `docs/superpowers/specs/2026-09-24-relation-load-paging-design.md`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { SWEEP_PAGE_SIZE } from '@/lib/read-in-pages';
import { autoCancelClasses, autoCompleteClasses, autoTransitionToInProgress } from './class-transitions';
import { createReconciliationStreaks, reconcileWaitlists } from './waitlist-reconciliation';
import { readGenerationCandidates } from './class-generator';
import { readStudioGenerationCandidates } from './studio-class-generator';
import { getUnreadForEmailFallback } from './notifications';
import { readDuePayments, REMIND_EVERY_DAYS } from './payment-reminders';
import { scopeSweep } from '../../tests/scoped-sweep';
import {
  CEILING_ROWS,
  CEILING_STACK,
  expectLowered,
  isStackDepthError,
  lowStackClient,
  seedClasses,
  seedTeachers,
  SLOTS_PER_DAY,
  type SeededTeachers,
} from '../../tests/stack-ceiling';

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * `base`, recording the id of every row a `class.findMany` through it returns.
 * Pass the result to `scopeSweep` rather than extending the scoped client:
 * `tests/scoped-sweep.ts`'s header explains the hook order.
 */
function recordClassReads(base: PrismaClient): { client: PrismaClient; ids: (string | undefined)[] } {
  // The extension's row type leaves `id` optional: `args` may not select it.
  const ids: (string | undefined)[] = [];
  const client = base.$extends({
    query: {
      class: {
        async findMany({ args, query }) {
          const rows = await query(args);
          for (const row of rows) ids.push(row.id);
          return rows;
        },
      },
    },
  }) as unknown as PrismaClient;
  return { client, ids };
}

/** Every seeded id was read, exactly once, and nothing else was. */
function expectReadExactlyOnce(read: (string | undefined)[], seeded: string[]): void {
  expect(new Set(read).size).toBe(read.length);
  expect([...read].sort()).toEqual([...seeded].sort());
}

describe('ceiling harness', () => {
  let low: PrismaClient;
  let teachers: SeededTeachers | undefined;
  let classIds: string[] = [];

  beforeAll(async () => {
    low = await lowStackClient();
    teachers = await seedTeachers(prisma, 11, 'ceiling-harness');
    ({ classIds } = await seedClasses(prisma, teachers, {
      rows: CEILING_ROWS,
      dates: [new Date('2030-01-07')],
      status: 'open',
      minStudents: 1,
      maxStudents: 10,
    }));
  }, 60_000);

  afterAll(async () => {
    await teachers?.cleanup();
    await low?.$disconnect();
  });

  function rowValueIn(count: number) {
    const tuples = Array.from(
      { length: count },
      (_, i) => Prisma.sql`(${`00000000-0000-0000-0000-${String(i).padStart(12, '0')}`}, 'regular'::"ClassFamily")`,
    );
    return low.$queryRaw<{ id: string }[]>`
      SELECT id FROM "CalendarEntry" WHERE (id, kind) IN (${Prisma.join(tuples)})`;
  }

  it('splits SWEEP_PAGE_SIZE from CEILING_ROWS row-value tuples', async () => {
    await expect(rowValueIn(SWEEP_PAGE_SIZE)).resolves.toEqual([]);
    const err: unknown = await rowValueIn(CEILING_ROWS).then(
      () => 'resolved',
      (e: unknown) => e,
    );
    expect(isStackDepthError(err)).toBe(true);
  });

  it('keeps the lowered stack on its own client', async () => {
    const second = await lowStackClient();
    try {
      const [lowered] = await second.$queryRawUnsafe<{ max_stack_depth: string }[]>('SHOW max_stack_depth');
      expect(lowered?.max_stack_depth).toBe(CEILING_STACK);
      const [shared] = await prisma.$queryRawUnsafe<{ max_stack_depth: string }[]>('SHOW max_stack_depth');
      expect(shared?.max_stack_depth).not.toBe(CEILING_STACK);
    } finally {
      await second.$disconnect();
    }
  });

  it('rejects an unpaged CEILING_ROWS relation load and resolves a SWEEP_PAGE_SIZE one', async () => {
    const load = (ids: string[]) =>
      low.class.findMany({ where: { id: { in: ids } }, include: { calendarEntry: true } });
    const err: unknown = await load(classIds).then(
      () => 'resolved',
      (e: unknown) => e,
    );
    expect(isStackDepthError(err)).toBe(true);
    await expect(load(classIds.slice(0, SWEEP_PAGE_SIZE))).resolves.toHaveLength(SWEEP_PAGE_SIZE);
  });
});

describe('autoCancelClasses', () => {
  let low: PrismaClient;
  let teachers: SeededTeachers | undefined;
  let classIds: string[] = [];
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  beforeAll(async () => {
    low = await lowStackClient();
    teachers = await seedTeachers(prisma, 11, 'ceiling-auto-cancel');
    // `minStudents: 0`: a count of 0 is not below it, so every row is a no-op.
    ({ classIds } = await seedClasses(prisma, teachers, {
      rows: CEILING_ROWS,
      dates: [today],
      status: 'open',
      minStudents: 0,
      maxStudents: 10,
    }));
  }, 60_000);

  afterAll(async () => {
    await teachers?.cleanup();
    await low?.$disconnect();
  });

  it('reads CEILING_ROWS in-window open classes under the lowered stack', async () => {
    if (!teachers) throw new Error('seed failed');
    const recorded = recordClassReads(low);
    const scoped = scopeSweep(recorded.client, {
      Class: { calendarEntry: { teacherId: { in: teachers.teacherIds } } },
    });
    await expect(autoCancelClasses(scoped.db, now)).resolves.toBe(0);
    expect(scoped.rowsRead('Class')).toBeGreaterThanOrEqual(CEILING_ROWS);
    expectReadExactlyOnce(recorded.ids, classIds);
    await expectLowered(scoped.db);
  });
});

/** Tomorrow's UTC midnight, and the instant 30 seconds after today's. */
function todayUtc(): { tomorrow: Date; justAfterMidnight: Date } {
  const wall = new Date();
  const today = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  return {
    tomorrow: new Date(today + 24 * 60 * 60 * 1000),
    justAfterMidnight: new Date(today + 30 * 1000),
  };
}

describe('autoTransitionToInProgress', () => {
  let low: PrismaClient;
  let teachers: SeededTeachers | undefined;
  // Every row is stored on tomorrow, so each is inside `date <= now + 24h`,
  // and none has started by `now`: the pre-filter skips them all.
  const { tomorrow, justAfterMidnight: now } = todayUtc();
  let classIds: string[] = [];

  beforeAll(async () => {
    low = await lowStackClient();
    teachers = await seedTeachers(prisma, 11, 'ceiling-auto-start');
    ({ classIds } = await seedClasses(prisma, teachers, {
      rows: CEILING_ROWS,
      dates: [tomorrow],
      status: 'open',
      minStudents: 0,
      maxStudents: 10,
    }));
  }, 60_000);

  afterAll(async () => {
    await teachers?.cleanup();
    await low?.$disconnect();
  });

  it('reads CEILING_ROWS open classes under the lowered stack', async () => {
    if (!teachers) throw new Error('seed failed');
    const recorded = recordClassReads(low);
    const scoped = scopeSweep(recorded.client, {
      Class: { calendarEntry: { teacherId: { in: teachers.teacherIds } } },
    });
    await expect(autoTransitionToInProgress(scoped.db, now)).resolves.toBe(0);
    expect(scoped.rowsRead('Class')).toBeGreaterThanOrEqual(CEILING_ROWS);
    expectReadExactlyOnce(recorded.ids, classIds);
    await expectLowered(scoped.db);
  });
});

describe('autoCompleteClasses', () => {
  let low: PrismaClient;
  let teachers: SeededTeachers | undefined;
  // No row has ended by `now`, so the pre-filter skips them all.
  const { tomorrow, justAfterMidnight: now } = todayUtc();
  let classIds: string[] = [];

  beforeAll(async () => {
    low = await lowStackClient();
    teachers = await seedTeachers(prisma, 11, 'ceiling-auto-complete');
    ({ classIds } = await seedClasses(prisma, teachers, {
      rows: CEILING_ROWS,
      dates: [tomorrow],
      status: 'in_progress',
      minStudents: 0,
      maxStudents: 10,
    }));
  }, 60_000);

  afterAll(async () => {
    await teachers?.cleanup();
    await low?.$disconnect();
  });

  it('reads CEILING_ROWS in-progress classes under the lowered stack', async () => {
    if (!teachers) throw new Error('seed failed');
    const recorded = recordClassReads(low);
    const scoped = scopeSweep(recorded.client, {
      Class: { calendarEntry: { teacherId: { in: teachers.teacherIds } } },
    });
    await expect(autoCompleteClasses(scoped.db, now)).resolves.toBe(0);
    expect(scoped.rowsRead('Class')).toBeGreaterThanOrEqual(CEILING_ROWS);
    expectReadExactlyOnce(recorded.ids, classIds);
    await expectLowered(scoped.db);
  });
});

describe('reconcileWaitlists', () => {
  let low: PrismaClient;
  let teachers: SeededTeachers | undefined;
  let registeredId: string | undefined;
  let waitingId: string | undefined;
  let classIds: string[] = [];
  const tag = `ceiling-reconcile-${Date.now()}`;

  beforeAll(async () => {
    low = await lowStackClient();
    teachers = await seedTeachers(prisma, 11, 'ceiling-reconcile');
    const dateCount = Math.ceil(CEILING_ROWS / (11 * SLOTS_PER_DAY));
    const dates = Array.from({ length: dateCount }, (_, i) => new Date(Date.UTC(2031, 0, 6 + i)));
    // `maxStudents: 1` and one registration each: every class is full, so
    // none is handed to `handleSpotFreed`.
    ({ classIds } = await seedClasses(prisma, teachers, {
      rows: CEILING_ROWS,
      dates,
      status: 'open',
      minStudents: 0,
      maxStudents: 1,
    }));
    const registered = await prisma.student.create({
      data: { firstName: 'Ceiling', lastName: 'Registered', email: `${tag}-a@test.local` },
    });
    registeredId = registered.id;
    const waiting = await prisma.student.create({
      data: { firstName: 'Ceiling', lastName: 'Waiting', email: `${tag}-b@test.local` },
    });
    waitingId = waiting.id;
    await prisma.registration.createMany({
      data: classIds.map((classId) => ({
        classId,
        studentId: registered.id,
        status: 'registered' as const,
        tierAtBooking: 3,
      })),
    });
    await prisma.waitlistEntry.createMany({
      data: classIds.map((classId) => ({
        classId,
        studentId: waiting.id,
        position: 1,
        status: 'waiting' as const,
      })),
    });
  }, 60_000);

  afterAll(async () => {
    // Students first: their registrations and waitlist entries cascade.
    const studentIds = [registeredId, waitingId].filter((id): id is string => id !== undefined);
    if (studentIds.length > 0) {
      await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    }
    await teachers?.cleanup();
    await low?.$disconnect();
  });

  it('reads CEILING_ROWS queued classes under the lowered stack', async () => {
    if (!teachers) throw new Error('seed failed');
    const byTeacher = { calendarEntry: { teacherId: { in: teachers.teacherIds } } };
    const recorded = recordClassReads(low);
    const scoped = scopeSweep(recorded.client, {
      Class: byTeacher,
      WaitlistEntry: { class: byTeacher },
      Registration: { class: byTeacher },
    });
    const summary = await reconcileWaitlists(scoped.db, {
      streaks: createReconciliationStreaks(),
    });
    expect(summary.candidates).toBe(CEILING_ROWS);
    expect(summary.reconciledClassIds).toEqual([]);
    expect(summary.failedClassIds).toEqual([]);
    expect(scoped.rowsRead('Class')).toBeGreaterThanOrEqual(CEILING_ROWS);
    expectReadExactlyOnce(recorded.ids, classIds);
    await expectLowered(scoped.db);
  });
});

/**
 * `CEILING_ROWS` `ScheduleRule` rows, split evenly across `teachers`, one
 * `dayOfWeek`/`startTime` slot each: `dayOfWeek = i % 7`, `startTime` a
 * 15-minute step at `floor(i / 7)`, so no two of one teacher's rows overlap
 * under `ScheduleRule_teacher_slot_excl`. `i` runs per teacher, so two
 * teachers never collide on `teacherId` either. Returns the rule ids in
 * creation order, teacher by teacher — all of the first teacher's rules, then
 * all of the next's, matching how each caller below pairs them with its own
 * child rows — and the `perTeacher` count so callers don't recompute it.
 */
async function seedScheduleRules(
  db: PrismaClient,
  teachers: SeededTeachers,
  kind: 'regular' | 'studio',
): Promise<{ ruleIds: string[]; perTeacher: number }> {
  const teacherCount = teachers.teacherIds.length;
  if (CEILING_ROWS % teacherCount !== 0) {
    throw new Error(`seedScheduleRules: CEILING_ROWS ${CEILING_ROWS} does not divide evenly across ${teacherCount} teachers`);
  }
  const perTeacher = CEILING_ROWS / teacherCount;
  const capacity = 7 * SLOTS_PER_DAY;
  if (perTeacher > capacity) {
    throw new Error(`seedScheduleRules: ${perTeacher} rules per teacher exceed ${capacity} non-overlapping slots`);
  }
  const rules: Prisma.ScheduleRuleCreateManyInput[] = [];
  const ruleIds: string[] = [];
  for (const teacherId of teachers.teacherIds) {
    for (let i = 0; i < perTeacher; i++) {
      const id = crypto.randomUUID();
      ruleIds.push(id);
      rules.push({
        id,
        teacherId,
        kind,
        classType: 'Ceiling',
        dayOfWeek: i % 7,
        startTime: new Date(Date.UTC(1970, 0, 1, 0, Math.floor(i / 7) * 15)),
        durationMinutes: 15,
        isActive: true,
        isArchived: false,
      });
    }
  }
  await db.scheduleRule.createMany({ data: rules });
  return { ruleIds, perTeacher };
}

describe('readGenerationCandidates', () => {
  let low: PrismaClient;
  let teachers: SeededTeachers | undefined;
  let ruleIds: string[] = [];
  const templateIds: string[] = [];

  beforeAll(async () => {
    low = await lowStackClient();
    teachers = await seedTeachers(prisma, 2, 'ceiling-class-gen');

    let perTeacher: number;
    ({ ruleIds, perTeacher } = await seedScheduleRules(prisma, teachers, 'regular'));

    const templates: Prisma.ClassTemplateCreateManyInput[] = [];
    ruleIds.forEach((scheduleRuleId, idx) => {
      const teacherRoomId = teachers!.teacherRoomIds[Math.floor(idx / perTeacher)]!;
      const id = crypto.randomUUID();
      templateIds.push(id);
      templates.push({
        id,
        scheduleRuleId,
        kind: 'regular',
        teacherRoomId,
        ruleLive: true,
        roomArchived: false,
        roomCost: 0,
        minRate: 0,
        targetRate: 0,
        minStudents: 0,
        maxStudents: 10,
      });
    });
    await prisma.classTemplate.createMany({ data: templates });
  }, 60_000);

  afterAll(async () => {
    if (templateIds.length > 0) {
      await prisma.classTemplate.deleteMany({ where: { id: { in: templateIds } } });
    }
    if (ruleIds.length > 0) {
      await prisma.scheduleRule.deleteMany({ where: { id: { in: ruleIds } } });
    }
    await teachers?.cleanup();
    await low?.$disconnect();
  });

  it('reads every seeded template under the lowered stack', async () => {
    const result = await readGenerationCandidates(low);
    const ids = new Set(result.map((r) => r.id));
    expect(ids.size).toBe(result.length);
    for (const id of templateIds) {
      expect(ids.has(id)).toBe(true);
    }
    await expectLowered(low);
  });
});

describe('readStudioGenerationCandidates', () => {
  let low: PrismaClient;
  let teachers: SeededTeachers | undefined;
  let ruleIds: string[] = [];
  const templateIds: string[] = [];

  beforeAll(async () => {
    low = await lowStackClient();
    teachers = await seedTeachers(prisma, 2, 'ceiling-studio-gen');

    ({ ruleIds } = await seedScheduleRules(prisma, teachers, 'studio'));

    const templates: Prisma.StudioClassTemplateCreateManyInput[] = ruleIds.map((scheduleRuleId) => {
      const id = crypto.randomUUID();
      templateIds.push(id);
      return {
        id,
        scheduleRuleId,
        kind: 'studio',
        location: 'Ceiling Studio',
        hourlyRate: 0,
      };
    });
    await prisma.studioClassTemplate.createMany({ data: templates });
  }, 60_000);

  afterAll(async () => {
    if (templateIds.length > 0) {
      await prisma.studioClassTemplate.deleteMany({ where: { id: { in: templateIds } } });
    }
    if (ruleIds.length > 0) {
      await prisma.scheduleRule.deleteMany({ where: { id: { in: ruleIds } } });
    }
    await teachers?.cleanup();
    await low?.$disconnect();
  });

  it('reads every seeded template under the lowered stack', async () => {
    const result = await readStudioGenerationCandidates(low);
    const ids = new Set(result.map((r) => r.id));
    expect(ids.size).toBe(result.length);
    for (const id of templateIds) {
      expect(ids.has(id)).toBe(true);
    }
    await expectLowered(low);
  });
});

describe('getUnreadForEmailFallback', () => {
  let low: PrismaClient;
  let teachers: SeededTeachers | undefined;
  let studentId: string | undefined;
  const notificationIds: string[] = [];
  // Unread and unsent, but recent, unlinked and not an immediate type: the
  // read's own predicate excludes it, on a later page as on the first.
  const freshId = crypto.randomUUID();
  const tag = `ceiling-fallback-${Date.now()}`;

  beforeAll(async () => {
    low = await lowStackClient();
    teachers = await seedTeachers(prisma, 11, 'ceiling-fallback');
    const { classIds } = await seedClasses(prisma, teachers, {
      rows: CEILING_ROWS,
      dates: [new Date('2030-01-07')],
      status: 'open',
      minStudents: 0,
      maxStudents: 10,
    });
    const student = await prisma.student.create({
      data: { firstName: 'Ceiling', lastName: 'Recipient', email: `${tag}@test.local` },
    });
    studentId = student.id;
    // One shared `createdAt`, past the unread threshold, so every row is
    // eligible. `CEILING_ROWS` is more than one page, so the tie spans a page
    // boundary: a cursor on `createdAt` alone would lose rows there.
    const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await prisma.notification.createMany({
      data: classIds.map((relatedClassId) => {
        const id = crypto.randomUUID();
        notificationIds.push(id);
        return {
          id,
          recipientType: 'student' as const,
          recipientId: student.id,
          type: 'reminder' as const,
          title: 'Ceiling',
          body: 'Ceiling',
          relatedClassId,
          isRead: false,
          emailSent: false,
          createdAt,
        };
      }),
    });
    await prisma.notification.create({
      data: {
        id: freshId,
        recipientType: 'student',
        recipientId: student.id,
        type: 'reminder',
        title: 'Ceiling fresh',
        body: 'Ceiling fresh',
        isRead: false,
        emailSent: false,
      },
    });
  }, 60_000);

  afterAll(async () => {
    // Before the teachers: deleting their classes only nulls
    // `relatedClassId`, which would leave these rows behind.
    await prisma.notification.deleteMany({ where: { id: { in: [...notificationIds, freshId] } } });
    if (studentId !== undefined) {
      await prisma.student.deleteMany({ where: { id: studentId } });
    }
    await teachers?.cleanup();
    await low?.$disconnect();
  });

  it('reads every seeded notification under the lowered stack, oldest first', async () => {
    const result = await getUnreadForEmailFallback(low);
    const ids = new Set(result.map((n) => n.id));
    expect(notificationIds).toHaveLength(CEILING_ROWS);
    for (const id of notificationIds) {
      expect(ids.has(id)).toBe(true);
    }
    for (let i = 1; i < result.length; i++) {
      const prev = result[i - 1]!;
      const cur = result[i]!;
      const ordered =
        prev.createdAt.getTime() < cur.createdAt.getTime() ||
        (prev.createdAt.getTime() === cur.createdAt.getTime() && prev.id < cur.id);
      expect(ordered).toBe(true);
    }
    await expectLowered(low);
  });

  it('applies its eligibility predicate on pages after the first', async () => {
    // The extension's row type leaves `id` optional: `args` may not select it.
    const fetched: (string | undefined)[] = [];
    const recording = low.$extends({
      query: {
        notification: {
          async findMany({ args, query }) {
            const rows = await query(args);
            for (const row of rows) fetched.push(row.id);
            return rows;
          },
        },
      },
    }) as unknown as PrismaClient;
    await getUnreadForEmailFallback(recording);
    expect(fetched.length).toBeGreaterThan(SWEEP_PAGE_SIZE);
    expect(fetched).toEqual(expect.arrayContaining(notificationIds));
    expect(fetched).not.toContain(freshId);
  });
});

describe('readDuePayments', () => {
  let low: PrismaClient;
  let teachers: SeededTeachers | undefined;
  let studentId: string | undefined;
  const registrationIds: string[] = [];
  const paymentIds: string[] = [];
  const tag = `ceiling-payments-${Date.now()}`;
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Overdue but reminded a day ago, so not due. The `ffffffff-ffff` prefix
  // sorts it after every random uuid, so only a page after the first can
  // reach it: the predicate that excludes it is the later pages' copy.
  const recentId = `ffffffff-ffff-4fff-bfff-${crypto.randomUUID().slice(-12)}`;

  beforeAll(async () => {
    low = await lowStackClient();
    teachers = await seedTeachers(prisma, 11, 'ceiling-payments');
    const { classIds } = await seedClasses(prisma, teachers, {
      rows: CEILING_ROWS + 1,
      dates: [new Date('2030-01-07')],
      status: 'open',
      minStudents: 0,
      maxStudents: 10,
    });
    const student = await prisma.student.create({
      data: { firstName: 'Ceiling', lastName: 'Payer', email: `${tag}@test.local` },
    });
    studentId = student.id;
    await prisma.registration.createMany({
      data: classIds.map((classId) => {
        const id = crypto.randomUUID();
        registrationIds.push(id);
        return { id, classId, studentId: student.id, status: 'registered' as const, tierAtBooking: 3 };
      }),
    });
    const [recentRegistrationId, ...dueRegistrationIds] = registrationIds;
    await prisma.payment.createMany({
      data: dueRegistrationIds.map((registrationId) => {
        const id = crypto.randomUUID();
        paymentIds.push(id);
        return { id, registrationId, status: 'overdue' as const, reminderSentAt: null, amount: 1 };
      }),
    });
    await prisma.payment.create({
      data: {
        id: recentId,
        registrationId: recentRegistrationId!,
        status: 'overdue',
        reminderSentAt: new Date(Date.now() - DAY_MS),
        amount: 1,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { id: { in: [...paymentIds, recentId] } } });
    if (registrationIds.length > 0) {
      await prisma.registration.deleteMany({ where: { id: { in: registrationIds } } });
    }
    if (studentId !== undefined) {
      await prisma.student.deleteMany({ where: { id: studentId } });
    }
    await teachers?.cleanup();
    await low?.$disconnect();
  });

  it('reads every seeded overdue payment under the lowered stack', async () => {
    const pages: (string | undefined)[][] = [];
    const recording = low.$extends({
      query: {
        payment: {
          async findMany({ args, query }) {
            const rows = await query(args);
            // The extension's row type leaves `id` optional: `args` may not select it.
            pages.push(rows.map((row) => row.id));
            return rows;
          },
        },
      },
    }) as unknown as PrismaClient;
    const result = await readDuePayments(recording, new Date(Date.now() - REMIND_EVERY_DAYS * DAY_MS));
    const ids = new Set(result.map((p) => p.id));
    expect(ids.size).toBe(result.length);
    expect(paymentIds).toHaveLength(CEILING_ROWS);
    for (const id of paymentIds) {
      expect(ids.has(id)).toBe(true);
    }
    const firstPageLast = pages[0]?.at(-1);
    expect(pages.length).toBeGreaterThan(1);
    expect(firstPageLast !== undefined && firstPageLast < recentId).toBe(true);
    expect(ids.has(recentId)).toBe(false);
    await expectLowered(low);
  });
});
