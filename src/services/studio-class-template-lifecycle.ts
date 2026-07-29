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
 *   - `pauseOrResumeStudioTemplate` generates on resume, inside its own
 *     `$transaction` — see that function's own doc comment for why, and
 *     `claimStudioTemplateForGeneration` (`studio-class-generator.ts`) for
 *     why the generation is preceded by a claim rather than run straight off
 *     the `update` above it (#94).
 */

import type { PrismaClient, StudioClassTemplate } from '@prisma/client';
import { startOfLocalDay } from '@/lib/timezone';
import {
  claimStudioTemplateForGeneration,
  generateStudioInstancesForTemplate,
} from './studio-class-generator';

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
 * Unlike before #94, resuming generates. It still does not call
 * `generateStudioClassInstances` — that takes no `teacherId` and sweeps every
 * active template platform-wide, across every teacher, which is not
 * something a single PATCH may do. It calls
 * `generateStudioInstancesForTemplate` instead, which is scoped to one
 * template and accepts this transaction's client.
 *
 * The write and the generation share one transaction, so a generation failure
 * rolls the `isActive` flip back rather than leaving a template flagged live
 * with an empty window — the state this issue was filed about.
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

  const updated = await db.$transaction(
    async (tx) => {
      const t = await tx.studioClassTemplate.update({
        where: { id: templateId },
        data: { isActive: desiredActive },
      });

      if (t.isActive) {
        // Take the row lock before generating. The `update` above only flips
        // `isActive`, a non-key column, so Postgres grants it `FOR NO KEY
        // UPDATE` — which does not conflict with the `FOR KEY SHARE` a
        // concurrent `StudioClass` insert takes on this template for FK
        // integrity. Without this claim that race is live, and the
        // generator's P2002 hedge cannot save us: a `catch` inside an
        // interactive transaction leaves Postgres with an aborted
        // transaction that fails the next statement with 25P02 rather than
        // skipping cleanly. `FOR UPDATE` makes the collision impossible
        // instead of trying to recover from it (#94).
        const claimed = await claimStudioTemplateForGeneration(tx, templateId);
        if (!claimed) {
          // Not a race — provably unreachable. The archived case returned
          // above, `isActive` was just set true by the write above, and we
          // hold this row's lock so nothing can archive or delete it in
          // between. A null here means the claim's predicate and this
          // function's guards have drifted apart. Returning 0 instead would
          // hide that behind a silently empty window — the exact failure
          // this issue is about.
          throw new Error(
            `pauseOrResumeStudioTemplate: claim returned null for template ${templateId} ` +
              'while holding its row lock — claim predicate and resume guards disagree',
          );
        }
        await generateStudioInstancesForTemplate(tx, claimed);
      }

      return t;
    },
    // The sweep's claim can hold this row for its own full 10s transaction;
    // Prisma's 5s default would abort us mid-wait.
    { timeout: 10_000 },
  );

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
 *
 * That transaction opens with a compare-and-swap rather than a plain update,
 * so the transition can only be applied once even when two requests race —
 * see `archiveOrUnarchiveTemplate` for the full reasoning, which holds here
 * unchanged.
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
  // A fast path, not the guarantee: this row was read before the transaction
  // below opened, so it is outside the row lock and two concurrent archives
  // both clear it. The compare-and-swap inside the transaction is the
  // authoritative one; this only saves them a transaction in the common case.
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
      // Compare-and-swap, mirroring `archiveOrUnarchiveTemplate` — see there
      // for what a plain `update` cost: the loser of a race overwrote the
      // winner's `archivedAt`/`withdrawnCount` with a `0` its own
      // `deleteMany` produced only because the winner had already deleted
      // those classes. Constraining the write to `isArchived: !archiving`
      // makes the transition itself the thing that can happen only once.
      //
      // Still the transaction's first statement, deliberately: this is what
      // takes the row lock `claimStudioTemplateForGeneration`
      // (studio-class-generator.ts) holds with its `FOR UPDATE`, and the
      // timeout below exists for the wait that lock can impose.
      const swapped = await tx.studioClassTemplate.updateMany({
        where: { id: templateId, isArchived: !archiving },
        data: {
          isArchived: archiving,
          isActive: false,
          // Folded in rather than issued as a second `update`: `null` depends
          // on nothing this transaction has yet to do, unlike the archiving
          // arm's `withdrawnCount` below.
          ...(archiving ? {} : { archivedAt: null, withdrawnCount: null }),
        },
      });

      if (swapped.count === 0) {
        // Another request already applied the transition, or the row is gone.
        // Read which rather than assuming. Re-read rather than reusing the
        // snapshot from the top of this function — that one still carries the
        // value the winner just falsified. See the class family's twin for why
        // the flag on the returned row can still be stale under three
        // concurrent requests, and why locking here would not be worth it.
        const current = await tx.studioClassTemplate.findUnique({ where: { id: templateId } });
        if (!current) return { ok: false as const, reason: 'not_found' as const };
        return { ok: true as const, action: 'unchanged' as const, template: current };
      }

      if (!archiving) {
        // `updateMany` returns a count, not a row, and every arm of the
        // contract carries a template. Safe to read back here specifically
        // because the CAS above holds this row's lock until we commit — the
        // same lock-then-read pattern the generator's claim uses.
        //
        // A template that is no longer archived has no withdrawal to report.
        // Not a *live* one — the CAS above forced `isActive: false` in the
        // same write, so what is standing here is paused. Leaving a stale
        // count on it would be worse than having none (#97).
        const cleared = await tx.studioClassTemplate.findUniqueOrThrow({
          where: { id: templateId },
        });
        return { ok: true as const, action: 'unarchived' as const, template: cleared };
      }

      // One clock reading serves both the calendar boundary and the
      // timestamp recorded below. `StudioClass.date` is `@db.Date`, so both
      // sides of every comparison below are calendar dates. See
      // `archiveOrUnarchiveTemplate` for what comparing the column to a raw
      // instant costs in each direction.
      const now = new Date();
      const today = startOfLocalDay(now, timeZone);

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

      // Written from the delete's own `count`, inside the same transaction
      // (#97). A second statement rather than folded into the CAS above, on
      // data dependency alone: `deleted` does not exist until the `deleteMany`
      // has run, and the CAS runs before it — see `archiveOrUnarchiveTemplate`
      // for the separate lock-ordering point that keeps the CAS first. A plain
      // single-record `update` is enough: the CAS's lock is still held, so
      // nothing can have moved this row since.
      const recorded = await tx.studioClassTemplate.update({
        where: { id: templateId },
        data: { archivedAt: now, withdrawnCount: deleted },
      });

      return { ok: true as const, action: 'archived' as const, template: recorded, deleted, remaining };
    },
    // The compare-and-swap above takes the same row lock
    // `claimStudioTemplateForGeneration` (studio-class-generator.ts) holds with
    // its `FOR UPDATE` for the duration of its own per-template transaction —
    // that claim is what gives this the claim-and-lock treatment, not the
    // timeout below; this archive can block on a sweep in progress today. The
    // 10s figure only matches the sweep's own transaction timeout so Prisma's
    // 5s default does not abort this update while it waits — a VPS can exceed 5s,
    // which would otherwise turn an ordinary archive click into an opaque
    // P2028.
    { timeout: 10_000 },
  );
}
