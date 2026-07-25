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
 *     uncancelled studio class the delete's `date > now` boundary can reach is
 *     deletable. That boundary deliberately spares a class dated today
 *     (`StudioClass.date` is `@db.Date`, i.e. midnight UTC, so today's row is
 *     already `< now` past 00:00) — the same carve-out the class family has —
 *     so `remaining` is a real query keyed at 00:00 UTC today, not a hardcoded
 *     0: today's survivor is the one row it can ever find.
 */

import type { PrismaClient, StudioClassTemplate } from '@prisma/client';

/** The furthest-out class still on the schedule, for the pause confirmation. */
export type PauseStudioTemplateResult =
  | {
      ok: true;
      template: StudioClassTemplate;
      lastScheduled: { date: Date; startTime: string } | null;
    }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'archived' };

export type ArchiveStudioTemplateResult =
  | { ok: true; template: StudioClassTemplate; deleted: number; remaining: number }
  | { ok: false; reason: 'not_found' | 'forbidden' };

/**
 * Future studio classes still on the schedule for a template — the
 * actionable ones. The studio analogue of `scheduledWhere` in
 * `class-template-lifecycle.ts`, but keyed on `cancelledAt` rather than
 * `status` because that is the only lifecycle column `StudioClass` has.
 */
const scheduledWhere = (templateId: string, now: Date) => ({
  templateId,
  date: { gt: now },
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
  const template = await db.studioClassTemplate.findUnique({ where: { id: templateId } });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };
  if (template.isArchived) return { ok: false, reason: 'archived' };

  const updated = await db.studioClassTemplate.update({
    where: { id: templateId },
    data: { isActive: !template.isActive },
  });

  const lastScheduled = await db.studioClass.findFirst({
    where: scheduledWhere(templateId, new Date()),
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
  const template = await db.studioClassTemplate.findUnique({ where: { id: templateId } });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  const archiving = !template.isArchived;

  return db.$transaction(async (tx) => {
    const updated = await tx.studioClassTemplate.update({
      where: { id: templateId },
      data: { isArchived: archiving, isActive: false },
    });

    if (!archiving) return { ok: true as const, template: updated, deleted: 0, remaining: 0 };

    const now = new Date();

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
      where: scheduledWhere(templateId, now),
    });

    // The delete above deliberately spares a class dated today (`date > now`
    // excludes it once the clock passes 00:00 UTC), so `remaining` needs its
    // own boundary at the start of today rather than reusing `scheduledWhere`
    // — reusing it would undercount that same survivor, the exact bug fixed in
    // `archiveOrUnarchiveTemplate` (`class-template-lifecycle.ts`). No
    // charged-status filter is needed here, unlike that sibling: `StudioClass`
    // has no registrations to consult, so every uncancelled row in scope
    // counts.
    const startOfToday = new Date(now);
    startOfToday.setUTCHours(0, 0, 0, 0);
    const remaining = await tx.studioClass.count({
      where: { templateId, date: { gte: startOfToday }, cancelledAt: null },
    });

    return { ok: true as const, template: updated, deleted, remaining };
  });
}
