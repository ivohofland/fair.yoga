/**
 * Studio Class Template lifecycle — the teacher-editable boundary for
 * `PUT /api/studio-class-templates/[id]` (#114), plus pause/resume and
 * archive/un-archive for `PATCH` on the same route (#86, #98). Both of those
 * PATCH verbs run on `rule-lifecycle.ts`'s shared `archiveOrUnarchiveRule`
 * (issue 332) and `pauseOrResumeRule` (issue 336); this file supplies only the
 * `STUDIO_FAMILY` descriptor that tells them how to reach this family's rows,
 * and two thin wrappers that parameterise them with it.
 *
 * What this family does differently from the class one is therefore written in
 * that descriptor rather than in a second copy of the verb:
 *
 *   - Where the class family's deletable predicate spreads a `status: {
 *     in: ['draft', 'open'] }` clause, `STUDIO_FAMILY.deleteWhere` below —
 *     one of the predicates this file hands the shared archive — has no
 *     status to filter on. It uses `cancelledAt: null` instead — an
 *     already-cancelled class is *not* an income record: the earnings query in
 *     `src/app/(teacher)/settings/reporting/page.tsx` filters `cancelledAt:
 *     null` and leaves it out.
 *     It survives because its entry holds `(scheduleRuleId, date)`, and a
 *     date the teacher cancelled deliberately must not be refilled on the
 *     next resume.
 *     Archiving leaves it standing for that reason — structurally like the
 *     class family leaving a charged registration standing, but not for the
 *     same reason. Corrected under issue 279; see `CalendarEntry.cancelledAt`
 *     in `prisma/schema.prisma` for the cancel-versus-remove split.
 *   - Where the class family excludes any class with a registration in a
 *     CHARGED status, the studio family has no registrations to consult at
 *     all — `studentCount` is a plain, unconnected `Int?`. That is what
 *     `STUDIO_FAMILY.deleteWhere` and `STUDIO_FAMILY.withdraw: null` below
 *     record between them: nothing to exclude from the shared delete's
 *     predicate and nothing to do around the delete, so every future
 *     uncancelled studio class that predicate reaches is deletable.
 *     The shared archive still spares a class dated today and still counts
 *     `remaining` from the start of the teacher's today — the same carve-out
 *     and the same boundary the class family gets — so `remaining` is a real
 *     query on this side too, not a hardcoded 0: today's survivor is the one
 *     row it can ever find.
 *   - `STUDIO_FAMILY.claim`/`generate` name this family's generation pair
 *     (`claimStudioTemplateForGeneration`,
 *     `generateStudioInstancesForTemplate`, `studio-class-generator.ts`).
 *     The claim is what a resume takes before generating, and its own doc
 *     comment carries why that matters (#94).
 */

