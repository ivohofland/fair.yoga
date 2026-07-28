/**
 * Studio Class Template lifecycle — pause/resume and archive/un-archive for
 * `PATCH /api/studio-class-templates/[id]` (#86).
 *
 * The studio sibling of `class-template-lifecycle.ts`'s pause/archive section.
 * Deliberately not sharing an implementation with it — PR #92 found the two
 * families had already drifted apart in their guards, and their registration
 * semantics genuinely differ. Two differences from the class family matter
 * here, and both come from the same root cause: `StudioClass` carries no
 * `status` column and no relation to `Student` at all.
 *
 *   - Where the class family's deletable predicate spreads a `status: {
 *     in: ['draft', 'open'] }` clause, the studio predicate has no status to
 *     filter on. It uses `cancelledAt: null` instead — an already-cancelled
 *     future class is an income record, not a bookable offer, and archiving
 *     must leave it standing exactly like the class family leaves a charged
 *     registration standing.
 *   - Where the class family excludes any class with a registration in a
 *     CHARGED status, the studio family has no registrations to consult at
 *     all — `studentCount` is a plain, unconnected `Int?`. So every future
 *     uncancelled studio class the delete's boundary can reach is deletable.
 *     That boundary deliberately spares a class dated today — the same
 *     carve-out the class family has — so `remaining` is a real query keyed
 *     at the start of the teacher's today, not a hardcoded 0: today's
 *     survivor is the one row it can ever find.
 */

import type { PrismaClient, StudioClassTemplate } from '@prisma/client';
import { startOfLocalDay } from '@/lib/timezone';

/** The furthest-out class still on the schedule, for the pause confirmation. */
export type PauseStudioTemplateResult =
  | {
      ok: true;
      template: StudioClassTemplate;
      lastScheduled: { date: Date; startTime: string } | null;
    }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'archived' };

/**
 * Archiving and un-archiving are different operations, so they report
 * different things — see `ArchiveTemplateResult` for why the un-archiving arm
 * carries no counts.
 */
export type ArchiveStudioTemplateResult =
  | {
      ok: true;
      action: 'archived';
      template: StudioClassTemplate;
      deleted: number;
      remaining: number;
    }
  | { ok: true; action: 'unarchived'; template: StudioClassTemplate }
  | { ok: false; reason: 'not_found' | 'forbidden' };

/**
 * Studio classes still on the schedule for a template, from the given
 * calendar-date boundary onward. The studio analogue of `scheduledWhere` in
 * `class-template-lifecycle.ts`, but keyed on `cancelledAt` rather than
 * `status` because that is the only lifecycle column `StudioClass` has.
 *
 * The boundary is a parameter for the same reason as there: the delete uses
 * `gt` (today's class is spared) and the counts use `gte` (today's class is
 * the survivor they must report), against a calendar date from
 * `startOfLocalDay` rather than a raw instant.
 */
const scheduledWhere = (templateId: string, date: { gt: Date } | { gte: Date }) => ({
  templateId,
  date,
  cancelledAt: null,
});

/**
 * Pause or resume generation. Deletes nothing: pausing means "no new classes",
 * not "withdraw what I already offered" — that is what archiving is for.
 *
 * Unlike the class family's `pauseOrResumeTemplate`, resuming here does not
 * call a generator. `generateStudioClassInstances` (`studio-class-generator.
 * ts`) has no per-template equivalent of `generateInstancesForTemplate` — it
 * takes no `teacherId` at all and sweeps every active, unarchived template
 * platform-wide, across every teacher, not just teacher-wide — and that was
 * true of the route this replaces as well: the pre-existing `PATCH` toggle
 * only ever flipped `isActive` and left materialisation to the cron sweep.
 * Calling the platform-wide sweep from here would generate a window for every
 * other teacher's active studio template too, not just the one being resumed
 * — a bigger behaviour change than this task is about. The user-visible
 * consequence of leaving it uncalled: a resumed studio template shows an
 * empty window until the next hourly cron sweep fills it back in.
 */
