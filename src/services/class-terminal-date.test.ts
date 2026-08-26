import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma, ClassStatus } from '@prisma/client';
import { classifyApiError } from '@/lib/api-errors';
import { TERMINAL_CLASS_STATUSES } from './class-lifecycle';
import { enforcedTerminalStatuses } from '../../tests/migration-sql';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture, slotDate } from '../../tests/class-fixtures';

/**
 * A pure DB-invariant test for `entry_frozen_schedule_guard` — no HTTP
 * surface, nothing here calls the app on `:3000` — so it lives in the `unit`
 * project rather than `tests/integration/`. `vitest.config.ts` resolves the
 * unit project's `DATABASE_URL` to `DATABASE_URL_TEST` when that variable is
 * set, so this file reaches the isolated database with no shell override.
 * That matters here specifically: the integration project runs against the
 * DEV database (`docs/test-database.md` §3.4), so proving this trigger by
 * dropping it from there would need a manual override, and getting the
 * override wrong drops the trigger on dev.
 *
 * WHAT THIS FILE PINS, AND WHAT `calendar-entry.test.ts` PINS. That file owns
 * the guard's own shape — the three columns it names, the `kind` asymmetry,
 * the marker the sync trigger writes — asserted through raw SQL against bare
 * entries. This one comes at the same guard from the `Class` side: the
 * rejection set is DERIVED from `TERMINAL_CLASS_STATUSES` rather than listed,
 * it observes both Prisma error shapes, and it runs the real
 * `classifyApiError` over the real thrown error so the 409 a caller sees is
 * pinned to something the database actually raised.
 *
 * SEPARATE FROM `class-terminal-status.test.ts`, which already has these
 * fixtures. The duplication is bought deliberately: the two triggers have to
 * be droppable independently. A `DROP TRIGGER entry_frozen_schedule_guard`
 * that reddens tests about the STATUS trigger would prove less than one that
 * reddens only this file, and that independence is the entire argument for
 * having two layers instead of one.
 *
 * WHY A DATABASE TRIGGER AND NOT ONLY `updateClass`. `waitlist-retention.ts`
 * permanently deletes unfulfilled queue entries on classes that are terminal
 * AND more than 365 days past their `date`. `class_terminal_status_guard`
 * enforces the first half; nothing enforced the second until #247. The service
 * guard in `updateClass` covers every field and gives the teacher a 409, but
 * it covers one call site — this covers the column.
 *
 * TERMINALITY REACHES THE ENTRY AS A MARKER (#327). The guard is single-table:
 * it reads `CalendarEntry.classCompletedAt`, which `class_sync_entry_completed`
 * stamps from the `Class` side, rather than reading `Class.status` across the
 * tables and inverting the lock order every other writer of this pair takes.
 * So a mutation that stops the marker being written un-freezes every completed
 * entry, and the cases below fall with it.
 *
 * Manual mutation-proof recipe, if this trigger is ever touched again —
 * against `DATABASE_URL_TEST`, never dev:
 *
 *   docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test \
 *     -c 'DROP TRIGGER entry_frozen_schedule_guard ON "CalendarEntry";'
 *   npx vitest run --project unit src/services/class-terminal-date.test.ts
 *   # the rejection case fails: `caughtRaw` stays undefined, no exception to
 *   # catch. The allow-cases and the drift pin stay green — with no trigger
 *   # everything is allowed, and the pin reads a file, not the database.
 *
 * To restore, recreate the trigger by hand. Replaying its migration is not an
 * option: `CREATE TRIGGER` is not idempotent, and
 * `20260826140000_entry_guard_restorations` also creates two objects that
 * would still be there.
 *
 *   docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test -c \
 *     'CREATE TRIGGER entry_frozen_schedule_guard
 *        BEFORE UPDATE OF "date", "startTime", "durationMinutes"
 *        ON "CalendarEntry" FOR EACH ROW
 *        EXECUTE FUNCTION entry_reject_frozen_schedule_change();'
 */
const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

let teacherId: string;
let accountId: string;
let roomId: string;
let teacherRoomId: string;
const classIds: string[] = [];

/**
 * A DAY per fixture, not a minute. `CalendarEntry_teacher_slot_excl` is a
 * RANGE overlap since #327, so two 60-minute fixtures a minute apart collide;
 * `slotDate` (`tests/class-fixtures.ts`) owns that reasoning. Two bases, one
 * for where fixtures are CREATED and one for where the allow-cases MOVE them
 * to, so a moved entry cannot land on a sibling's slot.
 */
