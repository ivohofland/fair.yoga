import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma, ClassStatus } from '@prisma/client';
import { classifyApiError } from '@/lib/api-errors';
import { TERMINAL_CLASS_STATUSES } from './class-lifecycle';
import { enforcedTerminalStatuses } from '../../tests/migration-sql';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../../tests/class-fixtures';

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
 *   # the two rejection cases fail: `caughtRaw` stays undefined, no exception
 *   # to catch. The allow-cases and the drift pin stay green — with no trigger
 *   # everything is allowed, and the pin reads a file, not the database.
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
 * the next hour rather than ever emitting an invalid minute like `'09:60'` —
 * a raw `09:${counter}` literal would build exactly that. `Class.startTime`
 * is `@db.Time` and would refuse the row outright at the DB, which is a less
 * useful failure here than this guard's message naming the counter that
 * produced it. Mirrors the helper of the same name in
 * `class-terminal-status.test.ts`.
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

/**
 * Derived, not listed. Every `ClassStatus` the trigger must NOT fire on is
 * whatever is left once the terminal set is removed — so adding a sixth
 * status to the enum extends the allow-case below automatically, and widening
 * `TERMINAL_CLASS_STATUSES` removes it from here and adds it to the rejection
 * cases in the same edit. Mirrors the intent of `class-lifecycle.test.ts`'s
 * `['draft', 'open', 'in_progress']` control, which exists so that a mutation
 * freezing a non-terminal status is caught by design rather than by accident;
 * this version cannot fall behind the enum the way that literal can.
 */
const NON_TERMINAL_STATUSES = Object.values(ClassStatus).filter(
  (s) => !TERMINAL_CLASS_STATUSES.includes(s),
);

let makeClassCounter = 0;

