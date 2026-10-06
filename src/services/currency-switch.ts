import { Prisma, type Currency } from '@prisma/client';
import { CURRENCIES } from '@/lib/format';
import {
  CLASS_TO_ENTRY_JOIN,
  lockClassRowsOrdered,
  lockTeacherForNoKeyUpdate,
  type TransactionClientOnly,
} from '@/lib/db-locks';
import { studioClassDateIsPast } from './studio-class-editability';

/**
 * Switching a teacher's currency (#758). What a switch relabels and why is
 * spec A2 in `docs/superpowers/specs/2026-10-06-multi-currency-design.md`;
 * the lock order is `docs/lock-order.md`, "The `Teacher` row is the first lock
 * (#758)".
 *
 * Framework-agnostic: `PUT /api/teachers/[id]` runs this inside its own
 * transaction and maps the answer to a response.
 */

/**
 * `kept` is every row of this teacher's still NOT in the new currency after
 * the relabel, grouped by the currency it shows, in `Currency` declaration
 * order, with no zero entries.
 */
export type CurrencySwitchResult = {
  relabelled: { classes: number; studioClasses: number };
  kept: ReadonlyArray<{ currency: Currency; classes: number; studioClasses: number }>;
};

/**
 * Runs inside the caller's transaction, and takes that transaction's first
 * lock: the caller has locked nothing before it.
 *
 * `'teacher_gone'` when the teacher is absent or erased, read under the lock;
 * `'unchanged'` when `currency` is already the stored one. Neither writes.
 */
export async function switchTeacherCurrency(
  tx: TransactionClientOnly,
  teacherId: string,
  currency: Currency,
): Promise<CurrencySwitchResult | 'unchanged' | 'teacher_gone'> {
  const teacher = await lockTeacherForNoKeyUpdate(tx, teacherId);
  if (teacher === null) return 'teacher_gone';
  if (teacher.currency === currency) return 'unchanged';

  // The template families' lock node, class family first. A generation holds
  // its template row `FOR UPDATE` across the insert of its classes, so this
  // waits it out and the class lock below sees what it committed; one that
  // starts later waits here and reads the new currency.
  await tx.$queryRaw`
    SELECT ct.id FROM "ClassTemplate" ct
      JOIN "ScheduleRule" r ON r.id = ct."scheduleRuleId"
     WHERE r."teacherId" = ${teacherId}
     ORDER BY ct.id
     FOR UPDATE OF ct`;
  await tx.$queryRaw`
    SELECT sct.id FROM "StudioClassTemplate" sct
      JOIN "ScheduleRule" r ON r.id = sct."scheduleRuleId"
     WHERE r."teacherId" = ${teacherId}
     ORDER BY sct.id
     FOR UPDATE OF sct`;

  // VERDICT (#327): no `entries: true`. This transaction writes
  // `Class.currency` and reads no entry column but `teacherId`, which no
  // writer changes. Cancellation is read from `entryLive` on the locked row,
  // and `settingsLocked` and `status` are the row's own, so a first booking
  // or a completion that lands while this waits is re-checked under the lock
  // and drops the row from the set.
  const classIds = await lockClassRowsOrdered(tx, {
    join: CLASS_TO_ENTRY_JOIN,
    where: Prisma.sql`e."teacherId" = ${teacherId}
      AND NOT c."settingsLocked"
      AND c.status <> 'completed'
      AND c."entryLive"`,
  });
  const relabelledClasses = await tx.class.updateMany({
    where: { id: { in: classIds } },
    data: { currency },
  });

  // A studio class is an income record once its date is before the teacher's
  // today (`studio-class-editability.ts`); from today on it is still editable.
  const now = new Date();
  const studio = await tx.studioClass.findMany({
    where: { calendarEntry: { teacherId } },
    select: { id: true, calendarEntry: { select: { date: true } } },
  });
  const studioIds = studio
    .filter((row) => !studioClassDateIsPast(row.calendarEntry.date, now, teacher.defaultTimezone))
    .map((row) => row.id);
  const relabelledStudio = await tx.studioClass.updateMany({
    where: { id: { in: studioIds } },
    data: { currency },
  });

  const notInNew = { calendarEntry: { teacherId }, currency: { not: currency } };
  const keptClasses = await tx.class.groupBy({ by: ['currency'], where: notInNew, _count: { _all: true } });
  const keptStudio = await tx.studioClass.groupBy({ by: ['currency'], where: notInNew, _count: { _all: true } });

  await tx.teacher.update({ where: { id: teacherId }, data: { currency } });

  const kept = CURRENCIES
    .map((c) => ({
      currency: c,
      classes: keptClasses.find((g) => g.currency === c)?._count._all ?? 0,
      studioClasses: keptStudio.find((g) => g.currency === c)?._count._all ?? 0,
    }))
    .filter((k) => k.classes + k.studioClasses > 0);

  return {
    relabelled: { classes: relabelledClasses.count, studioClasses: relabelledStudio.count },
    kept,
  };
}
