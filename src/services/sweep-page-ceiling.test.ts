/**
 * Calibrates the ceiling harness — a lowered `max_stack_depth` must split a
 * `SWEEP_PAGE_SIZE` set of app-authored row-value tuples from a
 * `CEILING_ROWS` one and must not leak past its own client, and a relation
 * load must bind parameters in proportion to its parent set — then runs one
 * test per paged read: each seeds a `CEILING_ROWS` parent set and asserts no
 * statement the read sends binds more than a page's parameters. Last, the
 * bind-parameter limit those bounds stand in for is shown to be real. Why
 * sweeps page: `docs/technical-architecture.md`, "Relation loads over
 * platform-wide sets".
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import crypto from 'crypto';
import { Prisma, type PrismaClient } from '@/lib/prisma-client';
import { SWEEP_PAGE_SIZE } from '@/lib/read-in-pages';
import { autoCancelClasses, autoCompleteClasses, autoTransitionToInProgress } from './class-transitions';
import { createReconciliationStreaks, reconcileWaitlists } from './waitlist-reconciliation';
import { readGenerationCandidates } from './class-generator';
import { readStudioGenerationCandidates } from './studio-class-generator';
import { getUnreadForEmailFallback } from './notifications';
import { readDuePayments, REMIND_EVERY_DAYS } from './payment-reminders';
import { processClassReminders } from './class-reminders';
import { scopeSweep } from '../../tests/scoped-sweep';
import {
  analyzeSeed,
  BIND_LIMIT_PARENTS,
  BIND_REFUSED_PARENTS,
  CEILING_ROWS,
  CEILING_STACK,
  expectLowered,
  isStackDepthError,
  lowStackClient,
  peakBoundParams,
  resetBoundParams,
  seedClasses,
  seedTeachers,
  SLOTS_PER_DAY,
  type SeededTeachers,
} from '../../tests/stack-ceiling';
import { createPrismaClient } from '@/lib/prisma-client';

const prisma = createPrismaClient();

/** What one page of a three-column composite relation load binds: three keys per parent, plus one. */
const PAGE_PARAM_BOUND = 3 * SWEEP_PAGE_SIZE + 1;

afterAll(async () => {
  await prisma.$disconnect();
});

