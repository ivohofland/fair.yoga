/**
 * @serial-tier lock-contention — each case holds a real row lock on a second
 * connection until the request under test is confirmed parked behind it, via
 * `pg_blocking_pids`. Lock noise from a neighbour in the parallel tier would
 * stretch that wait past the window the poll allows.
 *
 * The currency switch against the writers it must not interleave with (#758,
 * spec A2; `docs/lock-order.md`, "The `Teacher` row is the first lock
 * (#758)"):
 *
 * - a first booking flipping `settingsLocked` while the switch waits on the
 *   class row: the switch's predicate is re-checked under its lock, so the
 *   booked class keeps its currency;
 * - a generation holding its template row while it inserts a class: the
 *   switch waits on the template, then sees and relabels that class;
 * - a creator under no existing template, while a switch holds the teacher
 *   row: the creator waits on the teacher and stamps the new currency.
 *
 * The holder writes, then waits for the request to park behind it, then
 * commits. Each case asserts on the rows first and on `parked` second, so a
 * request that never waited fails on the currency it wrote rather than only on
 * the handshake.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, Prisma } from '@prisma/client';
import { fixtureRun, type RoomFixture } from '../../tests/room-fixtures';
import { createClassFixture, createStudioClassFixture } from '../../tests/class-fixtures';
import { cookie, seedSession } from '../../tests/helpers';
import { hhmmToTime } from '@/lib/time-of-day';
import { switchTeacherCurrency } from './currency-switch';
import { createClassTemplate } from './class-template-lifecycle';
import { createStudioClassTemplate } from './studio-class-template-lifecycle';
import { POST as postClass } from '@/app/api/classes/route';
import { POST as postStudioClass } from '@/app/api/studio-classes/route';

const prisma = new PrismaClient();
const fx = fixtureRun('curswl');
const WAIT_MS = 1_500;
const CASE_TIMEOUT_MS = 20_000;

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  const accounts = await prisma.teacher.findMany({
    where: { pageSlug: { startsWith: fx.suffix } },
    select: { accountId: true },
  });
  await prisma.session.deleteMany({ where: { accountId: { in: accounts.map((a) => a.accountId) } } });
  await fx.cleanup(prisma);
  await prisma.$disconnect();
});

function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

async function ownPid(tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
  if (row === undefined) throw new Error('pg_backend_pid returned no row');
  return row.pid;
}

/** The pid of a backend waiting on a lock `holderPid` holds, or null if none appears in time. */
async function waiterOf(holderPid: number, stop: () => boolean): Promise<number | null> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && !stop()) {
    const [row] = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND ${holderPid} = ANY(pg_blocking_pids(pid))
       LIMIT 1`;
    if (row !== undefined) return row.pid;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

/**
 * Runs `hold` on a second connection and keeps its transaction open, starts
 * `request`, and commits the holder only once `request` is parked behind it
 * (or has settled, or the poll gave up). `parked` says which.
 */
async function raceBehindHolder<T>(
  hold: (tx: Prisma.TransactionClient) => Promise<void>,
  request: () => Promise<T>,
): Promise<{ result: T; parked: boolean }> {
  const holder = new PrismaClient();
  const held = latch();
  const release = latch();
  let holderPid = 0;
  const holding = holder.$transaction(async (tx) => {
    holderPid = await ownPid(tx);
    await hold(tx);
    held.open();
    await release.promise;
  }, { timeout: CASE_TIMEOUT_MS });
  try {
    await Promise.race([held.promise, holding]);
    let settled = false;
    const pending = request().finally(() => { settled = true; });
    void pending.catch(() => undefined);
    const parked = (await waiterOf(holderPid, () => settled)) !== null;
    release.open();
    await holding;
    return { result: await pending, parked };
  } finally {
    release.open();
    await holding.catch(() => undefined);
    await holder.$disconnect();
  }
}

async function utcTeacher(): Promise<RoomFixture & { accountId: string }> {
  const f = await fx.makeFixture(prisma);
  const { accountId } = await prisma.teacher.update({
    where: { id: f.teacherId },
    data: { defaultTimezone: 'UTC' },
    select: { accountId: true },
  });
  return { ...f, accountId };
}

function daysAhead(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function openClass(
  db: PrismaClient | Prisma.TransactionClient,
  f: RoomFixture,
  n: number,
  scheduleRuleId?: string,
) {
  return createClassFixture(db, {
    teacherId: f.teacherId,
    teacherRoomId: f.linkId,
    classType: 'Vinyasa',
    date: daysAhead(n),
    startTime: hhmmToTime('10:00'),
    durationMinutes: 60,
    roomCost: new Prisma.Decimal(20),
    minRate: new Prisma.Decimal(15),
    targetRate: new Prisma.Decimal(25),
    minStudents: 2,
    maxStudents: 10,
    status: 'open',
    currency: 'EUR',
    ...(scheduleRuleId !== undefined ? { scheduleRuleId } : {}),
  });
}

const switchToGbp = (teacherId: string) =>
  prisma.$transaction((tx) => switchTeacherCurrency(tx, teacherId, 'GBP'), { timeout: CASE_TIMEOUT_MS });

/** A switch standing in the teacher row: the lock it takes first, and the write it ends with. */
async function holdTeacherSwitchingToGbp(tx: Prisma.TransactionClient, teacherId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Teacher" WHERE id = ${teacherId} FOR NO KEY UPDATE`;
  await tx.$executeRaw`UPDATE "Teacher" SET currency = 'GBP' WHERE id = ${teacherId}`;
}

