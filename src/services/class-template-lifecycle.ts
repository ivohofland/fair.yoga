/**
 * Class Template updates — the teacher-editable boundary for
 * `PUT /api/class-templates/[id]`.
 *
 * The sibling of `class-lifecycle.ts`'s update section (#82 is #79 one route
 * over), with the same pin structure. Three things deliberately differ, and
 * are worth knowing before reading this as a mirror:
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
 *     needed. Scoped to `updateClassTemplate` ALONE (#100): the archive
 *     section further down uses a compare-and-swap, because there the race to
 *     close is two requests applying the same transition rather than a row
 *     disappearing — and since #116 so does `pauseOrResumeTemplate`, which
 *     this paragraph named as the second P2025 site until that change made it
 *     the third CAS. Its `updateMany` returns a count where the old `update`
 *     threw, so nothing under its transaction raises P2025 at all and its
 *     `not_found` comes from the CAS's miss classification instead; its own
 *     `catch` carries the enumeration.
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient, ClassTemplate, ScheduleRule, ClassStatus } from '@prisma/client';
import type { z } from 'zod';
import type { updateClassTemplateSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { startOfLocalDay, mondayOf, classStartInstant } from '@/lib/timezone';
import { timeToHHmm, hhmmToTime } from '@/lib/time-of-day';
import { formatDayHeader } from '@/lib/format';
import { isExclusionConflictOn } from '@/lib/exclusion-conflict';
import { ruleSlotHolder, minutesSinceMidnight, type RuleSlotHolder } from '@/lib/rule-slot-holder';
import { spansOverlap } from '@/lib/generation';
import { isTransientDbError } from '@/lib/api-errors';
import { lockClassRowsOrdered, setLockTimeout } from '@/lib/db-locks';
// Server-only (pino). Safe here: this module's sole importer is
// `api/class-templates/[id]/route.ts`, and it already pulls `@/lib/log`
// transitively through `class-generator`. No `'use client'` component
// value-imports anything in this chain.
import { log } from '@/lib/log';
import { createBulkNotifications, type CreateNotificationInput } from './notifications';
import {
  generateInstancesForTemplate,
  claimTemplateForGeneration,
  getNextOccurrences,
  firstFreeWeek,
  DEFAULT_WEEKS,
} from './class-generator';
import { CHARGED_STATUSES } from './class-lifecycle';
import { countSkipReasons, type SkipCounts } from '@/lib/generation';
import {
  templateGenerationState,
  type TemplateGenerationState,
} from '@/lib/template-selection';

/**
 * The fields a teacher may change on an existing template — the WIRE shape,
 * spanning both `ClassTemplate` and `ScheduleRule` now that issue 298 has
 * split the model the schema describes.
 *
 * Derived from `updateClassTemplateSchema`, not hand-declared: deriving is what
 * puts a newly added schema field into `keyof`, which is what every pin below
 * depends on. A hand-declared type would never see the offending field at all.
 *
 * Unlike `ClassUpdateData`, this needs no `Omit`/intersection of its own —
 * every schema field maps to a column of the same type somewhere, including
 * the two enums. `ScheduleRuleUpdateData` and `ClassTemplateOwnUpdateData`
 * below are the `Pick`/`Omit` that route each field to its model; neither has
 * the `date` blind spot `class-lifecycle.ts` documents.
 */
export type ClassTemplateUpdateData = z.infer<typeof updateClassTemplateSchema>;

/**
 * The wire schema sliced to the fields named in its own `Pick` below, the
 * ones that route onto `ScheduleRule` rather than `ClassTemplate` (issue
 * 298) — `startTime` still `"HH:MM"` here, the wire shape every caller of
 * `ClassTemplateUpdateData` uses. Pins below check NAMES against this slice,
 * not against the whole schema: the whole schema now spans two models, so a
 * pin comparing it to one model's columns would name the other model's
 * fields as missing forever.
 */
type ScheduleRuleUpdateData = Pick<
  ClassTemplateUpdateData,
  'classType' | 'dayOfWeek' | 'startTime' | 'durationMinutes'
>;

/** The wire schema sliced to what stayed on `ClassTemplate` — the complement of `ScheduleRuleUpdateData`. */
type ClassTemplateOwnUpdateData = Omit<
  ClassTemplateUpdateData,
  'classType' | 'dayOfWeek' | 'startTime' | 'durationMinutes'
>;

/**
 * Compile-time pin: every field the wire schema routes to `ClassTemplate`
 * must name a column `update` can write there — the write below checks the
 * types, this checks the name, and only this catches a name Prisma has never
 * heard of.
 *
 * The reference is the *Many* input deliberately, as in the class service: the
 * single-record type additionally accepts a nested relation write (`classes`)
 * that a plain field update should never receive, so pinning against it would
 * wave through a schema field named after that relation.
 */
const _templateUpdateColumnsExist: NoneOf<
  Exclude<keyof ClassTemplateOwnUpdateData, keyof Prisma.ClassTemplateUncheckedUpdateManyInput>
> = true;
void _templateUpdateColumnsExist;

/**
 * The fields a teacher may change on their own template's own row via
 * `PUT /api/class-templates/[id]`.
 *
 * Adding a member is how a new schema field gets authorized. Since #194 a
 * template is a stamp, not a live link: editing one of these fields changes
 * the template row and NOTHING else. No generated `Class` moves, is rewritten,
 * or is deleted — not on a rate change, not on a room change. The next
 * generation run reads the new values; every class already on the schedule
 * keeps the values it was stamped with.
 *
 * The rule's own slot fields (`classType`, `dayOfWeek`, `startTime`,
 * `durationMinutes`) are NOT here (issue 298) — they left this model for
 * `ScheduleRule`, and `TeacherEditableScheduleRuleField` below is their
 * allowlist now.
 *
 * One member still carries a consequence beyond the row, and it is the reason
 * this list is an allowlist rather than a schema dump:
 *   - `teacherRoomId` → cross-teacher. The ownership check in
 *                       `updateClassTemplate` is the only thing stopping a
 *                       teacher attaching their template to another's room.
 */
type TeacherEditableClassTemplateField =
  | 'description'
  | 'teacherRoomId'
  | 'roomCost'
  | 'minRate'
  | 'targetRate'
  | 'minStudents'
  | 'maxStudents'
  | 'cancelDeadline'
  | 'autoCancelCheck';

/**
 * Compile-time pin (forward): every field the schema routes to `ClassTemplate`
 * must be on the allowlist. Add a column-shaped field to that slice without
 * adding it here and this names that field instead of resolving to `true`.
 *
 * As in `class-lifecycle.ts`, forward and reverse together force the allowlist to
 * *equal* the schema's key set, so the allowlist holds no policy of its own.
 * What it buys is that the grant must be explicit — a second edit, next to the
 * hazards above. The forbidden pin below is what refuses the grants that are
 * never right.
 */
const _templateFieldsArePermitted: NoneOf<
  Exclude<keyof ClassTemplateOwnUpdateData, TeacherEditableClassTemplateField>
> = true;
void _templateFieldsArePermitted;

/**
 * Compile-time pin (reverse): every allowlist entry must still be a field the
 * schema routes to `ClassTemplate`, so the list cannot rot into granting
 * permission for a column that no longer flows through this route.
 *
 * Also the only pin that fires if `ClassTemplateOwnUpdateData` ever degrades to
 * `{}` or `unknown` — on an empty `keyof` the forward pin passes vacuously.
 */
const _templateAllowlistHasNoStaleFields: NoneOf<
  Exclude<TeacherEditableClassTemplateField, keyof ClassTemplateOwnUpdateData>
> = true;
void _templateAllowlistHasNoStaleFields;

/**
 * The `ClassTemplate` columns the plain update path must never write.
 *
 *   - `id`             → identity
 *   - `scheduleRuleId`,
 *     `kind`           → identity, exactly like `id` (issue 298): which rule
 *                        this template belongs to. Writable here, a teacher
 *                        could re-parent their template onto another rule by
 *                        id — including, via the composite FK, one they do
 *                        not own. Nothing on this route ever needs to move a
 *                        template between rules.
 *   - `createdAt`, `updatedAt` → Prisma-managed.
 *
 * `teacherId`, `isActive`, `isArchived`, `archivedAt` and `withdrawnCount`
 * left this model for `ScheduleRule` in issue 298 — see
 * `PlainUpdateForbiddenScheduleRuleField` below for why each is still
 * forbidden on the rule's own plain-update path; none is a `ClassTemplate`
 * column any more; a name here for one of them would fail
 * `_templateForbiddenColumnsExist` below rather than protect anything.
 *
 * The forward and reverse pins make the allowlist mirror the schema, so the
 * quickest way to clear a forward-pin failure is to paste the offending name
 * into the allowlist — the reflexive grant #79 is about. This is the set where
 * that repair is never right.
 */
type PlainUpdateForbiddenTemplateField =
  | 'id'
  | 'scheduleRuleId'
  | 'kind'
  | 'createdAt'
  | 'updatedAt';

/**
 * Compile-time pin (completeness): every `ClassTemplate` column must be
 * claimed by the allowlist or the forbidden list above — checked against the
 * live Prisma type, so a migration that adds an unclassified column reddens
 * this rather than passing silently, matching the rule-level and
 * studio-family pins beside this one.
 */
const _templateForbiddenListIsComplete: NoneOf<
  Exclude<
    keyof Prisma.ClassTemplateUncheckedUpdateManyInput,
    TeacherEditableClassTemplateField | PlainUpdateForbiddenTemplateField
  >
> = true;
void _templateForbiddenListIsComplete;

/**
 * Compile-time pin: every name above must be a real `ClassTemplate` column.
 * Without this a typo (`scheduleRuleld`) would sit in the forbidden list
 * protecting nothing while looking like protection.
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

// ---------------------------------------------------------------------------
// The rule half of the partition (issue 298)
//
// `updateClassTemplate`'s wire schema spans two models now: the economics
// stayed on `ClassTemplate` (pinned above), the slot fields moved to
// `ScheduleRule`. One partition, two models, so it needs two sets of lists
// and two sets of pins — reusing the child's lists for both would either
// delete a teacher's ability to edit their schedule, delete the protection on
// `isActive`/`isArchived`/`archivedAt`/`withdrawnCount`/`teacherId` outright
// (naming them in a `ClassTemplate`-scoped list cannot even compile, since
// none is a `ClassTemplate` column any more), or let a teacher re-parent a
// template onto a rule they do not own. Mirrors the pin set above, against
// `keyof Prisma.ScheduleRuleUncheckedUpdateManyInput` rather than
// `ClassTemplate`'s.
// ---------------------------------------------------------------------------

/**
 * Compile-time pin: every field the wire schema routes to `ScheduleRule` must
 * name a column `update` can write there.
 */
const _scheduleRuleUpdateColumnsExist: NoneOf<
  Exclude<keyof ScheduleRuleUpdateData, keyof Prisma.ScheduleRuleUncheckedUpdateManyInput>
> = true;
void _scheduleRuleUpdateColumnsExist;

/**
 * The rule fields a teacher may change through `PUT /api/class-templates/[id]`
 * — the slot half of the wire schema (issue 298). `dayOfWeek` carries the same
 * stamp-not-link consequence `TeacherEditableClassTemplateField` documents:
 * editing it moves nothing already generated.
 */