export async function pauseOrResumeStudioTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
): Promise<PauseStudioTemplateResult> {
  const template = await db.studioClassTemplate.findUnique({
    where: { id: templateId },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };
  if (template.isArchived) return { ok: false, reason: 'archived' };

  const updated = await db.studioClassTemplate.update({
    where: { id: templateId },
    data: { isActive: !template.isActive },
  });

  // `gte` today, not `gt`: pause deletes nothing, so there is no spare-today
  // carve-out to mirror here — today's class is still on the schedule and
  // must be reported as such.
  const today = startOfLocalDay(new Date(), template.teacher.defaultTimezone);
  const lastScheduled = await db.studioClass.findFirst({
    where: scheduledWhere(templateId, { gte: today }),
    orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
    select: { date: true, startTime: true },
  });

  return { ok: true, template: updated, lastScheduled };
}

/**
 * Archive or un-archive. Archiving withdraws the future studio classes nobody
 * booked and leaves the rest standing (#86), mirroring
 * `archiveOrUnarchiveTemplate`'s reasoning for the class family: generated
 * instances stay publicly listed on the teacher's schedule until removed, so
 * without this an archived template keeps up to four weeks of studio classes
 * looking live.
 *
 * The update and the delete share a transaction: a half-applied archive is
 * exactly the shelved-but-listed state this exists to prevent.
 */
export async function archiveOrUnarchiveStudioTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
): Promise<ArchiveStudioTemplateResult> {
  const template = await db.studioClassTemplate.findUnique({
    where: { id: templateId },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  const archiving = !template.isArchived;
  const timeZone = template.teacher.defaultTimezone;

  return db.$transaction(
    async (tx) => {
      const updated = await tx.studioClassTemplate.update({
        where: { id: templateId },
        data: { isArchived: archiving, isActive: false },
      });

      if (!archiving) return { ok: true as const, action: 'unarchived' as const, template: updated };

      // The teacher's calendar today, not `new Date()` — `StudioClass.date` is
      // `@db.Date`, so both sides of every comparison below are calendar dates.
      // See `archiveOrUnarchiveTemplate` for what comparing the column to a raw
      // instant costs in each direction.
      const today = startOfLocalDay(new Date(), timeZone);

      // Deliberately one statement, not a `findMany` followed by a
      // `deleteMany({ id: { in: ids } })`: a two-step read-then-delete lets a
      // class get cancelled in the gap between them under READ COMMITTED, and
      // the delete — keyed only on the ids already read — would not re-check
      // it, destroying a class that became an income record after the read.
      // Passing the predicate straight to `deleteMany` makes Postgres
      // re-evaluate it at execution time, and its returned `count` is the
      // number of rows that actually matched then — not a stale count from an
      // earlier read. Do not "optimise" this back into a read-then-delete.
      const { count: deleted } = await tx.studioClass.deleteMany({
        where: scheduledWhere(templateId, { gt: today }),
      });

      // `gte`, where the delete used `gt`: the delete spares a class dated
      // today, and counting with its boundary would undercount that same
      // survivor. No charged-status filter is needed here, unlike the class
      // sibling — `StudioClass` has no registrations to consult, so every
      // uncancelled row in scope counts.
      const remaining = await tx.studioClass.count({
        where: scheduledWhere(templateId, { gte: today }),
      });

      return { ok: true as const, action: 'archived' as const, template: updated, deleted, remaining };
    },
    // Mirrors `archiveOrUnarchiveTemplate`'s timeout ahead of Task 2, which
    // gives the studio generator sweep the same claim-and-lock treatment
    // class-generator.ts already has. Once that lands, this `update` can
    // block on a sweep in progress the same way the class family's does;
    // adding it now — rather than splitting it across two tasks — means
    // Task 2 doesn't have to remember the other half of the symmetry.
    { timeout: 10_000 },
  );
}