import type { Prisma, PrismaClient, StudioClassTemplate, ScheduleRule } from '@prisma/client';
import type { z } from 'zod';
import type { createStudioClassTemplateSchema, updateStudioClassTemplateSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { timeToHHmm, hhmmToTime } from '@/lib/time-of-day';
import { ruleSlotHolder, minutesSinceMidnight, type RuleSlotHolder } from '@/lib/rule-slot-holder';
import { isTransientDbError } from '@/lib/api-errors';
import { setLockTimeout } from '@/lib/db-locks';
import type { GenerationResult } from '@/lib/generation';
// Server-only (pino). Safe here: this module's sole importer is
// `api/studio-class-templates/[id]/route.ts`, and it already pulls `@/lib/log`
// transitively through `studio-class-generator`. No `'use client'` component
// value-imports anything in this chain.
import { log } from '@/lib/log';
import type {
  PlainUpdateForbiddenScheduleRuleField as PlainUpdateForbiddenClassRuleField,
  TeacherEditableScheduleRuleField as TeacherEditableClassRuleField,
} from './class-template-lifecycle';
import {
  STUDIO_GENERATOR,
  claimStudioTemplateForGeneration,
  generateStudioInstancesForTemplate,
} from './studio-class-generator';
import {
  archiveOrUnarchiveRule,
  pauseOrResumeRule,
  updateRule,
  type ArchiveRuleResult,
  type PauseRuleResult,
  type UpdateRuleResult,
  type TemplateFamily,
  type WithSlot,
} from './rule-lifecycle';

/**
 * The wire shape `POST /api/studio-class-templates` accepts, derived from
 * `createStudioClassTemplateSchema` rather than hand-declared — the same
 * reasoning `StudioClassTemplateUpdateData` documents below: a hand-written
 * twin would drift from the schema silently, whereas deriving keeps every
 * schema field visible to `createStudioClassTemplate`.
 */
export type CreateStudioClassTemplateInput = z.infer<typeof createStudioClassTemplateSchema>;

/**
 * The fields a teacher may change on an existing studio template — the WIRE
 * shape, spanning both `StudioClassTemplate` and `ScheduleRule` now that issue
 * 298 has split the model the schema describes.
 *
 * Derived from `updateStudioClassTemplateSchema`, not hand-declared: deriving
 * is what puts a newly added schema field into `keyof`, which is what every
 * pin below depends on. A hand-declared type would never see the offending
 * field at all.
 *
 * Needs no `Omit`/intersection of its own — every schema field maps to a
 * column of the same type somewhere, `hourlyRate: number` included, which
 * assigns to the `Decimal` column's input union directly. Measured with
 * `tsc --noEmit`, not assumed (spec, "Verified mechanics").
 * `ScheduleRuleUpdateData` and `StudioTemplateOwnUpdateData` below are the
 * `Pick`/`Omit` that route each field to its model; neither has the `date`
 * blind spot `class-lifecycle.ts` documents.
 */
export type StudioClassTemplateUpdateData = z.infer<typeof updateStudioClassTemplateSchema>;

/**
 * The wire schema sliced to the fields named in its own `Pick` below, the
 * ones that route onto `ScheduleRule` rather than `StudioClassTemplate`
 * (issue 298) — `startTime` still `"HH:MM"` here, the wire shape every
 * caller of `StudioClassTemplateUpdateData` uses. Pins below check NAMES
 * against this slice, not against the whole schema: the whole schema now
 * spans two models, so a pin comparing it to one model's columns would name
 * the other model's fields as missing forever.
 */
type ScheduleRuleUpdateData = Pick<
  StudioClassTemplateUpdateData,
  'classType' | 'dayOfWeek' | 'startTime' | 'durationMinutes'
>;

/** The wire schema sliced to what stayed on `StudioClassTemplate` — the complement of `ScheduleRuleUpdateData`. */
type StudioTemplateOwnUpdateData = Omit<
  StudioClassTemplateUpdateData,
  'classType' | 'dayOfWeek' | 'startTime' | 'durationMinutes'
>;

/**
 * Compile-time pin: every field the wire schema routes to `StudioClassTemplate`
 * must name a column `update` can write there — the write checks the types,
 * this checks the name, and only this catches a name Prisma has never heard of.
 *
 * The *Many* input is the reference deliberately, as in both class services:
 * the single-record type additionally accepts a nested relation write
 * (`studioClasses`) that a plain field update should never receive, so pinning
 * against it would wave through a schema field named after that relation.
 */
const _studioTemplateUpdateColumnsExist: NoneOf<
  Exclude<
    keyof StudioTemplateOwnUpdateData,
    keyof Prisma.StudioClassTemplateUncheckedUpdateManyInput
  >
> = true;
void _studioTemplateUpdateColumnsExist;

/**
 * The fields a teacher may change on their own studio template's own row via
 * `PUT /api/studio-class-templates/[id]`.
 *
 * The rule's own slot fields (`classType`, `dayOfWeek`, `startTime`,
 * `durationMinutes`) are NOT here (issue 298) — they left this model for
 * `ScheduleRule`, and `TeacherEditableScheduleRuleField` below is their
 * allowlist now, with the same `ScheduleRule_teacher_slot_excl` and
 * stamp-not-link consequences this docblock used to record for them here.
 */
type TeacherEditableStudioTemplateField = 'location' | 'hourlyRate';

/**
 * Compile-time pin (forward): every field the schema routes to
 * `StudioClassTemplate` must be on the allowlist. Add a column-shaped field to
 * that slice without adding it here and this names that field instead of
 * resolving to `true`.
 *
 * Forward and reverse together force the allowlist to *equal* the schema's key
 * set, so the allowlist holds no policy of its own. What it buys is that the
 * grant must be explicit — a second edit, next to the hazards above. The
 * forbidden pins below refuse the grants that are never right.
 */
const _studioTemplateFieldsArePermitted: NoneOf<
  Exclude<keyof StudioTemplateOwnUpdateData, TeacherEditableStudioTemplateField>
> = true;
void _studioTemplateFieldsArePermitted;

/**
 * Compile-time pin (reverse): every allowlist entry must still be a field the
 * schema routes to `StudioClassTemplate`, so the list cannot rot into granting
 * permission for a column that no longer flows through this route.
 *
 * Also the only pin that fires if `StudioTemplateOwnUpdateData` ever degrades
 * to `{}` or `unknown` — on an empty `keyof` the forward pin passes vacuously.
 */
const _studioTemplateAllowlistHasNoStaleFields: NoneOf<
  Exclude<TeacherEditableStudioTemplateField, keyof StudioTemplateOwnUpdateData>
> = true;
void _studioTemplateAllowlistHasNoStaleFields;

/**
 * The `StudioClassTemplate` columns the plain update path must never write.
 *
 *   - `id`             → identity
 *   - `scheduleRuleId`,
 *     `kind`           → identity, exactly like `id` (issue 298): which rule
 *                        this template belongs to. Writable here, a teacher
 *                        could re-parent their template onto another rule by
 *                        id — including, via the composite FK, one they do
 *                        not own.
 *   - `createdAt`,
 *     `updatedAt`      → Prisma-managed.
 *
 * `teacherId`, `isActive`, `isArchived`, `archivedAt` and `withdrawnCount`
 * left this model for `ScheduleRule` in issue 298 — see
 * `PlainUpdateForbiddenScheduleRuleField` below for why each is still
 * forbidden on the rule's own plain-update path; none is a
 * `StudioClassTemplate` column any more; a name here for one of them would
 * fail `_studioTemplateForbiddenColumnsExist` below rather than protect
 * anything.
 *
 * The forward and reverse pins make the allowlist mirror the schema, so the
 * quickest way to clear a forward-pin failure is to paste the offending name
 * into the allowlist — the reflexive grant #79 is about. This is the set where
 * that repair is never right.
 *
 * A runtime guard covers these already and is worth knowing about, because it
 * is weaker in exactly the way that matters: `schemas.test.ts`'s
 * `server-owned fields` register walks every exported schema and refuses
 * every name on this list. But its failure message says "add it to EXPECTED
 * with a reason" — so *its* quickest repair IS the reflexive grant. The pin
 * below is what refuses that.
 */
type PlainUpdateForbiddenStudioTemplateField = 'id' | 'scheduleRuleId' | 'kind' | 'createdAt' | 'updatedAt';

/**
 * Compile-time pin (completeness): every column on the model must be claimed by
 * one of the two lists above. Catches a deletion from either, and a column a
 * migration adds that nobody classified — checked against the live Prisma
 * type rather than a duplicated literal union.
 *
 * If a future column is legitimately neither teacher-editable nor forbidden,
 * do not paste a name into either list to silence this. Read "replaced" as
 * "given a third operand", not "deleted": add a
 * `ServerManagedStudioTemplateColumn` union and `Exclude` against
 * `Allowlist | Forbidden | ServerManaged`. That keeps completeness while
 * letting the third category exist.
 *
 * Measured, on the two single-edit escapes from a red pin here: pasting the
 * name into the ALLOWLIST does not work — the reverse pin
 * (`…AllowlistHasNoStaleFields`) fires instead, and silencing that needs a
 * second edit in `schemas.ts` which for any forbidden name also reddens the
 * `server-owned fields` register. Pasting it into the FORBIDDEN list does
 * work and leaves every other pin green. So the only one-edit escape is the
 * deny direction, which is the safe one — the cost is documentation rot, not
 * a privilege grant: the forbidden list's docblock claims every name on it is
 * owned by a guarded path, and a paste-in falsifies that with nothing
 * checking.
 */
const _studioTemplateListsPartitionTheModel: NoneOf<
  Exclude<
    keyof Prisma.StudioClassTemplateUncheckedUpdateManyInput,
    TeacherEditableStudioTemplateField | PlainUpdateForbiddenStudioTemplateField
  >
> = true;
void _studioTemplateListsPartitionTheModel;

/**
 * Compile-time pin: every name on the forbidden list must be a real
 * `StudioClassTemplate` column. Without this a typo (`isActiv`) would sit there
 * protecting nothing while looking like protection.
 *
 * Kept for substance, not only for phrasing — an earlier version of this
 * comment undersold it as a message-quality tiebreak. It is the ONLY pin that
 * observes a name ADDED to the forbidden list that is not a column. Every
 * other pin either has the forbidden list on the excluding side of an
 * `Exclude` (the partition pin) or never mentions it at all, so junk added
 * here is invisible to all five. Measured: adding `'publishedAt'` to the list
 * below leaves the partition pin and both allowlist pins green and fails only
 * this one. Delete it and that mutation goes silent.
 *
 * A typo does trip both, and there the messages differ usefully: this one says
 * "`isActiv` is not a column", the partition pin says "`isActive` is
 * unclassified", and the first points at the fix.
 */
const _studioTemplateForbiddenColumnsExist: NoneOf<
  Exclude<
    PlainUpdateForbiddenStudioTemplateField,
    keyof Prisma.StudioClassTemplateUncheckedUpdateManyInput
  >
> = true;
void _studioTemplateForbiddenColumnsExist;

/**
 * Compile-time pin (forbidden): no forbidden column may appear on the
 * allowlist. Fails on a const whose name carries the reason, because the const
 * name is the part of a type error people actually read.
 */
const _studioTemplateAllowlistHasNoForbiddenFields: NoneOf<
  Extract<TeacherEditableStudioTemplateField, PlainUpdateForbiddenStudioTemplateField>
> = true;
void _studioTemplateAllowlistHasNoForbiddenFields;

// ---------------------------------------------------------------------------
// The rule half of the partition (issue 298)
//
// `updateStudioClassTemplate`'s wire schema spans two models now: the
// economics (`location`, `hourlyRate`) stayed on `StudioClassTemplate`
// (pinned above), the slot fields moved to `ScheduleRule`. Mirrors the pin
// set above, against `keyof Prisma.ScheduleRuleUncheckedUpdateManyInput`
// rather than `StudioClassTemplate`'s. Deliberately the same names as
// `class-template-lifecycle.ts`'s twin set — separate modules, so no
// collision, and the two families should read side by side.
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
 * The rule fields a teacher may change through
 * `PUT /api/studio-class-templates/[id]` — the slot half of the wire schema
 * (issue 298).
 *   - `dayOfWeek`, `startTime` → both feed
 *     `ScheduleRule_teacher_slot_excl` (`(teacherId, dayOfWeek, slot) WHERE
 *     isArchived = false`, #196/#298), so editing either can collide with
 *     another of this teacher's live rules — either family, since `kind` is
 *     not part of that constraint's key.
 *   - `dayOfWeek` additionally → generated `StudioClass` rows are NOT moved or
 *     withdrawn, so an edit leaves up to four weeks of classes on the
 *     superseded weekday — the decided rule since #194, not a gap.
 *
 * One rule model, shared by both families — `_ruleAllowlistsAgree` below pins
 * this list against the class family's own copy directly, the same way
 * `_ruleForbiddenListsAgree` pins the forbidden halves further down.
 */
type TeacherEditableScheduleRuleField =
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
 * Compile-time pin: the two families' rule-level ALLOWED lists must be the
 * same set. This does not add a new constraint — the forbidden halves are
 * already pinned equal by `_ruleForbiddenListsAgree`, and each family's own
 * allow/forbidden pair already partitions the same `ScheduleRule` columns
 * (`_scheduleRuleListsPartitionTheModel` in both files), so the allow halves
 * are already forced equal algebraically. It exists so a reader does not have
 * to do that algebra to know the two allowlists cannot silently diverge.
 * `Exclude` in both directions, matching `_ruleForbiddenListsAgree`, because a
 * one-way check passes when one list is a strict subset of the other.
 */
const _ruleAllowlistsAgree: NoneOf<
  | Exclude<TeacherEditableScheduleRuleField, TeacherEditableClassRuleField>
  | Exclude<TeacherEditableClassRuleField, TeacherEditableScheduleRuleField>
> = true;
void _ruleAllowlistsAgree;

/**
 * The `ScheduleRule` columns the plain update path must never write.
 *
 *   - `id`, `teacherId`, `kind` → identity/ownership.
 *   - `isActive`       → `PATCH ?state=active|paused`, which flips it inside a
 *                        transaction that also takes the generation claim and
 *                        generates the window (#94, #120). A bare flip to
 *                        `true` would mark a template active with no window.
 *   - `isArchived`     → `PATCH ?state=archived`, which also forces
 *                        `isActive: false`. Writing it alone can produce the
 *                        archived-but-active state `PATCH` refuses to create,
 *                        and moves the row in and out of
 *                        `ScheduleRule_teacher_slot_excl`'s scope without the
 *                        conflict handling that owns it.
 *   - `archivedAt`,
 *     `withdrawnCount` → written only by the same archive transaction that
 *                        owns `isArchived` (#97, #111).
 *   - `live`           → generated mirror of `isActive && !isArchived`
 *                        (issue 272). Postgres owns this column; a plain write
 *                        cannot set it at all.
 *   - `createdAt`,
 *     `updatedAt`      → Prisma-managed.
 *
 * One rule model, shared by both families — `_ruleForbiddenListsAgree` below
 * pins this list against the class family's own copy directly, rather than
 * this docblock asserting the two agree in prose.
 */
type PlainUpdateForbiddenScheduleRuleField =
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
 * Compile-time pin: the two families' rule-level forbidden lists must be the
 * same set. Both write the same `ScheduleRule` columns, so a name deny-listed
 * in one family and not the other would be a hole in whichever forgot it.
 * `Exclude` in both directions, because a one-way check passes when one list
 * is a strict subset of the other.
 */
const _ruleForbiddenListsAgree: NoneOf<
  | Exclude<PlainUpdateForbiddenScheduleRuleField, PlainUpdateForbiddenClassRuleField>
  | Exclude<PlainUpdateForbiddenClassRuleField, PlainUpdateForbiddenScheduleRuleField>
> = true;
void _ruleForbiddenListsAgree;

/**
 * Compile-time pin (completeness): every `ScheduleRule` column must be
 * claimed by the allowlist or the forbidden list above — checked against the
 * live Prisma type, so a migration that adds an unclassified column reddens
 * this rather than passing silently.
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
 * `StudioClassTemplate` with the rule's columns flattened back on, in the
 * wire shape every caller already expects: `startTime` as `"HH:MM"` (design
 * §6), not the `@db.Time` `Date` `ScheduleRule` stores it as (issue 298).
 *
 * Every result type below carries this rather than a bare
 * `StudioClassTemplate`, because the route spreads the template straight onto
 * the response body and the wire consumers on the other end still expect
 * these columns to be there, which the row itself no longer has. The class
 * family's `ClassTemplateWithSlot` (`class-template-lifecycle.ts`) is the
 * same shape one model over — and, like this one, an alias of `WithSlot`
 * (`rule-lifecycle.ts`) rather than a hand-written copy of its columns: the
 * shared archive's result type is spelled in `WithSlot` too, so a column
 * added there and not here would compile (a wider object satisfies a
 * narrower declared return) and reach the wire unnoticed.
 */
export type StudioClassTemplateWithSlot = WithSlot<StudioClassTemplate>;

/**
 * Flattens a rule's columns onto its child, converting `startTime` to the
 * wire's `"HH:MM"`. Exported for the two GET routes' own reads
 * (`GET /api/studio-class-templates`, `GET /api/studio-class-templates/[id]`),
 * which need the same flattening this file's writes do. The `POST` create no
 * longer calls this from the route — `createStudioClassTemplate` below calls
 * it itself, inside the service, like every other writer in this file.
 */
export function withSlot(template: StudioClassTemplate, rule: ScheduleRule): StudioClassTemplateWithSlot {
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
 *
 * Aliased to `UpdateRuleResult` (`rule-lifecycle.ts`), parameterised by `StudioClassTemplate`.
 */
export type UpdateStudioClassTemplateResult = UpdateRuleResult<StudioClassTemplate>;

/**
 * Applies a teacher's edit to their own studio template.
 *
 * Runs on `updateRule` in `rule-lifecycle.ts` parameterised by `STUDIO_FAMILY` (issue 284 / stage C2).
 */
export function updateStudioClassTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  data: StudioClassTemplateUpdateData &
    Partial<Record<PlainUpdateForbiddenStudioTemplateField, never>> &
    Partial<Record<PlainUpdateForbiddenClassRuleField, never>>,
): Promise<UpdateStudioClassTemplateResult> {
  return updateRule(db, STUDIO_FAMILY, templateId, teacherId, data);
}

/**
 * The studio family at `PauseRuleResult` (`rule-lifecycle.ts`), where every
 * arm's reasoning lives.
 */
export type PauseStudioTemplateResult = PauseRuleResult<StudioClassTemplate>;

/**
 * The studio family at `ArchiveRuleResult` (`rule-lifecycle.ts`), where every
 * arm's reasoning lives.
 */
export type ArchiveStudioTemplateResult = ArchiveRuleResult<StudioClassTemplate>;

/**
 * Studio entries still on the schedule for a template, from the given
 * calendar-date boundary onward. The studio analogue of `scheduledWhere` in
 * `class-template-lifecycle.ts`, and since #327 the two differ only in the
 * class-side conjunct that family adds: liveness is one column on the shared
 * `CalendarEntry` for both.
 *
 * A `CalendarEntry` predicate, not a `StudioClass` one, and the shift is not
 * cosmetic: THE ARCHIVE'S DELETE HAS TO DELETE THE ENTRY. Deleting the
 * `StudioClass` alone would leave its entry standing, still holding
 * `(scheduleRuleId, date)` against the hourly sweep and still occupying the
 * slot. Cascade runs the other way (`StudioClass.calendarEntry` is
 * `onDelete: Cascade`), so deleting the entry takes the class with it.
 *
 * The boundary is a parameter for the same reason as there: the delete uses
 * `gt` (today's class is spared) and the counts use `gte` (today's class is
 * the survivor they must report), against a calendar date from
 * `startOfLocalDay` rather than a raw instant.
 *
 * `kind: 'studio'` IS NOT DECORATION, and the class-family twin is why it looks
 * like one. That predicate restricts to `kind = 'regular'` structurally, via
 * the `classes: { some: { status: … } }` conjunct it needs anyway; this one has
 * no such conjunct — `StudioClass` has no status to filter on — so without the
 * word it restricts to nothing but the rule and the date. It then feeds a hard
 * `deleteMany` that cascades `CalendarEntry -> Class ->
 * Registration/Payment/WaitlistEntry`.
 *
 * What made that safe was a property of ANOTHER file: the generator
 * (`generateEntriesForRule`, `entry-generation.ts`) takes `scheduleRuleId`
 * from a template it already holds, so a rule's `kind` and its entries'
 * always agree. `CalendarEntry.scheduleRuleId`'s own docblock
 * records that the schema does NOT enforce it (issue 328) and says outright:
 * "Anyone writing one is standing here: check the rule's `kind` against the
 * entry's yourself, because nothing below will." A deleting path is the last
 * place to rest on a property nothing enforces, and one word makes it immune
 * by construction instead.
 */
const scheduledWhere = (scheduleRuleId: string, date: { gt: Date } | { gte: Date }) =>
  ({
    scheduleRuleId,
    kind: 'studio',
    date,
    cancelledAt: null,
  }) satisfies Prisma.CalendarEntryWhereInput;

/**
 * The studio family's `TemplateFamily` entry (`rule-lifecycle.ts`).
 *
 * `STUDIO_GENERATOR` (`studio-class-generator.ts`) spread rather than
 * restated: it is this same family's `GeneratorFamily`, and `TemplateFamily`
 * is that type intersected with the fields only the lifecycle verbs need.
 * Everything below the spread is one of those.
 */
export const STUDIO_FAMILY: TemplateFamily<StudioClassTemplate, 'studio'> = {
  ...STUDIO_GENERATOR,
  readChild: (client, templateId) =>
    client.studioClassTemplate.findUnique({
      where: { id: templateId },
      include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
    }),
  // Whole predicates, both of them: the shared archive passes each straight to
  // its statement and composes nothing onto it. This family spares nothing
  // beyond what `scheduledWhere` above already spares — `StudioClass` has no
  // registrations to consult — so the two differ only in their boundary.
  deleteWhere: (scheduleRuleId, today) => scheduledWhere(scheduleRuleId, { gt: today }),
  standingWhere: (scheduleRuleId, today) => scheduledWhere(scheduleRuleId, { gte: today }),
  // Destructures here, where `StudioClassTemplate` is concrete, then hands
  // the bare child and the bare rule to this file's existing exported
  // `withSlot` unchanged.
  withSlot: ({ scheduleRule, ...bare }, { teacher, ...rule }) => {
    void scheduleRule;
    void teacher;
    return withSlot(bare, rule);
  },
  // The generator's own pair, assigned directly: what it claims is the same
  // joined shape `readChild` above returns, so neither needs a wrapper.
  claim: claimStudioTemplateForGeneration,
  generate: generateStudioInstancesForTemplate,
  // Required and explicitly null, not omitted. `StudioClass` has no
  // registrations and no waitlist, so there is nothing to withdraw beyond the
  // entries the shared delete already removes.
  withdraw: null,
  editNoun: 'studio template',
  validateRoom: null,
  updateChild: async (tx, templateId, childData) => {
    const writeData: Prisma.StudioClassTemplateUncheckedUpdateManyInput &
      Partial<Record<PlainUpdateForbiddenStudioTemplateField, never>> =
      childData as StudioTemplateOwnUpdateData;
    return tx.studioClassTemplate.update({
      where: { id: templateId },
      data: writeData,
    });
  },
};

/**
 * Archive or un-archive. Archiving withdraws this template's future studio
 * classes and leaves the rest standing (#86): generated instances sit on the
 * teacher's own schedule until removed, so without this an archived template
 * keeps up to four weeks of studio classes standing there as if still live.
 *
 * There is no booking to consult — `StudioClass` has no registrations and no
 * waitlist — so every future uncancelled class the delete's boundary can reach
 * is deletable. An already-cancelled one survives instead, because its entry
 * holds `(scheduleRuleId, date)` against the sweep refilling a date the
 * teacher cancelled deliberately.
 *
 * The update and the delete share a transaction: a half-applied archive is
 * exactly the shelved-but-listed state this exists to prevent. The mechanics
 * — the compare-and-swap, the row lock, the transient/slot-conflict handling
 * — live in `archiveOrUnarchiveRule` (`rule-lifecycle.ts`), which this
 * function only parameterises with `STUDIO_FAMILY`.
 */
export function archiveOrUnarchiveStudioTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  target: 'archived' | 'unarchived',
): Promise<ArchiveStudioTemplateResult> {
  return archiveOrUnarchiveRule(db, STUDIO_FAMILY, templateId, teacherId, target);
}

/**
 * Pause or resume generation. Deletes nothing: pausing means "no new studio
 * classes", not "withdraw what I already offered" — that is what archiving is
 * for.
 *
 * Resuming does not call `generateStudioClassInstances`; that takes no
 * `teacherId` and sweeps every active template platform-wide, across every
 * teacher, which is not something a single PATCH may do. It goes through
 * `STUDIO_FAMILY.claim`/`generate` instead — `claimStudioTemplateForGeneration`
 * and `generateStudioInstancesForTemplate` (`studio-class-generator.ts`), both
 * scoped to one template and both taking this transaction's client.
 *
 * The mechanics — the compare-and-swap, the row lock, the claim, the transient
 * handling — live in `pauseOrResumeRule` (`rule-lifecycle.ts`), which this
 * function only parameterises with `STUDIO_FAMILY`.
 */
export function pauseOrResumeStudioTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  target: 'active' | 'paused',
): Promise<PauseStudioTemplateResult> {
  return pauseOrResumeRule(db, STUDIO_FAMILY, templateId, teacherId, target);
}

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
export type CreateStudioTemplateResult =
  | { ok: true; template: StudioClassTemplateWithSlot; generation: GenerationResult }
  | { ok: false; reason: 'slot_conflict'; heldBy: RuleSlotHolder }
  | { ok: false; reason: 'busy' };

