import { readFileSync } from 'fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import type { ClassStatus } from '@prisma/client';
import { classifyApiError } from '@/lib/api-errors';
import { TERMINAL_CLASS_STATUSES } from './class-lifecycle';

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
 * `DATABASE_URL_TEST` unset it logs "CI mode" and returns, and
 * `vitest.config.ts` falls back to `DATABASE_URL` — dev. Worth stating because
 * `waitlist-retention.test.ts` shares this paragraph and is the case where it
 * matters: that suite runs a database-wide `deleteMany`, so it carries a
 * runtime guard on the connected database's name. THIS file is the harmless
 * twin — every row it touches is one it created, and it takes no unscoped
 * write. This file used to live in
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
 * fixture." The reasoning holds; the line range no longer does. It was exact
 * at the commit that shipped it — those six lines were precisely the `it.each`
 * through its `prisma.class.update({ data: { status } })`, verified against
 * that commit rather than assumed. An earlier version of this paragraph said
 * the range "did not [hold] even when it shipped," which is false, and false
 * in the one direction a citation correction must never be: it blamed the
 * original author for rot this branch caused. What actually broke it was #174
 * task 9's own one-line net addition higher up that same file, which pushed
 * the block down by one, so the cited range now stops one line short of the
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

/**
 * Turns a running total-minutes-from-9am into a valid `HH:MM`, wrapping into
 * the next hour rather than ever emitting an invalid minute like `'09:60'`
 * once the counter below crosses 60. `startTime` is a plain `String` with no
 * CHECK constraint, occupancy is string equality, and
 * `Class_teacher_slot_unique` compares strings too — so a raw `09:${counter}`
 * literal would accept an out-of-range value silently instead of exercising
 * the constraint this file's counter exists to dodge collisions with.
 * Mirrors `class-template-lifecycle.test.ts`'s `slotTime`.
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
let studentId: string;
const classIds: string[] = [];

// Counter-derived startTime: every test in this file calls makeClass once
// for the same teacher/date, and several tests deliberately drive their
// class to a non-cancelled terminal state ('completed') that keeps
// occupying its slot under Class_teacher_slot_unique for the rest of the
// run. No test here reads or asserts the created row's literal startTime,
// so a distinct minute per call removes the collision without touching any
// assertion. Routed through `slotTime` rather than a raw `09:${counter}`
// literal.
let makeClassCounter = 0;

async function makeClass(opts: { status: ClassStatus }): Promise<{ classId: string }> {
  makeClassCounter += 1;
  const cls = await prisma.class.create({
    data: {
      teacherId,
      teacherRoomId,
      classType: 'Terminal Status Test',
      date: new Date('2099-06-01'),
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

  /**
   * The `completed` arm, which had no test until #174's four-specialist
   * review found it unfalsifiable. Narrowing the trigger's guard from
   * `OLD.status IN ('completed','cancelled')` to `IN ('cancelled')` on the
   * test database left the whole `unit` project green at 562/562: the test
   * above only exercises `cancelled`, and the one below it updates a
   * non-status column, which a `BEFORE UPDATE OF status` trigger never fires
   * for at all.
   *
   * This is the arm that matters most. A `cancelled` class has no money
   * attached to it; a `completed` one has a `Payment` row per charged
   * registration and students who have been asked to pay. Cancelling it
   * behind their backs orphans those payments — which is exactly what
   * `deleteTeacherAccount`'s cancel CAS would do if it ever landed on a class
   * that completed after its own read, and why that CAS re-checks the status
   * in its `where`. This trigger is the backstop for every writer that
   * forgets to.
   *
   * The fixture carries a real `Payment` for that reason: the assertion is
   * not only that the status held, but that the money it guards is still
   * there and still attached to a completed class.
   */
  it('refuses to cancel a completed class, leaving its payments attached', async () => {
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
      await prisma.class.update({ where: { id: classId }, data: { status: 'cancelled' } });
    } catch (err) {
      caught = err;
    }

    // The same error shape as the `cancelled` arm above, asserted the same
    // way and for the same reason — see that test's comment for the observed
    // transcript. Both arms of one `IF` must surface identically, or a route
    // handles one and 500s on the other.
    expect(caught).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    expect(String(caught)).toMatch(/23514/);
    expect(String(caught)).toMatch(/which is terminal/);
    expect(String(caught)).toMatch(/is completed/);
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
   * the migration's own comment ("Fires only on an actual status change")
   * would then be describing behaviour that no longer exists.
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
    const { classId } = await makeClass({ status: 'open' });
    await prisma.class.updateMany({
      where: { id: classId, status: 'open' },
      data: { status: 'in_progress' },
    });
    await prisma.class.updateMany({
      where: { id: classId, status: 'in_progress' },
      data: { status: 'completed' },
    });

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
   * The same clause on the other terminal value, and with nothing else in the
   * `SET` list — the minimal case, so a failure here says "the `WHEN` clause
   * is gone" and not "a multi-column write regressed".
   */
  it('allows a no-op status write on a cancelled class', async () => {
    const { classId } = await makeClass({ status: 'open' });
    await prisma.class.updateMany({
      where: { id: classId, status: 'open' },
      data: { status: 'cancelled' },
    });

    await prisma.class.update({ where: { id: classId }, data: { status: 'cancelled' } });

    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.status).toBe('cancelled');
  });

  it('leaves a non-status, non-date update to a completed class alone', async () => {
    // Narrowed by #247. `date` is now guarded on a terminal class by a SECOND
    // trigger, `class_terminal_date_guard`, pinned in the sibling file
    // `class-terminal-date.test.ts`. This case is about THIS trigger's `OF
    // status` scope, so it deliberately writes neither column.
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

  /**
   * The pin between the reaper's safety predicate and the thing that actually
   * enforces it (#238).
   *
   * `waitlist-retention.ts` deletes rows on a class whose status is in
   * `TERMINAL_CLASS_STATUSES`, and its whole safety argument is "no writer can
   * ever touch those rows again". That argument rests on this trigger, whose
   * SQL hard-codes `('completed','cancelled')` and cannot be edited — it is an
   * applied migration. The constant, meanwhile, is DERIVED from
   * `VALID_TRANSITIONS`. Widen that table and the constant widens silently
   * while the trigger does not, and the reaper would then delete rows on a
   * class whose immutability nothing enforces.
   *
   * So this iterates the derived set rather than restating it. The two tests
   * that assert `classifyApiError(...).status === 409` — 'refuses to change the
   * status of a cancelled class, and says so with a matchable code' and
   * 'refuses to cancel a completed class, leaving its payments attached' — stay
   * as they are: they assert the trigger's error SHAPE end to end, including
   * the HTTP status a caller sees. This one adds the per-status sweep, and
   * asserts the Prisma error class, `23514` and `/which is terminal/` for each
   * member as well as the status surviving.
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
   * it can only ever catch the set growing past what the trigger enforces. Give
   * `cancelled` an outgoing transition in `VALID_TRANSITIONS` and the set
   * shrinks to `['completed']` — the reaper silently stops reaping cancelled
   * classes, and every pin above passes VACUOUSLY, because a case that is no
   * longer generated cannot fail. An empty set is the same hole at its limit,
   * hence the length assertion.
   *
   * Read out of the migration's own SQL rather than restated as a literal here,
   * so there is exactly one place the enforced set is written down and this
   * cannot drift from it by being edited in only one of two files.
   *
   * Regex over SQL is normally fragile; here it inverts. The file is an APPLIED
   * migration, which `CLAUDE.md` forbids editing, so the text this reads is
   * frozen by policy — and the `if (!m)` guard turns a shape change into a
   * named failure rather than a silent pass. No database is touched.
   */
  it('matches the exact status set the trigger SQL enforces', () => {
    const sql = readFileSync(
      new URL(
        '../../prisma/migrations/20260805120000_class_terminal_status_trigger/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    // `noUncheckedIndexedAccess` makes both capture groups possibly-undefined,
    // and the narrowing is kept rather than cast away: a `!` here would turn a
    // shape change into a runtime `undefined` inside the comparison, which is
    // the failure mode this pin exists to make loud.
    const inList = sql.match(/OLD\.status IN \(([^)]+)\)/)?.[1];
    if (!inList) throw new Error('trigger SQL no longer has the shape this pin reads');
    const enforced = [...inList.matchAll(/'([a-z_]+)'/g)]
      .map((x) => x[1])
      .filter((s): s is string => s !== undefined)
      .sort();

    expect(enforced.length).toBeGreaterThan(0);
    expect(TERMINAL_CLASS_STATUSES.length).toBeGreaterThan(0);
    expect([...TERMINAL_CLASS_STATUSES].sort()).toEqual(enforced);
  });
});
