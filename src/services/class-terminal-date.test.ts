import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import type { ClassStatus } from '@prisma/client';
import { classifyApiError } from '@/lib/api-errors';

/**
 * A pure DB-invariant test for `class_terminal_date_guard` (#247) — no HTTP
 * surface, nothing here calls the app on `:3000` — so it lives in the `unit`
 * project rather than `tests/integration/`. `vitest.config.ts` resolves the
 * unit project's `DATABASE_URL` to `DATABASE_URL_TEST` when that variable is
 * set, so this file reaches the isolated database with no shell override.
 * That matters here specifically: the integration project runs against the
 * DEV database (`docs/test-database.md` §3.4), so proving this trigger by
 * dropping it from there would need a manual override, and getting the
 * override wrong drops the trigger on dev.
 *
 * SEPARATE FROM `class-terminal-status.test.ts`, which already has these
 * fixtures. The duplication is bought deliberately: the two triggers have to
 * be droppable independently. A `DROP TRIGGER class_terminal_date_guard` that
 * reddens tests about the STATUS trigger would prove less than one that
 * reddens only this file, and that independence is the entire argument for
 * having two layers instead of one.
 *
 * WHY A DATABASE TRIGGER AND NOT ONLY `updateClass`. `waitlist-retention.ts`
 * permanently deletes unfulfilled queue entries on classes that are terminal
 * AND more than 365 days past their `date`. `class_terminal_status_guard`
 * enforces the first half; nothing enforced the second until this. The service
 * guard in `updateClass` covers every field and gives the teacher a 409, but
 * it covers one call site — this covers the column.
 *
 * Manual mutation-proof recipe, if this trigger is ever touched again —
 * against `DATABASE_URL_TEST`, never dev:
 *
 *   docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test \
 *     -c 'DROP TRIGGER class_terminal_date_guard ON "Class";'
 *   npx vitest run --project unit src/services/class-terminal-date.test.ts
 *   # first two tests fail: `caught` stays undefined, no exception to catch
 *
 * To restore: `CREATE OR REPLACE FUNCTION` is idempotent but `CREATE TRIGGER`
 * is not, so replaying the migration file only works while the trigger is
 * actually gone. Confirm it is, then:
 *
 *   docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test \
 *     < prisma/migrations/20260817120000_class_terminal_date_trigger/migration.sql
 *
 * or reset from scratch: `DATABASE_URL_TEST=... npx prisma migrate reset`.
 */
const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

/**
 * Turns a running total-minutes-from-9am into a valid `HH:MM`, wrapping into
 * the next hour rather than ever emitting an invalid minute like `'09:60'`.
 * `startTime` is a plain `String` with no CHECK constraint and
 * `Class_teacher_slot_unique` compares strings, so a raw `09:${counter}`
 * literal would accept an out-of-range value silently instead of exercising
 * the constraint this counter exists to dodge. Mirrors the helper of the same
 * name in `class-terminal-status.test.ts`.
 */
function slotTime(totalMinutesFrom9am: number): string {
  const hour = 9 + Math.floor(totalMinutesFrom9am / 60);
  const minute = totalMinutesFrom9am % 60;
  const startTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (!/^\d{2}:[0-5]\d$/.test(startTime)) {
    throw new Error(`slotTime produced an invalid startTime: ${startTime}`);
  }
  return startTime;
}

let teacherId: string;
let accountId: string;
let roomId: string;
let teacherRoomId: string;
const classIds: string[] = [];

const ORIGINAL_DATE = '2099-06-01';
let makeClassCounter = 0;

async function makeClass(opts: { status: ClassStatus }): Promise<{ classId: string }> {
  makeClassCounter += 1;
  const cls = await prisma.class.create({
    data: {
      teacherId,
      teacherRoomId,
      classType: 'Terminal Date Test',
      date: new Date(ORIGINAL_DATE),
      startTime: slotTime(makeClassCounter),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 8,
      status: opts.status,
    },
  });
  classIds.push(cls.id);
  return { classId: cls.id };
}

beforeAll(async () => {
  await prisma.$connect();

  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Terminal',
      lastName: 'Date',
      email: `terminal-date-${uniqueSuffix}@test.local`,
      account: { create: { email: `terminal-date-${uniqueSuffix}@test.local` } },
      bio: 'Terminal date trigger tests',
      pageSlug: `terminal-date-${uniqueSuffix}`,
    },
  });
  teacherId = teacher.id;
  accountId = teacher.accountId;

  const room = await prisma.room.create({
    data: {
      venueName: 'Terminal Date Studio',
      address: `${uniqueSuffix} Trigger St`,
      city: 'Amsterdam',
      postcode: '1234RA',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 20,
      createdById: teacherId,
    },
  });
  roomId = room.id;

  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId, roomId, capacityOverride: 15, rentalRate: 30 },
  });
  teacherRoomId = teacherRoom.id;
});

