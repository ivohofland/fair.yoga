import { Prisma } from '@prisma/client';
import type { ClassFamily, PrismaClient } from '@prisma/client';
import { formatDateWithYear } from './format';
import { log } from './log';
import { timeToHHmm } from './time-of-day';

/**
 * The live entry occupying a slot, asked after `CalendarEntry_teacher_slot_excl`
 * has already refused a write.
 *
 * The whole row rather than its `kind`, which is the difference from
 * `ruleSlotHolder` (`./rule-slot-holder`) one layer up. There the family IS the
 * remedy — recurring and studio templates are separate surfaces in Settings, so
 * "go look at your studio classes" tells a teacher where to go. Here both
 * families are one list on the Schedule tab, so the family is the half a
 * teacher can already see, and the start time and date are the half they
 * cannot: the constraint is a RANGE overlap, so the conflicting row need share
 * neither a start time nor — across midnight — a date with the write that hit
 * it.
 */
export type ConflictingEntry = {
  id: string;
  kind: ClassFamily;
  date: Date;
  startTime: Date;
  durationMinutes: number;
};

/**
 * The occupancy a write is asking for, in the three columns
 * `CalendarEntry.span` is generated from, plus the row to disregard.
 *
 * A reschedule probes after its own write has rolled back, so the row it was
 * moving still holds its OLD span and answers as its own holder — naming back
 * the very time the teacher was moving away from. `excludeEntryId` is what a
 * caller that is MOVING an entry passes; a caller that is creating one has no
 * such row and omits it.
 */
export type EntrySpan = {
  date: Date;
  startTime: Date;
  durationMinutes: number;
  excludeEntryId?: string;
};

/**
 * The teacher-facing noun per family. `Record<ClassFamily, string>` is the
 * tether: a third family cannot be added to the enum without being given a
 * noun here, and `FAMILIES` below reads its membership off this same object so
 * the two cannot disagree.
 */
const FAMILY_NOUN: Record<ClassFamily, string> = {
  regular: 'class',
  studio: 'studio class',
};

const FAMILIES = Object.keys(FAMILY_NOUN) as readonly ClassFamily[];

/**
 * `kind` arrives as a bare `string`: `$queryRaw` has no model to map the column
 * through, so the generated client's enum type is not applied to it.
 *
 * `null` for anything else is not an error path, for the reason
 * `ruleSlotHolder` gives about its own `'unknown'`: it degrades to a refusal
 * that names no time and no date, which is vague rather than wrong — where
 * naming a family this module has no noun for cannot be anything but wrong.
 */
function toFamily(kind: string): ClassFamily | null {
  return FAMILIES.find((family) => family === kind) ?? null;
}

/**
 * The predicate BOTH probes below ask, as one fragment: this teacher's live
 * entries whose occupancy overlaps the given span.
 *
 * Built in SQL from the same three columns the generated `span` is built from,
 * rather than re-deriving an instant in TypeScript, so neither probe can
 * disagree with the constraint about what a span IS. `span` is
 * `Unsupported("tsrange")` on the model and therefore absent from the generated
 * client — no `where` clause can reach it, which is why the callers are
 * `$queryRaw` rather than a typed `findFirst`, the same concession
 * `ruleSlotHolder` makes for `ScheduleRule.slot`.
 *
 * ONE FRAGMENT, TWO CALLERS, and that is the point rather than tidiness. The
 * `'[)'` duplicates `CalendarEntry_teacher_slot_excl`'s own half-open bound
 * (`prisma/migrations/20260826080000_calendar_entry/migration.sql`); a second
 * copy of it would be a second thing to keep in step with the constraint, and
 * this one appears once. `entry-conflict.test.ts`'s boundary case is what holds
 * the remaining copy.
 *
 * `cancelledAt IS NULL` mirrors the constraint's partial predicate, and is also
 * why finding nothing is an ordinary outcome rather than a failure: a cancelled
 * entry releases its slot, so the row that refused a write can genuinely be
 * gone by the time either probe runs.
 *
 * `date` is read with UTC accessors (via `toISOString`), matching
 * `formatDateWithYear` and for the same reason: a `@db.Date` value is pinned to
 * midnight UTC, and a local read moves the calendar day back one day west of
 * UTC.
 */
