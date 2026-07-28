/**
 * Class Template updates — the teacher-editable boundary for
 * `PUT /api/class-templates/[id]`.
 *
 * The sibling of `class-lifecycle.ts`'s update section (#82 is #79 one route
 * over), with the same five pins. Three things deliberately differ, and are
 * worth knowing before reading this as a mirror:
 *
 *   - Ownership lives here, not in the route. `updateClass` takes no
 *     `teacherId` and its route checks ownership; this takes one and checks it
 *     itself, so the guard travels with the function.
 *   - The column pins reference the *Many* input while the write below is
 *     single-record `update`. That is a deliberate tightening, not a match.
 *   - The delete-between-read-and-write race is handled, but more simply than
 *     `updateClass`'s compare-and-swap (#72). A single-record `update` throws
 *     Prisma's P2025 when the row is already gone rather than silently
 *     matching zero rows the way `updateMany` does, so catching that one error
 *     code and mapping it to `not_found` is enough — no compare-and-swap
 *     needed.
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient, ClassTemplate, ClassStatus } from '@prisma/client';
import type { z } from 'zod';
import type { updateClassTemplateSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { startOfLocalDay } from '@/lib/timezone';
import { syncTemplateInstances, type TemplateSyncResult } from './template-sync';
import { generateInstancesForTemplate } from './class-generator';
import { CHARGED_STATUSES } from './class-lifecycle';

/**
 * The fields a teacher may change on an existing template.
 *
 * Derived from `updateClassTemplateSchema`, not hand-declared: deriving is what
 * puts a newly added schema field into `keyof`, which is what every pin below
 * depends on. A hand-declared type would never see the offending field at all.
 *
 * Unlike `ClassUpdateData`, this needs no `Omit`/intersection — every schema
 * field maps to a column of the same type, including the two enums. That is why
 * the reverse pin here has no equivalent of the `date` blind spot documented in
 * `class-lifecycle.ts`.
 */
export type ClassTemplateUpdateData = z.infer<typeof updateClassTemplateSchema>;

/**
 * Compile-time pin: every field the wire schema accepts must name a column
 * `update` can write on `ClassTemplate` — the write below checks the types,
 * this checks the name, and only this catches a name Prisma has never heard
 * of.
 *
 * The reference is the *Many* input deliberately, as in the class service: the
 * single-record type additionally accepts a nested relation write (`classes`)
 * that a plain field update should never receive, so pinning against it would
 * wave through a schema field named after that relation.
 */
const _templateUpdateColumnsExist: NoneOf<
  Exclude<keyof ClassTemplateUpdateData, keyof Prisma.ClassTemplateUncheckedUpdateManyInput>
> = true;
void _templateUpdateColumnsExist;

/**
 * The fields a teacher may change on their own template via
 * `PUT /api/class-templates/[id]`.
 *
 * Adding a member is how a new schema field gets authorized. Three kinds of
 * member already here carry consequences beyond the template row — check what
 * you are joining before adding another:
 *   - `dayOfWeek`     → `syncTemplateInstances` DELETES generated instances on
 *                       the old day (a different day is a different class) and
 *                       the generator refills on the new one. The most
 *                       destructive field on this list.
 *   - `teacherRoomId` → cross-teacher. The ownership check in
 *                       `updateClassTemplate` is the only thing stopping a
 *                       teacher attaching their template to another's room.
 *   - the economic fields → propagate to instances with no registrations;
 *                       anything a student has booked keeps its settings.
 */
type TeacherEditableClassTemplateField =
  | 'classType'
  | 'description'
  | 'teacherRoomId'
  | 'dayOfWeek'
  | 'startTime'
  | 'durationMinutes'
  | 'roomCost'
  | 'minRate'
  | 'targetRate'
  | 'minStudents'
  | 'maxStudents'
  | 'cancelDeadline'
  | 'autoCancelCheck';

/**
 * Compile-time pin (forward): every field the schema accepts must be on the
 * allowlist. Add a column-shaped field to the schema without adding it here and
 * this names that field instead of resolving to `true`.
 *
 * As in `class-lifecycle.ts`, forward and reverse together force the allowlist to
 * *equal* the schema's key set, so the allowlist holds no policy of its own.
 * What it buys is that the grant must be explicit — a second edit, next to the
 * hazards above. The forbidden pin below is what refuses the grants that are
 * never right.
 */