// Exported so the studio file can pin its own allowlist against this one
// directly (`_ruleAllowlistsAgree`), the same way
// `PlainUpdateForbiddenScheduleRuleField` is exported for the forbidden
// halves — one rule model, shared by both families.
export type TeacherEditableScheduleRuleField =
  | 'classType'
  | 'dayOfWeek'
  | 'startTime'
  | 'durationMinutes';

/** Compile-time pin (forward): every field the schema routes to `ScheduleRule` must be on this allowlist. */
const _scheduleRuleFieldsArePermitted: NoneOf<
  Exclude<keyof ScheduleRuleUpdateData, TeacherEditableScheduleRuleField>
> = true;
void _scheduleRuleFieldsArePermitted;

/** Compile-time pin (reverse): every allowlist entry must still be a field the schema routes to `ScheduleRule`. */
const _scheduleRuleAllowlistHasNoStaleFields: NoneOf<
  Exclude<TeacherEditableScheduleRuleField, keyof ScheduleRuleUpdateData>
> = true;
void _scheduleRuleAllowlistHasNoStaleFields;

/**
 * The `ScheduleRule` columns the plain update path must never write.
 *
 *   - `id`, `teacherId`, `kind` → identity/ownership.
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
 * `isActive` is the entry that matters most here: it is what stops a `PUT`
 * flipping a template active, which would bypass the transaction-and-generate
 * path `PATCH` owns and door 3's resume refusal with it. Door 5 no longer
 * gates on `isActive`, but door 3 still does.
 */
// Exported so the studio file can pin its own forbidden list against this
// one directly (`_ruleForbiddenListsAgree`) rather than asserting the two
// agree in prose with nothing tethering the claim.
export type PlainUpdateForbiddenScheduleRuleField =
  | 'id'
  | 'teacherId'
  | 'kind'
  | 'isActive'
  | 'isArchived'
  | 'archivedAt'
  | 'withdrawnCount'
  | 'createdAt'
  | 'updatedAt';

/**
 * Compile-time pin (completeness): every `ScheduleRule` column must be
 * claimed by the allowlist or the forbidden list above — checked against the
 * live Prisma type rather than a duplicated literal union, so a migration
 * that adds an unclassified column reddens this rather than passing
 * silently.
 */
const _scheduleRuleListsPartitionTheModel: NoneOf<
  Exclude<
    keyof Prisma.ScheduleRuleUncheckedUpdateManyInput,
    TeacherEditableScheduleRuleField | PlainUpdateForbiddenScheduleRuleField
  >
> = true;
void _scheduleRuleListsPartitionTheModel;

/**
 * Compile-time pin: every name above must be a real `ScheduleRule` column.
 * Without this a typo would sit in the forbidden list protecting nothing
 * while looking like protection.
 */
const _scheduleRuleForbiddenColumnsExist: NoneOf<
  Exclude<PlainUpdateForbiddenScheduleRuleField, keyof Prisma.ScheduleRuleUncheckedUpdateManyInput>
> = true;
void _scheduleRuleForbiddenColumnsExist;

/**
 * Compile-time pin (forbidden): no forbidden column may appear on the
 * allowlist.
 */
const _scheduleRuleAllowlistHasNoForbiddenFields: NoneOf<
  Extract<TeacherEditableScheduleRuleField, PlainUpdateForbiddenScheduleRuleField>
> = true;
void _scheduleRuleAllowlistHasNoForbiddenFields;

/**
 * `ClassTemplate` with the rule's columns flattened back on, in the wire
 * shape every caller already expects: `startTime` as `"HH:MM"` (design §6),
 * not the `@db.Time` `Date` `ScheduleRule` stores it as (issue 298).
 *
 * Every result type below carries this rather than a bare `ClassTemplate`,
 * because the route spreads the template straight onto the response body and
 * the wire consumers on the other end still expect these columns to be
 * there, which the row itself no longer has.
 */
export type ClassTemplateWithSlot = ClassTemplate & {
  teacherId: string;
  classType: string;
  dayOfWeek: number;
  startTime: string;
  durationMinutes: number;
  isActive: boolean;
  isArchived: boolean;
  archivedAt: Date | null;
  withdrawnCount: number | null;
};

/**
 * Flattens a rule's columns onto its child, converting `startTime` to the
 * wire's `"HH:MM"`. Exported for the routes' own reads
 * (`GET /api/class-templates`, `GET /api/class-templates/[id]`, and the
 * `POST` create), which need the same flattening this file's writes do.
 */
export function withSlot(template: ClassTemplate, rule: ScheduleRule): ClassTemplateWithSlot {
  return {
    ...template,
    teacherId: rule.teacherId,
    classType: rule.classType,
    dayOfWeek: rule.dayOfWeek,
    startTime: timeToHHmm(rule.startTime),
    durationMinutes: rule.durationMinutes,
    isActive: rule.isActive,
    isArchived: rule.isArchived,
    archivedAt: rule.archivedAt,
    withdrawnCount: rule.withdrawnCount,
  };
}

/**
 * Why an update did or did not happen. Every business outcome is a variant;
 * callers own the user-facing wording.
 */
export type UpdateClassTemplateResult =
  | {
      ok: true;
      template: ClassTemplateWithSlot;
      /**
       * The **Monday of the first week the new schedule reaches**, or `null`
       * when there is no such week to name (#194).
       *
       * `null` has TWO causes and they are not the same fact, which is why
       * `generationState` sits beside it rather than being left for the copy
       * layer to infer: either no free week is inside the probe's horizon, or
       * the template is not eligible to generate at all and the probe was
       * never run. Reading `null` alone as "no free week" is what produced a
       * confirmation naming a week the sweep would never fill for every edit
       * to a paused or archived template.
       *
       * Named as a week rather than as a date on purpose. `firstFreeWeek`
       * answers with a candidate *occurrence* — a Thursday, say — and the
       * sentence built from this speaks about weeks; a bare `Date` here
       * invites the occurrence reading and would put the wrong day in front
       * of a teacher. The conversion happens in `updateClassTemplate` rather
       * than in the copy layer because `mondayOf` lives in `@/lib/timezone`,
       * which imports pino, and `template-action-messages.ts` is
       * value-imported by a `'use client'` component.
       *
       * A prediction, not a report: this PUT generates nothing, so the class
       * it names does not exist yet and will be created by the sweep.
       */
      firstEffective: Date | null;
      /**
       * Whether the sweep will act on this edit at all, and if not, what the
       * teacher has to do first (#194).
       *
       * This PUT is deliberately open to a paused or archived template — door
       * 5's comment below argues that at length, and nothing here changes it.
       * The edit commits either way. What differs is WHEN it takes effect,
       * and for an ineligible template the answer is not a date: the hourly
       * sweep never reaches it (`ACTIVE_TEMPLATE_WHERE` at the `findMany`,
       * and again under the row lock in `claimTemplateForGeneration`), so no
       * week can be named honestly until the teacher resumes — or un-archives
       * and then resumes.
       *
       * Derived by `templateGenerationState` from the row this call just
       * wrote, not from the row read at the top: `isActive`/`isArchived` are
       * both on the forbidden list, so no PUT can move them, but reading the
       * post-write row is what keeps that a fact about the code rather than a
       * memory of it.
       *
       * Carried as its own field rather than left to the client to derive
       * from the `isActive`/`isArchived` columns the route already spreads.
       * Those two booleans are the INPUT to a rule that lives in
       * `@/lib/template-selection`; re-deriving it in a `'use client'` copy
       * layer would be a fourth copy of the generator's eligibility gate, in
       * the one place nobody would look when it changes.
       */
      generationState: TemplateGenerationState;
    }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'no_fields' }
  | { ok: false; reason: 'invalid_room' }
  /**
   * A fifth door on the room archive lifecycle (issue 76): relocating a
   * template onto an archived room is refused the same way creating (door 4)
   * or resuming (door 3) one there is — the doors reasoned about creating a
   * template and resuming one but never about moving one, the same commitment
   * by a different verb. The template is what the generator stamps from, so
   * an ACTIVE template pointed at an archived room hands the next sweep four
   * weeks of `open` classes to create in a shelved room — the exact state
   * door 1 exists to refuse, reached one step later.
   *
   * THE MECHANISM CHANGED UNDER THIS DOOR IN #194 AND THE DOOR DID NOT. Until
   * then the edit produced that state itself, relocating every future
   * non-`settingsLocked` `draft`/`open` instance onto the target room in the
   * same transaction — one `PUT`, four bookable classes, no race needed.
   * Nothing propagates now, so the sweep is the whole route, and a route that
   * takes until the next hour is still a route.
   *
   * Gated on a CHANGE of room, NOT on `template.isActive`. Fix round 2 gated
   * it on `isActive` "symmetrically with door 3"; PR review proved that a
   * false analogy. Door 3 gates on the *direction of the verb*
   * (`desiredActive`), so that pausing a template whose room was archived
   * under it still works. `isActive` is a property of the template on a
   * different axis, and it is not one this door can rest on: a paused
   * template is one `PATCH` away from generating, and door 3 refuses exactly
   * that resume — so an `isActive` gate here would accept the commitment at
   * the move and refuse it at the resume, stranding the teacher one verb
   * later over a decision this request already took. What that gate let
   * through when it shipped is worse and is recorded rather than
   * paraphrased: pausing deletes nothing, so a paused template still owned
   * the `open` instances it had generated, and the propagation carried every
   * one of them onto the archived room in a single request with no race.
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
  /**
   * A live rule occupies the requested slot (#196/#296) — enforced by
   * `ScheduleRule_teacher_slot_excl`, one exclusion constraint spanning both
   * class families (issue 298), in place of the partial unique index and the
   * cross-family trigger this reason used to split across two. `heldBy` is
   * what tells the two apart now: the constraint's `23P01` cannot say which
   * family raised it, so a fresh probe of `ScheduleRule` answers separately
   * (`ruleSlotHolder`, `src/lib/rule-slot-holder.ts`).
   */
  | { ok: false; reason: 'slot_conflict'; heldBy: RuleSlotHolder }

  /**
   * This transaction lost a contention race and rolled back whole, so nothing
   * was applied and the identical request can win the next attempt.
   *
   * ONE row family can produce it: the `ClassTemplate` row itself, held by a
   * concurrent generation claim, archive, or pause/resume.
   *
   * It was two for the length of one branch. While the write and the
   * propagation were one transaction, any `Class` row of this template could
   * lose the race too — the sync took an ordered `FOR UPDATE OF c` over every
   * future instance, and an ordinary booking holding one `FOR UPDATE` for the
   * length of its own transaction could time a teacher's edit out at 2s.
   * #194 deleted the sync, so this transaction takes no `Class` locks at all
   * and that second family is gone with it: the edit path has left the
   * deadlock graph entirely. Do not re-derive it from the archive's
   * exposure — `archiveOrUnarchiveTemplate` still holds an ordered pre-lock
   * and still documents that race for itself; this function no longer shares
   * it.
   *
   * The log line at the `catch` still logs `err`, whose invocation line names
   * the statement that lost, which is the fastest way to tell a claim from an
   * archive from a pause.
   *
   * See `ArchiveTemplateResult`'s `busy` arm for the fuller range of causes
   * `isTransientDbError` matches; this arm is produced by the same helper.
   * Its `40P01` paragraph no longer extends to this function, though: it says
   * "this function is one side of" the `{Class, ClassTemplate}` ordering
   * question (issue #229), meaning the archive. `updateClassTemplate` was a
   * fifth site on that side for as long as it locked `Class` rows; it is not
   * one now, so a `40P01` here can only come from the `ClassTemplate` row.
   */
  | { ok: false; reason: 'busy' };

