/**
 * Studio Class Template lifecycle — pause/resume and archive/un-archive for
 * `PATCH /api/studio-class-templates/[id]` (#86, #98).
 *
 * The studio sibling of `class-template-lifecycle.ts`'s pause/archive section.
 * Deliberately not sharing an implementation with it — PR #92 found the two
 * families had already drifted apart in their guards, and their registration
 * semantics genuinely differ. Three differences from the class family matter
 * here:
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
 *   - `pauseOrResumeStudioTemplate` does not call a generator, and has no
 *     `$transaction` at all — see that function's own doc comment for both.
 */

import type { PrismaClient, StudioClassTemplate } from '@prisma/client';
import { startOfLocalDay } from '@/lib/timezone';

/**
 * Outcome of a pause/resume PATCH. `paused` carries the furthest-out class
 * still on the schedule, for the pause confirmation; `active` and
 * `unchanged` report nothing beyond the template itself — mirroring
 * `PauseTemplateResult` in the class family.
 */
export type PauseStudioTemplateResult =
  | {
      ok: true;
      action: 'paused';
      template: StudioClassTemplate;
      lastScheduled: { date: Date; startTime: string } | null;
    }
  | { ok: true; action: 'active'; template: StudioClassTemplate }
  | { ok: true; action: 'unchanged'; template: StudioClassTemplate }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'archived' };

/**
 * Archiving and un-archiving are different operations and report different
 * things; `unchanged` is a third, and reports nothing at all — see
 * `ArchiveTemplateResult` for why the un-archiving and unchanged arms carry
 * no counts.
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
  | { ok: true; action: 'unchanged'; template: StudioClassTemplate }
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
 *
 * With no generator to call, there is also nothing here that needs the class
 * family's `$transaction`: the single `update` below is autocommit, so there
 * is no Prisma transaction timeout to bust — it simply waits on any row lock
 * (e.g. the generator sweep's own claim) and then succeeds.
 */
export async function pauseOrResumeStudioTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  target: 'active' | 'paused',
): Promise<PauseStudioTemplateResult> {
  const template = await db.studioClassTemplate.findUnique({
    where: { id: templateId },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  // Dropped rather than leaked back to the caller — `PauseStudioTemplateResult`
  // carries a plain `StudioClassTemplate`, and this early-return path never
  // reaches the write below that would otherwise need the join.
  const { teacher: _t, ...bare } = template;
  void _t;

  const desiredActive = target === 'active';

  // Before the archived guard, deliberately — the same reason as the class
  // family's `pauseOrResumeTemplate`: archiving forces `isActive: false`, so
  // `?state=paused` on an archived template is already true and there is
  // nothing to refuse — only `?state=active` is the transition the guard
  // exists to block.
  if (template.isActive === desiredActive) {
    return { ok: true, action: 'unchanged', template: bare };
  }

  if (template.isArchived) return { ok: false, reason: 'archived' };

  const updated = await db.studioClassTemplate.update({
    where: { id: templateId },
    data: { isActive: desiredActive },
  });

  if (!desiredActive) {
    // `gte` today, not `gt`: pause deletes nothing, so there is no
    // spare-today carve-out to mirror here — today's class is still on the
    // schedule and must be reported as such.
    const today = startOfLocalDay(new Date(), template.teacher.defaultTimezone);
    const lastScheduled = await db.studioClass.findFirst({
      where: scheduledWhere(templateId, { gte: today }),
      orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
      select: { date: true, startTime: true },
    });
    return { ok: true, action: 'paused', template: updated, lastScheduled };
  }

  return { ok: true, action: 'active', template: updated };
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
  target: 'archived' | 'unarchived',
): Promise<ArchiveStudioTemplateResult> {
  const template = await db.studioClassTemplate.findUnique({
    where: { id: templateId },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  const archiving = target === 'archived';

  // No write, no delete. Archiving twice must not withdraw twice — the
  // withdrawal is a consequence of the transition, not of the request.
  //
  // The one place "already there" and "apply the transition" differ
  // observably: both archiving and un-archiving force `isActive: false`
  // below, but this early return touches nothing. So `?state=unarchived`
  // against a template that is already unarchived but still active answers
  // `unchanged` and leaves it active, where a real un-archive would have
  // paused it. That is correct — `isArchived` and `isActive` are independent
  // axes, and no button ever sends that combination — but it deserves to be
  // written down rather than left for a future reader to derive.
  if (template.isArchived === archiving) {
    const { teacher: _t, ...bare } = template;
    void _t;
    return { ok: true, action: 'unchanged', template: bare };
  }

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
    // This `update` takes the same row lock `claimStudioTemplateForGeneration`
    // (studio-class-generator.ts) holds with its `FOR UPDATE` for the
    // duration of its own per-template transaction — that claim is what gives
    // this the claim-and-lock treatment, not the timeout below; this archive
    // can block on a sweep in progress today. The 10s figure only matches the
    // sweep's own transaction timeout so Prisma's 5s default does not abort
    // this update while it waits on that lock — a loaded VPS can exceed 5s,
    // which would otherwise turn an ordinary archive click into an opaque
    // P2028.
    { timeout: 10_000 },
  );
}
