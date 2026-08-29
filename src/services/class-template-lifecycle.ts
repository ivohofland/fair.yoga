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
 *     needed. Scoped to `updateClassTemplate` ALONE (#100): the two shared
 *     verbs the wrappers at the foot of this file parameterise with
 *     `CLASS_FAMILY` — `archiveOrUnarchiveRule` and `pauseOrResumeRule`
 *     (`rule-lifecycle.ts`) — each use a compare-and-swap instead, because the
 *     race they close is two requests applying the same transition rather than
 *     a row disappearing. Their `updateMany` returns a count where a
 *     single-record `update` throws, so nothing under either transaction
 *     raises P2025 and each one's `not_found` comes from its CAS's miss
 *     classification; the enumeration sits with each CAS.
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient, ClassTemplate, ScheduleRule, ClassStatus } from '@prisma/client';
import type { z } from 'zod';
import type { createClassTemplateSchema, updateClassTemplateSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { classStartInstant } from '@/lib/timezone';
import { timeToHHmm, hhmmToTime } from '@/lib/time-of-day';
import { formatDayHeader } from '@/lib/format';
import { isExclusionConflictOn } from '@/lib/exclusion-conflict';
import { ruleSlotHolder, minutesSinceMidnight, type RuleSlotHolder } from '@/lib/rule-slot-holder';
import { isTransientDbError } from '@/lib/api-errors';
import { lockClassRowsOrdered, setLockTimeout } from '@/lib/db-locks';
// Server-only (pino). Safe here: this module's sole importer is
// `api/class-templates/[id]/route.ts`, and it already pulls `@/lib/log`
// transitively through `class-generator`. No `'use client'` component
// value-imports anything in this chain.
import { log } from '@/lib/log';
import { createBulkNotifications, type CreateNotificationInput } from './notifications';
import {
  CLASS_GENERATOR,
  generateInstancesForTemplate,
  claimTemplateForGeneration,
} from './class-generator';
import { getNextOccurrences, DEFAULT_WEEKS, probeFirstEffectiveWeek } from './entry-generation';
import { CHARGED_STATUSES } from './class-lifecycle';
import type { GenerationResult } from '@/lib/generation';
import {
  templateGenerationState,
  type TemplateGenerationState,
} from '@/lib/template-selection';
import {
  archiveOrUnarchiveRule,
  pauseOrResumeRule,
  type ArchiveRuleResult,
  type PauseRuleResult,
  type TemplateFamily,
  type WithSlot,
} from './rule-lifecycle';

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
 *   - `roomArchived`   → the issue 272 room mirror. Written only at the create
 *                        and move sites in this module, which assert or mirror
 *                        the room's `isArchived` explicitly — never by a plain
 *                        edit that could detach the child from its parent.
 *   - `ruleLive`       → the issue 272 rule mirror. Written by NOTHING in
 *                        `src/`: `ON UPDATE CASCADE` from `ScheduleRule.live`
 *                        maintains it, and the composite key refuses a row
 *                        that claims a value its rule does not hold. It is on
 *                        this list so a plain edit cannot start.
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
  | 'roomArchived'
  | 'ruleLive'
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
 *   - `live` → generated mirror of `isActive && !isArchived` (issue 272).
 *              Postgres owns this column; a plain write cannot set it at all.
 *   - `createdAt`, `updatedAt` → Prisma-managed.
 *
 * `isActive` is the entry that matters most here: it is what stops a `PUT`
 * flipping a template active, which would bypass the transaction-and-generate
 * path `PATCH` owns and door 3's resume refusal with it. Both doors changed in
 * issue 272: door 3's service guard is gone, the constraint enforces it, and
 * door 5's route pre-check now gates on `ruleLive` — which is
 * `isActive AND NOT isArchived`, so it DOES turn on liveness, deliberately,
 * because a PAUSED template may legitimately move onto an archived room. What
 * is unchanged is why `isActive` sits on this list: a bare `PUT` flip to
 * `true` would still mark a template active with no instance window.
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
  | 'live'
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
 *
 * An alias of `WithSlot` (`rule-lifecycle.ts`) rather than a third hand-written
 * copy of the same columns: the shared archive's result type is spelled in
 * `WithSlot` too, so a column added there and not here would compile — a wider
 * object satisfies a narrower declared return — and reach the wire unnoticed.
 */
export type ClassTemplateWithSlot = WithSlot<ClassTemplate>;

/**
 * Flattens a rule's columns onto its child, converting `startTime` to the
 * wire's `"HH:MM"`. Exported for the two GET routes' own reads
 * (`GET /api/class-templates`, `GET /api/class-templates/[id]`), which need
 * the same flattening this file's writes do. The `POST` create no longer
 * calls this from the route — `createClassTemplate` below calls it itself,
 * inside the service, like every other writer in this file.
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
       * of a teacher. The conversion happens in the service layer —
       * `probeFirstEffectiveWeek` (`entry-generation.ts`) returns the Monday,
       * so this field is already one — rather than in the copy layer, because
       * `mondayOf` lives in `@/lib/timezone`, which imports pino, and
       * `template-action-messages.ts` is value-imported by a `'use client'`
       * component.
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
 * this would read it. The `catch` sits OUTSIDE the `$transaction` call, the
 * same shape `archiveOrUnarchiveRule` (`rule-lifecycle.ts`) and
 * `POST /api/class-templates` already use: a failed statement aborts a
 * Postgres transaction, so there is nothing to catch from within, and the whole
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
  let targetRoomIsArchived: boolean | undefined;
  if (data.teacherRoomId !== undefined) {
    const teacherRoom = await db.teacherRoom.findUnique({ where: { id: data.teacherRoomId } });
    if (!teacherRoom || teacherRoom.teacherId !== teacherId) {
      return { ok: false, reason: 'invalid_room' };
    }
    // Captured, not consulted as a door: issue 272 moved this refusal to the
    // constraint (`ClassTemplate_live_needs_open_room` / the room mirror's
    // foreign key), and this value is written into the child below so the
    // mirror stays equal to the target room. The route answers the 409 the
    // guard used to.
    targetRoomIsArchived = teacherRoom.isArchived;
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
        // writer of this template's lifecycle or calendar columns takes this
        // same lock as its own first statement — both shared verbs
        // (`archiveOrUnarchiveRule` and `pauseOrResumeRule`,
        // `rule-lifecycle.ts`) — so this one has to as well: `classType`,
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

        // The mirror is written, not defaulted: moving to a different room
        // means the child's `roomArchived` must equal that room's `isArchived`
        // or the composite foreign key refuses the row. A PAUSED template may
        // legitimately move onto an archived room, so this cannot assert
        // `false` the way the create path does.
        //
        // Gated on a CHANGE of room, for the same reason the route's pre-check
        // gates there: `TemplateForm` posts `teacherRoomId` on every edit, and
        // writing the mirror on a no-op would trip the room CHECK for a
        // pre-branch snapshot whose own room is archived and live. The mirror
        // is a property of the room binding; it moves with the binding only.
        const updatedChild = await tx.classTemplate.update({
          where: { id: templateId },
          data: {
            ...childData,
            ...(data.teacherRoomId !== undefined && data.teacherRoomId !== template.teacherRoomId
              ? { roomArchived: targetRoomIsArchived }
              : {}),
          },
        });

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
    // Transient first, matching the order the shared verbs
    // (`archiveOrUnarchiveRule` and `pauseOrResumeRule`, `rule-lifecycle.ts`)
    // use. Not correctness-critical here — `isTransientDbError`'s codes are
    // disjoint from P2025 and from the exclusion constraint's `23P01` below, so a
    // transient error could not fall into either of those branches even
    // checked last — but kept first anyway so a reader does not have to
    // re-derive that at every template lifecycle function this helper guards.
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
    // ONE branch, because issue 298 replaced the two DB objects that used to
    // sit here — one per family — with the single exclusion constraint below.
    // A `23P01` cannot say which family it refused, so `ruleSlotHolder` probes
    // `ScheduleRule` itself to answer that; do not split this back into a
    // per-family pair of error tests, there is only one raiser to match.
    // LOGGED for the reason the shared
    // archive's own `23P01` branch gives (`archiveOrUnarchiveRule`,
    // `rule-lifecycle.ts`): a returned failure never reaches
    // `withErrorHandler`, so catching here is what would otherwise remove the
    // server-side record.
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
      generationState === 'active'
        ? await probeFirstEffectiveWeek(db, updated, horizon, 'recurring class')
        : null,
    generationState,
  };
}

// ---------------------------------------------------------------------------
// Pause / resume and archive / un-archive (#86)
// ---------------------------------------------------------------------------

/**
 * The class family at `PauseRuleResult` (`rule-lifecycle.ts`), where every
 * arm's reasoning lives.
 */
export type PauseTemplateResult = PauseRuleResult<ClassTemplate>;

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
 * The recurring-class family's `TemplateFamily` entry (`rule-lifecycle.ts`).
 *
 * `CLASS_GENERATOR` (`class-generator.ts`) spread rather than restated: it is
 * this same family's `GeneratorFamily`, and `TemplateFamily` is that type
 * intersected with the fields only the lifecycle verbs need. Everything below
 * the spread is one of those.
 */
export const CLASS_FAMILY: TemplateFamily<ClassTemplate, 'regular'> = {
  ...CLASS_GENERATOR,
  readChild: (client, templateId) =>
    client.classTemplate.findUnique({
      where: { id: templateId },
      include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
    }),
  // Whole predicates, both of them: the shared archive passes each straight to
  // its statement and composes nothing onto it. So the charged-registration
  // conjunct is applied by the same expression that chooses it, and nothing
  // crosses the boundary for the other side to drop.
  //
  // "Nobody booked" means no registration in a CHARGED status — deliberately
  // not `settingsLocked` (which answers whether the price may change, and
  // stays true forever) and not `ACTIVE_REGISTRATION_STATUSES` (which excludes
  // `late_cancel`, so a class a student still owes for would be cascaded
  // away).
  deleteWhere: (scheduleRuleId, today) =>
    scheduledWhere(
      scheduleRuleId,
      { gt: today },
      { registrations: { none: { status: { in: [...CHARGED_STATUSES] } } } },
    ),
  standingWhere: (scheduleRuleId, today) => scheduledWhere(scheduleRuleId, { gte: today }),
  // Destructures here, where `ClassTemplate` is concrete, then hands the bare
  // child and the bare rule to this file's existing exported `withSlot`
  // unchanged.
  withSlot: ({ scheduleRule, ...bare }, { teacher, ...rule }) => {
    void scheduleRule;
    void teacher;
    return withSlot(bare, rule);
  },
  // The generator's own pair, assigned directly: what it claims is the same
  // joined shape `readChild` above returns, so neither needs a wrapper.
  claim: claimTemplateForGeneration,
  generate: generateInstancesForTemplate,
  withdraw: {
    around: async (tx, { scheduleRuleId, today }, deleteEntries) => {
      // A lock is not unavailable — `POST /api/registrations` already takes
      // the `Class` row lock too, through `lockClassRow` (`db-locks.ts`) —
      // and this transaction now takes one too, immediately below.
      // The candidate read further down is NOT what the pre-lock replaces:
      // for NOTIFICATION correctness a read is better than a lock, and that
      // read is still here, still needed. The pre-lock buys something a read
      // cannot buy at any price: a
      // CANONICAL LOCK ORDER. `deleteStudentAccount` (`gdpr.ts`) takes its
      // `Class` row locks ascending by id; this function's `deleteMany`
      // below takes them in heap order, whatever order Postgres's planner
      // visits matching rows in — never the read's order, and not
      // controllable by sorting anything in JS. Two rows, opposite orders,
      // one AB-BA cycle (issue 180, reproduced and recorded when the issue
      // was filed). Ordering this function's locks ascending, before either the
      // read or the delete, is what closes it, and the cost is real: an
      // archive blocks booking on this template's future classes for its
      // duration, bounded by the 2s `SET LOCAL lock_timeout` at the head of
      // this transaction and its 10s budget.
      //
      // What a `40P01` out of THIS family's archive most likely means, which
      // belongs beside the statement that decides it. The AB-BA cycle against
      // `deleteStudentAccount` argued above was reproduced (issue 180), and
      // the pre-lock below is what closed it — except through the narrow
      // window recorded further down, which is still open. The other lock
      // case, an archive queued behind the generation sweep's claim, has no
      // cycle at all and ends in `55P03`. So a deadlock here now points at
      // that window, or at the still-open `{Class, ClassTemplate}` ordering
      // question this hook is one side of (`docs/lock-order.md`, "Known
      // violation, not fixed here"; the decision is issue #229) — an
      // unresolved disagreement, never itself reproduced as a live deadlock —
      // rather than at the pairing this pre-lock already handles.
      // `ArchiveRuleResult`'s `busy` arm (`rule-lifecycle.ts`) lists the codes
      // that reach it; this calibration sits here instead, because a family
      // whose `withdraw` is null takes none of these locks.
      //
      // Ordered pre-lock (issue 180 task 4). Deliberately the FULL
      // `scheduledWhere(scheduleRuleId, { gt: today })` set — every scheduled
      // future class of this template — not narrowed by the
      // `registrations: { none: … }` conjunct `deleteWhere` above carries.
      // The shared `deleteMany` this hook brackets re-evaluates its predicate
      // at execution time (deliberately — see its own comment in
      // `rule-lifecycle.ts`, which this does not change), so ANY
      // candidate may still match and must already be held before that
      // statement runs. Narrowing this set to only the deletable rows would
      // leave a candidate the delete's re-evaluation pulls into scope
      // unlocked, and the cycle returns — measured, not just reasoned.
      // `template-lock-order.test.ts`'s deadlock fixtures cannot show this
      // (they hold no `Registration` row at all, so a narrower clause would
      // be vacuously true for both their candidate classes and coincide with
      // this wide one). The fixture that can is in that same file, under
      // "does not deadlock when the archive pre-lock must cover a class that
      // only becomes deletable mid-transaction": one
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
      // That is NOT the same as lock ⊇ delete being total: more than one
      // writer can add a row to the set after the pre-lock runs, and only
      // some of them are stopped. The generation sweep is one
      // such writer and genuinely cannot: it serialises on the same
      // `ClassTemplate` row the archive's child `FOR UPDATE` already holds —
      // that statement, and the #95 reasoning for it, are in
      // `archiveOrUnarchiveRule` (`rule-lifecycle.ts`), not the CAS, which
      // writes `ScheduleRule` and which no sweep touches. But it is not the
      // only one. `updateClass` (`class-lifecycle.ts`) issues a bare
      // `db.class.updateMany({ where:
      // { id } })` with `date` in its teacher-editable set, taking neither
      // the `ClassTemplate` lock nor any `Class` lock this pre-lock holds.
      // A same-day instance — outside `e.date > ${today}` above, so never
      // locked here — rescheduled into the future between this pre-lock
      // and the `deleteMany` below (whose predicate is re-evaluated at
      // execution time, by design — see its own comment in
      // `rule-lifecycle.ts`) can still be matched and deleted without ever
      // having been held by this
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
        where: Prisma.sql`e."scheduleRuleId" = ${scheduleRuleId}
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
          class: { calendarEntry: scheduledWhere(scheduleRuleId, { gt: today }) },
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
              calendarEntry: { select: { classType: true, date: true, startTime: true } },
            },
          },
        },
      });

      await deleteEntries();

      // `candidates` is an ordinary local here — the reason this hook is one
      // function rather than two. It was read before the delete; the survivors
      // are read after it, and the difference is who gets told.
      //
      // Which candidates' classes actually went. `deleteMany` returns a count,
      // not ids, and its predicate was re-evaluated at execution time — so
      // this read, not the candidate read, is what says who was withdrawn.
      //
      // Notifying from `candidates` alone would be simpler and wrong: a
      // booking landing between the two statements spares that class, and its
      // waiter would be told the class was withdrawn while their entry is
      // still `waiting` and the class is still open on the teacher's page — a
      // message the app itself contradicts.
      if (candidates.length === 0) return;
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
      if (withdrawn.length === 0) return;
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
    },
  },
};

/**
 * The class family at `ArchiveRuleResult` (`rule-lifecycle.ts`), where every
 * arm's reasoning lives.
 */
export type ArchiveTemplateResult = ArchiveRuleResult<ClassTemplate>;

/**
 * Archive or un-archive. Archiving withdraws the future classes nobody booked
 * and leaves the rest standing (#86): generated instances are created `open`
 * and the public booking page filters on status and date without consulting
 * the template, so without this an archived template keeps up to four weeks of
 * classes publicly bookable.
 *
 * "Nobody booked" is the charged-registration conjunct in
 * `CLASS_FAMILY.deleteWhere` above, which also names the two status sets it is
 * deliberately not.
 *
 * The update and the delete share a transaction: a half-applied archive is
 * exactly the shelved-but-bookable state this exists to prevent.
 */
export function archiveOrUnarchiveTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  target: 'archived' | 'unarchived',
): Promise<ArchiveTemplateResult> {
  return archiveOrUnarchiveRule(db, CLASS_FAMILY, templateId, teacherId, target);
}

/**
 * Pause or resume generation. Deletes nothing: pausing means "no new classes",
 * not "withdraw what I already offered" — that is what archiving is for.
 *
 * Resuming does not call `generateClassInstances`; that takes no `teacherId`
 * and sweeps every active template platform-wide, across every teacher, which
 * is not something a single PATCH may do. It goes through
 * `CLASS_FAMILY.claim`/`generate` instead — `claimTemplateForGeneration` and
 * `generateInstancesForTemplate` (`class-generator.ts`), both scoped to one
 * template and both taking this transaction's client.
 *
 * The mechanics — the compare-and-swap, the row lock, the claim, the transient
 * handling — live in `pauseOrResumeRule` (`rule-lifecycle.ts`), which this
 * function only parameterises with `CLASS_FAMILY`.
 */
export function pauseOrResumeTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  target: 'active' | 'paused',
): Promise<PauseTemplateResult> {
  return pauseOrResumeRule(db, CLASS_FAMILY, templateId, teacherId, target);
}

/**
 * The wire shape `POST /api/class-templates` accepts, derived from
 * `createClassTemplateSchema` rather than hand-declared — the same reasoning
 * `ClassTemplateUpdateData` above documents: a hand-written twin would drift
 * from the schema silently, whereas deriving keeps every schema field
 * visible to `createClassTemplate`. The studio twin,
 * `CreateStudioClassTemplateInput`
 * (`studio-class-template-lifecycle.ts`), is the same derivation one model
 * over.
 */
export type CreateClassTemplateInput = z.infer<typeof createClassTemplateSchema>;

/**
 * A create either lands, loses the slot, or loses a contention race. The
 * `slot_conflict` arm carries `heldBy` for the same reason
 * `ArchiveTemplateResult`'s does: one exclusion constraint spans both
 * families (issue 298) and cannot say which raised it, so a fresh probe
 * answers.
 *
 * `slot_conflict` is NOT produced by catching a `23P01` here. The rule insert
 * uses `ON CONFLICT DO NOTHING`, which refuses by returning no row — the
 * deadlock-free path (issue 331). A plain INSERT inserts its tuple and THEN
 * checks the exclusion constraint, so two conflicting creates each wait on
 * the other's transaction and Postgres breaks the cycle with `40P01`.
 */
export type CreateTemplateResult =
  | { ok: true; template: ClassTemplateWithSlot; generation: GenerationResult }
  | { ok: false; reason: 'slot_conflict'; heldBy: RuleSlotHolder }
  | { ok: false; reason: 'busy' };

export async function createClassTemplate(
  db: PrismaClient,
  teacherId: string,
  input: CreateClassTemplateInput,
): Promise<CreateTemplateResult> {
  let outcome:
    | { ok: true; created: ClassTemplateWithSlot; generation: GenerationResult }
    | { ok: false };
  try {
    outcome = await db.$transaction(async (tx) => {
      // FIRST STATEMENT, per every sibling in this file. FOUR statements in
      // this transaction can wait on a lock — this insert, the template
      // insert below, and generation's own two writes
      // (`calendarEntry.createManyAndReturn` at `entry-generation.ts:814`
      // and the `family.createChildren` call after it, which for this family
      // is `class.createMany`); its two reads — the date-scoped occupancy
      // `findMany` and the `scheduleRuleId`-scoped week read — are plain
      // reads and do not wait under READ COMMITTED. So 4 x 2s sits inside
      // the 10s budget with 2s of headroom; redo that sum before adding a
      // fifth waiting statement (issue 228, docs/lock-order.md).
      await setLockTimeout(tx);
      const [rule] = await tx.scheduleRule.createManyAndReturn({
        data: [{
          teacherId,
          kind: 'regular' as const,
          classType: input.classType,
          dayOfWeek: input.dayOfWeek,
          startTime: hhmmToTime(input.startTime),
          durationMinutes: input.durationMinutes,
        }],
        skipDuplicates: true,
      });
      // No row means a constraint refused it. WHICH one is not knowable here
      // — `ON CONFLICT DO NOTHING` carries no conflict target — so the probe
      // runs below, on `db`, after this transaction has closed.
      if (!rule) return { ok: false as const };

      // Unchecked shape (`teacherRoomId` scalar), not the nested `teacherRoom:
      // { connect: … }` write #298 forced on the route's old inline
      // transaction: `scheduleRuleId` already names the just-created rule, so
      // there is no relation left that needs a nested write to establish.
      const created = await tx.classTemplate.create({
        data: {
          scheduleRuleId: rule.id,
          kind: 'regular',
          teacherRoomId: input.teacherRoomId,
          // ASSERTS the room is open rather than reading it. There is no
          // matching parent key for an archived room, so this is refused by the
          // foreign key without a read that could go stale between the two.
          roomArchived: false,
          description: input.description,
          roomCost: input.roomCost,
          minRate: input.minRate,
          targetRate: input.targetRate,
          minStudents: input.minStudents,
          maxStudents: input.maxStudents,
          cancelDeadline: input.cancelDeadline,
          autoCancelCheck: input.autoCancelCheck,
        },
        include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
      });
      const generation = await generateInstancesForTemplate(tx, created);
      const { scheduleRule, ...bare } = created;
      return { ok: true as const, created: withSlot(bare, scheduleRule), generation };
    }, { timeout: 10_000 });
  } catch (err) {
    // BEFORE any conflict check (`api-errors.ts`: `isTransientDbError` is
    // checked ahead of every other branch precisely so a non-matching check
    // placed first cannot swallow a `P2028`/`P2024` — both are
    // `PrismaClientKnownRequestError`s too, and a conflict check that matches
    // only one specific code would rethrow them straight past `busy`). An
    // error that escapes this branch still reaches a 503 —
    // `classifyApiError`'s own transient-error net (`api-errors.ts`) — but
    // loses this service's `TEMPLATE_BUSY` code and its create-specific
    // "nothing was created" sentence for that net's generic, code-less one
    // (measured, this function's own mutation testing).
    //
    // Logs, like every sibling's own transient branch (#231: `classifyApiError`
    // warns when this escapes uncaught, so catching it here must not be what
    // removes that line).
    if (isTransientDbError(err)) {
      log.warn(
        { err, teacherId, classType: input.classType, dayOfWeek: input.dayOfWeek, startTime: input.startTime },
        'recurring class create lost a lock race — nothing committed',
      );
      return { ok: false, reason: 'busy' };
    }
    throw err;
  }

  if (!outcome.ok) {
    const heldBy = await ruleSlotHolder(db, {
      teacherId,
      dayOfWeek: input.dayOfWeek,
      startMinutes: minutesSinceMidnight(hhmmToTime(input.startTime)),
      durationMinutes: input.durationMinutes,
    });
    return { ok: false, reason: 'slot_conflict', heldBy };
  }
  return { ok: true, template: outcome.created, generation: outcome.generation };
}