/**
 * The probe behind `UpdateClassTemplateResult.firstEffective` (#194): the
 * Monday of the first week in `horizon` whose candidate date
 * `generateInstancesForTemplate` would actually fill, GIVEN that the template
 * is eligible to generate at all.
 *
 * That precondition is the caller's, not this function's, and it is stated in
 * the contract rather than assumed because it is not a `SkipReason` and so
 * cannot appear in the enumeration below. `generateInstancesForTemplate`
 * refuses candidate DATES; `ACTIVE_TEMPLATE_WHERE` refuses whole TEMPLATES,
 * one layer up, before any candidate is considered — at the sweep's
 * `findMany` (`class-generator.ts`) and again under the row lock in
 * `claimTemplateForGeneration`. For a paused or archived template the
 * generator is never called, no date is ever declined, and every answer this
 * function could give would name a week nothing will fill. `updateClassTemplate`
 * therefore calls it only when `templateGenerationState(updated) === 'active'`
 * and reports the other two states as themselves; a reader completing the
 * bullet list below would still be missing that case, which is why it is up
 * here and not in it.
 *
 * Read-only, and it must stay that way — this endpoint creates no class, so
 * everything in the sentence it feeds is a prediction about the sweep.
 *
 * ## Which of the generator's refusals this reproduces, and which it does not
 *
 * The generator declines a candidate date on six named grounds (`SkipReason`,
 * `@/lib/generation`, whose own header says "Six reasons, six distinct
 * origins" — one number, derived from the type, not two conventions counting
 * the same union). Stated one at a time rather than as a parity claim, because
 * the parity claim is what this docblock said before `slot_taken` was found
 * missing — and a reader who trusted it had no way to check it. Named rather
 * than numbered, because "the Nth ground" resolves against no ordering anyone
 * has written down:
 *
 *   - `already_generated` and `blocked_by_cancelled` — this template's own row
 *     on the date itself, live or cancelled. Both reproduced by the FIRST read:
 *     a row on a date is a row in that date's week, and the read carries no
 *     status filter, so a cancelled row holds its week too. That absent filter
 *     is deliberate and is the one place this codebase does not read cancelled
 *     as free —
 *     `docs/superpowers/specs/2026-08-20-template-stamp-not-link-design.md`
 *     §3.2 has the flip-flop schedule the alternative produces.
 *   - `already_this_week` — the same read, and the same `isWeekHeld` the
 *     generator's loop decides with. That sharing is the point of the
 *     function existing.
 *   - `slot_taken` (#196) and `blocked_by_overlap` (#296) — somebody
 *     ELSE's row: another LIVE entry of this teacher whose SPAN overlaps the
 *     candidate's. Invisible to a rule-keyed read, which is why there
 *     is a SECOND read. Missing it made the prediction land EARLIER than the
 *     sweep delivers, which is the dishonest direction: rule 1 of #194 leaves
 *     a moved-off template's instances standing, so a second template edited
 *     onto that day and time finds its own weeks empty and every date
 *     occupied. The two reasons took two reads until #327 put both families
 *     in one `CalendarEntry`; they take one now, and the probe does not tell
 *     them apart because the answer it gives is the same either way.
 *
 *     Overlap rather than an identical start time, and that distinction is
 *     #327's: the constraint behind both reasons is a RANGE now. A read keyed
 *     on `startTime` reproduced neither reason fully, and erred in the
 *     dishonest direction while this bullet claimed it reproduced both.
 *   - `raced` — **not reproduced, and not reproducible.** It is a concurrent
 *     insert landing between the generator's pre-check and its write, so at
 *     probe time it has not happened yet and there is nothing to read. Its
 *     effect on this prediction is bounded and self-correcting: the sweep loses
 *     that one date and picks the template up again on its next run, so the
 *     class arrives late rather than never. This is the one divergence, and it
 *     is the only one that errs later-than-promised.
 *
 * The two facts are kept apart rather than merged into one set, because they
 * are not the same fact: a WEEK this template already occupies versus a single
 * DATE whose slot another entry holds. Slot-taken dates are removed from the
 * candidate list; `firstFreeWeek` then answers the week question over what is
 * left. BOTH reads are bounded by `horizon` itself — its first and last weeks
 * for the week read, its own members for the slot read — so nothing here can
 * disagree with anything else about which dates are in play.
 *
 * Answers `null` rather than throwing when a read fails. The edit has already
 * committed by the time this runs, so a probe failure must not turn a saved
 * template into a 500 — and `templateUpdatedMessage` already has a `null`
 * branch that says nothing about weeks rather than something unfounded. Logged
 * so the silence is not also invisible.
 */
async function probeFirstEffectiveWeek(
  db: PrismaClient,
  template: ClassTemplateWithSlot,
  horizon: readonly Date[],
): Promise<Date | null> {
  // Guarded rather than `!`-asserted: under `noUncheckedIndexedAccess` a `!`
  // here would be a claim about `getNextOccurrences` and its filter several
  // lines away, and both ends are dereferenced below.
  const first = horizon[0];
  const last = horizon[horizon.length - 1];
  if (first === undefined || last === undefined) return null;

  try {
    const [ownRows, slotHolders] = await Promise.all([
      // The weeks this template already occupies. Keyed on `scheduleRuleId`,
      // which rides `@@unique([scheduleRuleId, date])`, and bounded by the
      // horizon's own first and last weeks. No liveness filter — see the
      // docblock.
      db.calendarEntry.findMany({
        where: {
          scheduleRuleId: template.scheduleRuleId,
          date: {
            gte: new Date(mondayOf(first)),
            lt: new Date(mondayOf(last) + 7 * 24 * 60 * 60 * 1000),
          },
        },
        select: { date: true },
      }),
      // This teacher's LIVE entries on the candidate dates, whatever their
      // start time — the SPAN comparison happens below, in `spansOverlap`, the
      // same function the generator's own pre-check decides with.
      // `cancelledAt: null` rather than no filter, matching
      // `CalendarEntry_teacher_slot_excl`'s partial scope (`WHERE
      // "cancelledAt" IS NULL`) — the opposite of the read above, and for the
      // opposite reason: a cancelled entry does not hold a slot, and a
      // cancelled entry does hold a week. `date: { in: … }` over the horizon
      // itself rather than a second pair of bounds, so the two reads cannot
      // drift apart about the range; `@@index([teacherId, date])` backs it.
      //
      // ONE READ FOR BOTH FAMILIES since #327, where this used to be two — the
      // second was a `StudioClass` scan added in #296, and it was not an
      // extension of the probe but a REPAIR of it: a probe blind to the other
      // family counted a cross-family date as a free candidate and named a
      // week the sweep would then skip, landing EARLIER than delivered, which
      // this function's own docblock calls the dishonest direction. With one
      // occupancy table that blindness is not expressible.
      //
      // OVERLAP, NOT EXACT START, and that is the SAME defect one shape over.
      // #327 made `CalendarEntry_teacher_slot_excl` a RANGE constraint, so a
      // generator declines a candidate that merely runs into a neighbour. An
      // exact-start read here counts such a date as free, names a week the
      // sweep then skips, and lands EARLIER than delivered — the dishonest
      // direction again, and #194's original failure. Erring the other way is
      // not on offer: matching the generator exactly is what makes the answer
      // right rather than merely safe.
      db.calendarEntry.findMany({
        where: {
          teacherId: template.teacherId,
          cancelledAt: null,
          date: { in: [...horizon] },
        },
        select: { date: true, startTime: true, durationMinutes: true },
      }),
    ]);

    const heldWeeks = new Set(ownRows.map((e) => mondayOf(e.date)));
    // What every candidate would occupy — one span for the whole horizon,
    // since a template has one start time and one duration. Built exactly as
    // `generateInstancesForTemplate` builds its own `candidateSpan`, so the
    // two cannot disagree about which dates are reachable.
    const candidateSpan = {
      startTime: hhmmToTime(template.startTime),
      durationMinutes: template.durationMinutes,
    };
    // Both families' slot holders in one set, which is now what the table is
    // rather than something this function assembles. They are not told apart,
    // and deliberately: a date is unreachable for the same reason whichever
    // family holds it. The GENERATOR tells them apart, because its two reasons
    // carry two different remedies for the teacher.
    //
    // `spansOverlap` is same-date-only and the read above supplies that. It
    // therefore misses a neighbour spilling over midnight into a candidate,
    // exactly as the generator's pre-check does — so the two agree on that
    // case too, and the constraint refuses it at insert either way.
    const takenDates = new Set(
      slotHolders
        .filter((e) => spansOverlap(e, candidateSpan))
        .map((e) => e.date.getTime()),
    );

    // Removed from the candidates rather than folded into `heldWeeks`. Folding
    // would be shorter and would say something false: a taken slot does not
    // make the WEEK unavailable to this template in general, it makes this
    // one date unfillable — and since a weekly template has exactly one
    // candidate per week, the week is lost as a consequence, not as a
    // definition. The generator draws the same distinction, which is why it
    // reports two different reasons.
    const candidates = horizon.filter((date) => !takenDates.has(date.getTime()));

    const free = firstFreeWeek(candidates, heldWeeks);
    // Converted to the WEEK's Monday before leaving this function, not left as
    // the candidate date — see `UpdateClassTemplateResult`'s own note for why
    // the conversion cannot live in the copy layer.
    return free === null ? null : new Date(mondayOf(free));
  } catch (err) {
    log.warn(
      { err, templateId: template.id },
      'recurring class edit saved, but the first-effective-week probe failed — the confirmation will not name a week',
    );
    return null;
  }
}

