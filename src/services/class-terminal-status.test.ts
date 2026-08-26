import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import type { ClassStatus } from '@prisma/client';
import { classifyApiError } from '@/lib/api-errors';
import { TERMINAL_CLASS_STATUSES } from './class-lifecycle';
import { enforcedTerminalStatuses } from '../../tests/migration-sql';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture, slotDate } from '../../tests/class-fixtures';

/**
 * A pure DB-invariant test — no HTTP surface, nothing here calls the app on
 * `:3000` — so it lives here, in the `unit` project, rather than
 * `tests/integration/`. `vitest.config.ts` resolves the unit project's
 * `DATABASE_URL` to `DATABASE_URL_TEST` when that variable is set, so this
 * project reaches the isolated database with no shell override; the sibling
 * DB-invariant files it matches for shape (`class-lifecycle.test.ts`,
 * `gdpr.test.ts`) are unit-project files for the same reason.
 *
 * That is configuration, not a guard. `tests/setup/unit-db.ts` provisions and
 * migrates the test database; it does not force the switch. With
 * `DATABASE_URL_TEST` unset it returns early without provisioning, and
 * `vitest.config.ts` falls back to `DATABASE_URL` — dev. Worth stating because
 * `waitlist-retention.test.ts` shares this paragraph and is the case where it
 * matters: that suite runs a database-wide `deleteMany`, so it carries a
 * runtime guard on the connected database's name. THIS file is the harmless
 * twin — every row it touches is one it created, and it takes no unscoped
 * write.
 *
 * THE SUBJECT IS `class_terminal_status_guard`, and since #327 its terminal
 * set has one member. Cancellation is not a `ClassStatus` any more; it is
 * `CalendarEntry.cancelledAt`, and the arms of this trigger that used to guard
 * it — a cancelled class cannot leave its status, a completed class cannot be
 * cancelled — are `entry_terminal_liveness_guard` now, pinned in
 * `calendar-entry.test.ts` beside the other entry-level guards.
 *
 * Manual mutation-proof recipe, if this trigger is ever touched again —
 * against `DATABASE_URL_TEST`, never dev:
 *
 *   docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test \
 *     -c 'DROP TRIGGER class_terminal_status_guard ON "Class";'
 *   npx vitest run --project unit src/services/class-terminal-status.test.ts
 *   # first test fails: `caught` stays undefined, no exception to catch
 *
 * To restore, recreate the trigger by hand. Replaying its migration is not an
 * option: `CREATE OR REPLACE FUNCTION` is idempotent but `CREATE TRIGGER` is
 * not, and the file that carries both — `20260826080100_calendar_entry_rewire`
 * — also moves columns between tables and refuses to run against a populated
 * database at all.
 *
 *   docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test -c \
 *     'CREATE TRIGGER class_terminal_status_guard BEFORE UPDATE OF status
 *        ON "Class" FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
 *        EXECUTE FUNCTION class_reject_terminal_status_change();'
 */
const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

let teacherId: string;
let accountId: string;
let roomId: string;
let teacherRoomId: string;
let studentId: string;
const classIds: string[] = [];

/**
 * A DAY per fixture, not a minute. Every test here calls `makeClass` once for
 * the same teacher, and several drive their class to `completed`, which keeps
 * occupying its slot for the rest of the run. `CalendarEntry_teacher_slot_excl`
 * is a RANGE overlap since #327, so the per-call minute offset this file used
 * against the old exact-start key is no longer enough — two 60-minute classes
 * one minute apart overlap. `slotDate` (`tests/class-fixtures.ts`) owns that
 * reasoning; no test here reads or asserts a fixture's literal date.
 */
const FIXTURE_BASE = '2099-06-01';
let makeClassCounter = 0;

async function makeClass(opts: { status: ClassStatus }): Promise<{ classId: string }> {
  makeClassCounter += 1;
  const cls = await createClassFixture(prisma, {
    teacherId,
    teacherRoomId,
    classType: 'Terminal Status Test',
    date: slotDate(FIXTURE_BASE, makeClassCounter),
    startTime: hhmmToTime('09:00'),
    durationMinutes: 60,
    roomCost: 20,
    minRate: 15,
    targetRate: 25,
    minStudents: 1,
    maxStudents: 8,
    status: opts.status,
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

  const student = await prisma.student.create({
    data: {
      firstName: 'Terminal',
      lastName: 'Student',
      email: `terminal-status-student-${uniqueSuffix}@test.local`,
      incomeTier: 3,
    },
  });
  studentId = student.id;
});

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { registration: { classId: { in: classIds } } } });
  await prisma.registration.deleteMany({ where: { classId: { in: classIds } } });
  await prisma.student.deleteMany({ where: { id: studentId } });
  // Entries, not classes: `Class_calendarEntryId_kind_fkey` is
  // `ON DELETE CASCADE`, so deleting the entry takes its class with it, and
  // the entry is what would otherwise be left behind holding a slot.
  await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: { in: classIds } } } } });
  await prisma.teacherRoom.deleteMany({ where: { id: teacherRoomId } });
  await prisma.room.deleteMany({ where: { id: roomId } });
  await prisma.teacher.deleteMany({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { id: accountId } });
  await prisma.$disconnect();
});