const _templateFieldsArePermitted: NoneOf<
  Exclude<keyof ClassTemplateUpdateData, TeacherEditableClassTemplateField>
> = true;
void _templateFieldsArePermitted;

/**
 * Compile-time pin (reverse): every allowlist entry must still be a field the
 * schema accepts, so the list cannot rot into granting permission for a column
 * that no longer flows through this route.
 *
 * Also the only pin that fires if `ClassTemplateUpdateData` ever degrades to
 * `{}` or `unknown` — on an empty `keyof` the forward pin passes vacuously.
 */
const _templateAllowlistHasNoStaleFields: NoneOf<
  Exclude<TeacherEditableClassTemplateField, keyof ClassTemplateUpdateData>
> = true;
void _templateAllowlistHasNoStaleFields;

/**
 * The `ClassTemplate` columns the plain update path must never write.
 *
 * "Plain update path", not "never": `isActive` and `isArchived` are edited
 * constantly — by `PATCH` on this very route — and that is the point. Each
 * column here is owned by a different, guarded path:
 *   - `id`         → identity
 *   - `teacherId`  → ownership
 *   - `isActive`   → `PATCH`, which wraps the flip in a transaction and calls
 *                    `generateInstancesForTemplate`. A bare flip to `true`
 *                    would mark a template active with no instance window.
 *   - `isArchived` → `PATCH ?state=archived`, which also forces
 *                    `isActive: false`. Writing it alone can produce the
 *                    archived-but-active state `PATCH` refuses to create.
 *   - `createdAt`, `updatedAt` → Prisma-managed.
 *
 * The forward and reverse pins make the allowlist mirror the schema, so the
 * quickest way to clear a forward-pin failure is to paste the offending name
 * into the allowlist — the reflexive grant #79 is about. This is the set where
 * that repair is never right.
 */
type PlainUpdateForbiddenTemplateField =
  | 'id'
  | 'teacherId'
  | 'isActive'
  | 'isArchived'
  | 'createdAt'
  | 'updatedAt';

/**
 * Compile-time pin: every name above must be a real `ClassTemplate` column.
 * Without this a typo (`isActiv`) would sit in the forbidden list protecting
 * nothing while looking like protection.
 */
const _templateForbiddenColumnsExist: NoneOf<
  Exclude<PlainUpdateForbiddenTemplateField, keyof Prisma.ClassTemplateUncheckedUpdateManyInput>
> = true;
void _templateForbiddenColumnsExist;

/**
 * Compile-time pin (forbidden): no forbidden column may appear on the
 * allowlist. Fails on a const whose name carries the reason, because the const
 * name is the part of a type error people actually read.
 */
const _templateAllowlistHasNoForbiddenFields: NoneOf<
  Extract<TeacherEditableClassTemplateField, PlainUpdateForbiddenTemplateField>
> = true;
void _templateAllowlistHasNoForbiddenFields;

/**
 * Why an update did or did not happen. Every business outcome is a variant;
 * callers own the user-facing wording.
 */
export type UpdateClassTemplateResult =
  | { ok: true; template: ClassTemplate; sync: TemplateSyncResult }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'no_fields' }
  | { ok: false; reason: 'invalid_room' };

/**
 * Apply a partial update to a class template, then propagate it to the
 * instances that are still mutable.
 *
 * Takes `teacherId` rather than a session: this is the ownership check, and
 * keeping it a plain argument is what lets the function be tested without HTTP.
 *
 * The write and the propagation are deliberately NOT one transaction, matching
 * the behaviour this replaced: if `syncTemplateInstances` throws, the template
 * row is already updated and the error propagates, so the caller sees a failure
 * for a partially applied change. That window is real and predates this
 * function; closing it changes behaviour (a sync failure would roll the edit
 * back) and belongs in its own change, with its own test.
 *
 * That is not the only seam. `syncTemplateInstances` has one of its own:
 * deletes and updates run inside an inner `$transaction`, but the refill that
 * follows a day change runs after it, outside any transaction. A refill
 * failure there leaves the wrong-day instances already permanently deleted and
 * the window not refilled — the template write, the sync's delete/update step,
 * and the refill are three separately-committed steps, not one.
 */