function liveOverlapOf(
  teacherId: string,
  span: { date: Date; startTime: Date; durationMinutes: number },
): Prisma.Sql {
  const startsAt = `${span.date.toISOString().slice(0, 10)} ${timeToHHmm(span.startTime)}`;
  return Prisma.sql`
             "teacherId" = ${teacherId}
         AND "cancelledAt" IS NULL
         AND "span" && tsrange(
               ${startsAt}::timestamp,
               ${startsAt}::timestamp + (${span.durationMinutes}::int * interval '1 minute'),
               '[)')
  `;
}

/**
 * Which of a generator's candidate dates a live entry of this teacher's still
 * overlaps — asked AFTER `createManyAndReturn`'s `ON CONFLICT DO NOTHING` has
 * silently absorbed the refusal, about the dates that did not come back.
 *
 * WHY A SECOND LOOK IS NEEDED AT ALL, which is the whole of this function.
 * Both generators pre-check occupancy with `spansOverlap` (`@/lib/generation`)
 * over a `date: { in: dates }` read — minutes-since-midnight on ONE calendar
 * date. A neighbour whose duration carries it past midnight overlaps a
 * candidate on the NEXT date, and that read cannot see it. The constraint can,
 * refuses the insert, `ON CONFLICT DO NOTHING` absorbs it, and before this the
 * date was reported as `'raced'` — a reason `countSkipReasons` drops on the
 * argument that a race is transient. For a midnight spill it is not: the
 * pre-check says free forever and the constraint refuses forever, so the
 * teacher was navigated away from a window that generated nothing, in silence,
 * every hour, for good.
 *
 * This asks the DATABASE the question the pre-check could not, using the
 * constraint's own range so the two cannot disagree, and its answer is what
 * lets the caller report `blocked_by_overlap` instead.
 *
 * ONE STATEMENT PER SHORT DATE, deliberately. `free` is at most one window
 * (four dates today), the short set is a subset of it, and this runs only when
 * something was actually refused — which outside a midnight spill is a lost
 * race and therefore rare. A single statement over a date array would need an
 * array binding and a correlated `EXISTS` to keep each candidate's answer
 * separate; that is more SQL to be wrong in than the loop saves.
 *
 * THROWS, unlike `probeConflictingEntry` above, and the contracts differ
 * because the moments do. That one runs after its caller's transaction has
 * closed and after the 409 is already decided — a throw there would report a
 * correctly refused write as one that may have happened. This one runs INSIDE
 * the generating transaction, before the result exists, and its answer is the
 * result: swallowing a failure here would hand back the very `'raced'` that
 * silently discards the window, which is the defect this exists to close. Both
 * generators state "NO CATCH" as doctrine for the same reason. Either sweep
 * isolates a throwing template and carries on (`class-generator.ts`,
 * `studio-class-generator.ts`); the two template POSTs roll their create back,
 * and a teacher who retries gets an honest answer rather than a quiet one.
 *
 * Takes `PrismaClient | Prisma.TransactionClient`, where `probeConflictingEntry`
 * takes only the former — the same difference, from the other side: this one is
 * MEANT to run on the caller's transaction, which is still healthy because
 * `ON CONFLICT DO NOTHING` completed rather than raised.
 *
 * Returns `date.getTime()` values rather than `Date`s, because a caller matching
 * these against its own candidates has `Date` objects that are equal by value
 * and never by identity.
 */
