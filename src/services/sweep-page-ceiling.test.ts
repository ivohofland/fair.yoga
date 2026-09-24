/**
 * The ceiling harness itself: a lowered `max_stack_depth` must split a
 * `SWEEP_PAGE_SIZE` parent set from a `CEILING_ROWS` one, on the raw SQL path
 * and on Prisma's relation-load path, and must not leak past its own client.
 * These cases are the ceiling tests' premise; the design is
 * `docs/superpowers/specs/2026-09-24-relation-load-paging-design.md`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { SWEEP_PAGE_SIZE } from '@/lib/read-in-pages';
import { autoCancelClasses, autoCompleteClasses, autoTransitionToInProgress } from './class-transitions';
import { createReconciliationStreaks, reconcileWaitlists } from './waitlist-reconciliation';
import { readGenerationCandidates } from './class-generator';
import { readStudioGenerationCandidates } from './studio-class-generator';
import { scopeSweep } from '../../tests/scoped-sweep';
import {
  CEILING_ROWS,
  CEILING_STACK,
  expectLowered,
  isStackDepthError,
  lowStackClient,
  seedClasses,
  seedTeachers,
  type SeededTeachers,
} from '../../tests/stack-ceiling';

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

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
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  beforeAll(async () => {
    low = await lowStackClient();
    teachers = await seedTeachers(prisma, 11, 'ceiling-auto-cancel');
    // `minStudents: 0`: a count of 0 is not below it, so every row is a no-op.
    await seedClasses(prisma, teachers, {
      rows: CEILING_ROWS,
      dates: [today],
      status: 'open',
      minStudents: 0,
      maxStudents: 10,
    });
  }, 60_000);

  afterAll(async () => {
    await teachers?.cleanup();
    await low?.$disconnect();
  });

  it('reads CEILING_ROWS in-window open classes under the lowered stack', async () => {
    if (!teachers) throw new Error('seed failed');
    const scoped = scopeSweep(low, {
      Class: { calendarEntry: { teacherId: { in: teachers.teacherIds } } },
    });
    await expect(autoCancelClasses(scoped.db, now)).resolves.toBe(0);
    expect(scoped.rowsRead('Class')).toBeGreaterThanOrEqual(CEILING_ROWS);
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

  beforeAll(async () => {
    low = await lowStackClient();
    teachers = await seedTeachers(prisma, 11, 'ceiling-auto-start');
    await seedClasses(prisma, teachers, {
      rows: CEILING_ROWS,
      dates: [tomorrow],
      status: 'open',
      minStudents: 0,
      maxStudents: 10,
    });
  }, 60_000);

  afterAll(async () => {
    await teachers?.cleanup();
    await low?.$disconnect();
  });

  it('reads CEILING_ROWS open classes under the lowered stack', async () => {
    if (!teachers) throw new Error('seed failed');
    const scoped = scopeSweep(low, {
      Class: { calendarEntry: { teacherId: { in: teachers.teacherIds } } },
    });
    await expect(autoTransitionToInProgress(scoped.db, now)).resolves.toBe(0);
    expect(scoped.rowsRead('Class')).toBeGreaterThanOrEqual(CEILING_ROWS);
    await expectLowered(scoped.db);
  });
});

describe('autoCompleteClasses', () => {
  let low: PrismaClient;
  let teachers: SeededTeachers | undefined;
  // No row has ended by `now`, so the pre-filter skips them all.
  const { tomorrow, justAfterMidnight: now } = todayUtc();

  beforeAll(async () => {
    low = await lowStackClient();
    teachers = await seedTeachers(prisma, 11, 'ceiling-auto-complete');
    await seedClasses(prisma, teachers, {
      rows: CEILING_ROWS,
      dates: [tomorrow],
      status: 'in_progress',
      minStudents: 0,
      maxStudents: 10,
    });
  }, 60_000);

  afterAll(async () => {
    await teachers?.cleanup();
    await low?.$disconnect();
  });

  it('reads CEILING_ROWS in-progress classes under the lowered stack', async () => {
    if (!teachers) throw new Error('seed failed');
    const scoped = scopeSweep(low, {
      Class: { calendarEntry: { teacherId: { in: teachers.teacherIds } } },
    });
    await expect(autoCompleteClasses(scoped.db, now)).resolves.toBe(0);
    expect(scoped.rowsRead('Class')).toBeGreaterThanOrEqual(CEILING_ROWS);
    await expectLowered(scoped.db);
  });
});

describe('reconcileWaitlists', () => {
  let low: PrismaClient;
  let teachers: SeededTeachers | undefined;
  let registeredId: string | undefined;
  let waitingId: string | undefined;
  const tag = `ceiling-reconcile-${Date.now()}`;

  beforeAll(async () => {
    low = await lowStackClient();
    teachers = await seedTeachers(prisma, 11, 'ceiling-reconcile');
    const dateCount = Math.ceil(CEILING_ROWS / (11 * 96));
    const dates = Array.from({ length: dateCount }, (_, i) => new Date(Date.UTC(2031, 0, 6 + i)));
    // `maxStudents: 1` and one registration each: every class is full, so
    // none is handed to `handleSpotFreed`.
    const { classIds } = await seedClasses(prisma, teachers, {
      rows: CEILING_ROWS,
      dates,
      status: 'open',
      minStudents: 0,
      maxStudents: 1,
    });
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
    const scoped = scopeSweep(low, {
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
    await expectLowered(scoped.db);
  });
});

/**
 * `CEILING_ROWS` `ScheduleRule` rows, split evenly across `teachers`, one
 * `dayOfWeek`/`startTime` slot each: `dayOfWeek = i % 7`, `startTime` a
 * 15-minute step at `floor(i / 7)` — at most 72 steps per day, inside the 96
 * available, so no two of one teacher's rows overlap under
 * `ScheduleRule_teacher_slot_excl`. `i` runs per teacher, so two teachers
 * never collide on `teacherId` either. Returns the rule ids in creation
 * order, round-robin across teachers, matching how each caller below pairs
 * them with its own child rows.
 */
async function seedScheduleRules(
  db: PrismaClient,
  teachers: SeededTeachers,
  kind: 'regular' | 'studio',
): Promise<{ ruleIds: string[] }> {
  const perTeacher = CEILING_ROWS / teachers.teacherIds.length;
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
  return { ruleIds };
}

describe('readGenerationCandidates', () => {
  let low: PrismaClient;
  let teachers: SeededTeachers | undefined;
  let ruleIds: string[] = [];
  const templateIds: string[] = [];

  beforeAll(async () => {
    low = await lowStackClient();
    teachers = await seedTeachers(prisma, 2, 'ceiling-class-gen');

    ({ ruleIds } = await seedScheduleRules(prisma, teachers, 'regular'));

    const perTeacher = CEILING_ROWS / teachers.teacherIds.length;
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
    for (const id of templateIds) {
      expect(ids.has(id)).toBe(true);
    }
    await expectLowered(low);
  });
});
