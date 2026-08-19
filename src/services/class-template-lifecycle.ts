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
import { lockClassRowsOrdered, setLockTimeout } from '@/lib/db-locks';
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
  /**
   * A fifth door on the room archive lifecycle (issue 76): relocating a
   * template onto an archived room is refused the same way creating (door 4)
   * or resuming (door 3) one there is — the doors reasoned about creating a
   * template and resuming one but never about moving one, the same commitment
   * by a different verb, and `syncTemplateInstances` relocates every future
   * non-`settingsLocked` `draft`/`open` instance onto the target room in the
   * same transaction.
   *
   * Gated on a CHANGE of room, NOT on `template.isActive`. Fix round 2 gated
   * it on `isActive` "symmetrically with door 3"; PR review proved that a
   * false analogy. Door 3 gates on the *direction of the verb*
   * (`desiredActive`), so that pausing a template whose room was archived
   * under it still works. `isActive` is a property of the template on a
   * different axis, and pausing deletes nothing — a paused template still
   * owns the `open` instances it generated, and the sync carried every one of
   * them onto the archived room. That produced, in a single request with no
   * race, the exact state door 1 exists to refuse: an archived room holding
   * bookable classes.
   *
   * Nobody needs to move a template ONTO an archived room. Moving one OFF one
   * is the recovery, and this guard reads the TARGET room, so that direction
   * was never affected by either version of the gate.
   *
   * The `!==` half is equally load-bearing: `TemplateForm` posts the whole
   * form on every edit, so `teacherRoomId` is present on every PUT whether or
   * not the teacher touched the picker. Without that half, an active template
   * whose own room is archived — a state spec section 10 says exists in
   * pre-branch data — could not be edited at all, and answered a description
   * change with a 409 about moving.
   */
  | { ok: false; reason: 'room_archived' }
  | { ok: false; reason: 'slot_conflict' }
  | { ok: false; reason: 'sync_conflict' }
  /**
   * This transaction lost a contention race and rolled back whole, so nothing
   * was applied and the identical request can win the next attempt.
   *
   * TWO row families can produce it, and an earlier version of this docblock
   * named only the first — which made the enumeration wrong from the moment
   * the write and the sync became one transaction:
   *
   * 1. The `ClassTemplate` row, held by a concurrent generation claim,
   *    archive, or pause/resume. The only cause while this function's write
   *    was a transaction of its own.
   * 2. **Any `Class` row of this template**, held by an ordinary booking.
   *    `syncTemplateInstances` (`template-sync.ts`) is composed into this
   *    transaction now and takes an ordered `FOR UPDATE OF c` over every
   *    future instance, while `POST /api/registrations` holds its `Class` row
   *    `FOR UPDATE` for the length of its own transaction — one of the
   *    deliberately UNBOUNDED sites `db-locks.ts` names (#104). It said "one
   *    of the five" until #237 converted `withdrawWaitingEntriesForTeacher`
   *    and left this cross-reference behind; the count is not repeated here
   *    any more, because nothing enforces it. So a student booking
   *    one instance can now time a teacher's edit out at 2s.
   *    `archiveOrUnarchiveTemplate` documents the same exposure for its own
   *    pre-lock ("that one can lose to an ordinary booking holding a `Class`
   *    row"); this function acquired it in the same branch and inherits it.
   *
   * The log line at the `catch` deliberately names neither, because the code
   * cannot tell them apart — `err`'s invocation line can, and is logged.
   *
   * See `ArchiveTemplateResult`'s `busy` arm for the fuller range of causes
   * `isTransientDbError` matches; this arm is produced by the same helper.
   * Read its `40P01` paragraph with care, though: it says "this function is
   * one side of" the `{Class, ClassTemplate}` ordering question (issue #229),
   * meaning the archive. This branch made `updateClassTemplate` a fifth site
   * on that same side (`docs/lock-order.md`, "Known violation, not fixed
   * here"), so a `40P01` here carries the same reading.
   */
  | { ok: false; reason: 'busy' };