/**
 * Apply a partial update to a class template. The template row, and nothing
 * else.
 *
 * A template is a stamp, not a live link (#194): no already-generated `Class`
 * is moved, rewritten or deleted by an edit — not its day, not its time, not
 * its room, not its rates, not its capacity. The rule has no exception, which
 * is the point of it; "what happens to my existing classes when I change
 * this?" has exactly one answer. Until #194 this function also ran
 * `syncTemplateInstances`, which rewrote unbooked future instances and DELETED
 * the ones sitting on a superseded weekday. That function is gone, not
 * narrowed.
 *
 * Takes `teacherId` rather than a session: this is the ownership check, and
 * keeping it a plain argument is what lets the function be tested without HTTP.
 *
 * The `$transaction` wraps an explicit child-row lock and up to two
 * `update`s — one on this row, one on `ScheduleRule` when the PUT touches a
 * calendar field — and survives for a reason beyond scoping `SET LOCAL
 * lock_timeout` (`db-locks.ts`, still true and still load-bearing: deleting
 * the wrapper would silently delete the #100/#209 lock bound with it). See
 * the budget comment at the call for the same warning where someone trimming
 * this would read it. The `catch` sits OUTSIDE the
 * `$transaction` call, the same shape `archiveOrUnarchiveTemplate` and `POST
 * /api/class-templates` already use: a failed statement aborts a Postgres
 * transaction, so there is nothing to catch from within, and the whole
 * thing rolling back is what makes catching it after the fact meaningful —
 * every reason mapped below describes a transaction that did not commit.
 *
 * Three shapes are mapped below rather than left to propagate as a 500: P2025
 * becomes `{ ok: false, reason: 'not_found' }`, because the row is gone
 * before the caller is answered (#100); a `23P01` named `slot_conflict`
 * (#196/#298); and `isTransientDbError` matching — a holder of the child or
 * rule row outlasting the `setLockTimeout` bound below — becomes
 * `busy`. There was a fourth, `sync_conflict`: a P2002 on
 * `Class_teacher_slot_unique` raised when the propagation rewrote a generated
 * instance's `startTime` onto a slot some other class already held. Nothing
 * writes a `Class` row here any more, so that error can no longer be raised
 * and the arm is gone; `slot_conflict`, a different failure entirely, stays.
 * Everything else still propagates as an opaque 500.
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
  // `defaultTimezone` joined for the probe at the foot of this function, which
  // has to drop an occurrence whose start has already passed exactly the way
  // `generateInstancesForTemplate` does. Read here rather than separately
  // because it is the same column the generator filters with and this read
  // already exists; the zone is a `Teacher` field and no PUT can move it, so
  // reading it before the write rather than after changes nothing.
  //
  // `scheduleRule` joined too (issue 298): `teacherId` and the slot fields
  // live there now, and this read is also the fallback value for a PUT that
  // touches none of them — see the transaction below.
  const template = await db.classTemplate.findUnique({
    where: { id: templateId },
    include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
  });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.scheduleRule.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  // Defined-value scan, matching `updateClass`'s own `hasEdit` check
  // (`class-lifecycle.ts`): a key present with value `undefined` is not an
  // edit. A key-count check would let `{ description: undefined }` clear
  // this guard, issue a no-op `update`, take the template row's lock for
  // nothing, and still report `ok: true`.
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
    // was the only one of the three left unguarded. The template is the
    // generator's stamp, so an active one pointed here gives the next sweep
    // four weeks of `open` classes to create in a shelved room. Until #194 the
    // edit did it itself, relocating every future non-`settingsLocked`
    // `draft`/`open` instance onto the target room in this transaction; that
    // mechanism is gone and the door is not. `UpdateClassTemplateResult`'s
    // `room_archived` docblock carries the same reasoning at length — the two
    // were written together and must be corrected together.
    //
    // Gated on a CHANGE of room, NOT on `template.isActive`. Both halves are
    // load-bearing and each reddens a test alone (mutations 8 and 9, spec
    // section 9):
    //   - drop `isArchived` and both move-refusal cases go red.
    //   - drop `!== template.teacherRoomId` and "allows a no-op room field"
    //     goes red, because `TemplateForm` posts the whole form on every edit,
    //     so an unchanged `teacherRoomId` arrives on every PUT.
    //
    // `isActive` is deliberately NOT consulted. The fix-round-2 gate that did
    // consult it was wrong for a reason #194 has since removed — pausing
    // deletes nothing, so a paused template still owned its generated `open`
    // instances, and the propagation carried them onto the archived room, one
    // step behind door 1's refusal — and it stays wrong for a reason that
    // remains: a paused template is one resume away from generating, door 3
    // refuses that resume, and gating here on `isActive` would move the
    // refusal off the request that made the commitment.
    if (teacherRoom.isArchived && data.teacherRoomId !== template.teacherRoomId) {
      log.info(
        { templateId, from: template.teacherRoomId, to: data.teacherRoomId },
        'template move refused: the target room is archived',
      );
      return { ok: false, reason: 'room_archived' };
    }
  }

  // Declared out here rather than returned from inside the `try`, so the probe
  // below sits OUTSIDE the catch. Inside it, a transient failure of a
  // read-only probe would be mapped to `busy` — "nothing was changed" — about
  // an edit that had already committed. The catch either returns or rethrows
  // on every path, so this is definitely assigned by the time the probe runs.
  let updated: ClassTemplateWithSlot;
  let updatedRule: ScheduleRule;
  try {
    // `updated`, not `template`: the pre-transaction read at the head of this
    // function is already called `template`, and the `catch` below turns on
    // keeping the two apart — "the read above and the write inside the
    // transaction are not the same statement" is the sentence that explains
    // why P2025 has one source. Two values that the error mapping
    // distinguishes should not share a name.
    const written = await db.$transaction(
      async (tx) => {
        // First statement, deliberately — and now the only statement it has
        // to bound, the up-to-three statements below it. A concurrent
        // generation claim, archive, or pause/resume can hold the child row
        // locked for the duration of its own transaction.
        //
        // Without it the wait is bounded by NOTHING, not by the budget below:
        // Prisma checks that budget at statement boundaries, so it "cannot
        // roll back a statement already blocked inside Postgres, only refuse
        // to start a new one" (`db-locks.ts`).
        //
        // This call was once one of two — `syncTemplateInstances` issued its
        // own before its pre-lock, and the note here explained which of the
        // two was load-bearing. #194 deleted that function, so there is one
        // `setLockTimeout` on this path and no ambiguity left to resolve.
        await setLockTimeout(tx);

        // The child's row lock, explicit rather than incidental. Every other
        // caller in this file — `pauseOrResumeTemplate`,
        // `archiveOrUnarchiveTemplate` — takes this same lock as their own
        // first statement, so this one has to as well: `classType`,
        // `dayOfWeek`, `startTime` and `durationMinutes` write `ScheduleRule`
        // below, and a PUT that touches only those four would otherwise reach
        // that write without ever touching `ClassTemplate` — an edit with
        // nothing for the CAS in the sibling functions to wait on. See
        // `docs/lock-order.md`, "The child row is the lock node for the
        // template families" for the decision this implements.
        await tx.$queryRaw`SELECT "id" FROM "ClassTemplate" WHERE "id" = ${templateId} FOR UPDATE`;

        // The wire data covers both models now (issue 298): the fields named
        // in `TeacherEditableScheduleRuleField` route to `ScheduleRule`,
        // everything else stays a `ClassTemplate` column. Destructuring those
        // out — rather than hand-picking the rest — is tethered to the pins
        // above:
        // `_templateFieldsArePermitted`/`_templateAllowlistHasNoStaleFields`
        // together prove `childData`'s keys equal `TeacherEditableClassTemplateField`
        // exactly, so nothing wider can reach `classTemplate.update` this way.
        const { classType, dayOfWeek, startTime, durationMinutes, ...childData } = data;

        const updatedChild = await tx.classTemplate.update({ where: { id: templateId }, data: childData });

        // Built field-by-field rather than spread, and typed with the same
        // `Partial<Record<PlainUpdateForbiddenScheduleRuleField, never>>`
        // guard `data` itself carries: a future edit that tried to fold a
        // forbidden name (`isActive`, say) into this object would fail here,
        // at the point it would actually reach the rule row, rather than
        // relying on `data`'s own guard reaching this deep by construction.
        const ruleData: Partial<Pick<Prisma.ScheduleRuleUncheckedUpdateManyInput, TeacherEditableScheduleRuleField>> &
          Partial<Record<PlainUpdateForbiddenScheduleRuleField, never>> = {};
        if (classType !== undefined) ruleData.classType = classType;
        if (dayOfWeek !== undefined) ruleData.dayOfWeek = dayOfWeek;
        if (startTime !== undefined) ruleData.startTime = hhmmToTime(startTime);
        if (durationMinutes !== undefined) ruleData.durationMinutes = durationMinutes;

        // Only written when the PUT actually touched one of
        // `TeacherEditableScheduleRuleField`'s members — sparing the rule row
        // a lock and an `updatedAt` bump on an edit that is purely economics
        // (room, rates, capacity, deadlines).
        const newRule =
          Object.keys(ruleData).length > 0
            ? await tx.scheduleRule.update({ where: { id: template.scheduleRuleId }, data: ruleData })
            : template.scheduleRule;

        return { updatedChild, newRule };
      },
      // Two statements now at most, where there were five (#194 deleted the
      // sync). The transaction survives only to scope `SET LOCAL
      // lock_timeout`, which is a no-op outside one (`db-locks.ts`) — remove
      // the transaction and the #100/#209 bound goes with it, silently. That
      // is the whole reason it is still here; it is not vestigial.
      { timeout: 10_000 },
    );
    updated = withSlot(written.updatedChild, written.newRule);
    updatedRule = written.newRule;
  } catch (err) {
    // Transient first, matching the order `pauseOrResumeTemplate` and
    // `archiveOrUnarchiveTemplate` use in this same file. Not
    // correctness-critical here — `isTransientDbError`'s codes are disjoint
    // from P2025 and from the exclusion constraint's `23P01` below, so a
    // transient error could not fall into either of those branches even
    // checked last — but kept first anyway so a reader does not have to
    // re-derive that for each of the six template lifecycle functions this
    // helper now guards — `updateClassTemplate`, `pauseOrResumeTemplate` and
    // `archiveOrUnarchiveTemplate`, and the three studio twins. (Counted, not
    // incremented: it read "five" at this branch's base too, and was wrong
    // there as well.)
    if (isTransientDbError(err)) {
      // The template row, and it can now be named: this transaction takes one
      // lock and it is the `ClassTemplate` row's. For one branch the message
      // deliberately said "template row or one of its instances", because the
      // composed sync's ordered pre-lock meant a student booking a single
      // instance could time a teacher's edit out and an operator sent to the
      // generation sweep would find nothing. #194 deleted the sync; no `Class`
      // row is locked here any more, so the vaguer wording would now send that
      // operator to look for a race the code cannot have. `err` is still
      // logged — its invocation line names the statement that lost, which
      // separates a generation claim from an archive from a pause/resume.
      log.warn(
        { err, templateId, teacherId },
        'recurring class edit lost a lock race on the template row — nothing committed',
      );
      return { ok: false, reason: 'busy' };
    }

    // The read above and the write inside the transaction are not the same
    // statement, so a delete landing in the gap between them still surfaces
    // here as Prisma's P2025 — from one source, `classTemplate.update`
    // itself. (Two branches ago the sync's opening `findUniqueOrThrow` was a
    // second source, telling them apart needed the invocation line at the head
    // of `err.message`, and composing the sync into this transaction closed
    // it. #194 deleted the sync outright, so the question cannot come back
    // through that door.) Map it to the same outcome the read-time guard above
    // would have produced, rather than letting it fall through as an opaque
    // 500.
    //
    // That reports `not_found` for a delete that beat this transaction to the
    // row, so nothing here commits. The row really is gone, though, so the
    // write that raced this one has its own consequences worth naming:
    // `Class.template` is `onDelete: SetNull`
    // (`prisma/schema.prisma`), so deleting a template does not take its
    // generated classes with it. Each keeps standing with `templateId: null`,
    // still `open`, still on the teacher's schedule and public booking page,
    // frozen with whatever settings it had before this edit. Whoever writes
    // the delete path this guard exists for inherits those orphans; they are
    // that path's problem, not this function's.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return { ok: false, reason: 'not_found' };
    }

    // One source under this `try` now, from #196/#298. `dayOfWeek`/`startTime`
    // write onto the rule (`TeacherEditableScheduleRuleField`), so a collision
    // here means a live rule — either family — already occupies an overlapping
    // slot on the requested day.
    //
    // A second branch stood here until #194, matching
    // `Class_teacher_slot_unique` (`teacherId`, `date`, `startTime`) and
    // returning `sync_conflict`: the propagation rewrote `startTime` on every
    // still-mutable generated `Class` sharing this template's day, and any one
    // of those could collide with a class the propagation never touched. This
    // transaction writes no `Class` row at all now, so that P2002 has no way
    // to be raised from here.
    //
    // Two separate branches stood here until this task — `isUniqueConflictOn`
    // for a same-family collision, `isCrossFamilySlotConflict` for the other
    // family's — because two different DB objects raised them. Issue 298
    // replaced both objects with the ONE exclusion constraint below, and a
    // `23P01` cannot say which family it refused, so `ruleSlotHolder` probes
    // `ScheduleRule` itself to answer that. LOGGED for the reason
    // `archiveOrUnarchiveTemplate`'s own branch below gives: a returned
    // failure never reaches `withErrorHandler`, so catching here is what
    // would otherwise remove the server-side record.
    if (isExclusionConflictOn(err, 'ScheduleRule_teacher_slot_excl')) {
      const heldBy = await ruleSlotHolder(db, {
        teacherId,
        dayOfWeek: data.dayOfWeek ?? template.scheduleRule.dayOfWeek,
        startMinutes: minutesSinceMidnight(
          data.startTime !== undefined ? hhmmToTime(data.startTime) : template.scheduleRule.startTime,
        ),
        durationMinutes: data.durationMinutes ?? template.scheduleRule.durationMinutes,
        excludeRuleId: template.scheduleRuleId,
      });
      log.warn(
        { err, templateId, teacherId, heldBy },
        'recurring class edit refused: that slot is taken',
      );
      return { ok: false, reason: 'slot_conflict', heldBy };
    }
    throw err;
  }

  // The edit is committed; everything below is read-only and cannot undo it.
  //
  // This PUT creates nothing — generation still happens only on the cron
  // sweep, on create and on resume — so the confirmation has to PREDICT where
  // the new schedule first lands rather than report it.
  //
  // A longer horizon than the generator's own window, and that asymmetry is
  // the point rather than an inconsistency: when all four of the generator's
  // weeks are held by the superseded schedule, the honest answer is week five,
  // which the generator cannot see. Derived from `DEFAULT_WEEKS` rather than
  // written as 8, so widening the window widens the prediction with it.
  //
  // The same past-start filter the generator applies to its own candidates,
  // with the same two inputs. Without it this probe can name the CURRENT week
  // on the template's own weekday once the class hour has gone —
  // `getNextOccurrences` includes today and the generator drops it — so the
  // sentence would name a week the sweep never fills. That is the one
  // direction the staleness note below does not cover, and it is the
  // dishonest one.
  //
  // Staleness the other way is possible and harmless: if the sweep runs
  // between this read and the teacher reading the sentence, the class can only
  // land EARLIER than predicted, never later.
  const now = new Date();
  const horizon = getNextOccurrences(updated.dayOfWeek, now, DEFAULT_WEEKS * 2).filter(
    (date) =>
      classStartInstant({ date, startTime: hhmmToTime(updated.startTime) }, template.scheduleRule.teacher.defaultTimezone) >
      now,
  );

  // The gate the probe cannot apply for itself, because it is not about a
  // date: the sweep reaches only templates matching `ACTIVE_TEMPLATE_WHERE`,
  // so for a paused or archived one there is no week to predict at all. Every
  // per-date ground the probe reproduces sits INSIDE
  // `generateInstancesForTemplate`, and for these two states that function is
  // never called — which is exactly why the probe's own docblock could
  // enumerate its grounds exhaustively and still be wrong here.
  //
  // Deterministic, not a race: `isActive` is a committed column read by every
  // generation path. Before this gate, editing a paused template promised a
  // dated week for 100% of such edits, and promised it EARLIER than delivery —
  // the direction the past-start filter's comment above names as the dishonest
  // one. The archived case was sharper still: archiving deletes the future
  // window, so the probe found no held week and answered with the earliest
  // date it has, this week's Monday, for a template that generates nothing.
  //
  // Not probed-then-discarded: two reads for an answer that cannot be used are
  // two reads too many, and skipping them makes the precondition visible at
  // the call site rather than buried in a `null` return.
  const generationState = templateGenerationState(updatedRule);

  return {
    ok: true,
    template: updated,
    firstEffective:
      generationState === 'active' ? await probeFirstEffectiveWeek(db, updated, horizon) : null,
    generationState,
  };
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
 * `date` is `CalendarEntry.date` straight through — one column for both
 * producers since #327 — and it is `@db.Date`: a calendar date
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
 * window holds and why it is not fuller — `scheduled`, `added`, and `counts`
 * (a whole `SkipCounts`); `unchanged` reports nothing beyond the template
 * itself, because it describes a request that changed nothing.
 *
 * This paragraph used to say "resuming needs no explanation", directly above an
 * arm that had grown counts. That is exactly the shape #164 was caused by — a
 * header disagreeing with the declaration beneath it — so it is worth stating
 * why it survived: it was true when resuming only flipped a flag, and nothing
 * forces a docblock to be re-read when the type under it grows.
 *
 * It has now been wrong twice more, and the second time is the instructive one.
 * #194 added `alreadyThisWeek` to `SkipCounts`, the arm gained it through the
 * old `& SkipCounts` without either name being written here, and this sentence
 * kept naming four. The response was to DERIVE the numbers from the
 * declaration "rather than incremented, which is the only way this stays true
 * through the next one".
 *
 * #296 was the next one, and deriving did not save it: the arm stopped
 * intersecting `SkipCounts` and started nesting it, so the sentence's whole
 * SHAPE — a list of member names — became wrong rather than its count. A
 * derived number survives a member being added; nothing survives the members
 * ceasing to be fields of this arm at all. Hence the naming stops here: this
 * header now says "a whole `SkipCounts`" and points at that type, which is the
 * only spelling that cannot drift, and the count lives in `SkipCounts`' own
 * docblock where the members do.
 */
