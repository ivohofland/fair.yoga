/**
 * Class Template updates — the teacher-editable boundary for
 * `PUT /api/class-templates/[id]`.
 *
 * The sibling of `class-lifecycle.ts`'s update section, for the same reason
 * (#82 is #79 one route over) and with the same five pins.
 */

import type { Prisma } from '@prisma/client';
import type { z } from 'zod';
import type { updateClassTemplateSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';

/**
 * The fields a teacher may change on an existing template.
 *
 * Derived from `updateClassTemplateSchema`, not hand-declared: deriving is what
 * puts a newly added schema field into `keyof`, which is what every pin below
 * depends on. A hand-declared type would never see the offending field at all.
 *
 * Unlike `ClassUpdateData`, this needs no `Omit`/intersection — every schema
 * field maps to a column of the same type, including the two enums. That is why
 * the reverse pin here has no equivalent of the `date` blind spot documented on
 * the class route.
 */
export type ClassTemplateUpdateData = z.infer<typeof updateClassTemplateSchema>;

/**
 * Compile-time pin: every field the wire schema accepts must be a column
 * `update` can actually write on `ClassTemplate`.
 *
 * The reference is the *Many* input deliberately, as on the class route: the
 * single-record type additionally accepts nested relation writes (`classes`,
 * `teacher`, …) that a plain field update should never receive, so pinning
 * against it would wave through a schema field named after a relation.
 */
const _templateUpdateColumnsExist: NoneOf<
  Exclude<keyof ClassTemplateUpdateData, keyof Prisma.ClassTemplateUncheckedUpdateManyInput>
> = true;
void _templateUpdateColumnsExist;

/**
 * The fields a teacher may change on their own template via
 * `PUT /api/class-templates/[id]`.
 *
 * Adding a member is how a new schema field gets authorized. Three members
 * already here carry consequences beyond the template row — check what you are
 * joining before adding a fourth:
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
 * As on the class route, forward and reverse together force the allowlist to
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