afterAll(async () => {
  await prisma.class.deleteMany({ where: { id: { in: classIds } } });
  await prisma.teacherRoom.deleteMany({ where: { id: teacherRoomId } });
  await prisma.room.deleteMany({ where: { id: roomId } });
  await prisma.teacher.deleteMany({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { id: accountId } });
  await prisma.$disconnect();
});

describe('class_terminal_date_guard', () => {
  it.each(['completed', 'cancelled'] as const)(
    'refuses to move a %s class to a past date, from raw SQL',
    async (status) => {
      const { classId } = await makeClass({ status: 'open' });
      await prisma.class.updateMany({ where: { id: classId, status: 'open' }, data: { status } });

      // Raw SQL, not `updateClass` — the point is that this holds with the
      // service layer, and Prisma's typed layer, entirely out of the picture.
      // `2020-01-01` is the exact date from issue #247: more than 365 days
      // past, so `reapClosedWaitlistEntries` would treat this class as
      // reapable.
      //
      // No `::uuid` cast on the id parameter, here or in the two cases below.
      // `Class.id` is Prisma `String @default(uuid())`, which is a `text`
      // column, not Postgres `uuid` — casting the bound parameter makes the
      // comparison `text = uuid` and the statement dies with `42883` before
      // the trigger is ever consulted.
      let caughtRaw: unknown;
      try {
        await prisma.$executeRaw`UPDATE "Class" SET date = '2020-01-01' WHERE id = ${classId}`;
      } catch (err) {
        caughtRaw = err;
      }

      // A `$executeRaw` failure is a PrismaClientKnownRequestError (P2010)
      // carrying the SQLSTATE in ``Code: `23514` `` framing — NOT the
      // PrismaClientUnknownRequestError the typed path below produces.
      // `src/lib/api-errors.ts` documents both shapes for `55P03` and the
      // split is the same here: the engine has a P-code for "raw query
      // failed" and none for "a trigger fired".
      expect(caughtRaw).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(String(caughtRaw)).toMatch(/23514/);
      expect(String(caughtRaw)).toMatch(/which is terminal/);
      expect(String(caughtRaw)).toMatch(new RegExp(`is ${status}`));

      // The typed path, which is the one production actually takes: of the
      // `class.update`/`updateMany` sites in `src/`, the only one that writes
      // `date` is `updateClass`. It is also the only shape
      // `isTerminalStatusViolation` matches, so the 409 claim has to be
      // pinned against this write rather than the raw one above — asserting
      // it on the raw error would assert something no caller can observe.
      let caught: unknown;
      try {
        await prisma.class.update({
          where: { id: classId },
          data: { date: new Date('2020-01-01') },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
      expect(String(caught)).toMatch(/23514/);
      expect(String(caught)).toMatch(/which is terminal/);
      expect(String(caught)).toMatch(new RegExp(`is ${status}`));

      // The route's own mapping, not a second copy of it: whatever
      // classifyApiError does with this shape is what a caller would see.
      expect(classifyApiError(caught).status).toBe(409);

      const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
      expect(after.date.toISOString().slice(0, 10)).toBe(ORIGINAL_DATE);
    },
  );

  it('allows a date change on a live class', async () => {
    // The test that proves the trigger CAN pass. Without it, a WHEN clause
    // mutated to fire unconditionally would still satisfy both cases above.
    const { classId } = await makeClass({ status: 'open' });

    await prisma.$executeRaw`UPDATE "Class" SET date = '2099-07-01' WHERE id = ${classId}`;

    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.date.toISOString().slice(0, 10)).toBe('2099-07-01');
  });

  it('allows a write that carries a terminal class\'s unchanged date alongside another column', async () => {
    // The IS DISTINCT FROM half of the WHEN clause, and the reason it is
    // there: `UPDATE OF date` fires whenever `date` is in the SET list, value
    // unchanged or not. Without this half, any future writer that carries the
    // current date along with the columns it means to change is rejected by a
    // guard aimed at something else — the same failure the sibling trigger
    // records for its own WHEN.
    const { classId } = await makeClass({ status: 'open' });
    await prisma.class.updateMany({
      where: { id: classId, status: 'open' },
      data: { status: 'completed' },
    });

    await prisma.$executeRaw`
      UPDATE "Class" SET date = ${new Date(ORIGINAL_DATE)}, description = 'Unchanged date'
      WHERE id = ${classId}`;

    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.description).toBe('Unchanged date');
    expect(after.date.toISOString().slice(0, 10)).toBe(ORIGINAL_DATE);
  });
});