export async function updateClassTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  // The intersection with `Partial<Record<PlainUpdateForbiddenTemplateField,
  // never>>` is what makes the forbidden list above bind *callers*, not just
  // the wire schema. The pins only prove the allowlist and the schema agree
  // with each other — they say nothing about what a caller actually passes.
  // Excess-property checking, the mechanism that would otherwise catch a
  // stray `teacherId` or `isActive` riding along with a legitimate patch,
  // fires only on a fresh object literal; build `data` as a variable first
  // (`const patch = { classType: 'Yin', teacherId: 'x' }; updateClassTemplate(
  // db, id, me, patch)`) and it never triggers, so a value with no matching
  // type declaration would sail straight through to `update`. Marking each
  // forbidden key optional-and-`never` here forces TypeScript to reject that
  // argument regardless of whether it arrives as a literal or a variable.
  data: ClassTemplateUpdateData & Partial<Record<PlainUpdateForbiddenTemplateField, never>>,
): Promise<UpdateClassTemplateResult> {
  const template = await db.classTemplate.findUnique({ where: { id: templateId } });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  // Defined-value scan, matching `updateClass` (`class-lifecycle.ts:465`): a
  // key present with value `undefined` is not an edit. A key-count check would
  // let `{ description: undefined }` clear this guard, issue a no-op `update`,
  // run a full sync for nothing, and still report `ok: true`.
  const hasEdit = Object.values(data).some((v) => v !== undefined);
  if (!hasEdit) return { ok: false, reason: 'no_fields' };

  // A teacher may only attach a template to a room they already hold. Checked
  // before the write so a bad room never lands, and checked here rather than in
  // the route so the guard travels with the function.
  //
  // "Room doesn't exist" and "room isn't yours" are deliberately the same
  // outcome. Splitting them would hand a caller a cross-teacher existence
  // oracle for `TeacherRoom` ids — try every id and read which error comes
  // back. Right now only two tests stand between that merge and a
  // well-meaning refactor that reports the two cases separately.
  if (data.teacherRoomId !== undefined) {
    const teacherRoom = await db.teacherRoom.findUnique({ where: { id: data.teacherRoomId } });
    if (!teacherRoom || teacherRoom.teacherId !== teacherId) {
      return { ok: false, reason: 'invalid_room' };
    }
  }

  let updated: ClassTemplate;
  try {
    updated = await db.classTemplate.update({ where: { id: templateId }, data });
  } catch (err) {
    // The read above and this write are not one transaction, so a delete
    // landing in between surfaces here as Prisma's P2025 ("record to update
    // not found"). Map it to the same outcome the read-time check above would
    // have produced, rather than letting it fall through as an opaque 500.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return { ok: false, reason: 'not_found' };
    }
    throw err;
  }
  const sync = await syncTemplateInstances(db, templateId);

  return { ok: true, template: updated, sync };
}

// ---------------------------------------------------------------------------
// Pause / resume and archive / un-archive (#86)
// ---------------------------------------------------------------------------

/**
 * Outcome of a pause/resume PATCH. `paused` carries the furthest-out class
 * still on the schedule, for the pause confirmation; `active` and
 * `unchanged` report nothing beyond the template itself — resuming needs no
 * explanation, and `unchanged` describes a request that changed nothing.
 */
export type PauseTemplateResult =
  | {
      ok: true;
      action: 'paused';
      template: ClassTemplate;
      lastScheduled: { date: Date; startTime: string } | null;
    }
  | { ok: true; action: 'active'; template: ClassTemplate }
  | { ok: true; action: 'unchanged'; template: ClassTemplate }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'archived' };

/**
 * Archiving and un-archiving are different operations and report different
 * things; `unchanged` is a third, and reports nothing at all. `deleted`/
 * `remaining` exist only on the archiving arm — un-archiving removes nothing,
 * and a no-op removes nothing twice.
 */
export type ArchiveTemplateResult =
  | { ok: true; action: 'archived'; template: ClassTemplate; deleted: number; remaining: number }
  | { ok: true; action: 'unarchived'; template: ClassTemplate }
  | { ok: true; action: 'unchanged'; template: ClassTemplate }
  | { ok: false; reason: 'not_found' | 'forbidden' };

