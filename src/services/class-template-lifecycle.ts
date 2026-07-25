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
 *   - `isArchived` → `PATCH ?action=archive`, which also forces
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

/** The furthest-out class still on the schedule, for the pause confirmation. */
export type PauseTemplateResult =
  | { ok: true; template: ClassTemplate; lastScheduled: { date: Date; startTime: string } | null }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'archived' };

export type ArchiveTemplateResult =
  | { ok: true; template: ClassTemplate; deleted: number; remaining: number }
  | { ok: false; reason: 'not_found' | 'forbidden' };

/**
 * Statuses a generated instance can still be withdrawn or regenerated from.
 * A plain, mutable `ClassStatus[]` — not `as const` — because Prisma's `in`
 * filter wants `ClassStatus[]`, not a readonly tuple.
 */
const SCHEDULED_STATUSES: ClassStatus[] = ['draft', 'open'];

/** Future classes still on the schedule for a template — the actionable ones. */
const scheduledWhere = (templateId: string, now: Date) => ({
  templateId,
  date: { gt: now },
  status: { in: SCHEDULED_STATUSES },
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
): Promise<PauseTemplateResult> {
  const template = await db.classTemplate.findUnique({ where: { id: templateId } });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };
  if (template.isArchived) return { ok: false, reason: 'archived' };

  const updated = await db.$transaction(async (tx) => {
    const t = await tx.classTemplate.update({
      where: { id: templateId },
      data: { isActive: !template.isActive },
      include: { teacher: { select: { defaultTimezone: true } } },
    });
    if (t.isActive) await generateInstancesForTemplate(tx, t);
    return t;
  });

  // The include above is only for `generateInstancesForTemplate`'s benefit —
  // `PauseTemplateResult` carries a plain `ClassTemplate`, so the joined
  // `teacher` is dropped rather than leaked back to the caller.
  const { teacher, ...template_ } = updated;
  void teacher;

  const lastScheduled = await db.class.findFirst({
    where: scheduledWhere(templateId, new Date()),
    orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
    select: { date: true, startTime: true },
  });

  return { ok: true, template: template_, lastScheduled };
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
): Promise<ArchiveTemplateResult> {
  const template = await db.classTemplate.findUnique({ where: { id: templateId } });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  const archiving = !template.isArchived;

  return db.$transaction(async (tx) => {
    const updated = await tx.classTemplate.update({
      where: { id: templateId },
      data: { isArchived: archiving, isActive: false },
    });

    if (!archiving) return { ok: true as const, template: updated, deleted: 0, remaining: 0 };

    const now = new Date();
    const deletable = await tx.class.findMany({
      where: {
        ...scheduledWhere(templateId, now),
        registrations: { none: { status: { in: CHARGED_STATUSES } } },
      },
      select: { id: true },
    });

    if (deletable.length > 0) {
      await tx.class.deleteMany({ where: { id: { in: deletable.map((c) => c.id) } } });
    }

    const remaining = await tx.class.count({ where: scheduledWhere(templateId, now) });

    return { ok: true as const, template: updated, deleted: deletable.length, remaining };
  });
}