export type PauseTemplateResult =
  | {
      ok: true;
      action: 'paused';
      template: ClassTemplateWithSlot;
      lastScheduled: LastScheduledClass | null;
    }
  | ({
      ok: true;
      action: 'active';
      template: ClassTemplateWithSlot;
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
      /**
       * One nested field rather than re-listed `number`s, and the difference is
       * a guarantee that did not exist before #116.
       *
       * `countSkipReasons`' docblock says a SEVENTH `SkipReason` fails the
       * build rather than vanishing, and that is true of the REASON — its
       * exhaustive `switch` catches it, measured by mutation at #296. It was
       * not true of the COUNT: measured, adding a fifth reason, handling it,
       * and adding its count to `SkipCounts` compiled clean repo-wide, and the
       * new number vanished at every site that re-listed the fields by hand.
       * #296 added a fourth count and it vanished nowhere, which is the change
       * below rather than the guard above.
       *
       * This was `& SkipCounts` until #296 — an intersection, which bought the
       * same compile-time guarantee HERE and nothing downstream: the route
       * still mapped the members one by one onto the wire, the wire type still
       * named them one by one, and the form still read them one by one. Four
       * hops, three of which an intersection cannot reach. Nesting reaches all
       * four, because every hop now moves one field whose type is
       * `SkipCounts` — which is what makes the next count's arrival free rather
       * than merely loud. Covers this arm and `ResumeTransactionOutcome`'s.
       */
      counts: SkipCounts;
    })
  | { ok: true; action: 'unchanged'; template: ClassTemplateWithSlot }
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
   * THREE statements here can wait on a lock — the CAS, the generation claim's
   * `SELECT … FOR UPDATE`, and generation's insert — matching the archive's
   * three rather than undercutting them. This paragraph said two until #116
   * added the claim.
   *
   * Which of them the bound catches first moved with that change, and the
   * distinction is the arm's whole reason for existing: the bound reaches past
   * the CAS, so a resume contending with a concurrent `Class` writer answers
   * `busy` rather than reporting that date as `raced`. It used to reach that
   * verdict at generation's insert, parking on a pending unique entry. It now
   * reaches it one statement earlier, at the claim, whose `FOR UPDATE`
   * conflicts with the `FOR KEY SHARE` an inserting row's FK check holds —
   * measured, `class-generator.test.ts`, "the clash outlives the lock
   * timeout".
   */
  | { ok: false; reason: 'busy' };

/**
 * Archiving and un-archiving are different operations and report different
 * things; `unchanged` is a third, and reports nothing at all. `deleted`/
 * `remaining` exist only on the archiving arm — un-archiving removes nothing,
 * and a no-op removes nothing twice.
 */
export type ArchiveTemplateResult =
  | { ok: true; action: 'archived'; template: ClassTemplateWithSlot; deleted: number; remaining: number }
  | { ok: true; action: 'unarchived'; template: ClassTemplateWithSlot }
  | { ok: true; action: 'unchanged'; template: ClassTemplateWithSlot }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  /**
   * A live rule occupies the requested slot (#196/#296) — enforced by
   * `ScheduleRule_teacher_slot_excl`, one exclusion constraint spanning both
   * class families (issue 298), in place of the partial unique index and the
   * cross-family trigger this reason used to split across two. `heldBy` is
   * what tells the two apart now: the constraint's `23P01` cannot say which
   * family raised it, so a fresh probe of `ScheduleRule` answers separately
   * (`ruleSlotHolder`, `src/lib/rule-slot-holder.ts`).
   */
  | { ok: false; reason: 'slot_conflict'; heldBy: RuleSlotHolder }
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
 * silently re-opening the deadlock the pre-lock exists to close. Deriving this
 * from the same array makes the desync un-representable — there is only one
 * list to edit now, not two to keep in sync.
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
const scheduledWhere = (
  scheduleRuleId: string,
  date: { gt: Date } | { gte: Date },
  alsoOnClass: Prisma.ClassWhereInput = {},
) =>
  ({
    // A `CalendarEntry` predicate since #327, not a `Class` one, and the shift
    // is not cosmetic: `date` and the rule key both live there, and the
    // ARCHIVE'S DELETE HAS TO DELETE THE ENTRY. Deleting the `Class` alone
    // would leave its entry standing, still holding `(scheduleRuleId, date)`
    // against the hourly sweep and still occupying the slot — a withdrawn
    // class that can never be regenerated and that blocks the date for good.
    // Cascade runs the other way (`Class.calendarEntry` is `onDelete:
    // Cascade`), so deleting the entry takes the class with it.
    scheduleRuleId,
    date,
    // The half `status IN ('draft','open')` used to carry for free. A
    // cancelled class keeps a live status now, and archiving must leave it
    // standing: it holds the date the teacher deliberately called off, which
    // is exactly what `ScheduleRule.withdrawnCount`'s docblock says the studio
    // family's `cancelledAt: null` filter is for. Both families spell it the
    // same way here.
    cancelledAt: null,
    classes: { some: { status: { in: [...SCHEDULED_STATUSES] }, ...alsoOnClass } },
  }) satisfies Prisma.CalendarEntryWhereInput;

/**
 * One arm per way `pauseOrResumeTemplate`'s transaction can resolve. Internal
 * only — mapped to the public `PauseTemplateResult` after the transaction
 * commits. Mirrors `ResumeTransactionOutcome` in
 * `studio-class-template-lifecycle.ts`; the two families are meant to be read
 * side by side.
 *
 * None of these carries the stale pre-transaction snapshot the CAS exists to
 * stop being trusted, but they reach that differently: `paused` and `active`
 * are read back under a lock the successful CAS is still holding, while
 * `unchanged` comes from a plain re-read in the miss branch that may or may
 * not run under a lock this transaction already holds — see that branch, and
 * `archiveOrUnarchiveTemplate`'s, for why the re-read is correct either way.
 */
type ResumeTransactionOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'archived' }
  | { outcome: 'busy' }
  | { outcome: 'unchanged'; template: ClassTemplateWithSlot }
  | { outcome: 'paused'; template: ClassTemplateWithSlot }
  | ({
      outcome: 'active';
      template: ClassTemplateWithSlot;
      scheduled: number;
      added: number;
      counts: SkipCounts;
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
      scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } },
      teacherRoom: { select: { isArchived: true } },
    },
  });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.scheduleRule.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  // Same reason as the drop further down: `PauseTemplateResult` carries
  // `ClassTemplateWithSlot`, flattened fresh from whatever row versions each
  // branch below actually reads — the joined `scheduleRule.teacher` and
  // `teacherRoom` this include added are dropped rather than leaked back to
  // the caller, including on this early-return path, before any write
  // happens.
  const { scheduleRule, teacherRoom: _tr, ...bare } = template;
  void _tr;

  const desiredActive = target === 'active';

  // Before the archived guard, deliberately. Archiving forces `isActive:
  // false`, so `?state=paused` on an archived template is already true and
  // there is nothing to refuse — only `?state=active` is the transition the
  // guard exists to block.
  if (scheduleRule.isActive === desiredActive) {
    return { ok: true, action: 'unchanged', template: withSlot(bare, scheduleRule) };
  }

  if (scheduleRule.isArchived) return { ok: false, reason: 'archived' };

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
  //
  // KNOWN-OPEN (issue 116). This guard reads `teacherRoom.isArchived` from the
  // non-transactional `findUnique` at the top of this function, so a room
  // archive committing between that read and the CAS below is invisible to it:
  // measured on #116's branch, four classes generated into a just-archived
  // room. The template's own archive race IS closed, by the CAS — but a CAS on
  // `ScheduleRule` (issue 298; it wrote `ClassTemplate` directly before that)
  // cannot carry a predicate on the related room's column.
  //
  // Not closed here, deliberately, and not by oversight: `room-archive.ts`
  // (see its own KNOWN-OPEN, spec section 8) accepts this same race class from
  // the other side rather than locking, because the alternative is a new
  // `FOR UPDATE` node in the ordering `template-lock-order.test.ts` exists to
  // defend. A re-read after the CAS would close the interleaving measured
  // above and leave its mirror open — a half-guard whose residue would need
  // documenting forever.
  //
  // The invariant "an active template may not sit on an archived room" is
  // currently enforced by five application doors, every one a non-transactional
  // read. Enforcing it once in Postgres is the structural answer and a
  // product-and-schema decision, filed as such: issue #272, which carries the
  // reproduction above and three options.
  if (desiredActive && template.teacherRoom.isArchived) {
    log.info(
      { templateId, teacherRoomId: template.teacherRoomId },
      'template resume refused: the room is archived',
    );
    return { ok: false, reason: 'room_archived' };
  }

  let result: ResumeTransactionOutcome;
  try {
    result = await db.$transaction(
      async (tx): Promise<ResumeTransactionOutcome> => {
        // Bounds every statement left in this transaction — the child lock
        // immediately below first among them, then the CAS, then the claim
        // and generation's insert.
        //
        // Without it the wait is bounded by NOTHING, not by the 10s budget:
        // Prisma checks that budget at statement boundaries, so it "cannot
        // roll back a statement already blocked inside Postgres, only refuse
        // to start a new one" (`db-locks.ts`), which the mutation records
        // measure as a hung test rather than a 10s abort.
        await setLockTimeout(tx);

        // The child's row lock, taken explicitly and first — before the CAS
        // touches `ScheduleRule` at all. `isActive`/`isArchived` moved off
        // `ClassTemplate` in issue 298, so a bare `updateMany` on
        // `ScheduleRule` no longer locks anything a concurrent
        // `claimTemplateForGeneration` (`class-generator.ts`) or
        // `archiveOrUnarchiveTemplate`/`updateClassTemplate` waits on — those
        // now serialise through this same statement instead. See
        // `docs/lock-order.md`, "The child row is the lock node for the
        // template families" for the decision this implements.
        //
        // Row count checked, not discarded: `ScheduleRule` carries no FK back
        // to `ClassTemplate`, so a `ClassTemplate` deleted out from under this
        // transaction leaves an orphaned rule row the CAS below would still
        // match — reachable only through a test double today (nothing in
        // `src/` deletes a `ClassTemplate`), but the CAS cannot tell that
        // apart from a real one, so the check is made here rather than relied
        // on to never come up.
        const childLock = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "ClassTemplate" WHERE "id" = ${templateId} FOR UPDATE`;
        if (childLock.length === 0) return { outcome: 'not_found' as const };

        // A compare-and-swap, not a plain `update`. The two guards at the top
        // of this function are read outside any lock and are fast paths only,
        // not the guarantee: an archive can commit between those reads and
        // this write. Keyed on `{ id }` alone — which is what stood here until
        // #116 — this statement would not notice. It would re-read the new row
        // version and set `isActive: true` on a template that had just been
        // archived, then generate a four-week window onto it: measured, four
        // `open` classes on an archived template, which is precisely the
        // shelved-but-bookable state #86 exists to prevent. Constraining the
        // write to the exact `isArchived`/`isActive` values the guards saw
        // makes that transition impossible rather than merely unlikely.
        //
        // `updateMany`, not `update`, because `update` throws P2025 when
        // nothing matches and a CAS miss is an ordinary outcome here, not an
        // exception — see the miss branch below for the three things it can
        // mean. That choice is also why this transaction no longer has a
        // P2025 source at all; the `catch` below records the full enumeration.
        const swapped = await tx.scheduleRule.updateMany({
          where: { id: template.scheduleRuleId, isArchived: false, isActive: !desiredActive },
          data: { isActive: desiredActive },
        });

        if (swapped.count === 0) {
          // A miss may or may not leave this transaction holding a lock, and
          // this plain re-read is correct either way. See
          // `archiveOrUnarchiveTemplate`'s own miss branch for the full
          // account rather than repeating it here. Both rows read together
          // (issue 298): the child's existence is still what `not_found`
          // means, and the rule is what the classification below reads.
          const current = await tx.classTemplate.findUnique({
            where: { id: templateId },
            include: { scheduleRule: true },
          });
          if (!current) return { outcome: 'not_found' as const };
          // `isActive === desiredActive` before `isArchived`, deliberately —
          // the same order as the fast paths above, and for the same reason:
          // archiving forces `isActive: false`, so an archived row racing a
          // *pause* is simultaneously "already the desired state" and
          // "archived". Checking already-desired first answers that case
          // `unchanged`, matching the fast path; checking `isArchived` first
          // would answer a plain pause with a 409 meant for resuming an
          // archived template. A racing *resume* is not already-desired, so it
          // falls through regardless of order.
          if (current.scheduleRule.isActive === desiredActive) {
            return { outcome: 'unchanged' as const, template: withSlot(current, current.scheduleRule) };
          }
          if (current.scheduleRule.isArchived) return { outcome: 'archived' as const };
          // Residual, and REACHABLE — measured, not merely conceded. This
          // CAS's `where` is `isArchived: false AND isActive: !desiredActive`;
          // a miss means one of those held *when the CAS ran*, and both are
          // checked above against a second, later read. Under READ COMMITTED
          // each statement takes its own snapshot, so a row that changed back
          // in between reaches here. One interleaving that does it, with the
          // `$extends` lever this file's tests already use: a resume commits
          // between this transaction's own read and its CAS (so the CAS misses
          // on `isActive`), and a pause commits before the re-read (so the
          // re-read sees neither already-desired nor archived).
          //
          // `busy`, not a throw, and the distinction is the whole point: the
          // CAS matched ZERO rows, so this transaction has written nothing and
          // rolls back clean. That is a lost race a retry wins, which is what
          // `busy` means everywhere else in this file — the route renders it
          // 503 "Nothing was changed. Wait a moment, then try again." An
          // earlier version of this branch threw here on the theory that the
          // state was a stacked race too exotic to answer; it surfaced as a
          // 500 "Internal server error" logged at `error`, the paging level,
          // for a condition `classifyApiError`'s transient branch exists to
          // demote. `archiveOrUnarchiveTemplate`'s miss branch reaches the
          // analogous fourth state and answers `unchanged` rather than
          // throwing; the two families agreeing matters more than a
          // distinction only this branch drew.
          //
          // Logged rather than silent, because `busy` now covers two causes
          // that want telling apart in production: a lock wait that timed out
          // (the `catch` below, which carries `err`) and this one, which
          // carries the observed row instead. A steady trickle here with no
          // concurrent writer would mean the CAS predicate and this
          // classification have drifted apart — the case the throw was really
          // aimed at.
          log.warn(
            {
              templateId,
              teacherId,
              target,
              observed: { isActive: current.scheduleRule.isActive, isArchived: current.scheduleRule.isArchived },
              desiredActive,
            },
            'recurring class pause/resume CAS missed and the re-read matched no classification',
          );
          return { outcome: 'busy' as const };
        }

        if (!desiredActive) {
          // `updateMany` returns a count, not a row. Safe to read back without
          // a lock re-check: the CAS above matched, so this transaction holds
          // `FOR NO KEY UPDATE` on the rule row and nothing can change or
          // delete it before we commit. `OrThrow` for that reason — a `| null`
          // here would be an impossible branch every caller had to pretend to
          // handle. `bare`, not a fresh child read: pausing writes nothing on
          // `ClassTemplate`, so the pre-transaction snapshot is still current.
          const pausedRule = await tx.scheduleRule.findUniqueOrThrow({
            where: { id: template.scheduleRuleId },
          });
          return { outcome: 'paused' as const, template: withSlot(bare, pausedRule) };
        }

        // Take the row lock before generating. The CAS above only flipped
        // `isActive`, a non-key column, so Postgres granted it `FOR NO KEY
        // UPDATE` — which does not conflict with the `FOR KEY SHARE` a
        // concurrent `Class` insert takes on this template for FK integrity.
        // Without this claim that race is live; `FOR UPDATE` makes the
        // collision impossible instead of leaving it to the generator's
        // `ON CONFLICT DO NOTHING`, which would cost that date's class with no
        // error (#116, mirroring what #94 did for the studio family).
        //
        // It also returns the row, so the generation below runs off a value
        // read under the lock rather than off the CAS's own count (#102).
        const claimed = await claimTemplateForGeneration(tx, templateId);
        if (!claimed) {
          // Genuinely unreachable, not merely believed to be. The CAS above
          // proved `isArchived: false` and set `isActive: true` in the same
          // statement that took this row's write lock, and that lock is still
          // held here — nothing can have archived, paused or deleted it since.
          // A null here would mean the claim's eligibility predicate and the
          // CAS's have drifted apart, not that a race slipped past either.
          //
          // This is the detail #116 got right for the wrong reason: it called
          // a null "a logic error rather than a race" while proposing to keep
          // the plain `update`, under which a raced archive makes null
          // legitimately reachable and this throw a 500. The CAS is what earns
          // the throw.
          throw new Error(
            `pauseOrResumeTemplate: claim returned null for template ${templateId} ` +
              "right after this transaction's own CAS confirmed it eligible — " +
              'the claim predicate and the CAS predicate have diverged',
          );
        }
        const generation = await generateInstancesForTemplate(tx, claimed);

        // `claimed.teacher`, not the CAS's own read either: the claim's
        // `findUniqueOrThrow` runs under `FOR UPDATE`, so this is the one read
        // of that column that cannot be stale, and `generateInstancesForTemplate`
        // filtered its candidate dates off this same object.
        //
        // Inside the transaction, on `tx`, and keyed to `claimed.teacher` — all
        // three deliberately, to match `pauseOrResumeStudioTemplate` rather
        // than merely resemble it.
        //
        // `claimed.teacher.defaultTimezone`, not the `template.teacher` read at
        // the top of this function. That is the studio twin's rule, and its
        // reasoning carries over unchanged: `generateInstancesForTemplate`
        // filtered its candidate dates with `classStartInstant(date,
        // startTime, claimed.teacher.defaultTimezone)` off this same object, so
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
        // `template.scheduleRule.teacher.…`.
        const today = startOfLocalDay(new Date(), claimed.scheduleRule.teacher.defaultTimezone);
        const scheduled = await tx.calendarEntry.count({
          where: scheduledWhere(claimed.scheduleRuleId, { gte: today }),
        });
        const { scheduleRule: claimedRule, ...bareT } = claimed;
        const skipCounts = countSkipReasons(generation.skipped);

        // The studio twin's line, ported — this block was rewritten by #116
        // and the warning did not come with it. The state it reports — a
        // template flagged live that produces no classes — is reachable
        // WITHOUT failing: every candidate date already holds a cancelled row,
        // so generation creates nothing and there is no throw for
        // `withErrorHandler` to classify. The teacher is told
        // (`resumeMessage`'s `scheduled === 0` branch); this carries the
        // breakdown to the operator side, which otherwise has no record that a
        // resume left the window empty. Rare enough not to be noise: it only
        // fires on a resume that filled nothing.
        if (scheduled === 0) {
          log.warn(
            { templateId, teacherId, added: generation.created, ...skipCounts },
            'recurring class template resumed live with an empty window',
          );
        }

        return {
          outcome: 'active' as const,
          template: withSlot(bareT, claimedRule),
          scheduled,
          added: generation.created,
          counts: skipCounts,
        };
      },
      // Each individual WAIT is bounded at 2s by the `setLockTimeout` at the
      // top of this transaction, so this budget does not govern any one of
      // them — but there are three that can wait (the CAS, the claim, and
      // generation's insert), so it does govern their sum, and a path that
      // waits at all three spends 6s of the 10 before doing any work at all.
      //
      // The work it was written for is the rest, and it forks. Both arms run
      // this transaction's `SET LOCAL` and the CAS. The PAUSED arm then runs
      // one further statement — its own `findUniqueOrThrow` read-back — and
      // returns; three statements, the cheap path, and a path this enumeration
      // did not mention at all. The ACTIVE arm runs the claim's `SET LOCAL`,
      // raw `SELECT` and `findUniqueOrThrow`, generation's TWO reads — its
      // date-scoped occupancy `findMany` and the `templateId`-scoped week read
      // #194 added — its batched insert, and the `count`.
      //
      // The claim's three statements joined that list in #116 and this
      // enumeration did not; the week read joined it in #194 and this
      // enumeration was visited for it; the paused arm's read-back predates
      // both and was never in it. Three by omission, not the two the sentence
      // here used to own up to — which is why it now enumerates by ARM rather
      // than as one flat list, since a flat list is what made a whole branch
      // easy to miss. The `catch` below asks whoever adds a statement to
      // update its own enumeration; this one asks the same. A loaded VPS can
      // push the work past Prisma's 5s default on its own.
      //
      // The sentence this replaces said the 5s default "would abort us
      // mid-wait". It would not, and could not: Prisma checks the budget at
      // statement boundaries, and a statement blocked inside Postgres never
      // reaches one. It was the third of three comments making that claim and
      // the one the correction wave missed.
      { timeout: 10_000 },
    );
  } catch (err: unknown) {
    // Note what this `catch` is actually attached to: the whole
    // `$transaction`, not a single statement — so it covers
    // `generateInstancesForTemplate` too. Nothing under this transaction can
    // raise P2025: the CAS returns a count, the paused arm's
    // `findUniqueOrThrow` runs after the CAS matched (under `FOR NO KEY
    // UPDATE`), `claimTemplateForGeneration`'s `findUniqueOrThrow` runs
    // under `FOR UPDATE` its own raw `SELECT` just took (so the row
    // provably exists), `generateInstancesForTemplate` issues two `findMany`s
    // — the date-scoped occupancy read and the `templateId`-scoped week read
    // #194 added — and a `createManyAndReturn` (none of the three produces
    // P2025, and the insert absorbs P2002 rather than raising it), and
    // `class.count` cannot
    // produce it. `pauseOrResumeStudioTemplate`'s catch already carries only
    // the transient branch and a rethrow; this converges on it. Add an
    // *unprotected* `findUniqueOrThrow` or single-record `update` inside
    // this transaction and that changes silently. Whoever does that owes
    // this comment an enumeration of what it now covers.
    //
    // Never `23P01` from the CAS either, and this half is worth proving
    // rather than asserting, because #196/#298 added an exclusion constraint
    // this file's other CAS does collide on. `data` up there is
    // `{ isActive: desiredActive }` — nothing else — and
    // `ScheduleRule_teacher_slot_excl` excludes on `(teacherId, dayOfWeek,
    // slot)` `WHERE isArchived = false`. None of the columns that key names is
    // in this write's `data`, so the excluded values are unchanged: a row
    // that already satisfied the constraint still does, whatever mechanism
    // Postgres uses to re-check it. That exemption is local to this write —
    // `archiveOrUnarchiveTemplate`'s CAS DOES write `isArchived`, and
    // un-archiving into a slot another live rule holds is exactly what makes
    // that one raise `23P01`. This paragraph stood in the `catch` #116
    // replaced; it is kept because deleting the P2025 branch is no reason to
    // delete the exclusion-constraint reasoning beside it, and
    // `studio-class-template-lifecycle.ts` still cites it as the original.
    if (isTransientDbError(err)) {
      log.warn(
        { err, templateId, teacherId, target },
        'recurring class pause/resume lost the template lock race',
      );
      return { ok: false, reason: 'busy' };
    }
    throw err;
  }

  switch (result.outcome) {
    case 'not_found':
      return { ok: false, reason: 'not_found' };
    case 'archived':
      return { ok: false, reason: 'archived' };
    case 'busy':
      return { ok: false, reason: 'busy' };
    case 'unchanged':
      return { ok: true, action: 'unchanged', template: result.template };
    case 'paused': {
      // `gte` today, not `gt`: this reports what is still on the schedule, and
      // today's class is still on it. Pause deletes nothing, so there is no
      // spare-today carve-out here to mirror.
      const today = startOfLocalDay(new Date(), template.scheduleRule.teacher.defaultTimezone);
      const lastScheduledRow = await db.calendarEntry.findFirst({
        where: scheduledWhere(template.scheduleRuleId, { gte: today }),
        orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
        select: { date: true, startTime: true },
      });
      const lastScheduled: LastScheduledClass | null = lastScheduledRow && {
        date: lastScheduledRow.date,
        startTime: timeToHHmm(lastScheduledRow.startTime),
      };
      return { ok: true, action: 'paused', template: result.template, lastScheduled };
    }
    case 'active':
      return {
        ok: true,
        action: 'active',
        template: result.template,
        scheduled: result.scheduled,
        added: result.added,
        counts: result.counts,
      };
    default: {
      // Throws rather than returning `unhandled`, converging on
      // `pauseOrResumeStudioTemplate`'s own default. Both are unreachable —
      // the union is internal, closed, and the `never` binding is what proves
      // a new arm cannot be forgotten — but the two failure modes are not
      // equally diagnosable if one ever is reached. Returning the internal arm
      // hands `{ outcome: … }` to the route, where `result.ok` is `undefined`,
      // every `reason` test misses, and the route's own default returns a
      // plain object where Next expects a `Response`: two silent hops and an
      // unattributable 500. This says which arm, once, at the boundary.
      const unhandled: never = result;
      throw new Error(
        `pauseOrResumeTemplate: unhandled transaction outcome ${JSON.stringify(unhandled)}`,
      );
    }
  }
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
 * That transaction takes the child's `FOR UPDATE` lock first, then runs a
 * compare-and-swap rather than a plain update, so the transition can only be
 * applied once even when two requests race — see the statement itself for
 * why the pre-transaction guard cannot do that job on its own.
 */
