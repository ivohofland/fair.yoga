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
 *     needed. Scoped to `updateClassTemplate` and `pauseOrResumeTemplate`
 *     (#100; the latter's guard points back at the former): the archive section
 *     further down does use a compare-and-swap, because there the race to
 *     close is two requests applying the same transition, not a row
 *     disappearing.
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient, ClassTemplate, ClassStatus } from '@prisma/client';
import type { z } from 'zod';
import type { updateClassTemplateSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { startOfLocalDay } from '@/lib/timezone';
import { formatDayHeader } from '@/lib/format';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { isTransientDbError } from '@/lib/api-errors';
import { setLockTimeout } from '@/lib/db-locks';
// Server-only (pino). Safe here: this module's sole importer is
// `api/class-templates/[id]/route.ts`, and it already pulls `@/lib/log`
// transitively through `class-generator`. No `'use client'` component
// value-imports anything in this chain.
import { log } from '@/lib/log';
import { createBulkNotifications, type CreateNotificationInput } from './notifications';
import { syncTemplateInstances, type TemplateSyncResult } from './template-sync';
import { generateInstancesForTemplate } from './class-generator';
import { CHARGED_STATUSES } from './class-lifecycle';
import { countSkipReasons } from '@/lib/generation';

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
 *   - `archivedAt`, `withdrawnCount` → written only by the same `PATCH
 *                    ?state=archived|unarchived` transaction that owns
 *                    `isArchived` (#97). A plain update setting these directly
 *                    could forge "Archived <date> · <count> withdrawn" onto a
 *                    template that was never archived — the exact stale-record
 *                    state the un-archive clear exists to prevent.
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
  | 'archivedAt'
  | 'withdrawnCount'
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
  | { ok: false; reason: 'invalid_room' }
  | { ok: false; reason: 'slot_conflict' }
  | { ok: false; reason: 'sync_conflict' };

/**
 * Apply a partial update to a class template, then propagate it to the
 * instances that are still mutable.
 *
 * Takes `teacherId` rather than a session: this is the ownership check, and
 * keeping it a plain argument is what lets the function be tested without HTTP.
 *
 * The write and the propagation are deliberately NOT one transaction, matching
 * the behaviour this replaced: if `syncTemplateInstances` throws, the template
 * row is already updated. Three shapes are mapped below rather than left to
 * propagate: P2025 becomes `{ ok: false, reason: 'not_found' }`, because the
 * row is gone before the caller is answered (#100); a P2002 on
 * `ClassTemplate_teacher_slot_unique` — raised by the `update` call above
 * writing this template's own `dayOfWeek`/`startTime` — becomes
 * `slot_conflict` (#196); and a P2002 on `Class_teacher_slot_unique` — raised
 * by `syncTemplateInstances`'s same-day rewrite colliding with an instance the
 * propagation never touches — becomes `sync_conflict` (#196). Everything else
 * from the sync call still propagates, so the caller sees a failure for a
 * partially applied change. That window is real and predates this function;
 * closing it for those remaining failures changes behaviour (a sync failure
 * would roll the edit back) and belongs in its own change, with its own test.
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

  // Defined-value scan, matching `updateClass`'s own `hasEdit` check
  // (`class-lifecycle.ts`): a key present with value `undefined` is not an
  // edit. A key-count check would let `{ description: undefined }` clear
  // this guard, issue a no-op `update`, run a full sync for nothing, and
  // still report `ok: true`.
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
  let sync: TemplateSyncResult;
  try {
    updated = await db.classTemplate.update({ where: { id: templateId }, data });
    // Inside the same `try` as the write above, deliberately. This call opens
    // with a `findUniqueOrThrow` (`template-sync.ts`) and runs after the
    // update has already committed, with no lock held in between — so it has
    // a P2025 window of its own (#100).
    sync = await syncTemplateInstances(db, templateId);
  } catch (err) {
    // The read above and the two statements in the `try` are not one
    // transaction, so a delete landing in between surfaces here as Prisma's
    // P2025 from either of them. Map it to the same outcome the read-time
    // check above would have produced, rather than letting it fall through as
    // an opaque 500.
    //
    // Two different statements under the one code, and telling them apart in
    // a log is harder than it looks. Measured against this repo's
    // `@prisma/client` 6.19.3: the `update` raises the cause "No record was
    // found for an update.", `syncTemplateInstances`'s opening
    // `findUniqueOrThrow` "No record was found for a query." One word apart,
    // so do not go grepping for either — the discriminator that actually
    // works is the invocation line Prisma puts at the head of `err.message`
    // ("Invalid `prisma.classTemplate.update()` invocation" versus
    // "…findUniqueOrThrow() invocation"). Both cause strings are Prisma's
    // wording, not ours, and they have changed across its major versions;
    // re-measure before relying on either.
    //
    // From the sync call this means answering `not_found` for an update that
    // *did* commit. That is the honest answer rather than a convenient one:
    // the row is gone before the caller is answered, so reporting a
    // successful update of a template that no longer exists would be the lie.
    // The `sync` counts are lost with it, which costs nothing — but not
    // because there is nothing left. `Class.template` is `onDelete: SetNull`
    // (`prisma/schema.prisma`), so deleting a template does not take its
    // generated classes with it: each keeps standing with `templateId: null`,
    // still `open`, still on the teacher's schedule and public booking page,
    // frozen with whatever settings it had before this edit. What the delete
    // removed is the link, so `syncTemplateInstances`'s `templateId` filter
    // now matches nothing and the counts it would have returned are `{ synced:
    // 0, regenerated: 0, kept: 0 }` — worth nothing to a caller. Whoever
    // writes the delete path this guard exists for inherits those orphans:
    // they are that path's problem, not this function's.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return { ok: false, reason: 'not_found' };
    }

    // Two more sources under this one `try`, added by #196, and they raise
    // two different column shapes because they are two different tables. The
    // `update` above writes `dayOfWeek`/`startTime` straight from `data` (both
    // on `TeacherEditableClassTemplateField`), so it can collide on this
    // template's own `ClassTemplate_teacher_slot_unique`. `syncTemplateInstances`
    // (`template-sync.ts`)'s `sameDay` block then rewrites `startTime` on every
    // still-mutable generated `Class` sharing this template's day, and each of
    // those can independently collide on `Class_teacher_slot_unique` with a
    // class the propagation never touches — a manually created draft, say, or
    // an instance of a different template — sitting at the slot the new
    // `startTime` now lands on. `isUniqueConflictOn`'s column-set match is what
    // tells the two apart without needing `modelName`: neither column set names
    // the other table.
    if (isUniqueConflictOn(err, ['teacherId', 'dayOfWeek', 'startTime'])) {
      return { ok: false, reason: 'slot_conflict' };
    }
    if (isUniqueConflictOn(err, ['teacherId', 'date', 'startTime'])) {
      // The one outcome here that leaves the database knowingly inconsistent
      // — by this point `db.classTemplate.update` above has committed, and
      // `syncTemplateInstances`'s inner transaction has rolled back — and the
      // only one that logged nothing before this line: `respondError`
      // (`api/class-templates/[id]/route.ts`) does not log, and
      // `withErrorHandler` logs only on `throw`, which this path does not do.
      // #209.
      log.warn(
        { templateId, teacherId },
        'template updated but its generated-instance sync rolled back — template and instances are now desynced',
      );
      return { ok: false, reason: 'sync_conflict' };
    }
    throw err;
  }

  return { ok: true, template: updated, sync };
}

// ---------------------------------------------------------------------------
// Pause / resume and archive / un-archive (#86)
// ---------------------------------------------------------------------------

/**
 * The last class still on the schedule for a template, as `pauseOrResumeTemplate`
 * and its studio twin report it, and as `pauseMessage` renders it.
 *
 * Shared rather than declared per site, which is what #100 asked for. Note the
 * two families are otherwise deliberately parallel-but-separate (see the header
 * of `studio-class-template-lifecycle.ts`, and PR #92, which found they had
 * drifted): that policy is about shared *implementation*, and this is two
 * fields with no logic to drift.
 *
 * `date` is `Class.date` or `StudioClass.date` straight through — both
 * producers supply one — and both columns are `@db.Date`: a calendar date
 * pinned to midnight UTC, never an instant. That is the one
 * property of this type a producer can actually violate, and it is what
 * licenses `pauseMessage` to render it through `formatDayHeader`, which reads
 * its argument with `getUTC*` accessors (`src/lib/format.ts`). Fill this from
 * a raw `new Date()` instead and the rendered day slips back one west of UTC.
 * Both producers satisfy it today by `select`ing the column unchanged.
 *
 * `TemplateToggleResponse.lastScheduled` in `template-action-messages.ts` is
 * NOT this type and must not be folded into it — it carries `date: string`,
 * the post-`JSON.parse` wire form, converted back inside that file's two
 * `resolve*Confirmation` functions.
 */
export type LastScheduledClass = { date: Date; startTime: string };

/**
 * Outcome of a pause/resume PATCH. `paused` carries the furthest-out class
 * still on the schedule, for the pause confirmation; `active` reports what the
 * window holds and why it is not fuller — `scheduled`, `added`,
 * `blockedByCancelled`, `slotTaken`; `unchanged` reports nothing beyond the
 * template itself, because it describes a request that changed nothing.
 *
 * This paragraph used to say "resuming needs no explanation", ten lines above
 * the arm that now carries four counts. That is exactly the shape #164 was
 * caused by — a header disagreeing with the declaration beneath it — so it is
 * worth stating why it survived: it was true when resuming only flipped a flag,
 * and nothing forces a docblock to be re-read when the type under it grows.
 */
export type PauseTemplateResult =
  | {
      ok: true;
      action: 'paused';
      template: ClassTemplate;
      lastScheduled: LastScheduledClass | null;
    }
  | {
      ok: true;
      action: 'active';
      template: ClassTemplate;
      /**
       * Scheduled classes for this template from the start of the teacher's
       * today onward — the same predicate and boundary `remaining` uses, so
       * archiving and resuming report on one basis.
       *
       * Mirrors the studio family's `scheduled` (#119) in the three ways that
       * carry the guarantee, not just in name: counted after generation,
       * inside the same transaction, off the same `defaultTimezone` read the
       * generator filtered its candidate dates with. An earlier draft counted
       * it outside the transaction against the pre-transaction read of that
       * column, which is the one input the studio twin's docblock names as
       * making `scheduled < added` reachable.
       */
      scheduled: number;
      /** Rows this resume created. */
      added: number;
      /** Candidate dates a cancelled instance of this template holds (#192). */
      blockedByCancelled: number;
      /** Candidate dates another of this teacher's classes holds (#196). */
      slotTaken: number;
    }
  | { ok: true; action: 'unchanged'; template: ClassTemplate }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'archived' }
  /**
   * See `ArchiveTemplateResult`'s `busy` arm for what it guarantees and the
   * range of causes behind it.
   *
   * Two statements here can wait on a lock — the `update` below and
   * generation's insert — against the archive's three, so this is the smaller
   * exposure of the two. The second of them is what makes this arm worth its
   * own note: the bound reaches generation, so a resume that loses a slot race
   * answers `busy` rather than reporting that date as `raced`
   * (`class-generator.test.ts`, "the clash outlives the lock timeout").
   */
  | { ok: false; reason: 'busy' };

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
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'slot_conflict' }
  /**
   * This transaction lost a contention race and rolled back whole, so nothing
   * was applied and the identical request can win the next attempt.
   *
   * Not only a `lock_timeout` expiry, though that is the case this branch
   * added and the one the copy is written for. The arm is produced by
   * `isTransientDbError`, which also matches a deadlock the detector broke
   * (`40P01`), Prisma's own write-conflict code (`P2034`), an exhausted
   * connection pool (`P2024`) and the transaction budget expiring (`P2028`).
   * Reading a `busy` in the logs and hunting for a 2s lock wait that never
   * happened is the mistake this paragraph exists to prevent.
   *
   * Two calibrations, so this list does not send anyone the other way. The
   * deadlock is the likelier answer only WHERE A CYCLE FORMS — the detector
   * runs on a 1s `deadlock_timeout` and `docs/lock-order.md` records a live
   * cycle against this function — while the branch's headline case, an archive
   * queued behind the sweep's claim, has no cycle and ends in `55P03`. And
   * `40001` is in the matcher but cannot fire yet: nothing here uses a
   * serializable or repeatable-read transaction, as `api-errors.ts` says where
   * it lists the code.
   *
   * The writer on the other side is equally unknown — the generation sweep, or
   * another tab's archive, pause or resume — which is why the copy names none
   * of them.
   */
  | { ok: false; reason: 'busy' };

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

  const updated = await db
    .$transaction(
      async (tx) => {
        // Bounds every statement left in this transaction, the `update` below
        // first among them — the sweep's claim holds this row `FOR UPDATE`.
        //
        // Without it the wait is bounded by NOTHING, not by the 10s budget:
        // Prisma checks that budget at statement boundaries, so it "cannot
        // roll back a statement already blocked inside Postgres, only refuse
        // to start a new one" (`db-locks.ts`), which the mutation records
        // measure as a hung test rather than a 10s abort.
        await setLockTimeout(tx);

        const t = await tx.classTemplate.update({
          where: { id: templateId },
          data: { isActive: desiredActive },
          include: { teacher: { select: { defaultTimezone: true } } },
        });
        if (!t.isActive) {
          return { template: t, generation: { created: 0, skipped: [] }, scheduled: 0 };
        }
        const generation = await generateInstancesForTemplate(tx, t);

        // Inside the transaction, on `tx`, and keyed to `t.teacher` — all
        // three deliberately, to match `pauseOrResumeStudioTemplate` rather
        // than merely resemble it.
        //
        // `t.teacher.defaultTimezone`, not the `template.teacher` read at the
        // top of this function. That is the studio twin's rule, and its
        // reasoning carries over unchanged: `generateInstancesForTemplate`
        // filtered its candidate dates with `classStartInstant(date,
        // startTime, t.teacher.defaultTimezone)` off this same object, so
        // keying the count's boundary to a *different* read of that column is
        // the one way `scheduled < added` becomes reachable — a zone change
        // committing between the two reads moves the `gte today` boundary past
        // a row generation just added.
        //
        // **No test pins this, deliberately — know that before trusting it.**
        // Making the two reads disagree needs a zone change injected between
        // them (the `$extends` lever this file's tests already use) *and* a
        // wall-clock hour at which the two zones' local days straddle a
        // generated date. This function reads `new Date()` internally and takes
        // no injectable clock, so such a test would pass vacuously at most
        // hours — the #138 failure, where a check ran at a time when both code
        // paths rendered identically and therefore proved nothing. Adding a
        // `now` parameter to production code for a test to steer is the other
        // thing this project declines to do. The guard is this paragraph and
        // the studio twin's; if you change this line, nothing will stop you.
        //
        // Do not "simplify" this to
        // `template.teacher.…`.
        const today = startOfLocalDay(new Date(), t.teacher.defaultTimezone);
        const scheduled = await tx.class.count({
          where: scheduledWhere(templateId, { gte: today }),
        });
        return { template: t, generation, scheduled };
      },
      // The wait is bounded at 2s by the `setLockTimeout` at the top of this
      // transaction, so this budget no longer governs it — it governs this
      // transaction's own work once the row is won: the `update`, generation's
      // occupancy read and its batched insert, and the `count`. A loaded VPS
      // can push those past Prisma's 5s default.
      //
      // The sentence this replaces said the 5s default "would abort us
      // mid-wait". It would not, and could not: Prisma checks the budget at
      // statement boundaries, and a statement blocked inside Postgres never
      // reaches one. It was the third of three comments making that claim and
      // the one the correction wave missed.
      { timeout: 10_000 },
    )
    .catch((err: unknown) => {
      // Same window as `updateClassTemplate`'s guard above: the read at the
      // top of this function and this write are not one transaction, and the
      // `update` is the transaction's first statement, so nothing holds the
      // row when it runs. A delete landing in between surfaces as P2025. Map
      // it to the outcome the read-time check would have produced (#100).
      //
      // Note what this `catch` is actually attached to: the whole
      // `$transaction`, not the `update` alone — so it covers
      // `generateInstancesForTemplate` too. It is tight today only by
      // accident of what runs under it, which is now three statements, not
      // two: the `update` above, `generateInstancesForTemplate`'s
      // `class.findMany` + `class.createManyAndReturn` (`class-generator.ts`),
      // and this transaction's own `class.count`. P2003 only — never P2002
      // from the insert, which the insert's bare `ON CONFLICT DO NOTHING`
      // absorbs rather than raises. Never P2002 from the `update` above
      // either, and this one is worth proving rather than asserting, because
      // #196 added a partial unique index this file's other CAS now collides
      // on: `data` here is `{ isActive: desiredActive }` — nothing else — and
      // `ClassTemplate_teacher_slot_unique` covers `(teacherId, dayOfWeek,
      // startTime)` `WHERE isArchived = false`. None of those four columns is
      // in this write's `data`, so the indexed values themselves are
      // unchanged: a row that already satisfied the constraint still does,
      // regardless of which mechanism Postgres uses to re-check it — the
      // conclusion holds without needing to claim anything about that
      // mechanism. That exemption is local to this write, not
      // to the file: `archiveOrUnarchiveTemplate`'s own CAS, a few hundred
      // lines down, DOES write `isArchived`, and un-archiving into a slot
      // another live template holds is exactly what makes that one raise
      // P2002 — see its own `catch` for where that is handled. And never
      // P2025, which neither a `findMany` nor a `count` can
      // produce. So the `update` above really is the only
      // P2025 source under here, and the guard says `not_found` about the only
      // thing that can go missing. Add an *unprotected* `findUniqueOrThrow`
      // or single-record `update` inside this transaction and that stops
      // being true silently. Whoever does that owes this comment an
      // enumeration of what it now covers, the way the sibling guard above
      // already lists both of its statements.
      //
      // #116, the change most likely to add one, happens to be safe: it puts
      // `claimTemplateForGeneration` here, whose `findUniqueOrThrow` is its
      // *last* statement and runs under the `FOR UPDATE` its own raw `SELECT`
      // just took — so on a transaction client that row provably exists and
      // cannot raise P2025. Safe for the reason the lock gives, not because
      // it is a read.
      // Transient first, ahead of the P2025 sentinel below: `P2028`/`P2024`
      // are `PrismaClientKnownRequestError`s too, so testing `err.code ===
      // 'P2025'` first is safe today only because those codes differ — the
      // ordering is kept explicit so it stays safe if either test widens.
      //
      // A SECOND sentinel, because `null` already means P2025 below. Both are
      // narrowed at the call site; returning a bare `null` here for both would
      // report a busy template as `not_found`, which is the wrong answer and
      // an unretryable-sounding one.
      if (isTransientDbError(err)) {
        log.warn(
          { err, templateId, teacherId, target },
          'recurring class pause/resume lost the template lock race',
        );
        return 'busy' as const;
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return null;
      }
      throw err;
    });

  if (updated === 'busy') return { ok: false, reason: 'busy' };
  if (updated === null) return { ok: false, reason: 'not_found' };

  const { template: updatedTemplate, generation, scheduled } = updated;

  // The include above is only for `generateInstancesForTemplate`'s benefit —
  // `PauseTemplateResult` carries a plain `ClassTemplate`, so the joined
  // `teacher` is dropped rather than leaked back to the caller.
  const { teacher, ...template_ } = updatedTemplate;
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

  // `scheduled` was counted inside the transaction above — see the comment
  // there for why it is not recomputed here. `countSkipReasons`
  // (`@/lib/generation`) is the one place `blockedByCancelled`/`slotTaken`
  // are reduced from `generation.skipped` — see its docblock for why a fifth
  // `SkipReason` fails the build here instead of vanishing.
  return {
    ok: true,
    action: 'active',
    template: template_,
    scheduled,
    added: generation.created,
    ...countSkipReasons(generation.skipped),
  };
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
 *
 * That transaction opens with a compare-and-swap rather than a plain update,
 * so the transition can only be applied once even when two requests race —
 * see the statement itself for why the pre-transaction guard cannot do that
 * job on its own.
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

  // Un-archiving (`archiving === false`) flips `isArchived` from `true` to
  // `false` in the CAS below — the one write in this function that can newly
  // enter `ClassTemplate_teacher_slot_unique`'s partial scope (`WHERE
  // isArchived = false`, #196). Archiving only ever leaves that scope, which
  // cannot collide. Wrapped around the whole `$transaction`, not just the CAS
  // statement: a P2002 raised inside a Postgres transaction aborts it, and
  // the driver surfaces that failure from `$transaction` itself rather than
  // from the individual `await` that triggered it.
  try {
    return await db.$transaction(
      async (tx) => {
        // Bounds every statement left in this transaction — the CAS below
        // first among them, and the `deleteMany` further down too, which is
        // not incidental: that one can lose to an ordinary booking holding a
        // `Class` row, so the 2s answer reaches a path the sweep never
        // touches (`class-generator.test.ts`, "the bound reaches its
        // deleteMany").
        //
        // Without it the wait is bounded by NOTHING, not by the 10s budget:
        // Prisma checks that budget at statement boundaries, so it "cannot
        // roll back a statement already blocked inside Postgres, only refuse
        // to start a new one" (`db-locks.ts`).
        await setLockTimeout(tx);

        // Compare-and-swap, the pattern `updateClass` already uses for #72.
        // Constraining the write to `isArchived: !archiving` makes the
        // *transition* the thing that can happen only once: two archives that
        // both cleared the guard above reach here, and exactly one of them
        // matches a row. Without it the loser overwrote the winner's
        // `archivedAt`/`withdrawnCount` with its own timestamp and a `0` its
        // `deleteMany` produced only because the winner had already deleted
        // those classes — a durable record (#97) of a withdrawal that says it
        // withdrew nothing.
        //
        // Still the transaction's first statement, deliberately: this is what
        // locks the row `claimTemplateForGeneration` (class-generator.ts) locks
        // with its `FOR UPDATE`. Not the same lock mode — an `updateMany`
        // touching no key column takes `FOR NO KEY UPDATE` — but the two
        // *conflict*, and that conflict is what serialises an archive against a
        // sweep in progress (#95). Moving the CAS after the `deleteMany` would
        // withdraw classes before establishing the right to.
        //
        // The contended case resolves in Postgres, not here: the loser blocks
        // inside this statement, and when the winner commits, READ COMMITTED
        // re-evaluates this WHERE against the row version the winner left
        // (EvalPlanQual). `isArchived` now equals `archiving`, the row is
        // skipped, and `count` is 0. That re-evaluation applies to the CAS
        // predicate itself only because Prisma emits this as a single `UPDATE
        // … WHERE "id" = $1 AND "isArchived" = $2` — a filter it compiled to a
        // subquery would be re-run under the same snapshot and match anyway.
        //
        // No P2025 guard here, unlike `updateClassTemplate` and
        // `pauseOrResumeTemplate` (#100). Not an omission: `updateMany` returns
        // `{ count: 0 }` rather than throwing when nothing matches, and the
        // zero-count branch below already answers `not_found` by re-reading. The
        // `findUniqueOrThrow`/`update` sites further down *can* raise P2025, but
        // only run after this CAS matched, which holds `FOR NO KEY UPDATE` on
        // this row until commit. That conflicts with the `FOR UPDATE`-strength
        // lock a concurrent `DELETE` needs, so it blocks rather than wins.
        //
        // What a plain single-record `update` would change is not the lock — it
        // takes the same mode — but the first limb: it raises P2025 where
        // `updateMany` returns `{ count: 0 }`, so the write itself becomes a
        // P2025 source needing its own guard.
        const swapped = await tx.classTemplate.updateMany({
          where: { id: templateId, isArchived: !archiving },
          data: {
            isArchived: archiving,
            isActive: false,
            // Folded in rather than issued as a second `update`: `null` depends
            // on nothing this transaction has yet to do, unlike the archiving
            // arm's `withdrawnCount`, which does not exist until the delete has
            // run. See the record write at the bottom for that asymmetry.
            ...(archiving ? {} : { archivedAt: null, withdrawnCount: null }),
          },
        });

        if (swapped.count === 0) {
          // Both clauses of the CAS constrain the row, so a zero count means
          // either another request already applied the transition or the row is
          // gone — read which rather than assuming, the same distinction #72
          // had to make.
          //
          // This read takes a fresh READ COMMITTED snapshot and holds no lock:
          // the CAS matched nothing, so it acquired none. With three concurrent
          // requests a fourth state is possible — the winner archives, someone
          // un-archives, and this read returns `isArchived: !archiving`. The
          // answer is still `unchanged` for *this* request, which changed
          // nothing, and the returned row is a real row; only the flag a caller
          // reads off it may already be stale. Locking here to close that would
          // serialise the no-op path against the sweep for no gain.
          //
          // Re-read rather than reusing the snapshot from the top of this
          // function: that one still says `isArchived: !archiving`, which is
          // the exact value the winner just falsified.
          const current = await tx.classTemplate.findUnique({ where: { id: templateId } });
          if (!current) return { ok: false as const, reason: 'not_found' as const };
          return { ok: true as const, action: 'unchanged' as const, template: current };
        }

        if (!archiving) {
          // `updateMany` returns a count, not a row, and every arm of the
          // contract carries a template. Reading it back is safe here
          // specifically because the CAS above holds this row's lock until we
          // commit, so nothing can change or delete it in between — the same
          // lock-then-read pattern `claimTemplateForGeneration` uses, and
          // `OrThrow` for the same reason: the update just matched this row.
          //
          // A template that is no longer archived has no withdrawal to report.
          // Not a *live* one — the CAS above forced `isActive: false` in the
          // same write, so what is standing here is paused. Leaving a stale
          // count on it would be worse than having none (#97).
          const cleared = await tx.classTemplate.findUniqueOrThrow({ where: { id: templateId } });
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

        // #112. Who is waiting on a class this archive might withdraw.
        //
        // Read BEFORE the delete because `WaitlistEntry.class` is
        // `onDelete: Cascade` (the `WaitlistEntry` model's `class` relation
        // in `prisma/schema.prisma`) — after the delete these rows
        // do not exist to be read. Decided AFTER it, from the survivor read
        // below, because this read is not the delete's own evaluation.
        //
        // DELIBERATELY WIDER THAN THE DELETE: every waiting entry on a scheduled
        // future class of this template, with no registration predicate. Mirror
        // the delete's `registrations: { none: … }` here instead and the two
        // reads disagree in a direction nothing downstream can repair — a class
        // whose last charged registration is cancelled in the gap becomes
        // deletable without ever having been a candidate, and its waiters are
        // cascade-deleted unnotified. That is #112 itself, one window narrower.
        // It is not exotic: a queue only forms at `maxStudents`, so a class
        // carrying waiters normally DOES hold a charged registration, and any
        // cancel that is not `late_cancel` writes plain `cancelled`
        // (`registrations/[id]/route.ts` — a student's before-deadline cancel and
        // a teacher's cancel at any hour both land there).
        //
        // Wide costs only rows: a class the delete spares is a survivor and is
        // filtered out below, which is what the concurrency test pins. Wide plus
        // that filter makes `withdrawn` exactly the set this `deleteMany` took.
        //
        // A lock is not unavailable — `POST /api/registrations` does take
        // `SELECT … FOR UPDATE` on the class row inline rather than through
        // `lockClassRow` (`db-locks.ts` lists it as one of five deliberate inline
        // sites) — and this transaction now takes one too, immediately below.
        // An earlier draft of this comment argued that locking every candidate
        // class would work and was simply worse than a second read, because it
        // blocks booking on every future class of the template for the
        // duration of the archive, to buy what the read below buys for free.
        // That was right for what it weighed: a lock against a read, for
        // NOTIFICATION correctness, where the read genuinely is better — and
        // the read is still here, still needed, unreplaced by the lock below.
        // But a pre-lock buys something a read cannot buy at any price: a
        // CANONICAL LOCK ORDER. `deleteStudentAccount` (`gdpr.ts`) takes its
        // `Class` row locks ascending by id; this function's `deleteMany`
        // below takes them in heap order, whatever order Postgres's planner
        // visits matching rows in — never the read's order, and not
        // controllable by sorting anything in JS. Two rows, opposite orders,
        // one AB-BA cycle (issue 180, `docs/lock-order.md`, "The two that do
        // not"). Ordering this function's locks ascending, before either the
        // read or the delete, is what closes it — the cost the earlier draft
        // named is real and is now paid: an archive blocks booking on this
        // template's future classes for its duration, bounded by the 2s
        // `SET LOCAL lock_timeout` at the head of this transaction and its
        // 10s budget.
        //
        // Ordered pre-lock (issue 180 task 4). Deliberately the FULL
        // `scheduledWhere(templateId, { gt: today })` set — every scheduled
        // future class of this template — not narrowed to the `deleteMany`'s
        // `registrations: { none: … }` predicate below. The `deleteMany`
        // re-evaluates its predicate at execution time (deliberately — see
        // its own comment below, which this does not change), so ANY
        // candidate may still match and must already be held before that
        // statement runs. Narrowing this set to only the deletable rows would
        // leave a candidate the delete's re-evaluation pulls into scope
        // unlocked, and the cycle returns — reasoned, not measured: a
        // narrowing mutation was run against `template-lock-order.test.ts`'s
        // own fixture and did NOT reproduce the deadlock there, because that
        // fixture holds no `Registration` row at all, so the narrower clause
        // is vacuously true for both candidate classes and coincides with
        // this wide one on that specific fixture (see the report for issue
        // 180 task 4 for the full account and for the fixture shape that
        // would be needed to exercise the difference). `setLockTimeout(tx)`
        // is already in effect from this transaction's own call above;
        // issuing it again here would be redundant, not wrong.
        await tx.$queryRaw`
          SELECT c.id
          FROM "Class" c
          WHERE c."templateId" = ${templateId}
            AND c.date > ${today}
            AND c.status IN ('draft', 'open')
          ORDER BY c.id
          FOR UPDATE OF c
        `;

        const candidates = await tx.waitlistEntry.findMany({
          where: {
            status: 'waiting',
            class: scheduledWhere(templateId, { gt: today }),
          },
          select: {
            studentId: true,
            classId: true,
            // Type, date AND time: the notification outlives the class row with
            // a null link, so these three fields are the only identity it will
            // ever have. A student with two weekly classes needs the time.
            class: { select: { classType: true, date: true, startTime: true } },
          },
        });

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

        // Which candidates' classes actually went. `deleteMany` returns a count,
        // not ids, and its predicate was re-evaluated at execution time — so
        // this read, not the candidate read, is what says who was withdrawn.
        //
        // Notifying from `candidates` alone would be simpler and wrong: a
        // booking landing between the two statements spares that class, and its
        // waiter would be told the class was withdrawn while their entry is
        // still `waiting` and the class is still open on the teacher's page — a
        // message the app itself contradicts.
        if (candidates.length > 0) {
          // De-duplicated: `candidates` carries one row per waiter, so a class
          // with three waiters would otherwise repeat its id three times in the
          // `in` list. Same shape and same reason as
          // `withdrawWaitingEntriesForTeacher` (`waitlist.ts`).
          const survivors = await tx.class.findMany({
            where: { id: { in: [...new Set(candidates.map((c) => c.classId))] } },
            select: { id: true },
          });
          const survived = new Set(survivors.map((s) => s.id));
          // Per class, not all-or-nothing across the batch: a template generates
          // on a rolling 4-week basis, so the ordinary archive faces several
          // future classes at once and spares only the booked ones.
          const withdrawn = candidates.filter((c) => !survived.has(c.classId));

          if (withdrawn.length > 0) {
            // No `relatedClassId`: the row is gone and the FK is `SetNull`
            // (the `Notification` model's `relatedClass` relation in
            // `prisma/schema.prisma`), so the notification outlives its class with
            // a null link. Passing the id would fail the insert's FK outright.
            // The body has to name the class or the student is left with an inbox
            // entry they cannot place.
            const notifications: CreateNotificationInput[] = withdrawn.map((c) => ({
              recipientType: 'student' as const,
              recipientId: c.studentId,
              type: 'class_cancelled' as const,
              title: 'Class cancelled',
              body: `The ${c.class.classType} class on ${formatDayHeader(c.class.date)} at ${c.class.startTime} has been withdrawn by your teacher. You were on its waiting list.`,
            }));
            await createBulkNotifications(tx, notifications);
          }
        }

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
        // survive a rollback that withdrew nothing (#97).
        //
        // A second statement rather than folded into the CAS above, on data
        // dependency alone: `deleted` does not exist until the `deleteMany` has
        // run, and the CAS runs before it. The lock ordering is a separate point
        // and closes the other direction — the CAS has to stay the transaction's
        // first statement to take the row lock the sweep serialises against
        // (#95), so it cannot instead be moved down to where `deleted` exists.
        //
        // A plain single-record `update` is enough here: the CAS's lock is still
        // held, so nothing can have moved this row since.
        const recorded = await tx.classTemplate.update({
          where: { id: templateId },
          data: { archivedAt: now, withdrawnCount: deleted },
        });

        return { ok: true as const, action: 'archived' as const, template: recorded, deleted, remaining };
      },
      // The compare-and-swap above locks the same row the generator sweep's
      // `claimTemplateForGeneration` (class-generator.ts) holds `FOR UPDATE` for
      // the duration of its own per-template transaction. The CAS's own `FOR NO
      // KEY UPDATE` conflicts with that, so an archive can block on a sweep in
      // progress. The wait itself is now bounded by the transaction's own
      // `setLockTimeout` (2s); this budget covers the transaction's own work —
      // the delete, the notifications, the record write — not the wait. Matching
      // the sweep's 10s transaction timeout still matters: a loaded VPS can
      // exceed Prisma's 5s default and turn an ordinary archive click into an
      // opaque P2028.
      { timeout: 10_000 },
    );
  } catch (err) {
    // Transient first — and the honest reason is narrower than the one this
    // comment used to give, which the spec, the plan and the handover all
    // repeated. It claimed that testing for a slot conflict first would let a
    // transient code "fall past a branch that cannot match it into the
    // rethrow". It would not: `isUniqueConflictOn` returns false unless the
    // code is `P2002`, the two predicates are disjoint, and a non-match falls
    // to the NEXT branch rather than to the rethrow. Reordering these two is
    // behaviour-neutral today, and no mutation could show otherwise.
    //
    // Kept explicit anyway, for the reason the pause/resume twin in this file
    // states correctly: it is safe today only BECAUSE those codes differ, and
    // either predicate widening would end that silently. `classifyApiError`
    // orders itself the same way for the same defensive reason.
    //
    // Logged here rather than left to the API wrapper: returning instead of
    // throwing means the wrapper never sees this, and its automatic line
    // disappears with it. The message names the operation because the wrapper
    // cannot — an archive and a resume reach the same route with the same
    // method and the same path, and the query parameter that separates them is
    // deliberately excluded from request logs.
    if (isTransientDbError(err)) {
      // `target` because this function serves both directions and the message
      // cannot name which: the wrapper's own line could not tell an archive
      // from an un-archive either, and the route's copy does distinguish them.
      log.warn(
        { err, templateId, teacherId, target },
        'recurring class archive lost the template lock race',
      );
      return { ok: false, reason: 'busy' };
    }
    if (isUniqueConflictOn(err, ['teacherId', 'dayOfWeek', 'startTime'])) {
      // Logged for the same reason the branch above is, and it predates that
      // branch only because nothing had stated the rule yet: a RETURNED
      // failure never reaches `withErrorHandler`, and `respondError` does not
      // log, so without this line an un-archive refused by the slot index is a
      // 409 to the teacher and complete silence on the server. `classifyApiError`
      // logs this same P2002 at `warn` when it escapes; catching it here must
      // not be what removes that.
      log.warn({ err, templateId, teacherId }, 'recurring class un-archive refused: slot already held');
      return { ok: false, reason: 'slot_conflict' };
    }
    throw err;
  }
}
