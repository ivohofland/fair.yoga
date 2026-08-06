import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import type { ClassStatus } from '@prisma/client';
import { classifyApiError } from '@/lib/api-errors';

/**
 * A pure DB-invariant test — no HTTP surface, nothing here calls the app on
 * `:3000` — so it lives here, in the `unit` project, rather than
 * `tests/integration/`. `tests/setup/unit-db.ts` forces this project onto
 * the isolated `DATABASE_URL_TEST` automatically; the sibling DB-invariant
 * files it matches for shape (`class-lifecycle.test.ts`, `gdpr.test.ts`) are
 * unit-project files for the same reason. This file used to live in
 * `tests/integration/`, which by design runs against the **dev** database
 * (`docs/test-database.md` §3.4) — every mutation-prove-the-trigger run
 * therefore needed a manual `DATABASE_URL` shell override to reach the test
 * DB instead, and getting that override wrong drops the trigger on dev.
 * Moving the file removes the foot-gun rather than documenting around it.
 *
 * Correction to the migration's own comment, which cannot be edited (the
 * migration is applied; `CLAUDE.md` forbids touching one). It explains that
 * the trigger enforces terminality only, not the whole `VALID_TRANSITIONS`
 * table, because mirroring the table would reject `open -> completed`, "which
 * class-template-lifecycle.test.ts:592-597 does deliberately when building a
 * fixture." The reasoning holds; the line range does not, and did not even
 * when it shipped — #174 task 9's own one-line edit to that file pushed the
 * block down, so the cited range no longer contains the
 * `prisma.class.update({ data: { status } })` that is the entire point of the
 * citation. The test it means is `class-template-lifecycle.test.ts`'s
 * "keeps a future %s class — outside the draft/open scope", whose `it.each`
 * runs `'in_progress'` and `'completed'`. Named rather than re-pinned: this
 * branch broke three line-number citations by moving code near them, and a
 * test name only rots if someone renames the test.
 *
 * Manual mutation-proof recipe, if this trigger is ever touched again —
 * against `DATABASE_URL_TEST`, never dev:
 *
 *   docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test \
 *     -c 'DROP TRIGGER class_terminal_status_guard ON "Class";'
 *   npx vitest run --project unit src/services/class-terminal-status.test.ts
 *   # first test fails: `caught` stays undefined, no exception to catch
 *
 * To restore: `CREATE OR REPLACE FUNCTION` (in the migration) is idempotent,
 * but `CREATE TRIGGER` is not — replaying the migration file only works
 * because the trigger was just dropped. Replaying it while the trigger still
 * exists fails with `trigger "class_terminal_status_guard" for relation
 * "Class" already exists`. Either confirm it's actually gone first, then:
 *
 *   docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test \
 *     < prisma/migrations/20260805120000_class_terminal_status_trigger/migration.sql
 *
 * or reset the whole test database from scratch instead of replaying by
 * hand: `DATABASE_URL_TEST=... npx prisma migrate reset` (safe — it never
 * touches dev).
 */
const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

let teacherId: string;
let accountId: string;
let roomId: string;
let teacherRoomId: string;
const classIds: string[] = [];

async function makeClass(opts: { status: ClassStatus }): Promise<{ classId: string }> {
  const cls = await prisma.class.create({
    data: {
      teacherId,
      teacherRoomId,
      classType: 'Terminal Status Test',
      date: new Date('2099-06-01'),
      startTime: '09:00',
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
      lastName: 'Status',
      email: `terminal-status-${uniqueSuffix}@test.local`,
      account: { create: { email: `terminal-status-${uniqueSuffix}@test.local` } },
      bio: 'Terminal status trigger tests',
      pageSlug: `terminal-status-${uniqueSuffix}`,
    },
  });
  teacherId = teacher.id;
  accountId = teacher.accountId;

  const room = await prisma.room.create({
    data: {
      venueName: 'Terminal Status Studio',
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

describe('class terminal status trigger', () => {
  it('refuses to change the status of a cancelled class, and says so with a matchable code', async () => {
    const { classId } = await makeClass({ status: 'open' });
    await prisma.class.updateMany({
      where: { id: classId, status: 'open' },
      data: { status: 'cancelled' },
    });

    let caught: unknown;
    try {
      await prisma.class.update({ where: { id: classId }, data: { status: 'open' } });
    } catch (err) {
      caught = err;
    }

    // Observed directly (see api-errors.ts's isTerminalStatusViolation
    // docblock for the full transcript): the trigger's `RAISE EXCEPTION`
    // reaches Prisma as PrismaClientUnknownRequestError, not
    // PrismaClientKnownRequestError — there is no P-code for "a trigger
    // fired", so it carries no `.code`/`.meta`, only a message with the raw
    // driver text embedded, including `code: "23514"` and this trigger's own
    // wording. Asserting the class, not just a loose substring, is what
    // would have caught a regression to the wrong error shape.
    expect(caught).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    expect(String(caught)).toMatch(/23514/);
    expect(String(caught)).toMatch(/which is terminal/);

    // End-to-end pin, not just a unit test against a frozen fixture:
    // api-errors.test.ts feeds classifyApiError a hand-built string literal
    // shaped like this error, which proves the *matcher* is right about the
    // shape it was told to expect but not that the shape is still real. This
    // line closes that gap by running the real classifier against the real
    // error this test just caught — a Prisma upgrade that reshapes the
    // ConnectorError/PostgresError debug formatting the matcher depends on
    // fails here even if the frozen fixture in api-errors.test.ts stays
    // green.
    expect(classifyApiError(caught).status).toBe(409);

    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.status).toBe('cancelled');
  });

  it('leaves non-status updates to a completed class alone', async () => {
    const { classId } = await makeClass({ status: 'open' });
    await prisma.class.updateMany({
      where: { id: classId, status: 'open' },
      data: { status: 'in_progress' },
    });
    await prisma.class.updateMany({
      where: { id: classId, status: 'in_progress' },
      data: { status: 'completed' },
    });

    await prisma.class.update({ where: { id: classId }, data: { description: 'Edited after' } });

    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.description).toBe('Edited after');
    expect(after.status).toBe('completed');
  });
});