describe('class_terminal_status_guard', () => {
  /**
   * The `completed` arm, which had no test until #174's four-specialist review
   * found it unfalsifiable. Narrowing the trigger's guard on the test database
   * left the whole `unit` project green: no case exercised `completed`, and
   * the cases below it update a non-status column, which a
   * `BEFORE UPDATE OF status` trigger never fires for at all.
   *
   * This is the arm that matters most, and since #327 it is the only one.
   * A completed class has a `Payment` row per charged registration and
   * students who have been asked to pay. Moving it back out of `completed`
   * behind their backs orphans those payments — which is what
   * `deleteTeacherAccount`'s cancel CAS would do if it ever landed on a class
   * that completed after its own read, and why that CAS re-checks the status
   * in its `where`. This trigger is the backstop for every writer that forgets
   * to.
   *
   * The fixture carries a real `Payment` for that reason: the assertion is not
   * only that the status held, but that the money it guards is still there and
   * still attached to a completed class.
   */
  it('refuses to move a completed class back out of completed, leaving its payments attached', async () => {
    const { classId } = await makeClass({ status: 'open' });
    const registration = await prisma.registration.create({
      data: { classId, studentId, status: 'attended', tierAtBooking: 3, price: 12.5 },
    });
    await prisma.payment.create({
      data: { registrationId: registration.id, amount: 12.5, status: 'pending' },
    });

    // Through the real lifecycle, one legal transition at a time, rather than
    // creating the class `completed` outright: `open -> completed` is not a
    // transition this app makes, and a fixture that skipped `in_progress`
    // would pin the trigger against a state the rest of the system cannot
    // produce.
    await prisma.class.updateMany({
      where: { id: classId, status: 'open' },
      data: { status: 'in_progress' },
    });
    await prisma.class.updateMany({
      where: { id: classId, status: 'in_progress' },
      data: { status: 'completed' },
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
    // wording. Asserting the class, not just a loose substring, is what would
    // have caught a regression to the wrong error shape.
    expect(caught).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    expect(String(caught)).toMatch(/23514/);
    expect(String(caught)).toMatch(/which is terminal/);
    expect(String(caught)).toMatch(/is completed/);

    // End-to-end pin, not just a unit test against a frozen fixture:
    // api-errors.test.ts feeds classifyApiError a hand-built string literal
    // shaped like this error, which proves the *matcher* is right about the
    // shape it was told to expect but not that the shape is still real. This
    // line closes that gap by running the real classifier against the real
    // error this test just caught — a Prisma upgrade that reshapes the
    // ConnectorError/PostgresError debug formatting the matcher depends on
    // fails here even if the frozen fixture in api-errors.test.ts stays green.
    expect(classifyApiError(caught).status).toBe(409);

    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.status).toBe('completed');

    // The stakes, spelled out: the payment is still there, still pending, and
    // still hanging off a class that is still completed.
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { registrationId: registration.id },
    });
    expect(payment.status).toBe('pending');
  });

  /**
   * The `WHEN (OLD.status IS DISTINCT FROM NEW.status)` clause, which nothing
   * pinned either — deleting it from the migration today breaks no test, and
   * the migration's own comment would then be describing behaviour that no
   * longer exists.
   *
   * The shape is `completeClass`'s (`class-lifecycle.ts`): `status` in the
   * `SET` list alongside the three financial columns, in one statement. What
   * `BEFORE UPDATE OF status` decides is whether the trigger runs at all
   * (column in the `SET` list — yes here, unlike the non-status test below);
   * what the `WHEN` clause decides is whether it then raises (value actually
   * changed — no here). Without the `WHEN`, a re-issued completion write, or
   * any future writer that carries the current status along with the columns
   * it means to change, is rejected by a guard aimed at something else
   * entirely.
   */
  it('allows a completeClass-shaped write that repeats a completed status alongside other columns', async () => {
    const { classId } = await makeClass({ status: 'completed' });

    await prisma.class.update({
      where: { id: classId },
      data: {
        status: 'completed',
        effectiveTeacherRate: 25,
        totalStudents: 1,
        totalRevenue: 45,
      },
    });

    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.status).toBe('completed');
    expect(Number(after.totalRevenue)).toBe(45);
    expect(after.totalStudents).toBe(1);
  });

  /**
   * The same clause with nothing else in the `SET` list — the minimal case, so
   * a failure here says "the `WHEN` clause is gone" and not "a multi-column
   * write regressed".
   */
  it('allows a bare no-op status write on a completed class', async () => {
    const { classId } = await makeClass({ status: 'completed' });

    await prisma.class.update({ where: { id: classId }, data: { status: 'completed' } });

    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.status).toBe('completed');
  });

  it('leaves a non-status update to a completed class alone', async () => {
    // The entry's `date`, `startTime` and `durationMinutes` are frozen on a
    // completed class by a SECOND trigger, `entry_frozen_schedule_guard`,
    // pinned in the sibling file `class-terminal-date.test.ts`. This case is
    // about THIS trigger's `OF status` scope, so it writes a column on the
    // class row that is neither.
    const { classId } = await makeClass({ status: 'completed' });

    await prisma.class.update({ where: { id: classId }, data: { description: 'Edited after' } });

    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.description).toBe('Edited after');
    expect(after.status).toBe('completed');
  });

  /**
   * The pin between the reaper's safety predicate and the thing that actually
   * enforces it (#238) — the STATUS half of it.
   *
   * `waitlist-retention.ts` deletes rows on a class that is terminal AND more
   * than 365 days past its `date`, and its whole safety argument is "no writer
   * can ever touch those rows again". Since #247 that argument rests on TWO
   * triggers, one per half of the predicate: this one freezes `status`, and
   * `entry_frozen_schedule_guard` freezes the entry's `date`, pinned in the
   * sibling file `class-terminal-date.test.ts` — which carries its own copy of
   * the drift pin below, read out of the other frozen text.
   *
   * Both triggers hard-code the terminal set in SQL that cannot be edited —
   * they are applied migrations. The constant, meanwhile, is DERIVED from
   * `VALID_TRANSITIONS`. Widen that table and the constant widens silently
   * while neither trigger does, and the reaper would then delete rows on a
   * class whose immutability nothing enforces.
   *
   * So this iterates the derived set rather than restating it. The test above
   * that asserts `classifyApiError(...).status === 409` stays as it is: it
   * asserts the trigger's error SHAPE end to end, including the HTTP status a
   * caller sees. This one adds the per-status sweep, and asserts the Prisma
   * error class, `23514` and `/which is terminal/` for each member as well as
   * the status surviving.
   */
  it.each(TERMINAL_CLASS_STATUSES)(
    'has a DB-enforced terminal %s, so the reaper may treat it as unwritable',
    async (status) => {
      const { classId } = await makeClass({ status });

      let caught: unknown;
      try {
        await prisma.class.update({ where: { id: classId }, data: { status: 'open' } });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
      expect(String(caught)).toMatch(/23514/);
      expect(String(caught)).toMatch(/which is terminal/);

      const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
      expect(after.status).toBe(status);
    },
  );

  /**
   * The same pin in the NARROWING direction, which nothing above catches.
   *
   * The `it.each` above only iterates what is IN `TERMINAL_CLASS_STATUSES`, so
   * it can only ever catch the set growing past what the trigger enforces.
   * Give `completed` an outgoing transition in `VALID_TRANSITIONS` and the set
   * empties — the reaper silently stops reaping, and every pin above passes
   * VACUOUSLY, because a case that is no longer generated cannot fail. Hence
   * the length assertion.
   *
   * Read out of the migration's own SQL rather than restated as a literal here,
   * so there is exactly one place the enforced set is written down and this
   * cannot drift from it by being edited in only one of two files.
   *
   * ANCHORED ON THE FUNCTION NAME, not on the directory. Both frozen texts now
   * live in that one migration, so the directory alone no longer identifies
   * which one a pin reads — `tests/migration-sql.ts` explains what that would
   * cost. This pin reads the guard; the sibling file reads the sync trigger.
   *
   * Regex over SQL is normally fragile; here it inverts. The file is an APPLIED
   * migration, which `CLAUDE.md` forbids editing, so the text this reads is
   * frozen by policy — and the throws in the parser turn a shape change into a
   * named failure rather than a silent pass. No database is touched.
   */
  it('matches the exact status set the guard SQL enforces', () => {
    const enforced = enforcedTerminalStatuses(
      '20260826080100_calendar_entry_rewire',
      'class_reject_terminal_status_change',
    );

    expect(enforced.length).toBeGreaterThan(0);
    expect(TERMINAL_CLASS_STATUSES.length).toBeGreaterThan(0);
    expect([...TERMINAL_CLASS_STATUSES].sort()).toEqual(enforced);
  });
});
