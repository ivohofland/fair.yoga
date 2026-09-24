/**
 * The ceiling harness itself: a lowered `max_stack_depth` must split a
 * `SWEEP_PAGE_SIZE` parent set from a `CEILING_ROWS` one, on the raw SQL path
 * and on Prisma's relation-load path, and must not leak past its own client.
 * These cases are the ceiling tests' premise; the design is
 * `docs/superpowers/specs/2026-09-24-relation-load-paging-design.md`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { SWEEP_PAGE_SIZE } from '@/lib/read-in-pages';
import { autoCancelClasses } from './class-transitions';
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