async function makeClass(opts: { status: ClassStatus }): Promise<{ classId: string }> {
  makeClassCounter += 1;
  const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'Terminal Date Test',
      date: new Date(ORIGINAL_DATE),
      startTime: hhmmToTime(slotTime(makeClassCounter)),
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
  // Driven by `TERMINAL_CLASS_STATUSES`, not by a `['completed', 'cancelled']`
  // literal. Widen the derived set and these rejection cases widen with it, so
  // a status that the reaper starts treating as unwritable is proved
  // unwritable HERE too, in the same edit. The literal could not: it would go
  // on testing the old two while the reaper deleted rows on the new third.
  it.each(TERMINAL_CLASS_STATUSES)(
    'refuses to move a %s class to a past date, from raw SQL',
    async (status) => {
      // Inserted terminal directly. Both terminality guards are BEFORE
      // UPDATE triggers, so an INSERT with a terminal status is unaffected and
      // the row's state at the point of the date write below is identical to
      // what a create-then-flip would produce. The intermediate `open` state
      // is never read or asserted, so the extra statement covered nothing.
      const { classId } = await makeClass({ status });

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

      // The typed path, which is the one production actually takes: of the 13
      // NON-TEST `class.update`/`updateMany` sites in `src/`, the only one
      // that writes `date` is `updateClass`. The qualifier is not pedantry —
      // this very file issues a `prisma.class.update` writing `date` eight
      // lines below, as do four cases in `class-transitions.test.ts`, so
      // without "non-test" the sentence is refuted by its own test body. It is also the only shape
      // `isTerminalStatusViolation` matches, so the 409 claim has to be
      // pinned against this write rather than the raw one above — asserting
      // it on the raw error would assert something no caller can observe.
      let caught: unknown;
      try {
        await prisma.calendarEntry.update({
      where: { id: (await prisma.class.findUniqueOrThrow({ where: { id: classId }, select: { calendarEntryId: true } })).calendarEntryId },
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

      const after = await prisma.class.findUniqueOrThrow({ where: { id: classId }, include: { calendarEntry: true } });
      expect(after.calendarEntry.date.toISOString().slice(0, 10)).toBe(ORIGINAL_DATE);
    },
  );

  // The cases that prove the trigger CAN pass. Without them, a WHEN clause
  // mutated to fire unconditionally would still satisfy every case above.
  //
  // Every non-terminal status, not just `open`. `in_progress` is the one that
  // earns the sweep: the teacher edit page redirects away from it, so it is
  // easy to assume a freeze there is harmless — but the API allows that edit
  // and should, and a guard widened from `IN ('completed','cancelled')` to
  // "anything past draft" would pass a single-status `open` control while
  // breaking a real write. `draft` covers the same mutation from the other
  // end.
  it.each(NON_TERMINAL_STATUSES)('allows a date change on a %s class', async (status) => {
    const { classId } = await makeClass({ status });

    await prisma.$executeRaw`UPDATE "Class" SET date = '2099-07-01' WHERE id = ${classId}`;

    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId }, include: { calendarEntry: true } });
    expect(after.calendarEntry.date.toISOString().slice(0, 10)).toBe('2099-07-01');
  });

  it('allows a write that carries a terminal class\'s unchanged date alongside another column', async () => {
    // The IS DISTINCT FROM half of the WHEN clause. The migration's own
    // comment argues why it is there (`UPDATE OF date` fires on presence in
    // the SET list, not on change) and both triggers record it; this test is
    // the part that cannot live in the SQL — a writer that carries the
    // unchanged date alongside a column it does mean to change, proved to get
    // through.
    const { classId } = await makeClass({ status: 'completed' });

    // `${ORIGINAL_DATE}::date`, NOT `${new Date(ORIGINAL_DATE)}`. Binding a JS
    // Date sends a timestamptz, which Postgres narrows to `date` using the
    // SESSION time zone — so the "unchanged" date silently becomes the
    // previous day under any westward session, the WHEN clause's
    // `IS DISTINCT FROM` then holds, and this case fails claiming the trigger
    // is wrong when only the clock was. It round-trips here because the
    // session is UTC, which is exactly the kind of accident this repo has
    // shipped before (see the warning comment in `prisma/seed.ts`). A plain
    // date string has no zone to misread.
    await prisma.$executeRaw`
      UPDATE "Class" SET date = ${ORIGINAL_DATE}::date, description = 'Unchanged date'
      WHERE id = ${classId}`;

    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId }, include: { calendarEntry: true } });
    expect(after.description).toBe('Unchanged date');
    expect(after.calendarEntry.date.toISOString().slice(0, 10)).toBe(ORIGINAL_DATE);
  });

  /**
   * The same drift pin `class-terminal-status.test.ts` ends with, applied to
   * the other half of the same predicate — and it has to be a SECOND pin, not
   * a reuse of that one, because the two triggers hard-code
   * `('completed','cancelled')` in two different applied migrations that
   * nothing forces to agree.
   *
   * `reapClosedWaitlistEntries` permanently deletes rows on a class that is
   * terminal AND more than 365 days past its `date`. Its safety argument is
   * "no writer can ever touch those rows again", and that argument now rests
   * on two triggers: the sibling freezes `status`, this one freezes `date`.
   * `TERMINAL_CLASS_STATUSES` is DERIVED from `VALID_TRANSITIONS`, while both
   * triggers restate the set as frozen SQL. Widen the transition table and the
   * constant widens silently, the reaper starts reaping a third status — and
   * without this pin the DATE half would go unenforced for it with nothing
   * red. The sibling's pin would still pass: it only reads its own migration.
   *
   * The rejection `it.each` catches the set GROWING (a new terminal status
   * gets a rejection case that fails, because the SQL does not cover it). It
   * cannot catch the set SHRINKING: give `cancelled` an outgoing transition
   * and the set becomes `['completed']`, and every case it still generates
   * passes, because a case that is no longer generated cannot fail.
   *
   * Not the only thing that notices a shrink, and the honest version of this
   * paragraph says so: `NON_TERMINAL_STATUSES` is the enum minus the terminal
   * set, so a status leaving that set arrives in the allow-`it.each` directly
   * above, where the raw date update meets SQL that still names it and throws
   * `23514`. That case reddens too.
   *
   * This pin earns its place on two other grounds. It fails with a NAMED
   * diagnostic — the two sets printed side by side — where the allow-case
   * fails with a bare `23514` that reads as "the trigger is broken" rather
   * than "the constant and the SQL have drifted apart", and misreading that
   * points the next person at the migration instead of at
   * `VALID_TRANSITIONS`. And it covers the limit neither `it.each` reaches:
   * empty the terminal set and BOTH families generate vacuously — no
   * rejection cases at all, and allow-cases that pass honestly — while the
   * reaper stops reaping entirely. That is what the two length assertions are
   * for.
   *
   * Read out of the migration's own SQL rather than restated here, so the
   * enforced set is written down in exactly one place. The parsing lives in
   * `tests/migration-sql.ts`, shared with the sibling pin — two pins, one
   * regex: each must read its OWN migration, but neither needs its own copy
   * of the fragile part. Reads a file; touches no database.
   */
  it('matches the exact status set the trigger SQL enforces', () => {
    const enforced = enforcedTerminalStatuses('20260817120000_class_terminal_date_trigger');

    expect(enforced.length).toBeGreaterThan(0);
    expect(TERMINAL_CLASS_STATUSES.length).toBeGreaterThan(0);
    expect([...TERMINAL_CLASS_STATUSES].sort()).toEqual(enforced);
  });
});
