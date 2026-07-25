/**
 * Class Lifecycle State Machine — Pure logic, no side effects.
 *
 * Manages class status transitions with guards.
 * Classes move through: draft → open → in_progress → completed
 * with cancellation possible from most non-terminal states.
 * "Full" is derived (registrations >= maxStudents), not a stored state.
 */

import type { PrismaClient, Prisma, ClassStatus, RegistrationStatus, Class } from '@prisma/client';
import type { z } from 'zod';
import type { updateClassSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { calculateClassPricing } from './pricing';
import { createBulkNotifications, type CreateNotificationInput } from './notifications';

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * All valid state transitions. Terminal states (completed, cancelled)
 * have empty arrays — no transitions out.
 */
export const VALID_TRANSITIONS: Record<ClassStatus, ClassStatus[]> = {
  draft: ['open', 'cancelled'],
  open: ['in_progress', 'cancelled'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransitionResult = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Check whether a state transition is valid.
 */
export function canTransition(from: ClassStatus, to: ClassStatus): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed.includes(to);
}

/**
 * Validate a state transition, returning a typed result.
 * On failure, the error message describes the invalid transition.
 */
export function validateTransition(
  from: ClassStatus,
  to: ClassStatus,
): TransitionResult {
  if (canTransition(from, to)) {
    return { ok: true };
  }
  return {
    ok: false,
    error: `Invalid transition: cannot move from "${from}" to "${to}". Valid transitions from "${from}": [${VALID_TRANSITIONS[from].join(', ')}]`,
  };
}

// ---------------------------------------------------------------------------
// Economic field locking
// ---------------------------------------------------------------------------

/**
 * The economic fields that become immutable once settings_locked flips true
 * (i.e., after the first student registers).
 */
export const ECONOMIC_FIELDS = Object.freeze([
  'roomCost',
  'minRate',
  'targetRate',
  'minStudents',
  'maxStudents',
] as const);

export type EconomicField = (typeof ECONOMIC_FIELDS)[number];

/**
 * Whether economic fields are locked for editing.
 * Locked once the first registration is created (settingsLocked = true).
 */
export function isEconomicFieldLocked(settingsLocked: boolean): boolean {
  return settingsLocked;
}

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------

export type TransitionDbResult =
  | { ok: true; newStatus: ClassStatus }
  | { ok: false; error: string };

/**
 * Transition a class to a new status in the database.
 * Validates the transition against the state machine before applying.
 */
export async function transitionClass(
  db: PrismaClient,
  classId: string,
  targetStatus: ClassStatus,
): Promise<TransitionDbResult> {
  const cls = await db.class.findUnique({ where: { id: classId } });
  if (!cls) return { ok: false, error: `Class not found: ${classId}` };

  const validation = validateTransition(cls.status, targetStatus);
  if (!validation.ok) return validation;

  await db.class.update({ where: { id: classId }, data: { status: targetStatus } });
  return { ok: true, newStatus: targetStatus };
}

// ---------------------------------------------------------------------------
// Class completion
// ---------------------------------------------------------------------------

/** Registration statuses that are charged when a class completes. */
const CHARGED_STATUSES: RegistrationStatus[] = ['registered', 'attended', 'no_show', 'late_cancel'];

/**
 * Complete a class: validate transition, calculate pricing, update
 * registrations with prices, and create pending payments.
 *
 * Wrapped in a transaction so that all DB mutations (class status,
 * registration prices, payment creation) succeed or fail atomically.
 */
export async function completeClass(
  db: PrismaClient,
  classId: string,
): Promise<TransitionDbResult> {
  return db.$transaction(async (tx) => {
    const cls = await tx.class.findUnique({
      where: { id: classId },
      include: { registrations: true },
    });
    if (!cls) return { ok: false, error: `Class not found: ${classId}` };

    // If open, transition to in_progress first (teacher completing directly)
    if (cls.status === 'open') {
      const toInProgress = validateTransition('open', 'in_progress');
      if (!toInProgress.ok) return toInProgress;
      await tx.class.update({ where: { id: classId }, data: { status: 'in_progress' } });
    } else {
      const validation = validateTransition(cls.status, 'completed');
      if (!validation.ok) return validation;
    }

    const chargedRegistrations = cls.registrations.filter((r) =>
      CHARGED_STATUSES.includes(r.status),
    );

    if (chargedRegistrations.length === 0) {
      await tx.class.update({
        where: { id: classId },
        data: { status: 'completed', effectiveTeacherRate: 0, totalStudents: 0, totalRevenue: 0 },
      });
      return { ok: true, newStatus: 'completed' as ClassStatus };
    }

    const pricing = calculateClassPricing({
      roomCost: Number(cls.roomCost),
      minRate: Number(cls.minRate),
      targetRate: Number(cls.targetRate),
      minStudents: cls.minStudents,
      maxStudents: cls.maxStudents,
      studentTiers: chargedRegistrations.map((r) => r.tierAtBooking),
    });

    await tx.class.update({
      where: { id: classId },
      data: {
        status: 'completed',
        effectiveTeacherRate: pricing.effectiveTeacherRate,
        totalStudents: pricing.studentCount,
        totalRevenue: pricing.totalCost,
      },
    });

    for (let i = 0; i < chargedRegistrations.length; i++) {
      const reg = chargedRegistrations[i]!;
      await tx.registration.update({
        where: { id: reg.id },
        data: { price: pricing.studentPrices[i]!, tierRatio: pricing.studentTierRatios[i]! },
      });
      await tx.payment.create({
        data: { registrationId: reg.id, amount: pricing.studentPrices[i]!, status: 'pending' },
      });
    }

    // Payments exist — now tell people about them, in the same transaction.
    // In the Level 1 model this notification IS the payment request.
    const notifications: CreateNotificationInput[] = chargedRegistrations.map((reg, i) => ({
      recipientType: 'student' as const,
      recipientId: reg.studentId,
      type: 'payment_request' as const,
      title: 'Payment requested',
      body: `Your price for ${cls.classType} is €${pricing.studentPrices[i]!.toFixed(2)}. Pay your teacher directly.`,
      relatedClassId: cls.id,
    }));
    notifications.push({
      recipientType: 'teacher' as const,
      recipientId: cls.teacherId,
      type: 'payment_request' as const,
      title: 'Class completed',
      body: `${cls.classType} completed — €${(pricing.totalCost - Number(cls.roomCost)).toFixed(2)} earnings, ${chargedRegistrations.length} payment ${chargedRegistrations.length === 1 ? 'request' : 'requests'} sent.`,
      relatedClassId: cls.id,
    });
    await createBulkNotifications(tx, notifications);

    return { ok: true, newStatus: 'completed' as ClassStatus };
  });
}

// ---------------------------------------------------------------------------
// Class updates
// ---------------------------------------------------------------------------

/**
 * The fields a teacher may change on an existing class.
 *
 * Derived from `updateClassSchema` rather than hand-declared. `date` is the one
 * genuine difference — a `YYYY-MM-DD` string on the wire, a `Date` by the time
 * it reaches Prisma.
 *
 * Deriving alone buys no safety: the route builds its payload with
 * `{ ...rest }`, and spreading defeats TypeScript's excess-property check, so
 * the route itself will never flag a field added to the schema — it reaches
 * `db.class.updateMany` either way, hand-declared or derived. What deriving
 * enables is the pins below, and they are what catches it now: before them
 * adding a field to `updateClassSchema` alone left `tsc --noEmit` at exit 0
 * (that was true when this type landed, and is why #79 was filed); today the
 * allowlist pin fails the build with the field named.
 */
export type ClassUpdateData =
  Omit<z.infer<typeof updateClassSchema>, 'date'> & { date?: Date };

/**
 * Compile-time pin: every field the wire schema accepts must be a column
 * `updateMany` can actually write on `Class`.
 *
 * Because `ClassUpdateData` is derived, a new schema field lands in `keyof
 * ClassUpdateData`; if it has no matching column this alias resolves to that
 * field's name instead of `true`, and the assignment below stops compiling
 * with the offending field named in the error. A hand-declared type could not
 * do this — the unknown field would never appear in `keyof` at all.
 *
 * The reference is the *Many* input deliberately: `ClassUncheckedUpdateInput`
 * (the single-record type) additionally accepts nested relation writes
 * (`registrations`, `notifications`, …) that `updateMany` rejects, so pinning
 * against it would wave through a schema field named after a relation.
 */
// `void` because this repo's eslint `no-unused-vars` has no `varsIgnorePattern`
// — the const exists only to force the conditional type above to be evaluated.
// It is also what makes the check exist at all: a conditional type alias that
// nothing assigns is never instantiated, so deleting any of the const/void
// pairs in this section removes its pin silently, with nothing reporting the
// loss. Named for what it checks — columns exist — not for schema agreement,
// which is the pin below it.
const _classUpdateColumnsExist: NoneOf<
  Exclude<keyof ClassUpdateData, keyof Prisma.ClassUncheckedUpdateManyInput>
> = true;
void _classUpdateColumnsExist;

/**
 * The fields a teacher may change on their own class via `PUT /api/classes/[id]`.
 *
 * A pure type, not a runtime array: nothing reads this list at runtime — the
 * schema's `.strict()` already rejects undeclared keys, so this exists only to
 * feed the two pins below. Unlike `ECONOMIC_FIELDS`, which the update path
 * genuinely iterates, a runtime `as const` array here would be used solely as
 * a `typeof` source and earn an eslint suppression for the privilege.
 *
 * Adding a member is how a new schema field gets authorized: it grants write
 * access to a `Class` column that may be gated by business logic the plain
 * update path does not run. Before adding one, go read what actually guards
 * that column — none of these guards live in `updateClass`, which is the point:
 *   - `status`             → the lifecycle state machine (`VALID_TRANSITIONS`),
 *                            enforced by `validateTransition` in
 *                            `transitionClass` and `completeClass`
 *   - `settingsLocked`     → written once by the first registration
 *                            (`api/registrations/route.ts`). `updateClass` only
 *                            *reads* it, to gate `ECONOMIC_FIELDS` — so nothing
 *                            here would stop a write to the flag itself
 *   - `teacherId`          → class ownership, checked in the route
 *                            (`api/classes/[id]/route.ts`), not in this service
 *   - the financial totals → written only by `completeClass`
 * — because the compiler will not. For the columns above, the forbidden pin
 * below refuses the grant outright; for anything else, the judgement is yours.
 */
type TeacherEditableClassField =
  | 'classType'
  | 'description'
  | 'date'
  | 'startTime'
  | 'durationMinutes'
  | 'roomCost'
  | 'minRate'
  | 'targetRate'
  | 'minStudents'
  | 'maxStudents';

/**
 * Compile-time pin (forward): every field `updateClassSchema` accepts must be
 * on the teacher-editable allowlist. Add a column-shaped field to the schema
 * without adding it to the allowlist and this resolves to that field's name
 * instead of `true`, failing the build with the field named. This is the guard
 * the column pin above does NOT provide: `status` is a perfectly real, writable
 * column, so that pin waves it through.
 *
 * What it proves is narrower than "this field is permitted". Together with the
 * reverse pin it forces the allowlist to equal the schema's key set exactly, so
 * the allowlist holds no policy of its own and cannot encode "the schema has
 * `status` but a teacher may not write it" — that state does not compile. What
 * it buys is that the grant must be *explicit*: a new schema field breaks the
 * build until someone also names it above, next to the list of what else guards
 * these columns. It cannot tell a considered grant from a paste of the name the
 * error just handed you. The forbidden pin below is what refuses the grants
 * that are never right. See issue #79 for the latent `status` bypass this
 * closes — latent, because no such field is in the schema today.
 */
const _classUpdateFieldsArePermitted: NoneOf<
  Exclude<keyof ClassUpdateData, TeacherEditableClassField>
> = true;
void _classUpdateFieldsArePermitted;

/**
 * Compile-time pin (reverse): every allowlist entry must still be a field the
 * schema accepts. Remove a field from `updateClassSchema` but leave it on the
 * allowlist and this names the stale entry, so the list can't rot into granting
 * permission for a column that no longer flows through this route.
 *
 * Two things to know before deleting this as redundant paranoia:
 *   - It is the only pin that fires if `ClassUpdateData` ever degrades to `{}`
 *     or `unknown` — on an empty `keyof`, the forward pin passes vacuously.
 *     Measured across `any`, `unknown`, `{}`, `never` and an added index
 *     signature: every degradation trips the forward pin or this one, and the
 *     narrowing half is caught here alone.
 *   - It is blind to exactly one field. `date` is re-added unconditionally by
 *     the intersection in `ClassUpdateData`, so it is in `keyof` whether or not
 *     the schema declares it, and dropping `date` from the schema leaves both
 *     pins green. Covered instead by the key-set test in `schemas.test.ts`,
 *     which reads the schema object rather than a type derived from it.
 */
const _allowlistHasNoStaleFields: NoneOf<
  Exclude<TeacherEditableClassField, keyof ClassUpdateData>
> = true;
void _allowlistHasNoStaleFields;

/**
 * The `Class` columns the plain update path must never write.
 *
 * "Plain update path", not "never": each of these is owned by a different,
 * guarded route — `status` by `POST …/transition` and `completeClass`,
 * `settingsLocked` by the first registration. The pin says "not here", which is
 * why the name says it too.
 *
 * The forward and reverse pins force the allowlist to mirror the schema, which
 * means the quickest way to make a forward-pin failure go away is to paste the
 * offending field name into the allowlist — exactly the reflexive grant #79 is
 * about. This list is the set where that repair is never the right one, and the
 * pin below fails on a const whose *name* carries the reason, since the name is
 * the part of a type error people actually read.
 *
 * It also changes the shape of the mistake: adding a member above is a one-line
 * edit that looks like configuration, while deleting a member here reads in
 * review as what it is. Granting one of these still has an escape hatch — the
 * contributor has to remove it from this list first — and that is the point,
 * not a weakness: the guard makes the decision visible, it does not pretend to
 * be an access-control system.
 */
type PlainUpdateForbiddenClassField =
  | 'id'
  | 'teacherId'
  | 'status'
  | 'settingsLocked'
  | 'effectiveTeacherRate'
  | 'totalStudents'
  | 'totalRevenue';

/**
 * Compile-time pin: every name above must be a real `Class` column. Without
 * this, a typo (`statuss`) would sit in the forbidden list protecting nothing
 * while looking like protection — the same rot the reverse pin exists to stop,
 * one list over.
 */
const _forbiddenColumnsExist: NoneOf<
  Exclude<PlainUpdateForbiddenClassField, keyof Prisma.ClassUncheckedUpdateManyInput>
> = true;
void _forbiddenColumnsExist;

/**
 * Compile-time pin (forbidden): no forbidden column may appear on the
 * teacher-editable allowlist. Fails naming the field that must not be there.
 */
const _allowlistHasNoForbiddenFields: NoneOf<
  Extract<TeacherEditableClassField, PlainUpdateForbiddenClassField>
> = true;
void _allowlistHasNoForbiddenFields;

/**
 * Thrown when `updateClass` reaches a state its own guards say cannot happen.
 * A programmer error, never a business outcome — business outcomes are values
 * of `UpdateClassResult`. Named so it is distinguishable from unrelated
 * failures in `withErrorHandler`'s catch-all.
 */
export class UpdateClassInvariantError extends Error {}

/**
 * Why an update did or did not happen.
 *
 * `locked` carries a NON-EMPTY tuple of offending fields deliberately. The bug
 * this type replaced (#72) returned a "locked" response naming no fields at
 * all, for a request that touched none — the compiler now refuses to construct
 * that. Callers own the user-facing wording; this type owns the distinction.
 *
 * Every *business* outcome of an update is a variant here. The one non-outcome
 * — an invariant violation, where the function's own reasoning about its
 * inputs turns out to be wrong — is not encoded as a value; it throws
 * `UpdateClassInvariantError` instead.
 */
export type UpdateClassResult =
  | { ok: true; cls: Class }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'locked'; fields: readonly [EconomicField, ...EconomicField[]] }
  | { ok: false; reason: 'no_fields' };

/**
 * Apply a partial update to a class, enforcing the economic-field lock.
 *
 * The lock is checked twice. The first check, against the row we just read, is
 * an optimisation: it answers the common case in one query instead of three.
 * The compare-and-swap inside the write is the one that matters — it catches a
 * first registration landing between that read and this write, and on its own
 * it produces the identical result, list of offending fields included.
 * Deleting the first check would cost round trips, not correctness.
 */
export async function updateClass(
  db: PrismaClient,
  classId: string,
  data: ClassUpdateData,
): Promise<UpdateClassResult> {
  const cls = await db.class.findUnique({ where: { id: classId } });
  if (!cls) return { ok: false, reason: 'not_found' };

  // Destructured rather than length-checked, so the non-empty tuple below is
  // proven to the compiler (via noUncheckedIndexedAccess) instead of asserted.
  const [firstEconomic, ...otherEconomic] = ECONOMIC_FIELDS.filter(
    (f) => data[f] !== undefined,
  );
  const sentEconomic: readonly [EconomicField, ...EconomicField[]] | null =
    firstEconomic === undefined ? null : [firstEconomic, ...otherEconomic];

  if (cls.settingsLocked && sentEconomic !== null) {
    return { ok: false, reason: 'locked', fields: sentEconomic };
  }

  // A key whose value is `undefined` is not an edit. Prisma agrees more
  // strongly than you might expect: given a `data` object whose every value is
  // undefined it issues no UPDATE at all and returns `{ count: 0 }` — with no
  // regard for whether the row exists. Testing key *presence* here (rather
  // than defined *values*, as `sentEconomic` above already does) let a
  // no-op payload reach the compare-and-swap, come back with a zero count,
  // and land in the "unreachable" branch below as a 500.
  const hasEdit = Object.values(data).some((v) => v !== undefined);
  if (!hasEdit) {
    return { ok: false, reason: 'no_fields' };
  }

  const result = await db.class.updateMany({
    where: sentEconomic !== null ? { id: classId, settingsLocked: false } : { id: classId },
    data,
  });

  if (result.count === 0) {
    // Both filter shapes constrain `id`, so a deleted row explains a zero
    // count under either of them — find out which happened rather than
    // assuming. #72 was this branch asserting a cause instead of checking it;
    // the economic path had the identical defect, and a deleted class
    // reported as "locked" is harder to spot than #72's empty list, because
    // the field name it names looks entirely plausible.
    const stillExists = await db.class.findUnique({
      where: { id: classId },
      select: { id: true },
    });
    if (!stillExists) return { ok: false, reason: 'not_found' };

    // The row survives, so the only other conjunct that can have failed is
    // `settingsLocked: false` — which is only ever in the filter when
    // economic fields were sent.
    if (sentEconomic !== null) return { ok: false, reason: 'locked', fields: sentEconomic };

    // Unreachable, and now actually so: `hasEdit` above guarantees at least
    // one defined value, so Prisma issues a real UPDATE whose `{ id }` filter
    // can only match zero rows if the row is gone — and the re-read above
    // would have caught that. Loud rather than silently returning a
    // plausible-but-wrong reason.
    throw new UpdateClassInvariantError(
      `updateClass: class ${classId} matched no rows but still exists`,
    );
  }

  return { ok: true, cls: await db.class.findUniqueOrThrow({ where: { id: classId } }) };
}