/**
 * Statuses a generated instance can still be withdrawn or regenerated from.
 * Frozen for the same reason as `CHARGED_STATUSES`: it gates a destructive
 * delete. Prisma's `in` wants a mutable array, so call sites spread.
 */
const SCHEDULED_STATUSES: readonly ClassStatus[] = Object.freeze(['draft', 'open']);

/**
 * Classes still on the schedule for a template, from the given calendar-date
 * boundary onward.
 *
 * The boundary is a parameter rather than baked in because the two callers
 * need different ones against the same status filter, and the difference is
 * load-bearing: the delete uses `gt` (today's class is spared) while the
 * counts use `gte` (today's class is exactly the survivor they must report).
 * Both are compared against a *calendar date* from `startOfLocalDay`, never a
 * raw instant — see that helper for why.
 */
const scheduledWhere = (templateId: string, date: { gt: Date } | { gte: Date }) => ({
  templateId,
  date,
  status: { in: [...SCHEDULED_STATUSES] },
});

/**
 * Pause or resume generation. Deletes nothing: pausing means "no new classes",
 * not "withdraw what I already offered" — that is what archiving is for.
 *
 * The re-activation branch is moved verbatim from the PATCH route's previous
 * default action (`src/app/api/class-templates/[id]/route.ts`), not
 * reconstructed: atomic so a generation failure rolls the `isActive` toggle
 * back rather than leaving the template active with a stale window, and using
 * the same typed `teacher: { select: { defaultTimezone: true } }` include
 * `generateInstancesForTemplate` requires.
 */