// After each describe's `beforeAll` seed, before its read: the read must be
// planned for the rows it was given (`docs/test-database.md` §7). A seed
// written in a `beforeEach` or a test body comes after this and needs its own
// `analyzeSeed` call.
beforeEach(async () => {
  await analyzeSeed(prisma);
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

/**
 * `base`, recording the longest `in` list any operation through it is handed,
 * at any depth of its args. Attach it before `scopeSweep` so it sees the
 * sweep's own args (`tests/scoped-sweep.ts`'s header).
 */
function recordLongestInList(base: PrismaClient): { client: PrismaClient; longest: () => number } {
  let longest = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
    } else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'in' && Array.isArray(value)) longest = Math.max(longest, value.length);
        visit(value);
      }
    }
  };
  const client = base.$extends({
    query: {
      async $allOperations({ args, query }) {
        visit(args);
        return query(args);
      },
    },
  }) as unknown as PrismaClient;
  return { client, longest: () => longest };
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

  it("a paged relation load binds a page's parameters; an unpaged one binds the whole set's", async () => {
    const load = (ids: string[]) =>
      low.class.findMany({ where: { id: { in: ids } }, include: { calendarEntry: true } });
    resetBoundParams(low);
    await expect(load(classIds.slice(0, SWEEP_PAGE_SIZE))).resolves.toHaveLength(SWEEP_PAGE_SIZE);
    expect(peakBoundParams(low)).toBe(PAGE_PARAM_BOUND);
    resetBoundParams(low);
    await expect(load(classIds)).resolves.toHaveLength(CEILING_ROWS);
    expect(peakBoundParams(low)).toBe(3 * CEILING_ROWS + 1);
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

  it("reads CEILING_ROWS in-window open classes binding at most a page's parameters per statement", async () => {
    if (!teachers) throw new Error('seed failed');
    const recorded = recordClassReads(low);
    const scoped = scopeSweep(recorded.client, {
      Class: { calendarEntry: { teacherId: { in: teachers.teacherIds } } },
    });
    resetBoundParams(low);
    await expect(autoCancelClasses(scoped.db, now)).resolves.toBe(0);
    expect(peakBoundParams(low)).toBeGreaterThan(0);
    expect(peakBoundParams(low)).toBeLessThanOrEqual(PAGE_PARAM_BOUND);
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

  it("reads CEILING_ROWS open classes binding at most a page's parameters per statement", async () => {
    if (!teachers) throw new Error('seed failed');
    const recorded = recordClassReads(low);
    const scoped = scopeSweep(recorded.client, {
      Class: { calendarEntry: { teacherId: { in: teachers.teacherIds } } },
    });
    resetBoundParams(low);
    await expect(autoTransitionToInProgress(scoped.db, now)).resolves.toBe(0);
    expect(peakBoundParams(low)).toBeGreaterThan(0);
    expect(peakBoundParams(low)).toBeLessThanOrEqual(PAGE_PARAM_BOUND);
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

  it("reads CEILING_ROWS in-progress classes binding at most a page's parameters per statement", async () => {
    if (!teachers) throw new Error('seed failed');
    const recorded = recordClassReads(low);
    const scoped = scopeSweep(recorded.client, {
      Class: { calendarEntry: { teacherId: { in: teachers.teacherIds } } },
    });
    resetBoundParams(low);
    await expect(autoCompleteClasses(scoped.db, now)).resolves.toBe(0);
    expect(peakBoundParams(low)).toBeGreaterThan(0);
    expect(peakBoundParams(low)).toBeLessThanOrEqual(PAGE_PARAM_BOUND);
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

  it("reads CEILING_ROWS queued classes binding at most a page's parameters per statement", async () => {
    if (!teachers) throw new Error('seed failed');
    const byTeacher = { calendarEntry: { teacherId: { in: teachers.teacherIds } } };
    const lists = recordLongestInList(low);
    const recorded = recordClassReads(lists.client);
    const scoped = scopeSweep(recorded.client, {
      Class: byTeacher,
      WaitlistEntry: { class: byTeacher },
      Registration: { class: byTeacher },
    });
    resetBoundParams(low);
    const summary = await reconcileWaitlists(scoped.db, {
      streaks: createReconciliationStreaks(),
    });
    expect(peakBoundParams(low)).toBeGreaterThan(0);
    expect(peakBoundParams(low)).toBeLessThanOrEqual(PAGE_PARAM_BOUND);
    // The candidate ids reach Postgres as `in` lists in statements Prisma
    // neither splits nor sends past its own parameter limit, so each list is
    // a page at most, however many classes are queued.
    expect(lists.longest()).toBeGreaterThan(0);
    expect(lists.longest()).toBeLessThanOrEqual(SWEEP_PAGE_SIZE);
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

  it("reads every seeded template binding at most a page's parameters per statement", async () => {
    resetBoundParams(low);
    const result = await readGenerationCandidates(low);
    expect(peakBoundParams(low)).toBeGreaterThan(0);
    expect(peakBoundParams(low)).toBeLessThanOrEqual(PAGE_PARAM_BOUND);
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

  it("reads every seeded template binding at most a page's parameters per statement", async () => {
    resetBoundParams(low);
    const result = await readStudioGenerationCandidates(low);
    // A studio template reaches its rule over two key columns, not three.
    expect(peakBoundParams(low)).toBeGreaterThan(0);
    expect(peakBoundParams(low)).toBeLessThanOrEqual(2 * SWEEP_PAGE_SIZE + 1);
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

  it("reads every seeded notification binding at most a page's parameters per statement, oldest first", async () => {
    resetBoundParams(low);
    const result = await getUnreadForEmailFallback(low);
    expect(peakBoundParams(low)).toBeGreaterThan(0);
    expect(peakBoundParams(low)).toBeLessThanOrEqual(PAGE_PARAM_BOUND);
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

  it("reads every seeded overdue payment binding at most a page's parameters per statement", async () => {
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
    resetBoundParams(low);
    const result = await readDuePayments(recording, new Date(Date.now() - REMIND_EVERY_DAYS * DAY_MS));
    expect(peakBoundParams(low)).toBeGreaterThan(0);
    expect(peakBoundParams(low)).toBeLessThanOrEqual(PAGE_PARAM_BOUND);
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

describe('processClassReminders', () => {
  let low: PrismaClient;
  let teachers: SeededTeachers | undefined;
  // Every row is stored on tomorrow and has no registration, and no teacher
  // reminder is due by `now`: the read is all this exercises.
  const { tomorrow, justAfterMidnight: now } = todayUtc();
  let classIds: string[] = [];

  beforeAll(async () => {
    low = await lowStackClient();
    teachers = await seedTeachers(prisma, 11, 'ceiling-class-reminders');
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

  it("reads CEILING_ROWS in-window open classes binding at most a page's parameters per statement", async () => {
    if (!teachers) throw new Error('seed failed');
    const recorded = recordClassReads(low);
    const scoped = scopeSweep(recorded.client, {
      Class: { calendarEntry: { teacherId: { in: teachers.teacherIds } } },
    });
    resetBoundParams(low);
    await expect(processClassReminders(scoped.db, now)).resolves.toEqual({
      studentReminders: 0,
      teacherReminders: 0,
      emailFailures: 0,
    });
    expect(peakBoundParams(low)).toBeGreaterThan(0);
    expect(peakBoundParams(low)).toBeLessThanOrEqual(PAGE_PARAM_BOUND);
    expect(scoped.rowsRead('Class')).toBeGreaterThanOrEqual(CEILING_ROWS);
    expectReadExactlyOnce(recorded.ids, classIds);
    await expectLowered(scoped.db);
  }, 60_000);
});

/**
 * `count` regular classes for `teachers`' first teacher, one per day from
 * 2100-01-01 at 09:00, so none overlaps, written by one `generate_series`
 * statement. Returns the class ids.
 */
async function seedClassesBySql(
  db: PrismaClient,
  teachers: SeededTeachers,
  count: number,
): Promise<string[]> {
  const teacherId = teachers.teacherIds[0];
  const teacherRoomId = teachers.teacherRoomIds[0];
  if (!teacherId || !teacherRoomId) throw new Error('seedClassesBySql: no teacher seeded');
  await db.$executeRaw`
    WITH e AS (
      INSERT INTO "CalendarEntry" (id, "teacherId", kind, "classType", date, "startTime", "durationMinutes", "updatedAt")
      SELECT gen_random_uuid(), ${teacherId}, 'regular', 'Ceiling', DATE '2100-01-01' + g, TIME '09:00', 60, now()
      FROM generate_series(0, ${count - 1}::int) g
      RETURNING id)
    INSERT INTO "Class" (id, "calendarEntryId", kind, "teacherRoomId", currency, "roomCost", "minRate", "targetRate", "minStudents", "maxStudents", status, "updatedAt")
    SELECT gen_random_uuid(), e.id, 'regular', ${teacherRoomId}, 'EUR', 0, 0, 0, 0, 10, 'open', now() FROM e`;
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT c.id FROM "Class" c JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"
    WHERE e."teacherId" = ${teacherId}`;
  return rows.map((r) => r.id);
}

describe('bind-parameter limit', () => {
  let teachers: SeededTeachers | undefined;

  afterAll(async () => {
    await teachers?.cleanup();
  });

  it('an unpaged composite load over BIND_REFUSED_PARENTS parents is refused with P2029; BIND_LIMIT_PARENTS resolves', async () => {
    teachers = await seedTeachers(prisma, 1, 'ceiling-bind-limit');
    const ids = await seedClassesBySql(prisma, teachers, BIND_REFUSED_PARENTS);
    expect(ids).toHaveLength(BIND_REFUSED_PARENTS);
    await analyzeSeed(prisma);
    const load = (n: number, client: PrismaClient = prisma) =>
      client.class.findMany({ where: { id: { in: ids.slice(0, n) } }, include: { calendarEntry: true } });
    await expect(load(BIND_LIMIT_PARENTS)).resolves.toHaveLength(BIND_LIMIT_PARENTS);
    const low = await lowStackClient();
    try {
      await expect(load(BIND_LIMIT_PARENTS, low)).resolves.toHaveLength(BIND_LIMIT_PARENTS);
    } finally {
      await low.$disconnect();
    }
    const err: unknown = await load(BIND_REFUSED_PARENTS).then(
      () => 'resolved',
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2029');
  }, 120_000);
});