const FIXTURE_BASE = '2099-06-01';
const MOVE_TARGET_BASE = '2098-06-01';

let makeClassCounter = 0;

async function makeClass(
  opts: { status: ClassStatus },
): Promise<{ classId: string; entryId: string; seq: number }> {
  makeClassCounter += 1;
  const seq = makeClassCounter;
  const cls = await createClassFixture(prisma, {
    teacherId,
    teacherRoomId,
    classType: 'Terminal Date Test',
    date: slotDate(FIXTURE_BASE, seq),
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
  return { classId: cls.id, entryId: cls.calendarEntryId, seq };
}

/** The `YYYY-MM-DD` a fixture was created on, for the unchanged-date case. */
const isoDay = (base: string, seq: number): string =>
  slotDate(base, seq).toISOString().slice(0, 10);

/**
 * Derived, not listed. Every `ClassStatus` the guard must NOT freeze on is
 * whatever is left once the terminal set is removed — so adding a fifth
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

describe('entry_frozen_schedule_guard', () => {
  // Driven by `TERMINAL_CLASS_STATUSES`, not by a literal. Widen the derived
  // set and these rejection cases widen with it, so a status that the reaper
  // starts treating as unwritable is proved unwritable HERE too, in the same
  // edit. A literal could not: it would go on testing the old set while the
  // reaper deleted rows on the new member.
  it.each(TERMINAL_CLASS_STATUSES)(
    'refuses to move a %s class to a past date, from raw SQL',
    async (status) => {
      // `createClassFixture` reaches `completed` by TRANSITIONING, which is
      // what fires `class_sync_entry_completed` and stamps the marker this
      // guard reads. Since #327 an INSERT already carrying the status stamps
      // it too (`class_sync_entry_completed_insert_guard`), but the transition
      // is the path production takes and the fixture keeps it.
      const { entryId, seq } = await makeClass({ status });

      // Raw SQL, not `updateClass` — the point is that this holds with the
      // service layer, and Prisma's typed layer, entirely out of the picture.
      // `2020-01-01` is the exact date from issue #247: more than 365 days
      // past, so `reapClosedWaitlistEntries` would treat this class as
      // reapable.
      //
      // No `::uuid` cast on the id parameter, here or in the case below.
      // `CalendarEntry.id` is Prisma `String @default(uuid())`, which is a
      // `text` column, not Postgres `uuid` — casting the bound parameter makes
      // the comparison `text = uuid` and the statement dies with `42883`
      // before the trigger is ever consulted.
      let caughtRaw: unknown;
      try {
        await prisma.$executeRaw`UPDATE "CalendarEntry" SET date = '2020-01-01' WHERE id = ${entryId}`;
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

      // The typed path, which is the one production actually takes:
      // `updateClass` is the only writer in `src/` that moves an existing
      // entry's `date`, and it is also the only shape
      // `isTerminalStatusViolation` matches, so the 409 claim has to be
      // pinned against this write rather than the raw one above — asserting it
      // on the raw error would assert something no caller can observe.
      let caught: unknown;
      try {
        await prisma.calendarEntry.update({
          where: { id: entryId },
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
      // classifyApiError does with this shape is what a caller would see. The
      // `which is terminal` clause in the guard's message is what carries it —
      // without that clause the matcher misses and a well-formed request that
      // conflicts with a state the class already reached answers 500.
      expect(classifyApiError(caught).status).toBe(409);

      const after = await prisma.calendarEntry.findUniqueOrThrow({ where: { id: entryId } });
      expect(after.date.toISOString().slice(0, 10)).toBe(isoDay(FIXTURE_BASE, seq));
    },
  );

  // The cases that prove the guard CAN pass. Without them, a predicate mutated
  // to freeze unconditionally would still satisfy every case above.
  //
  // Every non-terminal status, not just `open`. `in_progress` is the one that
  // earns the sweep: the teacher edit page redirects away from it, so it is
  // easy to assume a freeze there is harmless — but the API allows that edit
  // and should, and a guard widened to "anything past draft" would pass a
  // single-status `open` control while breaking a real write. `draft` covers
  // the same mutation from the other end.
  it.each(NON_TERMINAL_STATUSES)('allows a date change on a %s class', async (status) => {
    const { entryId, seq } = await makeClass({ status });

    // Its own target day, derived from the same counter: two fixtures moved
    // onto one date at one time would collide in
    // `CalendarEntry_teacher_slot_excl` and this case would fail on the slot
    // rather than on the freeze.
    const target = isoDay(MOVE_TARGET_BASE, seq);
    await prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET date = $1::date WHERE id = $2`, target, entryId,
    );

    const after = await prisma.calendarEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(after.date.toISOString().slice(0, 10)).toBe(target);
  });

  it('allows a write that carries a frozen entry\'s unchanged date alongside another column', async () => {
    // The actual-change half of the guard's decision, restored by
    // `20260826140000_entry_guard_restorations`: `UPDATE OF date` fires on
    // presence in the SET list, not on change, so without it a writer that
    // carries the unchanged date alongside a column it does mean to change is
    // refused by a guard aimed at something else — and told it "cannot change
    // its date", about a statement changing no date.
    const { entryId, seq } = await makeClass({ status: 'completed' });

    // `${...}::date`, NOT a bound JS Date. Binding a Date sends a timestamptz,
    // which Postgres narrows to `date` using the SESSION time zone — so the
    // "unchanged" date silently becomes the previous day under any westward
    // session, the guard's `IS NOT DISTINCT FROM` then fails to hold, and this
    // case fails claiming the trigger is wrong when only the clock was. This
    // suite runs under `TZ: America/New_York` (`vitest.config.ts`), which is
    // exactly such a session. A plain date string has no zone to misread.
    const unchanged = isoDay(FIXTURE_BASE, seq);
    await prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET date = $1::date, "classType" = 'Unchanged date' WHERE id = $2`,
      unchanged, entryId,
    );

    const after = await prisma.calendarEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(after.classType).toBe('Unchanged date');
    expect(after.date.toISOString().slice(0, 10)).toBe(unchanged);
  });

  /**
   * The same drift pin `class-terminal-status.test.ts` ends with, applied to
   * the OTHER frozen text — and it has to be a SECOND pin, not a reuse of that
   * one, because the two triggers restate the terminal set independently and
   * nothing forces them to agree. Since #327 both texts live in one migration,
   * so the two pins are told apart by FUNCTION NAME rather than by directory;
   * `tests/migration-sql.ts` records what a directory-only pin would cost.
   *
   * The text here is `class_sync_entry_completed`, whose `NEW.status IN (...)`
   * decides which statuses stamp `CalendarEntry.classCompletedAt` — the marker
   * this whole file's rejection case depends on. The guard's own text says
   * which statuses cannot LEAVE their status; this one says which ARRIVE at a
   * frozen entry. Same set, opposite tense, and a class that reaches a terminal
   * status without stamping the marker is a completed class whose date is still
   * editable and whose queue the reaper will delete.
   *
   * `reapClosedWaitlistEntries` permanently deletes rows on a class that is
   * terminal AND more than 365 days past its `date`. Its safety argument is
   * "no writer can ever touch those rows again", and that argument rests on
   * two triggers: the sibling freezes `status`, this one's marker freezes the
   * entry's schedule. `TERMINAL_CLASS_STATUSES` is DERIVED from
   * `VALID_TRANSITIONS`, while both texts restate the set as frozen SQL. Widen
   * the transition table and the constant widens silently, the reaper starts
   * reaping a second status — and without this pin the DATE half would go
   * unenforced for it with nothing red. The sibling's pin would still pass: it
   * only reads its own function.
   *
   * The rejection `it.each` catches the set GROWING (a new terminal status
   * gets a rejection case that fails, because the SQL does not cover it). It
   * cannot catch the set SHRINKING: a case that is no longer generated cannot
   * fail. `NON_TERMINAL_STATUSES` catches part of that — a status leaving the
   * terminal set arrives in the allow-`it.each` above, where the raw date
   * update meets a marker the SQL still stamps — but not the limit: empty the
   * terminal set and BOTH families generate vacuously while the reaper stops
   * reaping entirely. That is what the two length assertions are for.
   *
   * It also fails with a NAMED diagnostic — the two sets printed side by side
   * — where the allow-case fails with a bare `23514` that reads as "the trigger
   * is broken" rather than "the constant and the SQL have drifted apart", and
   * misreading that points the next person at the migration instead of at
   * `VALID_TRANSITIONS`.
   *
   * Reads a file; touches no database.
   */
  it('matches the exact status set the sync trigger SQL enforces', () => {
    const enforced = enforcedTerminalStatuses(
      '20260826080100_calendar_entry_rewire',
      'class_sync_entry_completed',
    );

    expect(enforced.length).toBeGreaterThan(0);
    expect(TERMINAL_CLASS_STATUSES.length).toBeGreaterThan(0);
    expect([...TERMINAL_CLASS_STATUSES].sort()).toEqual(enforced);
  });
});
