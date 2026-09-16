/**
 * @serial-tier lock-contention — drops `WaitlistEntry_waiting_position_key`
 * inside a transaction, which holds ACCESS EXCLUSIVE on `WaitlistEntry` until
 * the rollback, a table the parallel tier's waitlist tests write to.
 *
 * Runs the migration file's own statements against a class seeded with a
 * duplicate and a gap — the state the index refuses, so it can only be seeded
 * with the index dropped — then rolls everything back, index drop included.
 */
import { it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../../tests/class-fixtures';
import { stripSqlComments } from '../../tests/migration-sql';

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

const MIGRATION = new URL(
  '../../prisma/migrations/20260916120000_waitlist_waiting_position_unique/migration.sql',
  import.meta.url,
);

const TABLE_LOCK = /LOCK TABLE "WaitlistEntry" IN SHARE ROW EXCLUSIVE MODE;/;
const RENUMBER = /DO \$\$[\s\S]*?END \$\$;/;
const CREATE_INDEX = /CREATE UNIQUE INDEX[\s\S]*?;/;

/** The migration's text with its comments removed, so a commented-out statement is absent. */
function migrationSql(): string {
  return stripSqlComments(readFileSync(MIGRATION, 'utf8'));
}

function migrationStatements(): { tableLock: string; renumber: string; createIndex: string } {
  const sql = migrationSql();
  const tableLock = sql.match(TABLE_LOCK)?.[0];
  const renumber = sql.match(RENUMBER)?.[0];
  const createIndex = sql.match(CREATE_INDEX)?.[0];
  if (tableLock === undefined || renumber === undefined || createIndex === undefined) {
    throw new Error('the migration no longer has the three statements this test executes');
  }
  return {
    tableLock: tableLock.replace(/;\s*$/, ''),
    renumber,
    createIndex: createIndex.replace(/;\s*$/, ''),
  };
}

// A statement-order check on the file's text, not a behavioural pin: the race
// the lock closes is between this migration and an old app still writing
// during a deploy, which no test here stages.
it('takes the table lock before the renumber and the index build (statement-order check)', () => {
  const sql = migrationSql();
  const lockAt = sql.search(TABLE_LOCK);
  const renumberAt = sql.search(RENUMBER);
  const indexAt = sql.search(CREATE_INDEX);
  expect(lockAt).toBeGreaterThanOrEqual(0);
  expect(renumberAt).toBeGreaterThan(lockAt);
  expect(indexAt).toBeGreaterThan(renumberAt);
});

/** Carries the observations out of a transaction that must not commit. */
class Rollback extends Error {
  constructor(
    readonly rows: Array<{ label: string; position: number; status: string }>,
    readonly indexCount: number,
  ) {
    super('rollback');
  }
}

it('renumbers a duplicate and a gap to 1..n, then builds the index over the result', async () => {
  const suffix = `wl-mig-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Migration',
      lastName: 'Teacher',
      email: `${suffix}@test.local`,
      account: { create: { email: `${suffix}@test.local` } },
      bio: 'Waiting-position migration fixture',
      pageSlug: suffix,
    },
    select: { id: true, accountId: true },
  });
  const room = await prisma.room.create({
    data: {
      venueName: 'Migration Studio',
      address: `${suffix} St`,
      city: 'Amsterdam',
      postcode: '1234MG',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 20,
      createdById: teacher.id,
    },
    select: { id: true },
  });
  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 15, rentalRate: 30 },
    select: { id: true },
  });
  const cls = await createClassFixture(prisma, {
    teacherId: teacher.id,
    teacherRoomId: teacherRoom.id,
    classType: 'Migration class',
    date: new Date('2099-06-01'),
    startTime: hhmmToTime('09:00'),
    durationMinutes: 60,
    roomCost: 20,
    minRate: 15,
    targetRate: 25,
    minStudents: 1,
    maxStudents: 1,
    status: 'open',
  });
  const labels = ['a', 'b', 'c', 'd'] as const;
  const ids: Record<(typeof labels)[number], string> = { a: '', b: '', c: '', d: '' };
  for (const label of labels) {
    ids[label] = (
      await prisma.student.create({
        data: { firstName: 'Migration', lastName: label, email: `${suffix}-${label}@test.local`, incomeTier: 3 },
        select: { id: true },
      })
    ).id;
  }
  const labelOf = new Map(labels.map((l) => [ids[l], l] as const));
  const { tableLock, renumber, createIndex } = migrationStatements();
  const t0 = new Date('2099-01-01T00:00:00Z');
  const t1 = new Date('2099-01-01T00:00:01Z');

  // A box, not a `let`: an assignment inside the `.catch` callback below is
  // invisible to the compiler's narrowing of a local.
  const box: { observed?: Rollback } = {};
  try {
    await prisma
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('DROP INDEX "WaitlistEntry_waiting_position_key"');
          // a and b share position 2 (a is older); c sits after a gap; d is
          // closed at 1 and must be left alone.
          const seed = [
            { label: 'a', position: 2, status: 'waiting', createdAt: t0 },
            { label: 'b', position: 2, status: 'waiting', createdAt: t1 },
            { label: 'c', position: 5, status: 'waiting', createdAt: t0 },
            { label: 'd', position: 1, status: 'removed', createdAt: t0 },
          ] as const;
          for (const row of seed) {
            await tx.waitlistEntry.create({
              data: {
                classId: cls.id,
                studentId: ids[row.label],
                position: row.position,
                status: row.status,
                createdAt: row.createdAt,
              },
            });
          }
          await tx.$executeRawUnsafe(tableLock);
          await tx.$executeRawUnsafe(renumber);
          await tx.$executeRawUnsafe(createIndex);
          const rows = await tx.waitlistEntry.findMany({
            where: { classId: cls.id },
            select: { studentId: true, position: true, status: true },
            orderBy: { studentId: 'asc' },
          });
          const [index] = await tx.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_indexes
             WHERE indexname = 'WaitlistEntry_waiting_position_key'`;
          throw new Rollback(
            rows.map((r) => ({ label: labelOf.get(r.studentId) ?? '?', position: r.position, status: r.status })),
            index?.n ?? 0,
          );
        },
        { timeout: 10_000 },
      )
      .catch((err: unknown) => {
        if (err instanceof Rollback) box.observed = err;
        else throw err;
      });

    const observed = box.observed;
    expect(observed).toBeDefined();
    const byLabel = Object.fromEntries(observed!.rows.map((r) => [r.label, r]));
    expect(byLabel).toEqual({
      a: { label: 'a', position: 1, status: 'waiting' },
      b: { label: 'b', position: 2, status: 'waiting' },
      c: { label: 'c', position: 3, status: 'waiting' },
      d: { label: 'd', position: 1, status: 'removed' },
    });
    expect(observed!.indexCount).toBe(1);

    // The rollback restored the index the transaction dropped.
    const [after] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_indexes
       WHERE indexname = 'WaitlistEntry_waiting_position_key'`;
    expect(after?.n).toBe(1);
  } finally {
    await prisma.calendarEntry.deleteMany({ where: { teacherId: teacher.id } });
    await prisma.student.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: teacher.id } });
    await prisma.room.deleteMany({ where: { id: room.id } });
    await prisma.teacher.deleteMany({ where: { id: teacher.id } });
    await prisma.account.deleteMany({ where: { id: teacher.accountId } });
  }
});