export async function archiveOrUnarchiveTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  target: 'archived' | 'unarchived',
): Promise<ArchiveTemplateResult> {
  const template = await db.classTemplate.findUnique({
    where: { id: templateId },
    include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
  });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.scheduleRule.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

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
  if (template.scheduleRule.isArchived === archiving) {
    const { scheduleRule, ...bare } = template;
    return { ok: true, action: 'unchanged', template: withSlot(bare, scheduleRule) };
  }

  const timeZone = template.scheduleRule.teacher.defaultTimezone;

  // Un-archiving (`archiving === false`) flips `isArchived` from `true` to
  // `false` in the CAS below — the one write in this function that can newly
  // enter `ScheduleRule_teacher_slot_excl`'s scope (`WHERE isArchived =
  // false`, #196/#298). Archiving only ever leaves that scope, which cannot
  // collide. Wrapped around the whole `$transaction`, not just the CAS
  // statement: a `23P01` raised inside a Postgres transaction aborts it, and
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

        // The child's row lock, taken explicitly and first — before the CAS
        // below touches `ScheduleRule` at all, and before the `deleteMany`
        // further down. Before issue 298 this CAS wrote `ClassTemplate`
        // directly and so held, as a side effect of a plain `updateMany`, the
        // same row `claimTemplateForGeneration` (class-generator.ts) takes
        // `FOR UPDATE` on — which is what serialised an archive against a
        // sweep in progress (#95). `isArchived`/`isActive` moved to
        // `ScheduleRule` with the rest of the calendar identity, so that CAS
        // no longer touches `ClassTemplate` at all; this statement is what
        // takes its place. See `docs/lock-order.md`, "The child row is the
        // lock node for the template families" for the decision this
        // implements, and why the lock sits on the child rather than on
        // `ScheduleRule` itself.
        //
        // Row count checked, not discarded: `ScheduleRule` carries no FK back
        // to `ClassTemplate`, so a `ClassTemplate` deleted out from under this
        // transaction leaves an orphaned rule row the CAS below would still
        // match — reachable only through a test double today (nothing in
        // `src/` deletes a `ClassTemplate`), but the CAS cannot tell that
        // apart from a real one, so the check is made here rather than relied
        // on to never come up.
        const childLock = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "ClassTemplate" WHERE "id" = ${templateId} FOR UPDATE`;
        if (childLock.length === 0) return { ok: false as const, reason: 'not_found' as const };

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
        // The contended case resolves in Postgres, not here: the loser blocks
        // inside this statement, and when the winner commits, READ COMMITTED
        // re-evaluates this WHERE against the row version the winner left
        // (EvalPlanQual). `isArchived` now equals `archiving`, the row is
        // skipped, and `count` is 0. That re-evaluation applies to the CAS
        // predicate itself only because Prisma emits this as a single `UPDATE
        // … WHERE "id" = $1 AND "isArchived" = $2` — a filter it compiled to a
        // subquery would be re-run under the same snapshot and match anyway.
        //
        // No P2025 guard here, unlike `updateClassTemplate` (#100) — and
        // unlike `pauseOrResumeTemplate` only until #116 gave it this same
        // shape, which is why the sentence below now describes both of them.
        // Not an omission: `updateMany` returns
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
        const swapped = await tx.scheduleRule.updateMany({
          where: { id: template.scheduleRuleId, isArchived: !archiving },
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
          // This read takes a fresh READ COMMITTED snapshot. Whether it also
          // runs under a lock this transaction already holds depends on which
          // interleaving produced the miss, and the re-read is correct either
          // way — which is the point, because the two differ:
          //
          //   - the conflicting change committed BEFORE this statement's own
          //     snapshot → the `where` evaluated against, and was rejected by,
          //     that already-committed version, and nothing was locked;
          //   - the conflicting change committed WHILE this statement was
          //     already blocked waiting on it → Postgres takes
          //     `LockTupleExclusive` on the newest row version *before*
          //     running the EvalPlanQual re-check, so a rejection at that
          //     point still leaves the lock held to commit.
          //
          // Settled by experiment during #94 — three Prisma connections and a
          // `FOR UPDATE NOWAIT` probe — not from the docs. The second row is
          // not exotic: it is the interleaving this repo's own three-
          // transaction race tests construct. The sentence this replaces said
          // flatly that a missed CAS "holds no lock: the CAS matched nothing,
          // so it acquired none" (#117), which invites a contributor to add a
          // read-then-write here believing the row is pinned. The reasoning
          // about whether to lock on purpose survives that correction; the
          // claim about what is already held does not.
          //
          // With three concurrent
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
          const current = await tx.classTemplate.findUnique({
            where: { id: templateId },
            include: { scheduleRule: true },
          });
          if (!current) return { ok: false as const, reason: 'not_found' as const };
          return {
            ok: true as const,
            action: 'unchanged' as const,
            template: withSlot(current, current.scheduleRule),
          };
        }

        if (!archiving) {
          // `updateMany` returns a count, not a row, and every arm of the
          // contract carries a template. Reading it back is safe here
          // specifically because the CAS above holds the rule row's lock until
          // we commit, so nothing can change or delete it in between — the same
          // lock-then-read pattern `claimTemplateForGeneration` uses, and
          // `OrThrow` for the same reason: the update just matched this row.
          //
          // A template that is no longer archived has no withdrawal to report.
          // Not a *live* one — the CAS above forced `isActive: false` in the
          // same write, so what is standing here is paused. Leaving a stale
          // count on it would be worse than having none (#97).
          const cleared = await tx.classTemplate.findUniqueOrThrow({
            where: { id: templateId },
            include: { scheduleRule: true },
          });
          return {
            ok: true as const,
            action: 'unarchived' as const,
            template: withSlot(cleared, cleared.scheduleRule),
          };
        }

        // One clock reading serves both the calendar boundary and the
        // timestamp recorded below. `CalendarEntry.date` is `@db.Date`, so both sides
        // of every comparison below are calendar dates — the comparison the
        // generator that created these rows already makes (`class-generator.ts`
        // filters on `classStartInstant`). Comparing the column to a raw
        // instant instead would, east of UTC, delete a class running that same
        // evening, and west of UTC leave tomorrow's class bookable under an
        // archived template — the exact leak #86 exists to close.
        const now = new Date();
        const today = startOfLocalDay(now, timeZone);

        // A lock is not unavailable — `POST /api/registrations` already takes
        // the `Class` row lock too, through `lockClassRow` (`db-locks.ts`) —
        // and this transaction now takes one too, immediately below.
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
        // `e.date > ${today}`, not Prisma's `date: { gt: today }` used
        // everywhere else `scheduledWhere` is called — `FOR UPDATE OF c` has
        // no query-builder equivalent, so this statement is raw SQL end to
        // end. The two forms are NOT the same comparison, and the difference
        // is worth stating precisely rather than waving through, because the
        // property this pre-lock needs is one-directional.
        //
        // `CalendarEntry.date` is `@db.Date`. Prisma's `date: { gt: today }`
        // binds a `date` parameter, so Postgres compares `date > date`. A
        // `$queryRaw` binds a JS `Date` as `timestamptz`, so this statement
        // compares `date > timestamptz`, which promotes `e.date` to an instant
        // at midnight IN THE SESSION `TimeZone`. Measured, both directions:
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
        // `withdrawWaitingEntriesForTeacher` (`waitlist.ts`), which reads its
        // write set straight out of the ids `lockClassRowsOrdered` handed back
        // — `classId: { in: classIds }`, a structural subset, not a predicate
        // re-evaluated later. (The example was the template sync's own
        // pre-lock, issue 180 task 2, until #194 deleted the function; the
        // shape outlived it.) This one instead relies on the
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
        // §7 risk 3. `withdrawWaitingEntriesForTeacher` does not share this
        // exposure, for the structural reason given above: its write set is a
        // subset of the ids the pre-lock itself returned, not a predicate
        // argument re-evaluated against whatever the table looks like when the
        // write finally runs.
        //
        // The delete cannot instead be scoped to exactly the ids this
        // pre-lock returns, the way that function's write is: that would undo the
        // wide candidate read and the survivor filter #86/#112 depend on,
        // which stay wide on purpose (see the comment above the candidate
        // read). Nor can the pre-lock be widened past `date > today` to close
        // this window — issues 86/112 require the delete's live predicate
        // re-evaluation regardless, and widening the pre-lock past `today`
        // would lock history for no gain, since a past-dated row is never a
        // delete candidate.
        //
        // VERDICT (#327): this transaction reads AND writes entry-level
        // scheduling state — the `deleteMany` below re-evaluates a predicate
        // over the entry's `date`, and the row it deletes IS the entry — so
        // the entry rows are locked here too.
        await lockClassRowsOrdered(tx, {
          join: Prisma.sql`JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"`,
          where: Prisma.sql`e."scheduleRuleId" = ${template.scheduleRuleId}
            AND e."cancelledAt" IS NULL
            AND e.date > ${today}
            AND c.status IN (${SCHEDULED_STATUSES_SQL})`,
          entries: true,
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
            class: { calendarEntry: scheduledWhere(template.scheduleRuleId, { gt: today }) },
          },
          select: {
            studentId: true,
            classId: true,
            // Type, date AND time: the notification outlives the class row with
            // a null link, so these three fields are the only identity it will
            // ever have. A student with two weekly classes needs the time. All
            // three moved to the entry in #327.
            class: {
              select: {
                calendarEntry: {
                  select: { classType: true, date: true, startTime: true },
                },
              },
            },
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
        const { count: deleted } = await tx.calendarEntry.deleteMany({
          where: scheduledWhere(template.scheduleRuleId, { gt: today }, {
            registrations: { none: { status: { in: [...CHARGED_STATUSES] } } },
          }),
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
              body: `The ${c.class.calendarEntry.classType} class on ${formatDayHeader(c.class.calendarEntry.date)} at ${timeToHHmm(c.class.calendarEntry.startTime)} has been withdrawn by your teacher. You were on its waiting list.`,
            }));
            await createBulkNotifications(tx, notifications);
          }
        }

        // `gte`, where the delete used `gt`. The delete deliberately spares a
        // class dated today — "a class hours from starting should not shift
        // under its students", which since #194 is what a template EDIT does
        // for every instance rather than only for today's: an edit moves
        // nothing at all, and this delete is the one verb left that can take a
        // generated class out from under a waiting student — so counting with
        // the delete's own boundary would exclude that
        // same survivor and tell the teacher nothing is left while the class is
        // still open on their public page.
        const remaining = await tx.calendarEntry.count({
          where: scheduledWhere(template.scheduleRuleId, { gte: today }),
        });

        // Written from the delete's own `count`, inside the same transaction, so
        // the record cannot claim a number the delete did not produce and cannot
        // survive a rollback that withdrew nothing (#97).
        //
        // A second statement rather than folded into the CAS above, on data
        // dependency alone: `deleted` does not exist until the `deleteMany` has
        // run, and the CAS runs before it. The lock ordering does not add a
        // second constraint here — the row lock the sweep serialises against
        // (#95) is the child's `FOR UPDATE`, taken explicitly before the CAS
        // even runs (see above), not the CAS's own `FOR NO KEY UPDATE` on
        // `ScheduleRule`, which the sweep never touches.
        //
        // A plain single-record `update` is enough here: the CAS's lock on the
        // rule row is still held, so nothing can have moved it since.
        // `archivedAt`/`withdrawnCount` live on `ScheduleRule` now (issue 298).
        const recordedRule = await tx.scheduleRule.update({
          where: { id: template.scheduleRuleId },
          data: { archivedAt: now, withdrawnCount: deleted },
        });

        // `template` unstripped still carries the pre-transaction
        // `scheduleRule` join `withSlot` would otherwise re-spread onto the
        // result — the archiving write touches no `ClassTemplate` column, so
        // that outer read is still current for the child half.
        const { scheduleRule: _sr, ...bareTemplate } = template;
        void _sr;
        return {
          ok: true as const,
          action: 'archived' as const,
          template: withSlot(bareTemplate, recordedRule),
          deleted,
          remaining,
        };
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
    // rethrow". It would not: `isTransientDbError` and `isExclusionConflictOn`
    // below match disjoint SQLSTATEs, and a non-match falls to the NEXT branch
    // rather than to the rethrow. Reordering these two is behaviour-neutral
    // today, and no mutation could show otherwise.
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
    // Only reachable un-archiving: `isArchived` flips false in the same CAS
    // that re-enters `ScheduleRule_teacher_slot_excl`'s scope (`WHERE
    // isArchived = false`), and another live rule — either family — can
    // already hold this slot. Neither `dayOfWeek` nor `startTime` moves here,
    // so the probe reads them straight off the pre-transaction `template`
    // read rather than merging in a PUT body the way `updateClassTemplate`'s
    // twin has to.
    //
    // Logged for the same reason the branch above is, and it predates that
    // branch only because nothing had stated the rule yet: a RETURNED
    // failure never reaches `withErrorHandler`, and `respondError` does not
    // log, so without this line an un-archive refused by the slot exclusion
    // is a 409 to the teacher and complete silence on the server.
    // `classifyApiError` logs this same `23P01` at `warn` when it escapes;
    // catching it here must not be what removes that.
    if (isExclusionConflictOn(err, 'ScheduleRule_teacher_slot_excl')) {
      const heldBy = await ruleSlotHolder(db, {
        teacherId,
        dayOfWeek: template.scheduleRule.dayOfWeek,
        startMinutes: minutesSinceMidnight(template.scheduleRule.startTime),
        durationMinutes: template.scheduleRule.durationMinutes,
        excludeRuleId: template.scheduleRuleId,
      });
      log.warn(
        { err, templateId, teacherId, heldBy },
        'recurring class un-archive refused: that slot is taken',
      );
      return { ok: false, reason: 'slot_conflict', heldBy };
    }
    throw err;
  }
}
