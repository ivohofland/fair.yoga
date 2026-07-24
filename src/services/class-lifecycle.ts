/**
 * Class Lifecycle State Machine — Pure logic, no side effects.
 *
 * Manages class status transitions with guards.
 * Classes move through: draft → open → in_progress → completed
 * with cancellation possible from most non-terminal states.
 * "Full" is derived (registrations >= maxStudents), not a stored state.
 */

import type { PrismaClient, ClassStatus, RegistrationStatus, Class } from '@prisma/client';
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
 * Declared here rather than derived from `updateClassSchema` so the service
 * stays independent of the wire format — the schema's `date` is a
 * `YYYY-MM-DD` string, which the route converts before calling in.
 */
export type ClassUpdateData = {
  classType?: string;
  description?: string | null;
  date?: Date;
  startTime?: string;
  durationMinutes?: number;
  roomCost?: number;
  minRate?: number;
  targetRate?: number;
  minStudents?: number;
  maxStudents?: number;
};

/**
 * Why an update did or did not happen.
 *
 * `locked` carries a NON-EMPTY tuple of offending fields deliberately. The bug
 * this type replaced (#72) returned a "locked" response naming no fields at
 * all, for a request that touched none — the compiler now refuses to construct
 * that. Callers own the user-facing wording; this type owns the distinction.
 */
export type UpdateClassResult =
  | { ok: true; cls: Class }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'locked'; fields: readonly [EconomicField, ...EconomicField[]] }
  | { ok: false; reason: 'no_fields' };

/**
 * Apply a partial update to a class, enforcing the economic-field lock.
 *
 * The lock is enforced twice on purpose: once against the row we read (so the
 * caller gets a precise list of offending fields), and once inside the write
 * as a compare-and-swap (so a first registration landing in between still
 * blocks the edit).
 */
export async function updateClass(
  db: PrismaClient,
  classId: string,
  data: ClassUpdateData,
): Promise<UpdateClassResult> {
  const cls = await db.class.findUnique({ where: { id: classId } });
  if (!cls) return { ok: false, reason: 'not_found' };

  // Destructured rather than length-checked, so the non-empty tuple below is
  // proven to the compiler instead of asserted.
  const [firstEconomic, ...otherEconomic] = ECONOMIC_FIELDS.filter(
    (f) => data[f] !== undefined,
  );
  const sentEconomic: readonly [EconomicField, ...EconomicField[]] | null =
    firstEconomic === undefined ? null : [firstEconomic, ...otherEconomic];

  if (cls.settingsLocked && sentEconomic !== null) {
    return { ok: false, reason: 'locked', fields: sentEconomic };
  }

  if (Object.keys(data).length === 0) {
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

    // Unreachable: with no economic fields the filter was `{ id }` alone, and
    // a surviving row would have matched it. Loud rather than silently
    // returning a plausible-but-wrong reason — the mistake this PR exists to
    // stop making.
    throw new Error(`updateClass: class ${classId} matched no rows but still exists`);
  }

  return { ok: true, cls: await db.class.findUniqueOrThrow({ where: { id: classId } }) };
}