export async function pauseOrResumeTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  target: 'active' | 'paused',
): Promise<PauseTemplateResult> {
  const template = await db.classTemplate.findUnique({
    where: { id: templateId },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  // Same reason as the drop further down: `PauseTemplateResult` carries a
  // plain `ClassTemplate`, so the joined `teacher` this include added is
  // dropped rather than leaked back to the caller — including on this
  // early-return path, before any write happens.
  const { teacher: _t, ...bare } = template;
  void _t;

  const desiredActive = target === 'active';

  // Before the archived guard, deliberately. Archiving forces `isActive:
  // false`, so `?state=paused` on an archived template is already true and
  // there is nothing to refuse — only `?state=active` is the transition the
  // guard exists to block.
  if (template.isActive === desiredActive) {
    return { ok: true, action: 'unchanged', template: bare };
  }

  if (template.isArchived) return { ok: false, reason: 'archived' };

  const updated = await db.$transaction(
    async (tx) => {
      const t = await tx.classTemplate.update({
        where: { id: templateId },
        data: { isActive: desiredActive },
        include: { teacher: { select: { defaultTimezone: true } } },
      });
      if (t.isActive) await generateInstancesForTemplate(tx, t);
      return t;
    },
    // The claim in `class-generator.ts` holds this row's lock for up to its
    // own 10s transaction; Prisma's 5s default would abort us mid-wait.
    { timeout: 10_000 },
  );

  // The include above is only for `generateInstancesForTemplate`'s benefit —
  // `PauseTemplateResult` carries a plain `ClassTemplate`, so the joined
  // `teacher` is dropped rather than leaked back to the caller.
  const { teacher, ...template_ } = updated;
  void teacher;

  if (!desiredActive) {
    // `gte` today, not `gt`: this reports what is still on the schedule, and
    // today's class is still on it. Pause deletes nothing, so there is no
    // spare-today carve-out here to mirror — using the delete's `gt` boundary
    // would tell a teacher whose only remaining class is today's that nothing
    // is scheduled, while it sits on their schedule and open on their page.
    const today = startOfLocalDay(new Date(), template.teacher.defaultTimezone);
    const lastScheduled = await db.class.findFirst({
      where: scheduledWhere(templateId, { gte: today }),
      orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
      select: { date: true, startTime: true },
    });
    return { ok: true, action: 'paused', template: template_, lastScheduled };
  }

  return { ok: true, action: 'active', template: template_ };
}

/**
 * Archive or un-archive. Archiving withdraws the future classes nobody booked
 * and leaves the rest standing (#86): generated instances are created `open`
 * and the public booking page filters on status and date without consulting
 * the template, so without this an archived template keeps up to four weeks of
 * classes publicly bookable.
 *
 * "Nobody booked" means no registration in a CHARGED status — deliberately not
 * `settingsLocked` (which answers whether the price may change, and stays true
 * forever) and not `ACTIVE_REGISTRATION_STATUSES` (which excludes `late_cancel`,
 * so a class a student still owes for would be cascaded away).
 *
 * The update and the delete share a transaction: a half-applied archive is
 * exactly the shelved-but-bookable state this exists to prevent.
 */
export async function archiveOrUnarchiveTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  target: 'archived' | 'unarchived',
): Promise<ArchiveTemplateResult> {
  const template = await db.classTemplate.findUnique({
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
      await tx.classTemplate.update({
        where: { id: templateId },
        data: { isArchived: archiving, isActive: false },
      });

      if (!archiving) {
        const cleared = await tx.classTemplate.update({
          where: { id: templateId },
          data: { archivedAt: null, withdrawnCount: null },
        });
        // A live template has no withdrawal to report. Leaving a stale count
        // on it would be worse than having none (#97).
        return { ok: true as const, action: 'unarchived' as const, template: cleared };
      }

      // One clock reading serves both the calendar boundary and the
      // timestamp recorded below. `Class.date` is `@db.Date`, so both sides
      // of every comparison below are calendar dates — the comparison the
      // generator that created these rows already makes (`class-generator.ts`
      // filters on `classStartInstant`). Comparing the column to a raw
      // instant instead would, east of UTC, delete a class running that same
      // evening, and west of UTC leave tomorrow's class bookable under an
      // archived template — the exact leak #86 exists to close.
      const now = new Date();
      const today = startOfLocalDay(now, timeZone);

      // Deliberately one statement, not a `findMany` followed by a
      // `deleteMany({ id: { in: ids } })`: a two-step read-then-delete lets a
      // registration commit in the gap between them under READ COMMITTED, and
      // the delete — keyed only on the ids already read — does not re-check it,
      // destroying a class (and cascading away a now-charged registration) that
      // became booked after the read. Passing the predicate straight to
      // `deleteMany` makes Postgres re-evaluate it at execution time, and its
      // returned `count` is the number of rows that actually matched then — not
      // a stale count from an earlier read. Do not "optimise" this back into a
      // read-then-delete.
      const { count: deleted } = await tx.class.deleteMany({
        where: {
          ...scheduledWhere(templateId, { gt: today }),
          registrations: { none: { status: { in: [...CHARGED_STATUSES] } } },
        },
      });

      // `gte`, where the delete used `gt`. The delete deliberately spares a
      // class dated today — "a class hours from starting should not shift under
      // its students", the rule `syncTemplateInstances` already applies to
      // edits — so counting with the delete's own boundary would exclude that
      // same survivor and tell the teacher nothing is left while the class is
      // still open on their public page.
      const remaining = await tx.class.count({
        where: scheduledWhere(templateId, { gte: today }),
      });

      // Written from the delete's own `count`, inside the same transaction, so
      // the record cannot claim a number the delete did not produce and cannot
      // survive a rollback that withdrew nothing (#97). A second `update`
      // rather than folding this into the first: that one runs before the
      // delete and takes the row lock the sweep serialises against (#95), and
      // moving it would change when that lock is acquired.
      const recorded = await tx.classTemplate.update({
        where: { id: templateId },
        data: { archivedAt: now, withdrawnCount: deleted },
      });

      return { ok: true as const, action: 'archived' as const, template: recorded, deleted, remaining };
    },
    // This `update` takes the same row lock the generator sweep's
    // `claimTemplateForGeneration` (class-generator.ts) holds for the
    // duration of its own per-template transaction, so an archive can now
    // block on a sweep in progress. Matching the sweep's 10s transaction
    // timeout means this waits at most as long as the sweep could possibly
    // run, not Prisma's 5s default — which a loaded VPS can exceed and turn
    // an ordinary archive click into an opaque P2028.
    { timeout: 10_000 },
  );
}