async function classCurrencies(teacherId: string): Promise<string[]> {
  const rows = await prisma.class.findMany({
    where: { calendarEntry: { teacherId } },
    select: { currency: true },
  });
  return rows.map((r) => r.currency);
}

describe('the currency switch against a first booking (#758)', () => {
  it('keeps the currency of a class booked while the switch waited on it', async () => {
    const f = await utcTeacher();
    const cls = await openClass(prisma, f, 10);

    const { result, parked } = await raceBehindHolder(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${cls.id} FOR UPDATE`;
        await tx.$executeRaw`UPDATE "Class" SET "settingsLocked" = true WHERE id = ${cls.id}`;
      },
      () => switchToGbp(f.teacherId),
    );

    expect(
      await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, select: { currency: true, settingsLocked: true } }),
    ).toEqual({ currency: 'EUR', settingsLocked: true });
    expect(result).toEqual({
      relabelled: { classes: 0, studioClasses: 0 },
      kept: [{ currency: 'EUR', classes: 1, studioClasses: 0 }],
    });
    expect(parked).toBe(true);
  }, CASE_TIMEOUT_MS);
});

describe('the currency switch against a generation (#758)', () => {
  it('relabels a class a generation inserted while the switch waited on its template', async () => {
    const f = await utcTeacher();
    const template = await fx.addTemplate(prisma, f, { isActive: true, isArchived: false });
    let generatedId = '';

    const { parked } = await raceBehindHolder(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ClassTemplate" WHERE id = ${template.id} FOR UPDATE`;
        generatedId = (await openClass(tx, f, 14, template.scheduleRuleId)).id;
      },
      () => switchToGbp(f.teacherId),
    );

    expect(generatedId).not.toBe('');
    expect(
      (await prisma.class.findUniqueOrThrow({ where: { id: generatedId }, select: { currency: true } })).currency,
    ).toBe('GBP');
    expect(parked).toBe(true);
  }, CASE_TIMEOUT_MS);

  it('relabels a studio class a generation inserted while the switch waited on its template', async () => {
    const f = await utcTeacher();
    const template = await prisma.studioClassTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId: f.teacherId,
            kind: 'studio',
            classType: 'Studio flow',
            dayOfWeek: 4,
            startTime: hhmmToTime('19:00'),
            durationMinutes: 60,
          },
        },
        location: 'Gym',
        hourlyRate: new Prisma.Decimal(40),
      },
    });
    let generatedId = '';

    const { parked } = await raceBehindHolder(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "StudioClassTemplate" WHERE id = ${template.id} FOR UPDATE`;
        generatedId = (await createStudioClassFixture(tx, {
          teacherId: f.teacherId,
          classType: 'Studio flow',
          date: daysAhead(14),
          startTime: hhmmToTime('19:00'),
          durationMinutes: 60,
          scheduleRuleId: template.scheduleRuleId,
          location: 'Gym',
          hourlyRate: new Prisma.Decimal(40),
          currency: 'EUR',
        })).id;
      },
      () => switchToGbp(f.teacherId),
    );

    expect(generatedId).not.toBe('');
    expect(
      (await prisma.studioClass.findUniqueOrThrow({ where: { id: generatedId }, select: { currency: true } })).currency,
    ).toBe('GBP');
    expect(parked).toBe(true);
  }, CASE_TIMEOUT_MS);
});

describe('a create under no existing template against a switch holding the teacher (#758)', () => {
  it('POST /api/classes waits for the switch and stamps its currency', async () => {
    const f = await utcTeacher();
    const token = await seedSession(prisma, f.accountId);

    const { result: res, parked } = await raceBehindHolder(
      (tx) => holdTeacherSwitchingToGbp(tx, f.teacherId),
      () => postClass(new NextRequest('http://localhost:3000/api/classes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(token) },
        body: JSON.stringify({
          teacherRoomId: f.linkId,
          classType: 'Hatha',
          date: isoDay(daysAhead(9)),
          startTime: '18:00',
          durationMinutes: 60,
          roomCost: 20,
          minRate: 15,
          targetRate: 25,
          minStudents: 2,
          maxStudents: 10,
        }),
      })),
    );

    expect(res.status).toBe(201);
    expect(await classCurrencies(f.teacherId)).toEqual(['GBP']);
    expect(parked).toBe(true);
  }, CASE_TIMEOUT_MS);

  // The lock sequence, not just the outcome: parked on its room's
  // `FOR KEY SHARE`, the create must already hold the `Teacher` row, so a
  // switch's `FOR NO KEY UPDATE` probe is refused.
  it('POST /api/classes takes the Teacher row before its room', async () => {
    const f = await utcTeacher();
    const token = await seedSession(prisma, f.accountId);
    const holder = new PrismaClient();
    const held = latch();
    const release = latch();
    let holderPid = 0;
    const holding = holder.$transaction(async (tx) => {
      holderPid = await ownPid(tx);
      await tx.$queryRaw`SELECT id FROM "TeacherRoom" WHERE id = ${f.linkId} FOR UPDATE`;
      held.open();
      await release.promise;
    }, { timeout: CASE_TIMEOUT_MS });
    try {
      await Promise.race([held.promise, holding]);
      let settled = false;
      const pending = postClass(new NextRequest('http://localhost:3000/api/classes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(token) },
        body: JSON.stringify({
          teacherRoomId: f.linkId,
          classType: 'Hatha',
          date: isoDay(daysAhead(9)),
          startTime: '18:00',
          durationMinutes: 60,
          roomCost: 20,
          minRate: 15,
          targetRate: 25,
          minStudents: 2,
          maxStudents: 10,
        }),
      })).finally(() => { settled = true; });
      void pending.catch(() => undefined);
      const parked = (await waiterOf(holderPid, () => settled)) !== null;

      // While the create is still parked on the room, before the holder lets go.
      const probe = await prisma
        .$transaction((tx) => tx.$queryRaw`SELECT id FROM "Teacher" WHERE id = ${f.teacherId} FOR NO KEY UPDATE NOWAIT`)
        .then(() => 'free', (err: unknown) => (String(err).includes('55P03') ? 'held' : `error: ${String(err)}`));

      release.open();
      await holding;
      const res = await pending;

      expect(probe).toBe('held');
      expect(res.status).toBe(201);
      expect(parked).toBe(true);
    } finally {
      release.open();
      await holding.catch(() => undefined);
      await holder.$disconnect();
    }
  }, CASE_TIMEOUT_MS);

  it('POST /api/studio-classes waits for the switch and stamps its currency', async () => {
    const f = await utcTeacher();
    const token = await seedSession(prisma, f.accountId);

    const { result: res, parked } = await raceBehindHolder(
      (tx) => holdTeacherSwitchingToGbp(tx, f.teacherId),
      () => postStudioClass(new NextRequest('http://localhost:3000/api/studio-classes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(token) },
        body: JSON.stringify({
          classType: 'Studio flow',
          date: isoDay(daysAhead(9)),
          startTime: '18:00',
          durationMinutes: 60,
          location: 'Gym',
          hourlyRate: 40,
        }),
      })),
    );

    expect(res.status).toBe(201);
    const rows = await prisma.studioClass.findMany({
      where: { calendarEntry: { teacherId: f.teacherId } },
      select: { currency: true },
    });
    expect(rows.map((r) => r.currency)).toEqual(['GBP']);
    expect(parked).toBe(true);
  }, CASE_TIMEOUT_MS);

  it('createClassTemplate waits for the switch and stamps its first window', async () => {
    const f = await utcTeacher();

    const { result, parked } = await raceBehindHolder(
      (tx) => holdTeacherSwitchingToGbp(tx, f.teacherId),
      () => createClassTemplate(prisma, f.teacherId, {
        teacherRoomId: f.linkId,
        classType: 'Hatha',
        dayOfWeek: 3,
        startTime: '18:00',
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 2,
        maxStudents: 10,
      }),
    );

    expect(result.ok).toBe(true);
    const stamped = await classCurrencies(f.teacherId);
    expect(stamped.length).toBeGreaterThan(0);
    expect(new Set(stamped)).toEqual(new Set(['GBP']));
    expect(parked).toBe(true);
  }, CASE_TIMEOUT_MS);

  it('createStudioClassTemplate waits for the switch and stamps its first window', async () => {
    const f = await utcTeacher();

    const { result, parked } = await raceBehindHolder(
      (tx) => holdTeacherSwitchingToGbp(tx, f.teacherId),
      () => createStudioClassTemplate(prisma, f.teacherId, {
        classType: 'Studio flow',
        dayOfWeek: 3,
        startTime: '18:00',
        durationMinutes: 60,
        location: 'Gym',
        hourlyRate: 40,
      }),
    );

    expect(result.ok).toBe(true);
    const rows = await prisma.studioClass.findMany({
      where: { calendarEntry: { teacherId: f.teacherId } },
      select: { currency: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.currency))).toEqual(new Set(['GBP']));
    expect(parked).toBe(true);
  }, CASE_TIMEOUT_MS);
});