export async function createStudioClassTemplate(
  db: PrismaClient,
  teacherId: string,
  input: CreateStudioClassTemplateInput,
): Promise<CreateStudioTemplateResult> {
  let outcome:
    | { ok: true; created: StudioClassTemplateWithSlot; generation: GenerationResult }
    | { ok: false };
  try {
    outcome = await db.$transaction(async (tx) => {
      // FIRST STATEMENT, per every sibling in this file. FOUR statements in
      // this transaction can wait on a lock — this insert, the template
      // insert below, and generation's own two writes
      // (`generateEntriesForRule`'s `calendarEntry.createManyAndReturn` and
      // the `family.createChildren` call after it, which for this family is
      // `studioClass.createMany`). Every other statement that function issues
      // is a plain read, and a read waits on no lock under READ COMMITTED —
      // which is why none of them is in the sum, and why no roster of them is
      // kept here: another read cannot move this budget and another WRITE
      // must. So 4 x 2s sits inside the 10s budget with 2s of headroom; redo
      // that sum before adding a fifth waiting statement (issue 228,
      // docs/lock-order.md).
      await setLockTimeout(tx);
      const [rule] = await tx.scheduleRule.createManyAndReturn({
        data: [{
          teacherId,
          kind: 'studio' as const,
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

      const created = await tx.studioClassTemplate.create({
        data: {
          scheduleRuleId: rule.id,
          kind: 'studio',
          location: input.location,
          hourlyRate: input.hourlyRate,
        },
        include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
      });
      const generation = await generateStudioInstancesForTemplate(tx, created);
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
    // loses this service's `STUDIO_TEMPLATE_BUSY` code and its
    // create-specific "nothing was created" sentence for that net's generic,
    // code-less one (measured, this function's own mutation testing).
    //
    // Logs, like every sibling's own transient branch (#231: `classifyApiError`
    // warns when this escapes uncaught, so catching it here must not be what
    // removes that line).
    if (isTransientDbError(err)) {
      log.warn(
        { err, teacherId, classType: input.classType, dayOfWeek: input.dayOfWeek, startTime: input.startTime },
        'recurring studio class create lost a lock race — nothing committed',
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