/**
 * Apply a partial update to a class template, then propagate it to the
 * instances that are still mutable.
 *
 * Takes `teacherId` rather than a session: this is the ownership check, and
 * keeping it a plain argument is what lets the function be tested without HTTP.
 *
 * The write and the propagation are ONE transaction (atomic-template-update,
 * issue 83) — not two, as this function used to run them, and not three
 * either: `syncTemplateInstances`'s delete/update step and the refill that
 * follows a day change both compose into the same `tx` now too (see
 * `template-sync.ts`), rather than the refill running afterward, outside any
 * transaction. A failure anywhere in that chain rolls the template write back
 * with it, so there is no longer a window where the row is updated but the
 * propagation partially applied. The `catch` sits OUTSIDE the `$transaction`
 * call, the same shape `archiveOrUnarchiveTemplate` and `POST
 * /api/class-templates` already use: a P2002 raised inside Postgres aborts
 * the transaction, so there is nothing to catch from within, and the whole
 * thing rolling back is what makes catching it after the fact meaningful —
 * every reason mapped below describes a transaction that did not commit.
 *
 * Four shapes are mapped below rather than left to propagate as a 500: P2025
 * becomes `{ ok: false, reason: 'not_found' }`, because the row is gone
 * before the caller is answered (#100); a P2002 on
 * `ClassTemplate_teacher_slot_unique` — raised by the `update` call above
 * writing this template's own `dayOfWeek`/`startTime` — becomes
 * `slot_conflict` (#196); a P2002 on `Class_teacher_slot_unique` — raised by
 * `syncTemplateInstances`'s same-day rewrite colliding with an instance the
 * propagation never touches — becomes `sync_conflict` (#196), and now means
 * the whole transaction rolled back rather than a partially applied change
 * (see that branch's own comment below); and `isTransientDbError` matching —
 * a holder of either the `ClassTemplate` row or any of this template's
 * future `Class` rows outlasting the `setLockTimeout` bound below — becomes
 * `busy`. The second family is new with this transaction and is easy to miss:
 * see the `busy` arm's own docblock on `UpdateClassTemplateResult` above,
 * which enumerates both. Everything else still propagates as an opaque 500.
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

    // A fifth door (issue 76): moving a template onto an archived room is the
    // same commitment as creating (door 4) or resuming (door 3) one there, and
    // was the only one of the three left unguarded — `syncTemplateInstances`
    // below relocates every future non-`settingsLocked` `draft`/`open`
    // instance onto the target room in the same transaction.
    //
    // Gated on a CHANGE of room, NOT on `template.isActive`. Both halves are
    // load-bearing and each reddens a test alone (mutations 8 and 9, spec
    // section 9):
    //   - drop `isArchived` and both move-refusal cases go red.
    //   - drop `!== template.teacherRoomId` and "allows a no-op room field"
    //     goes red, because `TemplateForm` posts the whole form on every edit,
    //     so an unchanged `teacherRoomId` arrives on every PUT.
    //
    // `isActive` is deliberately NOT consulted, and the fix-round-2 gate that
    // did consult it was wrong: pausing deletes nothing, so a paused template
    // still owns its generated `open` instances, and the sync carried them
    // onto the archived room — door 1 refuses to archive a room holding open
    // classes, and that gate produced the same state one step later.
    if (teacherRoom.isArchived && data.teacherRoomId !== template.teacherRoomId) {
      return { ok: false, reason: 'room_archived' };
    }
  }

  try {
    const { updated, sync } = await db.$transaction(
      async (tx) => {
        // First statement, deliberately — bounds every statement left in this
        // transaction, the `update` immediately below it first among them. A
        // concurrent generation claim, archive, or pause/resume can hold this
        // row locked for the duration of its own transaction.
        //
        // Without it the wait is bounded by NOTHING, not by the 15s budget
        // below: Prisma checks that budget at statement boundaries, so it
        // "cannot roll back a statement already blocked inside Postgres, only
        // refuse to start a new one" (`db-locks.ts`).
        //
        // `syncTemplateInstances` (`template-sync.ts`) issues its own
        // `setLockTimeout(tx)`, but only just before its own pre-lock — which
        // runs AFTER `classTemplate.update` below, so that call alone would
        // leave this transaction's true first statement unbounded. Calling it
        // again here is not redundant: `SET LOCAL lock_timeout` is idempotent
        // within one transaction — verified in psql that a later call
        // overwrites the earlier rather than stacking or erroring
        // (`db-locks.ts`, `LOCK_TIMEOUT_SQL`'s docblock, the
        // "verified in psql that a later `SET LOCAL lock_timeout` overwrites
        // the earlier one" sentence) — so the two coexist safely.
        //
        // Which of the two is load-bearing, stated exactly, because the
        // tempting shorthand ("the inner one covers its other callers") is
        // false: this is `syncTemplateInstances`'s ONLY production call site
        // (`api/class-templates/route.ts` says the same thing from the other
        // side — "its one production caller"). The inner `setLockTimeout` is
        // therefore not covering production traffic this call does not; it
        // earns its place two other ways. It bounds the test harnesses that
        // compose the function directly into a bare `prisma.$transaction`
        // (`template-sync.test.ts`, `template-lock-order.test.ts`), none of
        // which issues the bound itself. And it keeps the function correct
        // standalone, so a second caller can compose it without having to
        // know that the bound is someone else's responsibility.
        await setLockTimeout(tx);

        // `updated`, not `template`: the pre-transaction read at the head of
        // this function is already called `template`, and the `catch` below
        // turns on keeping the two apart — "the read above and the write
        // inside the transaction are not the same statement" is the sentence
        // that explains why P2025 now has one source instead of two. Two
        // values that the error mapping distinguishes should not share a name.
        const updated = await tx.classTemplate.update({ where: { id: templateId }, data });

        // Composed into this transaction, not opening its own. Safe since
        // #164/#192 (PR #204): `generateInstancesForTemplate` has no `catch`
        // and inserts with a bare `ON CONFLICT DO NOTHING`, so the refill
        // cannot abort the transaction it now runs inside.
        //
        // A statement rather than a property initialiser in the `return`
        // below: this is the second of the transaction's two load-bearing
        // steps — a pre-lock, four reads and up to three writes — and it read
        // as an afterthought inlined into an object literal.
        const sync = await syncTemplateInstances(tx, templateId);

        return { updated, sync };
      },
      // Five statements here can wait on a lock at 2s each (spec §2.4);
      // 10_000 would be consumed entirely by lock waits.
      { timeout: 15_000 },
    );

    return { ok: true, template: updated, sync };
  } catch (err) {
    // Transient first, matching the order `pauseOrResumeTemplate` and
    // `archiveOrUnarchiveTemplate` use in this same file. Not
    // correctness-critical here — `isTransientDbError`'s codes are disjoint
    // from P2025 and from both `isUniqueConflictOn` column sets below, so a
    // transient error could not fall into either of those branches even
    // checked last — but kept first anyway so a reader does not have to
    // re-derive that for each of the five template lifecycle functions this
    // helper now guards.
    if (isTransientDbError(err)) {
      // "a lock race", not "the template lock race". Since the write and the
      // sync became one transaction this can be lost on the `ClassTemplate`
      // row OR on any future `Class` row of the template — the sync's ordered
      // pre-lock takes those, and an ordinary booking holds one unbounded
      // (`db-locks.ts`). Naming the template row sent an operator to check
      // the generation sweep and the archive path for a race that was
      // actually a student booking, and find nothing. The code cannot tell
      // the two apart; `err`'s invocation line can, which is why it is logged
      // rather than summarised here. See the `busy` arm on
      // `UpdateClassTemplateResult` for both families.
      log.warn(
        { err, templateId, teacherId },
        'recurring class edit lost a lock race (template row or one of its instances) — nothing committed',
      );
      return { ok: false, reason: 'busy' };
    }

    // The read above and the write inside the transaction are not the same
    // statement, so a delete landing in the gap between them still surfaces
    // here as Prisma's P2025 — but from one source now, not two.
    // `syncTemplateInstances`'s opening `findUniqueOrThrow` used to be a
    // second source: before this ran inside the same transaction as the
    // write, it re-read the row after the update had already committed with
    // no lock held in between, so a delete landing in that gap could raise
    // its own P2025, and telling the two apart needed the invocation line at
    // the head of `err.message` rather than the one-word-apart cause string.
    // That second source is gone: `syncTemplateInstances`'s read now runs
    // inside this same transaction, on a row `classTemplate.update` has
    // already locked, so nothing else can delete it out from under that read
    // before this transaction ends. Only `classTemplate.update` itself can
    // still raise this — when a concurrent delete lands between the read-time
    // guard above and this transaction's own `update` — so map it to the
    // same outcome that guard would have produced, rather than letting it
    // fall through as an opaque 500.
    //
    // That reports `not_found` for a delete that beat this transaction to the
    // row, so nothing here commits — no template write, no sync. The row
    // really is gone, though, so the write that raced this one has its own
    // consequences worth naming: `Class.template` is `onDelete: SetNull`
    // (`prisma/schema.prisma`), so deleting a template does not take its
    // generated classes with it. Each keeps standing with `templateId: null`,
    // still `open`, still on the teacher's schedule and public booking page,
    // frozen with whatever settings it had before this edit. Whoever writes
    // the delete path this guard exists for inherits those orphans; they are
    // that path's problem, not this function's.
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
      // Logged because this `return` would otherwise be silent: `respondError`
      // (`api/class-templates/[id]/route.ts`) does not log, and
      // `withErrorHandler` logs only on `throw`, which this path does not do
      // — without this line a `sync_conflict` 409 is invisible to an
      // operator. #209.
      //
      // What it means now (task 6, atomic-template-update): the whole
      // transaction above rolled back, `classTemplate.update` included —
      // propagating the new `startTime` to a still-mutable generated
      // instance would have collided with an existing class, so nothing
      // committed. This is NOT evidence of a template/instance desync to go
      // reconcile; there is nothing left inconsistent to fix.
      log.warn(
        { templateId, teacherId },
        'recurring class edit refused (sync_conflict): propagating startTime to a generated instance would collide with an existing class — nothing changed',
      );
      return { ok: false, reason: 'sync_conflict' };
    }
    throw err;
  }
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
   * Door 3 of the room archive lifecycle (issue 76): the template's own room
   * has been archived. A paused template may still sit on an archived room —
   * only resuming it is refused, since that is the moment new classes would
   * start being manufactured there. See the guard site for the full note.
   */
  | { ok: false; reason: 'room_archived' }
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
   * Two calibrations, so this list does not send anyone the other way. This
   * function used to have a reproduced `40P01` cycle against
   * `deleteStudentAccount`'s ascending `Class`-row lock order — closed by
   * this function's own ordered pre-lock (issue 180, atomic-template-update)
   * — while the branch's headline case, an archive queued behind the sweep's
   * claim, has no cycle and ends in `55P03`. A `40P01` seen here now most
   * likely points at the still-open `{Class, ClassTemplate}` ordering
   * question this function is one side of (`docs/lock-order.md`, "Known
   * violation, not fixed here"; the decision is issue #229) rather than at a
   * confirmed, already-reproduced pairing — that inversion is recorded as an
   * unresolved ordering disagreement, not itself reproduced as a live
   * deadlock. And `40001` is in the matcher but cannot fire yet: nothing here
   * uses a serializable or repeatable-read transaction, as `api-errors.ts`
   * says where it lists the code.
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
 * `SCHEDULED_STATUSES`, pre-rendered as a raw SQL `IN (...)` list, for the
 * ordered pre-lock's `$queryRaw` further down — the one caller of this
 * constant that cannot go through `scheduledWhere`'s Prisma `{ in: [...] }`
 * filter, because `FOR UPDATE OF c` and `ORDER BY` have no Prisma
 * query-builder equivalent.
 *
 * Derived, not retyped: this was a second hand-written `'draft', 'open'`
 * literal in the raw SQL, with nothing tying the two lists together —
 * dropping a status from `SCHEDULED_STATUSES` above left this one stale, and
 * measurement during issue 180 task 4's review showed exactly that: dropping
 * `'draft'` from the raw list left every test covering this function green,
 * silently re-opening the deadlock the pre-lock exists to close. (A count and
 * a file count stood here — "all 102 tests across the four files" — with the
 * files unnamed and the number already stale by the time the branch ended.
 * The measurement is real and scoped to that moment; the number was doing no
 * work except going out of date.) Deriving this from the same array makes the
 * desync un-representable — there is only one list to edit now, not two to
 * keep in sync.
 *
 * `Prisma.raw`, not `Prisma.join`: `Prisma.join` would bind each status as a
 * separate parameter, and a bound text parameter compared against the
 * `status` column's enum type needs an explicit `::text` cast to resolve —
 * measured to cost the index the pre-lock's `WHERE` relies on. `Prisma.raw`
 * instead embeds the values as literal SQL text, identical to what was
 * hand-typed before, so the query plan is unchanged. Safe here specifically
 * because `SCHEDULED_STATUSES` is a frozen, hard-coded constant — never user
 * input, never touched by anything outside this module — which is the one
 * precondition that makes building SQL text by string concatenation
 * defensible at all.
 */
const SCHEDULED_STATUSES_SQL = Prisma.raw(SCHEDULED_STATUSES.map((s) => `'${s}'`).join(', '));

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
    include: {
      teacher: { select: { defaultTimezone: true } },
      teacherRoom: { select: { isArchived: true } },
    },
  });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  // Same reason as the drop further down: `PauseTemplateResult` carries a
  // plain `ClassTemplate`, so the joined `teacher` and `teacherRoom` this
  // include added are dropped rather than leaked back to the caller —
  // including on this early-return path, before any write happens.
  const { teacher: _t, teacherRoom: _tr, ...bare } = template;
  void _t;
  void _tr;

  const desiredActive = target === 'active';

  // Before the archived guard, deliberately. Archiving forces `isActive:
  // false`, so `?state=paused` on an archived template is already true and
  // there is nothing to refuse — only `?state=active` is the transition the
  // guard exists to block.
  if (template.isActive === desiredActive) {
    return { ok: true, action: 'unchanged', template: bare };
  }

  if (template.isArchived) return { ok: false, reason: 'archived' };

  // Door 3 of the room archive lifecycle (issue 76). Symmetric with door 2:
  // a paused template may SIT on an archived room, but resuming it is the
  // moment new classes start being manufactured there. Without this, resume
  // succeeded silently and generated instances into the archived room inside
  // the transaction below.
  //
  // After the already-in-state check above, for the same reason that check
  // precedes the template-archived guard: `?state=paused` on a template that
  // is already paused is a no-op with nothing to refuse.
  //
  // Gated on `desiredActive`, not on `template.teacherRoom.isArchived` alone
  // — pausing is a real `isActive` transition too (active room-archived
  // template -> paused) and does not hit the already-in-state short-circuit
  // above, so an ungated check here would also refuse the one direction the
  // brief and the test below require to keep working: a teacher must still
  // be able to stop a template whose room was archived out from under it.
  if (desiredActive && template.teacherRoom.isArchived) {
    return { ok: false, reason: 'room_archived' };
  }

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
        // first among them, and the ordered pre-lock further down too, which
        // is not incidental: that one can lose to an ordinary booking holding
        // a `Class` row, so the 2s answer reaches a path the sweep never
        // touches (`class-generator.test.ts`, "the bound reaches its
        // pre-lock" — issue 180 task 4 moved what that test actually blocks
        // on from the `deleteMany` to the pre-lock ahead of it; see that
        // test's own updated comment). The `deleteMany` below no longer waits
        // on an external holder OF A `Class` ROW THE PRE-LOCK COVERED — that
        // much the pre-lock does buy. It can still wait, two ways, and an
        // earlier version of this comment claimed otherwise on both:
        //
        //   - **Cascade children.** `Registration.class` and
        //     `WaitlistEntry.class` are `onDelete: Cascade`
        //     (`prisma/schema.prisma`), so the delete takes row locks on child
        //     rows no `Class` pre-lock holds. Spec §2.4 counts exactly this
        //     ("the `deleteMany` can then wait only on cascade children"), and
        //     `class-generator.test.ts`'s 15s derivation counts the sync's
        //     equivalent statement as a waiting one for the same reason.
        //   - **Rows the pre-lock never covered.** The `deleteMany` predicate
        //     is re-evaluated at execution time by design, and the pre-lock
        //     stops at `date > today` — see that statement's own comment for
        //     the `updateClass` window, which is measured, not theorised.
        //
        // The distinction matters for budgeting, not just for accuracy:
        // someone trimming this transaction's 10s on the strength of "nothing
        // it touches is still contested" would under-size it.
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
        // one AB-BA cycle (issue 180, reproduced and recorded when the issue
        // was filed). Ordering this function's locks ascending, before either the
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
        // unlocked, and the cycle returns — measured, not just reasoned.
        // `template-lock-order.test.ts`'s own fixture cannot show this (it
        // holds no `Registration` row at all, so a narrower clause would be
        // vacuously true for both its candidate classes and coincide with
        // this wide one). Review round 1 built the fixture that can: one
        // class carries a charged `Registration` at pre-lock time — a narrow
        // pre-lock would skip locking it, since it is not yet a delete
        // candidate — and that registration is cancelled from OUTSIDE the
        // transaction during the candidate read, via `registration.
        // updateMany`, the same write `DELETE /api/registrations/[id]` makes
        // and, like it, one that takes no `Class` row lock. Under a narrowed
        // pre-lock this reproduces `40P01` at the `deleteMany`; under this
        // wide one it produces `{ ok: true, deleted: 2, remaining: 0 }` (full
        // recipe and both transcripts in the atomic-template-update spec,
        // §4 — inlined there rather than left in a task report, because
        // `.superpowers/sdd/` is gitignored and this is the only evidence
        // that the wide set is required rather than merely conservative).
        // `setLockTimeout(tx)` is already in effect from this
        // transaction's own call above; issuing it again here would be
        // redundant, not wrong.
        //
        // `c.date > ${today}`, not Prisma's `date: { gt: today }` used
        // everywhere else `scheduledWhere` is called — `FOR UPDATE OF c` has
        // no query-builder equivalent, so this statement is raw SQL end to
        // end. The two forms are NOT the same comparison, and the difference
        // is worth stating precisely rather than waving through, because the
        // property this pre-lock needs is one-directional.
        //
        // `Class.date` is `@db.Date`. Prisma's `date: { gt: today }` binds a
        // `date` parameter, so Postgres compares `date > date`. A `$queryRaw`
        // binds a JS `Date` as `timestamptz`, so this statement compares
        // `date > timestamptz`, which promotes `c.date` to an instant at
        // midnight IN THE SESSION `TimeZone`. Measured, both directions:
        //
        //   TimeZone=UTC               '2026-08-15'::date > '2026-08-15T00:00:00Z' → f
        //   TimeZone=America/New_York  same comparison                             → t
        //                              (Prisma's `date > date` stays f in both)
        //
        // So under UTC the two forms select exactly the same rows, and west
        // of UTC this raw form additionally matches TODAY-dated rows that the
        // `deleteMany` below will never delete. That is a SUPERSET, never a
        // subset — which is the only thing lock ⊇ delete (below) actually
        // needs, and it holds under every session `TimeZone`, not just this
        // deployment's. Do not restate it as "the same set" and do not use
        // that as licence to narrow either side to match the other: equality
        // is a UTC-only accident, containment is the guarantee.
        //
        // This deployment runs UTC — the `postgres:16-alpine` default, since
        // neither `docker-compose.yml` nor `docker-compose.prod.yml` sets
        // `TZ`. That is where the equality comes from; it is not pinned by
        // configuration, which is the second reason not to depend on it.
        // Off UTC the cost is a slightly wider pre-lock: today's scheduled
        // classes are held for this transaction's duration too, contending
        // with bookings on classes this archive cannot delete.
        //
        // Why lock ⊇ delete holds here is not structural the way it is for
        // `syncTemplateInstances`'s own pre-lock (issue 180 task 2), which
        // reads its write set straight out of the ids the pre-lock itself
        // returned — `id: { in: lockedIds }`, a structural subset, not a
        // predicate re-evaluated later. This one instead relies on the
        // delete's predicate (`scheduledWhere` plus `registrations: { none:
        // … }`) being a strict narrowing of this pre-lock's predicate
        // (`scheduledWhere` alone), so a row already matching the delete's
        // predicate cannot escape this lock.
        //
        // That is NOT the same as lock ⊇ delete being total, and this branch
        // once claimed it was by naming only one writer that could add a row
        // to the set after the pre-lock runs. The generation sweep is one
        // such writer and genuinely cannot: it serialises on the same
        // `ClassTemplate` row the CAS above already holds (#95, the comment
        // on that CAS). But it is not the only one. `updateClass`
        // (`class-lifecycle.ts`) issues a bare `db.class.updateMany({ where:
        // { id } })` with `date` in its teacher-editable set, taking neither
        // the `ClassTemplate` lock nor any `Class` lock this pre-lock holds.
        // A same-day instance — outside `c.date > ${today}` above, so never
        // locked here — rescheduled into the future between this pre-lock
        // and the `deleteMany` below (whose predicate is re-evaluated at
        // execution time, by design — see its own comment) can still be
        // matched and deleted without ever having been held by this
        // statement. So the ascending-order guarantee at this site is not
        // total: the AB-BA cycle against `deleteStudentAccount` can still
        // form through this window. Measured, not just reasoned: template
        // with class A dated today and class B two weeks out, one student
        // waitlisted on both; a hook on the candidate read below moves A to
        // +21 days from outside this transaction, mid-transaction. The
        // pre-lock covered only B; the archive returned `{ ok: true, deleted:
        // 2 }` — it locked and deleted a row the ordered pre-lock never held.
        // Narrow (it needs a concurrent reschedule of a same-day instance AND
        // an erasure of a student waitlisted across both classes, timed into
        // the same gap) and no worse than the pre-branch state, which had no
        // ordering at all. Tracked as a residual, not closed here — see spec
        // §7 risk 3. `syncTemplateInstances` does not share this exposure,
        // for the structural reason given above: its write set is a subset
        // of ids the pre-lock itself returned, not a predicate argument
        // re-evaluated against whatever the table looks like when the write
        // finally runs.
        //
        // The delete cannot instead be scoped to exactly the ids this
        // pre-lock returns, the way the sync fix's is: that would undo the
        // wide candidate read and the survivor filter #86/#112 depend on,
        // which stay wide on purpose (see the comment above the candidate
        // read). Nor can the pre-lock be widened past `date > today` to close
        // this window — issues 86/112 require the delete's live predicate
        // re-evaluation regardless, and widening the pre-lock past `today`
        // would lock history for no gain, since a past-dated row is never a
        // delete candidate.
        await lockClassRowsOrdered(tx, {
          where: Prisma.sql`c."templateId" = ${templateId}
            AND c.date > ${today}
            AND c.status IN (${SCHEDULED_STATUSES_SQL})`,
        });

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
