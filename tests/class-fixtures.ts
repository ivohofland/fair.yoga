import type { CalendarEntry, Class, Prisma, PrismaClient, StudioClass } from '@prisma/client';

/**
 * Fixture builders for the two class families, taking the FLAT shape a class
 * had before #327 and writing the two rows it takes now.
 *
 * Every suite in this repo builds its own classes inline, and #327 turned each
 * of those creates into an entry plus a child. Two builders rather than ~150
 * hand-split literals: the split is the same everywhere, it is not what any of
 * those tests is about, and a hand-split copy per file is ~150 places for the
 * `kind` literal or a moved column to be got wrong quietly.
 *
 * NOT a production helper, and deliberately not shared with `src/`. The
 * production creates are three (`api/classes`, `api/studio-classes`, and each
 * generator's `createManyAndReturn`) and each has a shape of its own — a
 * generator writes many rows in two statements, a route writes one nested. A
 * builder wide enough for all three would hide exactly the thing those files
 * have to state.
 *
 * The return value carries `calendarEntry`, so a caller can read the entry's id
 * without a second query — several suites hold the entry to write `cancelledAt`
 * or to assert the slot constraint refused.
 */

/** The calendar identity, which #327 moved off both children. */
interface EntryFixtureFields {
  teacherId: string;
  classType: string;
  date: Date;
  startTime: Date;
  durationMinutes: number;
  /** Cancellation is one column for both families now. */
  cancelledAt?: Date | null;
  /** What `templateId` used to be: the rule a generated row hangs off. */
  scheduleRuleId?: string | null;
  /** The entry's own id, for suites that pin one. */
  calendarEntryId?: string;
}

type ClassOwnFields = Omit<
  Prisma.ClassUncheckedCreateInput,
  'calendarEntryId' | 'kind' | 'calendarEntry'
>;

type StudioClassOwnFields = Omit<
  Prisma.StudioClassUncheckedCreateInput,
  'calendarEntryId' | 'kind' | 'calendarEntry'
>;

export type ClassWithEntry = Class & { calendarEntry: CalendarEntry };
export type StudioClassWithEntry = StudioClass & { calendarEntry: CalendarEntry };

type AnyClient = PrismaClient | Prisma.TransactionClient;

/**
 * `kind` is set once, on the parent. It is half of the composite foreign key,
 * so Prisma omits it from the nested child input and fills it from the entry —
 * measured on the generated client during Task 2a, and the reason the seed does
 * the same.
 */
export async function createClassFixture(
  db: AnyClient,
  data: EntryFixtureFields & ClassOwnFields,
): Promise<ClassWithEntry> {
  const {
    teacherId,
    classType,
    date,
    startTime,
    durationMinutes,
    cancelledAt,
    scheduleRuleId,
    calendarEntryId,
    ...classFields
  } = data;

  const entry = await db.calendarEntry.create({
    data: {
      ...(calendarEntryId !== undefined ? { id: calendarEntryId } : {}),
      teacherId,
      kind: 'regular',
      classType,
      date,
      startTime,
      durationMinutes,
      cancelledAt: cancelledAt ?? null,
      scheduleRuleId: scheduleRuleId ?? null,
      // `in_progress` first when the caller asked for `completed` — see below.
      classes: {
        create: {
          ...classFields,
          ...(classFields.status === 'completed' ? { status: 'in_progress' as const } : {}),
        },
      },
    },
    include: { classes: true },
  });

  const { classes, ...bareEntry } = entry;
  const cls = classes[0];
  if (!cls) throw new Error('createClassFixture: the nested class row did not come back');

  // A COMPLETED fixture is created live and then TRANSITIONED, never inserted
  // already-completed — because `completeClass` (`class-lifecycle.ts`) is how a
  // class reaches `completed` in this application, and it gets there by
  // updating a live row. A fixture that INSERTed at `completed` would stage a
  // state no writer in `src/` produces.
  //
  // NOT because of the marker any more. `class_sync_entry_completed` now hangs
  // off `AFTER INSERT` as well as `AFTER UPDATE OF status`, so an insert
  // straight to `completed` stamps `CalendarEntry.classCompletedAt` too — that
  // is what `20260826140000_entry_guard_restorations` closed, and
  // `calendar-entry.test.ts` pins both paths. The transition is kept for
  // realism, which is the reason that survives.
  if (classFields.status === 'completed') {
    // No `in_progress` update here: the create above already inserted the row
    // in that status, so this is the one transition that actually changes
    // `status`.
    await db.class.update({ where: { id: cls.id }, data: { status: 'completed' } });
    const marked = await db.calendarEntry.findUniqueOrThrow({ where: { id: bareEntry.id } });
    return { ...cls, calendarEntry: marked };
  }
  return { ...cls, calendarEntry: bareEntry };
}

/** The studio twin. Same split, `kind: 'studio'`. */
export async function createStudioClassFixture(
  db: AnyClient,
  data: EntryFixtureFields & StudioClassOwnFields,
): Promise<StudioClassWithEntry> {
  const {
    teacherId,
    classType,
    date,
    startTime,
    durationMinutes,
    cancelledAt,
    scheduleRuleId,
    calendarEntryId,
    ...studioFields
  } = data;

  const entry = await db.calendarEntry.create({
    data: {
      ...(calendarEntryId !== undefined ? { id: calendarEntryId } : {}),
      teacherId,
      kind: 'studio',
      classType,
      date,
      startTime,
      durationMinutes,
      cancelledAt: cancelledAt ?? null,
      scheduleRuleId: scheduleRuleId ?? null,
      studioClasses: { create: studioFields },
    },
    include: { studioClasses: true },
  });

  const { studioClasses, ...bareEntry } = entry;
  const sc = studioClasses[0];
  if (!sc) throw new Error('createStudioClassFixture: the nested row did not come back');
  return { ...sc, calendarEntry: bareEntry };
}

/**
 * A fixture date offset so two fixtures from the same counter cannot overlap
 * in `CalendarEntry_teacher_slot_excl`.
 *
 * That constraint became a RANGE overlap in #327 (`EXCLUDE USING gist
 * ("teacherId" WITH =, span WITH &&)`), where the key it replaced was an exact
 * `(teacherId, date, startTime)`. The per-call MINUTE offset these suites used
 * against the old key is no longer enough on its own: two 60-minute classes
 * one minute apart overlap. A per-call DAY offset is enough whatever the
 * duration, which is why the offset moves to the date rather than being
 * widened in the time.
 *
 * A whole day per call rather than a rounded-up duration, deliberately: a
 * time-only offset is bounded by the 24 hours in a day, and several of these
 * suites make more fixtures than that allows — so that bound would come back
 * as a puzzle the next time someone added a test to one of them.
 *
 * NOT for suites whose fixture DATE is part of what they assert — the two
 * generators and the template lifecycles read week occupancy off it. Those
 * space their fixtures in time instead, with a gap at least as wide as the
 * fixture's own duration.
 */
export function slotDate(base: Date | string, counter: number): Date {
  const d = new Date(base);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + counter);
  return d;
}