export async function probeOverlappingCandidates(
  db: PrismaClient | Prisma.TransactionClient,
  teacherId: string,
  candidates: readonly Date[],
  shape: { startTime: Date; durationMinutes: number },
): Promise<Set<number>> {
  const blocked = new Set<number>();
  for (const date of candidates) {
    const rows = await db.$queryRaw<Array<{ blocked: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM "CalendarEntry"
         WHERE ${liveOverlapOf(teacherId, { date, ...shape })}
      ) AS blocked
    `;
    if (rows[0]?.blocked === true) blocked.add(date.getTime());
  }
  return blocked;
}

/**
 * The single live entry occupying a refused span, for the sentence a 409
 * carries. `liveOverlapOf` above owns the predicate and the bound.
 *
 * `ORDER BY "date", "startTime"` before the `LIMIT 1` because a candidate span
 * can overlap more than one live entry, and naming which one is a choice this
 * query would otherwise leave to the plan. Either holder is a truthful answer,
 * so the ordering buys determinism rather than correctness: a test that plants
 * two holders gets the earlier one every run instead of whichever the index
 * happened to reach first.
 *
 * Called on the failure path once the refused statement's transaction has
 * closed, always against `db`, never `tx`: a statement that fails inside a
 * Postgres transaction aborts it, so a probe issued on the aborted `tx` answers
 * `25P02` rather than answering at all. Every call site must therefore sit
 * after its own transaction's closing `)`. The current set of them is whatever
 * this returns:
 *
 *   grep -rn "probeConflictingEntry(" src/services/ src/app/api/
 *
 * NEVER THROWS, and that is a guarantee about the refusal rather than about
 * this query. Every caller has already been refused by the database and has
 * already decided on 409; this only decides how specific the sentence is. A
 * throw from here would reach `withErrorHandler` and answer 5xx instead —
 * reporting a correctly refused write as one that may have happened.
 * Contention is also exactly when slot conflicts occur, so a pool or lock
 * timeout on this extra query is the realistic case, not a hypothetical one.
 * Logged rather than swallowed, and degrading to the same `null` the ordinary
 * "it was cancelled meanwhile" outcome produces.
 */
export async function probeConflictingEntry(
  db: PrismaClient,
  teacherId: string,
  span: EntrySpan,
): Promise<ConflictingEntry | null> {
  const exclude = span.excludeEntryId ?? null;
  try {
    const rows = await db.$queryRaw<Array<{
      id: string;
      kind: string;
      date: Date;
      startTime: Date;
      durationMinutes: number;
    }>>`
      SELECT "id", "kind"::text AS kind, "date", "startTime", "durationMinutes"
        FROM "CalendarEntry"
       WHERE ${liveOverlapOf(teacherId, span)}
         AND (${exclude}::text IS NULL OR "id" <> ${exclude}::text)
       ORDER BY "date", "startTime"
       LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const kind = toFamily(row.kind);
    if (kind === null) return null;
    return {
      id: row.id,
      kind,
      date: row.date,
      startTime: row.startTime,
      durationMinutes: row.durationMinutes,
    };
  } catch (err) {
    log.warn(
      { err, teacherId },
      'entry conflict probe failed; the refusal will name no time and no date',
    );
    return null;
  }
}

/**
 * The 409's sentence, for every door a `CalendarEntry_teacher_slot_excl`
 * refusal can arrive at.
 *
 * Named for the HOLDER when the probe found one — its family, its start time
 * and its date. Naming a specific row is what makes the family compulsory
 * rather than decorative: "you already have a class at 19:00" about a studio
 * class is a false sentence, where the fallback below is merely a vague one.
 *
 * `caller` is that fallback, and it is the asking family on purpose. With no
 * row to describe there is nothing to be specific about, so the message says
 * only that the time is taken — in the words of the surface the teacher is
 * standing on.
 *
 * The fallback says OVERLAPS rather than naming the date and time, because
 * `CalendarEntry_teacher_slot_excl` is a RANGE constraint (#327): the holder
 * need share neither the requested start time nor, for a neighbour running
 * past midnight, the requested date. "at that date and time" was true under
 * the exact-start key it replaced and is a guess now.
 *
 * Both stored values go through a converter rather than into the template
 * literal: `startTime` is a `@db.Time` and `date` a `@db.Date`, each read back
 * as a `Date`, and either one interpolated raw renders as a full timestamp.
 */
export function entryConflictMessage(
  conflict: ConflictingEntry | null,
  caller: ClassFamily,
): string {
  if (conflict === null) {
    return `You already have a ${FAMILY_NOUN[caller]} that overlaps that time.`;
  }
  const when = `${timeToHHmm(conflict.startTime)} on ${formatDateWithYear(conflict.date)}`;
  return `You already have a ${FAMILY_NOUN[conflict.kind]} at ${when}.`;
}
